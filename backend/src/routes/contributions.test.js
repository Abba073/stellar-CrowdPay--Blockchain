const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} = require('@stellar/stellar-sdk');
const { TX_TIMEOUT_CONTRIBUTION_S } = require('../config/constants');

// Provide a dummy USDC issuer so stellar.js does not throw at module load time
// in environments (e.g. CI, unit tests) where USDC_ISSUER is not set.
process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// Provide a dummy JWT_SECRET for token signing/verification in unit tests.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const TESTNET_PASSPHRASE = Networks.TESTNET;
const VALID_G = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';

function buildUnsignedPaymentXdr({ senderPublicKey, destinationPublicKey, amount, asset = 'XLM' }) {
  return new TransactionBuilder(new Account(senderPublicKey, '1'), {
    fee: BASE_FEE,
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: asset === 'XLM' ? Asset.native() : new Asset('USDC', 'GISSUER'),
        amount,
      })
    )
    .addMemo(require('@stellar/stellar-sdk').Memo.text('cp-c-1'))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build()
    .toXDR();
}

function buildApp({ queryImpl, stellarImpl, stellarTxImpl }) {
  const stellarStub = {
    buildUnsignedContributionPayment: async () => 'unsigned-xdr',
    buildUnsignedContributionPathPayment: async () => 'unsigned-xdr',
    prepareSignedContributionPayment: async () => ({
      unsignedXdr: 'unsigned-xdr',
      signedXdr: 'signed-xdr',
      feeAmount: 0,
    }),
    prepareSignedContributionPathPayment: async () => ({
      unsignedXdr: 'unsigned-xdr',
      signedXdr: 'signed-xdr',
      feeAmount: 0,
    }),
    submitPreparedTransaction: async () => 'tx-from-submit',
    submitWithFeeBumpFallback: async (...args) => stellarStub.submitPreparedTransaction(...args),
    getPathPaymentQuote: async () => [],
    getSupportedAssetCodes: () => ['XLM', 'USDC'],
    ensureCustodialAccountFundedAndTrusted: async () => null,
    isBadSequenceError: () => false,
    ...stellarImpl,
  };

  const stellarTxStub = {
    insertContributionSubmitted: async () => 'stellar-row-id',
    ...stellarTxImpl,
  };

  const contributionServiceStub = {
    SLIPPAGE_BPS: 500,
    buildContributionMemo: () => 'cp-c-1',
    buildContributionIntent: async ({ campaign, amount, sendAsset, contributorPublicKey }) => {
      if (sendAsset === campaign.asset_type) {
        return {
          kind: 'payment',
          conversionQuote: null,
          flowMetadata: {
            flow: 'payment',
            send_asset: sendAsset,
            amount: String(amount),
            contributor_public_key: contributorPublicKey,
          },
        };
      }

      const paths = await stellarStub.getPathPaymentQuote({
        sendAsset,
        destAsset: campaign.asset_type,
        destAmount: amount,
      });
      if (!paths.length) {
        const error = new Error(`No conversion path found for ${sendAsset} -> ${campaign.asset_type}`);
        error.statusCode = 422;
        throw error;
      }

      const bestPath = paths[0];
      const sendMax = (
        parseFloat(bestPath.source_amount) *
        1.05
      ).toFixed(7);

      return {
        kind: 'path_payment_strict_receive',
        sendMax,
        conversionQuote: {
          send_asset: sendAsset,
          campaign_asset: campaign.asset_type,
          campaign_amount: String(amount),
          quoted_source_amount: bestPath.source_amount,
          max_send_amount: sendMax,
          path: bestPath.path,
        },
        flowMetadata: {
          flow: 'path_payment_strict_receive',
          send_asset: sendAsset,
          dest_asset: campaign.asset_type,
          dest_amount: String(amount),
          max_send_amount: sendMax,
          contributor_public_key: contributorPublicKey,
        },
      };
    },
    submitCustodialContribution: async ({
      campaign,
      campaignId,
      userId,
      walletPublicKey,
      walletSecretEncrypted,
      amount,
      sendAsset,
    }) => {
      await stellarStub.ensureCustodialAccountFundedAndTrusted({
        publicKey: walletPublicKey,
        secret: 'SDECRYPTED',
      });
      const intent = await contributionServiceStub.buildContributionIntent({
        campaign,
        amount,
        sendAsset,
        contributorPublicKey: walletPublicKey,
      });

      const prepared =
        intent.kind === 'payment'
          ? await stellarStub.prepareSignedContributionPayment({
              senderSecret: 'SDECRYPTED',
              destinationPublicKey: campaign.wallet_public_key,
              asset: sendAsset,
              amount,
              memo: 'cp-c-1',
            })
          : await stellarStub.prepareSignedContributionPathPayment({
              senderSecret: 'SDECRYPTED',
              destinationPublicKey: campaign.wallet_public_key,
              sendAsset,
              sendMax: intent.sendMax,
              destAmount: amount,
              destAssetCode: campaign.asset_type,
              memo: 'cp-c-1',
            });

      let txHash;
      try {
        txHash = await stellarStub.submitPreparedTransaction(prepared.signedXdr);
      } catch (err) {
        err.statusCode = err.statusCode || 502;
        throw err;
      }
      const stellarTransactionId = await stellarTxStub.insertContributionSubmitted(null, {
        txHash,
        campaignId,
        userId,
        unsignedXdr: prepared.unsignedXdr,
        signedXdr: prepared.signedXdr,
        metadata: {
          ...intent.flowMetadata,
          platform_fee_amount: prepared.feeAmount ?? 0,
        },
      });

      return {
        txHash,
        stellarTransactionId,
        conversionQuote: intent.conversionQuote,
        platform_fee_amount: prepared.feeAmount ?? 0,
      };
    },
  };

  const router = proxyquire('./contributions', {
    '../config/stellar': {
      networkPassphrase: TESTNET_PASSPHRASE,
      isTestnet: true,
    },
    '../config/database': { query: queryImpl },
    '../services/stellarService': stellarStub,
    '../services/stellarTransactionService': stellarTxStub,
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SDECRYPTED'),
    },
    '../services/contributionService': contributionServiceStub,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
      optionalAuth: (req, _res, next) => {
        next();
      },
    },
    '../middleware/validation': {
      contributionValidation: [],
      contributionQuoteValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contributions', router);
  // Same terminal handler as src/index.js, so thrown errors get the envelope.
  app.use(require('../middleware/errorHandler').errorHandler);
  return app;
}

test('GET /api/contributions/quote returns best path quote', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    stellarImpl: {
      submitPayment: async () => 'unused',
      submitPathPayment: async () => 'unused',
      getPathPaymentQuote: async () => [
        {
          source_asset: 'XLM',
          destination_asset: 'USDC',
          source_amount: '10.0000000',
          destination_amount: '9.0000000',
          path: ['AQUA'],
        },
      ],
    },
  });

  const response = await request(app)
    .get('/api/contributions/quote?send_asset=XLM&dest_asset=USDC&dest_amount=9')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.quoted_source_amount, '10.0000000');
  assert.equal(response.body.max_send_amount, '10.5000000');
  assert.equal(response.body.estimated_rate, '0.900000000000000');
});

