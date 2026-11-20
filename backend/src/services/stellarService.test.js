const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  Transaction,
} = require('@stellar/stellar-sdk');
const proxyquire = require('proxyquire').noCallThru();
const { TX_TIMEOUT_CONTRIBUTION_S } = require('../config/constants');

// Ensure required env vars are set before module load
process.env.USDC_ISSUER =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';

const TESTNET_PASSPHRASE = Networks.TESTNET;

// Stable keypairs for deterministic tests
const SENDER_KP = Keypair.random();
const DEST_KP = Keypair.random();
const PLATFORM_KP = Keypair.random();

/**
 * Load stellarService with the Horizon server stubbed out so no network calls are made.
 */
function loadService(senderSequence = '100') {
  const fakeAccount = new Account(SENDER_KP.publicKey(), senderSequence);

  return proxyquire('./stellarService', {
    '../config/stellar': {
      server: {
        loadAccount: async () => fakeAccount,
        transactions: () => ({
          forAccount: () => ({ order: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }) }),
        }),
        submitTransaction: async () => ({ hash: 'fakehash' }),
      },
      networkPassphrase: TESTNET_PASSPHRASE,
      USDC: new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
      isTestnet: true,
      configuredAssets: [Asset.native(), new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')],
    },
    '../config/constants': {
      TX_TIMEOUT_CONTRIBUTION_S: TX_TIMEOUT_CONTRIBUTION_S,
      TX_TIMEOUT_WITHDRAWAL_S: 300,
      CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM: 1,
      PLATFORM_FEE_BPS: 0, // disable fee so only one op is built, keeping tests simple
    },
    './walletSecrets': {
      getDecryptedWalletSecret: async () => PLATFORM_KP.secret(),
      withDecryptedWalletSecret: async (id, fn) => fn(PLATFORM_KP.secret()),
    },
    '@sentry/node': { captureException: () => {} },
  });
}

// ---------------------------------------------------------------------------
// buildUnsignedContributionPayment — memo
// ---------------------------------------------------------------------------

test('buildUnsignedContributionPayment includes memo in built XDR', async () => {
  const { buildUnsignedContributionPayment } = loadService();

  const xdr = await buildUnsignedContributionPayment({
    senderPublicKey: SENDER_KP.publicKey(),
    destinationPublicKey: DEST_KP.publicKey(),
    asset: 'XLM',
    amount: '10',
    memo: 'cp-abc123',
  });

  const tx = new Transaction(xdr, TESTNET_PASSPHRASE);
  assert.equal(tx.memo.type, 'text', 'memo type should be text');
  assert.equal(tx.memo.value.toString(), 'cp-abc123');
});

test('buildUnsignedContributionPayment omits memo field when no memo is passed', async () => {
  const { buildUnsignedContributionPayment } = loadService();

  const xdr = await buildUnsignedContributionPayment({
    senderPublicKey: SENDER_KP.publicKey(),
    destinationPublicKey: DEST_KP.publicKey(),
    asset: 'XLM',
    amount: '10',
  });

  const tx = new Transaction(xdr, TESTNET_PASSPHRASE);
  assert.equal(tx.memo.type, 'none', 'memo type should be none when omitted');
});

// ---------------------------------------------------------------------------
// buildUnsignedContributionPathPayment — memo
// ---------------------------------------------------------------------------

test('buildUnsignedContributionPathPayment includes memo in built XDR', async () => {
  const { buildUnsignedContributionPathPayment } = loadService();

  const xdr = await buildUnsignedContributionPathPayment({
    senderPublicKey: SENDER_KP.publicKey(),
    destinationPublicKey: DEST_KP.publicKey(),
    sendAsset: 'XLM',
    sendMax: '15',
    destAmount: '10',
    destAssetCode: 'XLM',
    memo: 'cp-path456',
  });

  const tx = new Transaction(xdr, TESTNET_PASSPHRASE);
  assert.equal(tx.memo.type, 'text', 'memo type should be text');
  assert.equal(tx.memo.value.toString(), 'cp-path456');
});

test('buildUnsignedContributionPathPayment omits memo field when no memo is passed', async () => {
  const { buildUnsignedContributionPathPayment } = loadService();

  const xdr = await buildUnsignedContributionPathPayment({
    senderPublicKey: SENDER_KP.publicKey(),
    destinationPublicKey: DEST_KP.publicKey(),
    sendAsset: 'XLM',
    sendMax: '15',
    destAmount: '10',
    destAssetCode: 'XLM',
  });

  const tx = new Transaction(xdr, TESTNET_PASSPHRASE);
  assert.equal(tx.memo.type, 'none', 'memo type should be none when omitted');
});
