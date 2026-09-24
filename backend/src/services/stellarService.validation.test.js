/**
 * Tests for #48 – withdrawal XDR builder validation.
 *
 * Covers validateWithdrawalParams, buildWithdrawalTransaction, and
 * buildBatchRefundTransaction using proxyquire so no real Stellar network
 * is contacted.
 */

'use strict';

// stellarService.js reads PLATFORM_SECRET_KEY at module-load time.
// Supply a valid testnet secret so Keypair.fromSecret does not throw.
process.env.PLATFORM_SECRET_KEY =
  process.env.PLATFORM_SECRET_KEY || 'SBRG4DJ6DC2VARCO2QS7BB2F6NR2XPDH6GDF3VAGTHAA4QZTIDOCFUOL';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

// A real-looking (but not real) Stellar Ed25519 public key.
const VALID_DEST   = 'GDOHG2SBTIP3WGLUS7WO4D5ULSLSSKDGLOVET5CCTF4ZRJLFSQNP5IZZ';
const VALID_WALLET = 'GCBYZCXFGSQ72QYSSDK57GN7YEZPFYNIROFDB5RODBAZK5JCE6RNMGR7';
const VALID_AMOUNT = '10.5';
const VALID_ASSET  = 'USDC';

/** Minimal Horizon account object returned by server.loadAccount. */
function makeAccount(balances = {}) {
  const records = Object.entries(balances).map(([code, bal]) => ({
    asset_type: code === 'XLM' ? 'native' : 'credit_alphanum4',
    asset_code: code === 'XLM' ? undefined : code,
    balance: String(bal),
  }));
  return {
    balances: records,
    incrementSequenceNumber: () => {},
    sequenceNumber: () => '1',
    accountId: () => VALID_WALLET,
  };
}

/** Build a proxyquired stellarService with optional Horizon / SDK overrides. */
function buildService({ balances = { USDC: '100', XLM: '10' }, extraStellar = {} } = {}) {
  const { Asset } = require('@stellar/stellar-sdk');
  // Use a valid Stellar public key as the USDC issuer (test fixture only).
  const USDC_ISSUER = 'GCNHZWKLBXF3VEDEF35O4OFHHSHOTZ6DJJERDEJETZ2ROHZTDP6MCP77';
  const realUsdc = new Asset('USDC', USDC_ISSUER);

  return proxyquire('./stellarService', {
    '../config/stellar': {
      server: {
        loadAccount: async () => makeAccount(balances),
        ...extraStellar,
      },
      networkPassphrase: 'Test SDF Network ; September 2015',
      USDC: realUsdc,
      isTestnet: true,
      configuredAssets: {
        XLM:  { type: 'native' },
        USDC: { type: 'credit_alphanum4', issuer: USDC_ISSUER },
      },
    },
    '../config/constants': {
      TX_TIMEOUT_CONTRIBUTION_S: 300,
      TX_TIMEOUT_WITHDRAWAL_S:   604800,
      CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM: 1,
      CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM: 0.5,
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '@sentry/node': { captureException: () => {} },
    '@stellar/stellar-sdk': require('@stellar/stellar-sdk'),
  });
}

// ---------------------------------------------------------------------------
// validateWithdrawalParams — unit tests (no I/O)
// ---------------------------------------------------------------------------

test('validateWithdrawalParams: accepts a valid set of params', () => {
  const { validateWithdrawalParams } = buildService();
  assert.doesNotThrow(() =>
    validateWithdrawalParams({
      amount: VALID_AMOUNT,
      asset: VALID_ASSET,
      destinationPublicKey: VALID_DEST,
    })
  );
});

test('validateWithdrawalParams: rejects invalid destination public key', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: VALID_AMOUNT, asset: VALID_ASSET, destinationPublicKey: 'NOT_A_KEY' }),
    /Invalid destination public key/
  );
});

test('validateWithdrawalParams: rejects empty destination', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: VALID_AMOUNT, asset: VALID_ASSET, destinationPublicKey: '' }),
    /Invalid destination public key/
  );
});

test('validateWithdrawalParams: rejects unsupported asset', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: VALID_AMOUNT, asset: 'SHIB', destinationPublicKey: VALID_DEST }),
    /Unsupported asset/
  );
});