test('GET /api/contributions/quote returns 404 when no path exists', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    stellarImpl: {
      submitPayment: async () => 'unused',
      submitPathPayment: async () => 'unused',
      getPathPaymentQuote: async () => [],
    },
  });

  const response = await request(app)
    .get('/api/contributions/quote?send_asset=XLM&dest_asset=USDC&dest_amount=9')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 404);
});

test('POST /api/contributions uses direct payment for same asset', async () => {
  const prepared = [];
  const submitted = [];
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async (payload) => {
        prepared.push(payload);
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      prepareSignedContributionPathPayment: async () => {
        throw new Error('should not be called');
      },
      submitPreparedTransaction: async (xdr) => {
        submitted.push(xdr);
        return 'tx-direct';
      },
      getPathPaymentQuote: async () => [],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-direct');
  assert.equal(response.body.stellar_transaction_id, 'stellar-row-id');
  assert.equal(prepared.length, 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], 's');
});

test('POST /api/contributions uses direct payment for same USDC asset', async () => {
  const submitted = [];
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '22222222-2222-2222-2222-222222222222', status: 'active', asset_type: 'USDC', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async (payload) => {
        submitted.push(payload);
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      prepareSignedContributionPathPayment: async () => {
        throw new Error('should not be called');
      },
      submitPreparedTransaction: async () => 'tx-direct-usdc',
      getPathPaymentQuote: async () => [],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '22222222-2222-2222-2222-222222222222', amount: '7.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-direct-usdc');
  assert.equal(submitted.length, 1);
});

