const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ userId, queryImpl }) {
  const router = proxyquire('./wallets', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: userId || 'creator-1', role: 'creator' };
        next();
      },
    },
    '../services/stellarService': {
      getAccountMultisigConfig: async () => ({ thresholds: { med_threshold: 2 }, signers: [] }),
      getWalletTransactionHistory: async () => [],
      getWalletPayments: async () => [],
      recoverWalletFromSecret: async (secret) => ({ publicKey: 'GWALLET', secret }),
    },
    '../services/walletService': {
      decryptSecret: (_stored) => 'SCAMPAIGN',
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/wallets', router);
  return app;
}

test('POST /api/wallets/:id/recover returns the verified keypair for the creator', async () => {
  const app = buildApp({
    queryImpl: async () => ({
      rows: [{ wallet_secret_encrypted: 'iv:tag:cipher', wallet_public_key: 'GWALLET', creator_id: 'creator-1' }],
    }),
  });

  const response = await request(app)
    .post('/api/wallets/campaign-1/recover')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.publicKey, 'GWALLET');
  assert.equal(response.body.verified, true);
});

test('POST /api/wallets/:id/recover returns 400 when no secret is stored', async () => {
  const app = buildApp({
    queryImpl: async () => ({
      rows: [{ wallet_secret_encrypted: null, wallet_public_key: 'GWALLET', creator_id: 'creator-1' }],
    }),
  });

  const response = await request(app)
    .post('/api/wallets/campaign-1/recover')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /No encrypted secret stored/i);
});

test('POST /api/wallets/:id/recover returns 403 for a non-creator', async () => {
  const app = buildApp({
    userId: 'other-user',
    queryImpl: async () => ({
      rows: [{ wallet_secret_encrypted: 'iv:tag:cipher', wallet_public_key: 'GWALLET', creator_id: 'creator-1' }],
    }),
  });

  const response = await request(app)
    .post('/api/wallets/campaign-1/recover')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 403);
});

test('POST /api/wallets/:id/recover returns 404 when the campaign is missing', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });

  const response = await request(app)
    .post('/api/wallets/campaign-missing/recover')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 404);
});

test('POST /api/wallets/:id/recover returns 500 when the recovered key mismatches the campaign wallet', async () => {
  const app = buildApp({
    queryImpl: async () => ({
      rows: [{ wallet_secret_encrypted: 'iv:tag:cipher', wallet_public_key: 'GDIIFFERENT', creator_id: 'creator-1' }],
    }),
  });

  const response = await request(app)
    .post('/api/wallets/campaign-1/recover')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 500);
  assert.match(response.body.error.message, /does not match/i);
});