test('validateWithdrawalParams: rejects zero amount', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: 0, asset: VALID_ASSET, destinationPublicKey: VALID_DEST }),
    /positive number/
  );
});

test('validateWithdrawalParams: rejects negative amount', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: -5, asset: VALID_ASSET, destinationPublicKey: VALID_DEST }),
    /positive number/
  );
});

test('validateWithdrawalParams: rejects NaN amount', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: NaN, asset: VALID_ASSET, destinationPublicKey: VALID_DEST }),
    /positive number/
  );
});

test('validateWithdrawalParams: rejects non-numeric string amount', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: 'abc', asset: VALID_ASSET, destinationPublicKey: VALID_DEST }),
    /positive number/
  );
});

test('validateWithdrawalParams: rejects amount with more than 7 decimal places', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () => validateWithdrawalParams({ amount: '1.00000001', asset: VALID_ASSET, destinationPublicKey: VALID_DEST }),
    /7 decimal places/
  );
});

test('validateWithdrawalParams: accepts amount with exactly 7 decimal places', () => {
  const { validateWithdrawalParams } = buildService();
  assert.doesNotThrow(() =>
    validateWithdrawalParams({ amount: '1.0000001', asset: VALID_ASSET, destinationPublicKey: VALID_DEST })
  );
});

test('validateWithdrawalParams: rejects sub-stroop dust amount', () => {
  const { validateWithdrawalParams } = buildService();
  // 0.00000001 has 8 decimal places, so it is caught by the decimal-places check first.
  // Either error proves the amount is rejected — match either message.
  assert.throws(
    () => validateWithdrawalParams({ amount: '0.00000001', asset: VALID_ASSET, destinationPublicKey: VALID_DEST }),
    /7 decimal places|minimum stroop/
  );
});

test('validateWithdrawalParams: accepts minimum stroop (0.0000001)', () => {
  const { validateWithdrawalParams } = buildService();
  assert.doesNotThrow(() =>
    validateWithdrawalParams({ amount: '0.0000001', asset: VALID_ASSET, destinationPublicKey: VALID_DEST })
  );
});

test('validateWithdrawalParams: rejects when balance is insufficient', () => {
  const { validateWithdrawalParams } = buildService();
  assert.throws(
    () =>
      validateWithdrawalParams({
        amount: '200',
        asset: VALID_ASSET,
        destinationPublicKey: VALID_DEST,
        balances: { USDC: '100' },
      }),
    /Insufficient balance/
  );
});

test('validateWithdrawalParams: accepts when balance exactly covers the amount', () => {
  const { validateWithdrawalParams } = buildService();
  assert.doesNotThrow(() =>
    validateWithdrawalParams({
      amount: '100',
      asset: VALID_ASSET,
      destinationPublicKey: VALID_DEST,
      balances: { USDC: '100' },
    })
  );
});

test('validateWithdrawalParams: skips balance check when balances not supplied', () => {
  const { validateWithdrawalParams } = buildService();
  // Amount larger than any real balance — should still pass without balances map.
  assert.doesNotThrow(() =>
    validateWithdrawalParams({
      amount: '99999',
      asset: VALID_ASSET,
      destinationPublicKey: VALID_DEST,
    })
  );
});

// ---------------------------------------------------------------------------
// buildWithdrawalTransaction — integration-style (mocked Horizon)
// ---------------------------------------------------------------------------

test('buildWithdrawalTransaction: rejects invalid destination before hitting network', async () => {
  const { buildWithdrawalTransaction } = buildService();
  await assert.rejects(
    () =>
      buildWithdrawalTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        destinationPublicKey: 'BAD_KEY',
        amount: VALID_AMOUNT,
        asset: VALID_ASSET,
      }),
    /Invalid destination public key/
  );
});

test('buildWithdrawalTransaction: rejects unsupported asset', async () => {
  const { buildWithdrawalTransaction } = buildService();
  await assert.rejects(
    () =>
      buildWithdrawalTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        destinationPublicKey: VALID_DEST,
        amount: VALID_AMOUNT,
        asset: 'DOGE',
      }),
    /Unsupported asset/
  );
});

test('buildWithdrawalTransaction: rejects when wallet balance is insufficient', async () => {
  const { buildWithdrawalTransaction } = buildService({ balances: { USDC: '5', XLM: '10' } });
  await assert.rejects(
    () =>
      buildWithdrawalTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        destinationPublicKey: VALID_DEST,
        amount: '10',      // more than the 5 USDC in wallet
        asset: VALID_ASSET,
      }),
    /Insufficient balance/
  );
});