test('POST /api/contributions uses path payment for conversion', async () => {
  let pathPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'USDC', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async () => {
        throw new Error('should not be called');
      },
      prepareSignedContributionPathPayment: async (payload) => {
        pathPayload = payload;
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      submitPreparedTransaction: async () => 'tx-path',
      getPathPaymentQuote: async () => [
        {
          source_asset: 'XLM',
          destination_asset: 'USDC',
          source_amount: '5.0000000',
          destination_amount: '4.5000000',
          path: [],
        },
      ],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '4.5000000', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-path');
  assert.equal(response.body.conversion_quote.max_send_amount, '5.2500000');
  assert.equal(pathPayload.sendMax, '5.2500000');
  assert.equal(pathPayload.destAmount, '4.5000000');
  assert.equal(pathPayload.destAssetCode, 'USDC');
});

test('POST /api/contributions supports reverse conversion USDC -> XLM', async () => {
  let pathPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '33333333-3333-3333-3333-333333333333', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async () => {
        throw new Error('should not be called');
      },
      prepareSignedContributionPathPayment: async (payload) => {
        pathPayload = payload;
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      submitPreparedTransaction: async () => 'tx-path-reverse',
      getPathPaymentQuote: async () => [
        {
          source_asset: 'USDC',
          destination_asset: 'XLM',
          source_amount: '12.0000000',
          destination_amount: '10.0000000',
          path: ['AQUA'],
        },
      ],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '33333333-3333-3333-3333-333333333333', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-path-reverse');
  assert.equal(response.body.conversion_quote.max_send_amount, '12.6000000');
  assert.equal(pathPayload.sendAsset, 'USDC');
  assert.equal(pathPayload.destAmount, '10.0000000');
  assert.equal(pathPayload.destAssetCode, 'XLM');
});

test('POST /api/contributions returns 503 when custodial trustline setup fails', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      ensureCustodialAccountFundedAndTrusted: async () => {
        throw new Error('horizon_down');
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 503);
  assert.match(response.body.error.message, /retry/i);
});

test('POST /api/contributions returns 502 when Stellar submit fails and skips audit insert', async () => {
  let inserted = false;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      submitPreparedTransaction: async () => {
        throw new Error('tx_failed');
      },
    },
    stellarTxImpl: {
      insertContributionSubmitted: async () => {
        inserted = true;
        return 'should-not-run';
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 502);
  assert.equal(inserted, false);
});

test('POST /api/contributions/prepare returns unsigned XDR and prepare token for Freighter', async () => {
  const sender = Keypair.random();
  let preparedPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      buildUnsignedContributionPayment: async (payload) => {
        preparedPayload = payload;
        return buildUnsignedPaymentXdr({
          senderPublicKey: payload.senderPublicKey,
          destinationPublicKey: payload.destinationPublicKey,
          amount: payload.amount,
          asset: payload.asset,
        });
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(response.status, 200);
  assert.ok(response.body.prepare_token);
  assert.ok(response.body.unsigned_xdr);
  assert.equal(response.body.sender_public_key, sender.publicKey());
  assert.equal(response.body.network_name, 'TESTNET');
  assert.equal(preparedPayload.senderPublicKey, sender.publicKey());
});

test('POST /api/contributions/submit-signed accepts Freighter-signed XDR that matches prepared transaction', async () => {
  const sender = Keypair.random();
  const destination = Keypair.random();
  let submittedXdr = null;
  let insertedRow = null;
  const unsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: destination.publicKey(),
    amount: '5.0000000',
  });

  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: destination.publicKey(),
          }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      buildUnsignedContributionPayment: async () => unsignedXdr,
      submitPreparedTransaction: async (xdr) => {
        submittedXdr = xdr;
        return 'tx-freighter';
      },
    },
    stellarTxImpl: {
      insertContributionSubmitted: async (_client, row) => {
        insertedRow = row;
        return 'stellar-freighter-row';
      },
    },
  });

  const prepare = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(prepare.status, 200);

  const tx = TransactionBuilder.fromXDR(prepare.body.unsigned_xdr, TESTNET_PASSPHRASE);
  tx.sign(sender);
  const signedXdr = tx.toXDR();

  const response = await request(app)
    .post('/api/contributions/submit-signed')
    .set('Authorization', 'Bearer token')
    .send({
      prepare_token: prepare.body.prepare_token,
      signed_xdr: signedXdr,
    });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-freighter');
  assert.equal(response.body.stellar_transaction_id, 'stellar-freighter-row');
  assert.equal(submittedXdr, signedXdr);
  assert.equal(insertedRow.signedXdr, signedXdr);
  assert.equal(insertedRow.unsignedXdr, prepare.body.unsigned_xdr);
});

