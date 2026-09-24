const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, anchorServiceImpl = {}, contributionServiceImpl = {}, stellarServiceImpl = {} } = {}) {
  const router = proxyquire('./anchor', {
    '../config/database': {
      query: queryImpl,
    },
    '../config/logger': {
      error: () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SUSER'),
    },
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => null,
      getSupportedAssetCodes: () => ['USDC'],
      ...stellarServiceImpl,
    },
    '../services/contributionService': {
      buildContributionIntent: async ({ campaign, amount, sendAsset, contributorPublicKey }) => ({
        kind: 'payment',
        conversionQuote: null,
        flowMetadata: {
          flow: 'payment',
          send_asset: sendAsset,
          amount: String(amount),
          contributor_public_key: contributorPublicKey,
        },
      }),
      submitCustodialContribution: async () => ({
        txHash: 'tx-123',
        stellarTransactionId: 'stellar-1',
      }),
      ...contributionServiceImpl,
    },
    '../services/anchorService': {
      getAvailableAnchors: () => [],
      getAnchorById: () => null,
      publicAnchorInfo: (anchor) => anchor,
      isAnchorConfigured: () => true,
      authenticateWithAnchor: async () => ({ token: 'anchor-token', expiresAt: new Date(Date.now() + 60000) }),
      startInteractiveDeposit: async () => ({ id: 'anchor-session-1', url: 'https://anchor.example/flow', status: 'pending' }),
      getAnchorTransaction: async () => ({ transaction: { status: 'pending' } }),
      isAnchorFailureStatus: () => false,
      ...anchorServiceImpl,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/anchor', router);
  return { app };
}

test('GET /api/anchor/info returns supported anchor metadata', async () => {
  const { app } = buildApp({
    anchorServiceImpl: {
      getAvailableAnchors: () => [
        {
          id: 'moneygram',
          name: 'MoneyGram Ramps',
          environment: 'sandbox',
          market: 'global-usd',
          rails: ['cash'],
          testnetAvailable: true,
          productionAvailable: false,
        },
      ],
      publicAnchorInfo: (anchor) => ({
        id: anchor.id,
        name: anchor.name,
        environment: anchor.environment,
        available: true,
      }),
    },
  });

  const response = await request(app).get('/api/anchor/info');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.supported_assets, ['USDC']);
  assert.equal(response.body.anchors.length, 1);
  assert.equal(response.body.anchors[0].id, 'moneygram');
  assert.equal(response.body.anchors[0].available, true);
});

test('POST /api/anchor/deposits/start begins an anchor deposit session', async () => {
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns c JOIN users u ON u.id = u.id')) {
        // never expected
        return { rows: [] };
      }
      if (text.includes('FROM campaigns c JOIN users u ON u.id = c.creator_id')) {
        return { rows: [{ id: 'camp-1', asset_type: 'USDC', status: 'active' }] };
      }
      if (text.includes('SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id')) {
        return { rows: [{ id: 'user-1', wallet_public_key: 'GUSER', wallet_secret_encrypted: 'encrypted' }] };
      }
      if (text.includes('INSERT INTO anchor_deposits')) {
        return {
          rows: [
            {
              id: 'deposit-1',
              anchor_id: 'moneygram',
              anchor_transaction_id: 'tx-123',
              anchor_asset: 'USDC',
              anchor_amount: '10',
              campaign_id: 'camp-1',
              contribution_amount: '10',
              status: 'pending_anchor',
              last_anchor_status: 'pending',
              last_anchor_payload: {},
              interactive_url: 'https://anchor.example/flow',
              conversion_quote: null,
              updated_at: new Date().toISOString(),
              completed_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    anchorServiceImpl: {
      getAnchorById: (id) => ({ id, assetCode: 'USDC' }),
      getAvailableAnchors: () => [{ id: 'moneygram', assetCode: 'USDC' }],
      publicAnchorInfo: (anchor) => anchor,
      isAnchorConfigured: () => true,
      authenticateWithAnchor: async () => ({ token: 'anchor-token', expiresAt: new Date(Date.now() + 60000) }),
      startInteractiveDeposit: async () => ({ id: 'tx-123', url: 'https://anchor.example/flow', status: 'pending' }),
    },
    contributionServiceImpl: {
      buildContributionIntent: async ({ campaign, amount, sendAsset, contributorPublicKey }) => ({
        kind: 'payment',
        conversionQuote: null,
      }),
    },
  });

  const response = await request(app)
    .post('/api/anchor/deposits/start')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', amount: '10', anchor_id: 'moneygram' });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'deposit-1');
  assert.equal(response.body.anchor_id, 'moneygram');
  assert.equal(response.body.anchor.interactive_protocol, undefined);
});

test('GET /api/anchor/deposits/:id refreshes anchor session status', async () => {
  let queryCount = 0;
  const { app } = buildApp({
    queryImpl: async (text) => {
      queryCount += 1;
      if (text.includes('FROM anchor_deposits ad')) {
        return {
          rows: [
            {
              id: 'deposit-1',
              user_id: 'user-1',
              campaign_id: 'camp-1',
              anchor_id: 'moneygram',
              anchor_transaction_id: 'anchor-tx',
              anchor_asset: 'USDC',
              anchor_amount: '10',
              contribution_amount: '10',
              campaign_asset: 'USDC',
              status: 'pending_anchor',
              last_anchor_status: 'pending',
              last_anchor_payload: {},
              interactive_url: 'https://anchor.example/flow',
              anchor_auth_token: null,
              anchor_auth_expires_at: null,
              wallet_public_key: 'GUSER',
              wallet_secret_encrypted: 'encrypted',
            },
          ],
        };
      }
      if (text.includes('UPDATE anchor_deposits') && text.includes('anchor_auth_token')) {
        return { rows: [] };
      }
      if (text.includes('UPDATE anchor_deposits') && text.includes('last_anchor_status')) {
        return { rows: [] };
      }
      if (text.includes('SELECT * FROM anchor_deposits WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'deposit-1',
              anchor_id: 'moneygram',
              anchor_transaction_id: 'anchor-tx',
              anchor_asset: 'USDC',
              anchor_amount: '10',
              campaign_id: 'camp-1',
              contribution_amount: '10',
              status: 'pending_anchor',
              last_anchor_status: 'pending',
              last_anchor_payload: {},
              interactive_url: 'https://anchor.example/flow',
              completed_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    anchorServiceImpl: {
      getAnchorById: () => ({ id: 'moneygram', assetCode: 'USDC' }),
      getAvailableAnchors: () => [{ id: 'moneygram', assetCode: 'USDC' }],
      publicAnchorInfo: (anchor) => anchor,
      isAnchorConfigured: () => true,
      authenticateWithAnchor: async () => ({ token: 'anchor-token', expiresAt: new Date(Date.now() + 60000) }),
      getAnchorTransaction: async () => ({ transaction: { status: 'pending' } }),
    },
  });

  const response = await request(app).get('/api/anchor/deposits/deposit-1').set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.id, 'deposit-1');
  assert.equal(response.body.status, 'pending_anchor');
  assert.equal(response.body.anchor_status, 'pending');
  assert.ok(queryCount >= 3);
});

test('concurrent completed-status polls submit exactly one contribution', async () => {
  let submitted = 0;
  let claimed = false;
  const session = {
    id: 'deposit-1', user_id: 'user-1', campaign_id: 'camp-1', anchor_id: 'moneygram',
    anchor_transaction_id: 'anchor-tx', anchor_asset: 'USDC', anchor_amount: '10',
    contribution_amount: '10', campaign_asset: 'USDC', status: 'pending_anchor',
    last_anchor_status: 'pending', last_anchor_payload: {}, deposit_type: 'campaign',
    contribution_tx_hash: null, contribution_id: null,
    wallet_public_key: 'GUSER', wallet_secret_encrypted: 'encrypted',
  };
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM anchor_deposits ad')) return { rows: [{ ...session }] };
      if (text.includes('contribution_submitting_at = NOW()')) {
        // Emulates the atomic conditional UPDATE: only the first caller wins.
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: 'deposit-1' }] };
      }
      if (text.includes('FROM campaigns c JOIN users u')) return { rows: [{ id: 'camp-1', status: 'active' }] };
      if (text.includes('SELECT * FROM anchor_deposits WHERE id = $1')) return { rows: [{ ...session, status: 'contribution_submitted' }] };
      return { rows: [] };
    },
    anchorServiceImpl: {
      getAnchorById: () => ({ id: 'moneygram', assetCode: 'USDC' }),
      getAnchorTransaction: async () => ({ transaction: { status: 'completed' } }),
    },
    contributionServiceImpl: {
      submitCustodialContribution: async () => {
        submitted += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { txHash: 'tx-123', stellarTransactionId: 'stellar-1' };
      },
    },
  });

  const responses = await Promise.all([
    request(app).get('/api/anchor/deposits/deposit-1').set('Authorization', 'Bearer token'),
    request(app).get('/api/anchor/deposits/deposit-1').set('Authorization', 'Bearer token'),
  ]);

  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.equal(submitted, 1);
});