test('buildWithdrawalTransaction: rejects amount with too many decimal places', async () => {
  const { buildWithdrawalTransaction } = buildService();
  await assert.rejects(
    () =>
      buildWithdrawalTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        destinationPublicKey: VALID_DEST,
        amount: '1.00000001',
        asset: VALID_ASSET,
      }),
    /7 decimal places/
  );
});

test('buildWithdrawalTransaction: returns XDR string for valid params', async () => {
  const { buildWithdrawalTransaction } = buildService({ balances: { USDC: '100', XLM: '10' } });
  const xdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: VALID_WALLET,
    destinationPublicKey: VALID_DEST,
    amount: '10',
    asset: VALID_ASSET,
  });
  assert.ok(typeof xdr === 'string' && xdr.length > 0, 'should return a non-empty XDR string');
});

// ---------------------------------------------------------------------------
// buildBatchRefundTransaction — integration-style (mocked Horizon)
// ---------------------------------------------------------------------------

test('buildBatchRefundTransaction: rejects empty refunds array', async () => {
  const { buildBatchRefundTransaction } = buildService();
  await assert.rejects(
    () =>
      buildBatchRefundTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        refunds: [],
      }),
    /non-empty array/
  );
});

test('buildBatchRefundTransaction: rejects a batch with an invalid destination in one entry', async () => {
  const { buildBatchRefundTransaction } = buildService({ balances: { USDC: '100', XLM: '10' } });
  await assert.rejects(
    () =>
      buildBatchRefundTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        refunds: [
          { destinationPublicKey: VALID_DEST, amount: '5', asset: 'USDC' },
          { destinationPublicKey: 'NOTAKEY', amount: '5', asset: 'USDC' },
        ],
      }),
    /refunds\[1\].*Invalid destination public key/
  );
});

test('buildBatchRefundTransaction: rejects a dust amount in a refund entry', async () => {
  const { buildBatchRefundTransaction } = buildService({ balances: { USDC: '100', XLM: '10' } });
  // 0.00000001 has 8 decimal places — caught by the decimal-places check (≤7 rule).
  await assert.rejects(
    () =>
      buildBatchRefundTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        refunds: [
          { destinationPublicKey: VALID_DEST, amount: '0.00000001', asset: 'USDC' },
        ],
      }),
    /refunds\[0\].*(?:7 decimal places|minimum stroop)/
  );
});

test('buildBatchRefundTransaction: rejects unsupported asset in a refund entry', async () => {
  const { buildBatchRefundTransaction } = buildService({ balances: { USDC: '100', XLM: '10' } });
  await assert.rejects(
    () =>
      buildBatchRefundTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        refunds: [
          { destinationPublicKey: VALID_DEST, amount: '5', asset: 'SHIB' },
        ],
      }),
    /refunds\[0\].*Unsupported asset/
  );
});

test('buildBatchRefundTransaction: rejects when an entry amount exceeds the wallet balance', async () => {
  // Wallet holds only 8 USDC; each entry is checked individually against that balance.
  // An entry requesting 9 USDC must be rejected.
  const { buildBatchRefundTransaction } = buildService({ balances: { USDC: '8', XLM: '10' } });
  await assert.rejects(
    () =>
      buildBatchRefundTransaction({
        campaignWalletPublicKey: VALID_WALLET,
        refunds: [
          { destinationPublicKey: VALID_DEST, amount: '9', asset: 'USDC' },
        ],
      }),
    /Insufficient balance/
  );
});

test('buildBatchRefundTransaction: returns XDR string for valid batch', async () => {
  const { buildBatchRefundTransaction } = buildService({ balances: { USDC: '100', XLM: '10' } });
  const xdr = await buildBatchRefundTransaction({
    campaignWalletPublicKey: VALID_WALLET,
    refunds: [
      { destinationPublicKey: VALID_DEST, amount: '5',   asset: 'USDC' },
      { destinationPublicKey: VALID_DEST, amount: '3.5', asset: 'USDC' },
    ],
  });
  assert.ok(typeof xdr === 'string' && xdr.length > 0, 'should return a non-empty XDR string');
});