test('POST /api/contributions/submit-signed rejects a signed XDR that does not match prepared transaction', async () => {
  const sender = Keypair.random();
  const destination = Keypair.random();
  const unsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: destination.publicKey(),
    amount: '5.0000000',
  });
  const mismatchedUnsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: destination.publicKey(),
    amount: '6.0000000',
  });

  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: destination.publicKey(),
          }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      buildUnsignedContributionPayment: async () => unsignedXdr,
      submitPreparedTransaction: async () => {
        throw new Error('should not submit');
      },
    },
  });

  const prepare = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(prepare.status, 200);

  const mismatchedTx = TransactionBuilder.fromXDR(mismatchedUnsignedXdr, TESTNET_PASSPHRASE);
  mismatchedTx.sign(sender);

  const response = await request(app)
    .post('/api/contributions/submit-signed')
    .set('Authorization', 'Bearer token')
    .send({
      prepare_token: prepare.body.prepare_token,
      signed_xdr: mismatchedTx.toXDR(),
    });

  assert.equal(response.status, 422);
  assert.match(response.body.error.message, /does not match/i);
});

test('GET /api/contributions/finalization/:txHash returns finalized when indexed', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM stellar_transactions st')) {
        return {
          rows: [
            {
              id: 'st-1',
              status: 'indexed',
              tx_hash: 'txh',
              campaign_id: '11111111-1111-1111-1111-111111111111',
              contribution_id: 'contrib-1',
              initiated_by_user_id: 'user-1',
              metadata: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              creator_id: 'user-1',
              contribution_row_id: 'contrib-1',
              sender_public_key: 'GSENDER',
              amount: '5',
              asset: 'XLM',
              contribution_created_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (text.includes('wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GSENDER' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .get('/api/contributions/finalization/txh')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.finalization_status, 'finalized');
  assert.equal(response.body.contribution.id, 'contrib-1');
});

test('POST /api/contributions includes platform_fee_amount in response and metadata', async () => {
  let capturedMetadata = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'USDC', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async () => ({
        unsignedXdr: 'u',
        signedXdr: 's',
        feeAmount: 0.15,
      }),
      submitPreparedTransaction: async () => 'tx-fee-test',
      getPathPaymentQuote: async () => [],
    },
    stellarTxImpl: {
      insertContributionSubmitted: async (_client, row) => {
        capturedMetadata = row.metadata;
        return 'stellar-row-id';
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.platform_fee_amount, 0.15);
  assert.equal(capturedMetadata.platform_fee_amount, 0.15);
});

test('POST /api/contributions validates min_contribution limit', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            min_contribution: '15.0000000',
          }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.message, 'Minimum contribution is 15.0000000 USDC');
});

test('POST /api/contributions validates max_contribution limit', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            max_contribution: '50.0000000',
          }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '60.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.message, 'Maximum contribution is 50.0000000 USDC');
});

test('POST /api/contributions validates cumulative max_per_user cap', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            max_per_user: '100.0000000',
          }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }] };
      }
      if (text.includes('COALESCE(SUM(amount)')) {
        return {
          rows: [{ total: '80.0000000' }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '30.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.message, 'You have already contributed 80 USDC. The per-contributor limit is 100.0000000.');
});

test('POST /api/contributions/prepare and /submit-signed have rate limiting applied', async () => {
  const router = proxyquire('./contributions', {
    '../config/database': { query: async () => ({ rows: [] }) },
    '../services/stellarService': {
      buildUnsignedContributionPathPayment: async () => ({ unsignedXdr: 'xdr', quote: {} }),
      signAndSubmitCampaignContribution: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
    '../services/stellarTransactionService': {
      insertContributionSubmitted: async () => 'row-id',
      updateContributionConfirmed: async () => {},
    },
  });

  assert.ok(router.stack.some((layer) => layer.route && layer.route.path === '/prepare'));
  assert.ok(router.stack.some((layer) => layer.route && layer.route.path === '/submit-signed'));
});

test('GET /api/contributions/campaign/:id 404s for a soft-deleted campaign (no backer data)', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (/FROM campaigns\b/.test(text)) {
        return /deleted_at IS NULL/.test(text) ? { rows: [] } : { rows: [{ id: 'c', creator_id: 'x' }] };
      }
      return { rows: [{ id: 'k', sender_public_key: 'GPII', total_count: 1 }] };
    },
  });
  const res = await request(app).get('/api/contributions/campaign/3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e');
  assert.equal(res.status, 404);
  assert.ok(!JSON.stringify(res.body).includes('GPII'));
});

// ---- backer wall keyset pagination ------------------------------------------

const WALL_CAMPAIGN = '11111111-1111-1111-1111-111111111111';

function wallRows(n, startMinute = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(startMinute + i).padStart(12, '0')}`,
    sender_public_key: 'GSENDER',
    amount: '1',
    asset: 'XLM',
    created_at: new Date(Date.UTC(2026, 9, 21, 10, 59 - (startMinute + i))).toISOString(),
    _cursor_value: `2026-10-21 10:${String(59 - (startMinute + i)).padStart(2, '0')}:00.123456+00`,
  }));
}

function wallApp(pageRows) {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (/FROM campaigns\b/.test(text)) return { rows: [{ id: WALL_CAMPAIGN }] };
      if (text.includes('COUNT(*)::int AS total FROM contributions')) return { rows: [{ total: 42 }] };
      if (text.includes('FROM contributions c')) return { rows: pageRows };
      return { rows: [] };
    },
  });
  return { app, queries };
}

test('GET /api/contributions/campaign/:id returns a first page with next_cursor and total', async () => {
  const { app, queries } = wallApp(wallRows(3));
  const res = await request(app).get(`/api/contributions/campaign/${WALL_CAMPAIGN}?limit=2`);

  assert.equal(res.status, 200);
  assert.equal(res.body.contributions.length, 2);
  assert.equal(res.body.total, 42);
  assert.ok(res.body.next_cursor);
  assert.ok(!('offset' in res.body));
  assert.ok(!('_cursor_value' in res.body.contributions[0]));

  const page = queries.find((q) => q.text.includes('FROM contributions c'));
  assert.match(page.text, /ORDER BY c\.created_at DESC, c\.id DESC/);
  assert.doesNotMatch(page.text, /OFFSET/);
  assert.deepEqual(page.params, [WALL_CAMPAIGN, 3], 'fetches limit + 1 to detect more pages');
});

test('GET /api/contributions/campaign/:id continues from a cursor with a keyset filter and no count', async () => {
  const first = wallApp(wallRows(3));
  const cursor = (await request(first.app).get(`/api/contributions/campaign/${WALL_CAMPAIGN}?limit=2`)).body.next_cursor;

  const { app, queries } = wallApp(wallRows(1, 2));
  const res = await request(app).get(`/api/contributions/campaign/${WALL_CAMPAIGN}?limit=2&cursor=${cursor}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.next_cursor, null, 'last page');
  assert.ok(!('total' in res.body));
  assert.ok(!queries.some((q) => q.text.includes('COUNT(*)')));
  const page = queries.find((q) => q.text.includes('FROM contributions c'));
  assert.match(page.text, /\(c\.created_at, c\.id\) < \(\$2::timestamptz, \$3::uuid\)/);
  assert.deepEqual(page.params, [
    WALL_CAMPAIGN,
    '2026-10-21 10:58:00.123456+00',
    '00000000-0000-4000-8000-000000000001',
    3,
  ]);
});

test('GET /api/contributions/campaign/:id keeps legacy ?offset paging', async () => {
  const { app, queries } = wallApp(wallRows(2));
  const res = await request(app).get(`/api/contributions/campaign/${WALL_CAMPAIGN}?limit=2&offset=40`);

  assert.equal(res.status, 200);
  assert.equal(res.body.offset, 40);
  assert.equal(res.body.next_cursor, null);
  const page = queries.find((q) => q.text.includes('FROM contributions c'));
  assert.match(page.text, /OFFSET \$3/);
  assert.deepEqual(page.params, [WALL_CAMPAIGN, 2, 40]);
});

test('GET /api/contributions/campaign/:id rejects a malformed cursor with 400', async () => {
  const { app } = wallApp([]);
  const res = await request(app).get(`/api/contributions/campaign/${WALL_CAMPAIGN}?cursor=not-a-cursor`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_CURSOR');
});

// ---- malformed amounts are client errors, not 500s ---------------------------

test('malformed contribution amounts answer 422 VALIDATION_ERROR with a field message', async () => {
  const app = buildApp({
    queryImpl: async () => {
      throw new Error('DB must not be reached for a malformed amount');
    },
  });

  for (const [path, body] of [
    ['/api/contributions', { campaign_id: WALL_CAMPAIGN, amount: 'abc', send_asset: 'XLM' }],
    ['/api/contributions', { campaign_id: WALL_CAMPAIGN, amount: '1e5', send_asset: 'XLM' }],
    ['/api/contributions/prepare', { campaign_id: WALL_CAMPAIGN, amount: '-3', send_asset: 'XLM', sender_public_key: 'G' }],
  ]) {
    const res = await request(app).post(path).set('Authorization', 'Bearer token').send(body);
    assert.equal(res.status, 422, `${path} ${body.amount}`);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.fields.amount);
  }
});

test('a malformed quote dest_amount answers 422, not 500', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [{ id: WALL_CAMPAIGN, asset_type: 'USDC', status: 'active', wallet_public_key: 'GDEST' }] }),
    stellarImpl: {
      getPathPaymentQuote: async () => [{ source_amount: '1', source_asset: 'XLM', path: [] }],
    },
  });
  const res = await request(app)
    .get(`/api/contributions/quote?campaign_id=${WALL_CAMPAIGN}&send_asset=XLM&dest_asset=USDC&dest_amount=1e5`)
    .set('Authorization', 'Bearer token');
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.ok(res.body.error.fields.dest_amount);
});
