const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

function buildApp({ commitFails = false } = {}) {
  process.env.PLATFORM_APPROVER_USER_ID = 'admin-1';
  process.env.PLATFORM_SECRET_KEY = Keypair.random().secret();
  const state = { commitFails, claimed: false, submits: 0, txHashRecorded: null, released: false, insertedTx: [] };
  const milestone = () => ({
    id: 'm-1', campaign_id: 'c-1', status: state.released ? 'released' : 'pending',
    campaign_status: 'funded', evidence_url: 'https://e', destination_key: Keypair.random().publicKey(),
    campaign_wallet_public_key: 'GCAMP', asset_type: 'XLM', raised_amount: '100', release_percentage: 50,
    creator_id: 'creator-1', creator_wallet_public_key: 'GCREATOR', wallet_secret_encrypted: 'enc',
    sort_order: 0, title: 'M1', release_tx_hash: state.txHashRecorded, release_signed_xdr: state.txHashRecorded ? 'xdr' : null,
    release_amount: state.txHashRecorded ? '50.0000000' : null,
  });

  const query = async (text, params) => {
    if (text.includes('FROM milestones m') && text.includes('JOIN campaigns c')) return { rows: [milestone()] };
    if (text.includes('SET release_claimed_at = NOW()')) {
      if (state.claimed || state.released) return { rows: [] };
      state.claimed = true;
      return { rows: [{ id: 'm-1' }] };
    }
    if (text.includes('SET release_claimed_at = NULL')) { state.claimed = false; return { rows: [] }; }
    if (text.includes('SET release_tx_hash')) { state.txHashRecorded = params[0]; return { rows: [] }; }
    if (text.includes('INSERT INTO withdrawal_requests')) return { rows: [{ id: 'w-1' }] };
    if (text.includes('UPDATE milestones') && text.includes("status = 'released'")) {
      state.pendingRelease = true;
      return { rows: [{ id: 'm-1', status: 'released' }] };
    }
    if (text.includes('milestones_contract_id')) return { rows: [{}] };
    return { rows: [] };
  };
  const client = {
    query: async (text, params) => {
      if (text === 'COMMIT' && state.commitFails) throw new Error('commit failed');
      if (text === 'COMMIT' && state.pendingRelease) state.released = true;
      return query(text, params);
    },
    release: () => {},
  };

  const router = proxyquire('./milestones', {
    '../config/database': { query, connect: async () => client },
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    '../middleware/auth': { requireAuth: (req, _res, next) => { req.user = { userId: 'admin-1' }; next(); } },
    '../services/alerting': { sendAlert: () => {} },
    '../services/stellarService': {
      buildWithdrawalTransaction: async () => 'unsigned',
      signTransactionXdr: ({ xdr }) => `${xdr}+sig`,
      signatureCountFromXdr: () => 2,
      submitSignedWithdrawal: async () => {
        state.submits += 1;
        await new Promise((r) => setTimeout(r, 20));
        return `hash-${state.submits}`;
      },
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => {},
      finalizeWithdrawalSubmitted: async () => {},
    },
    '../services/walletSecrets': { withDecryptedWalletSecret: async (_c, _ctx, fn) => fn('SCREATOR') },
    '../services/webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: {} },
    '../services/sorobanService': { invokeContract: async () => {}, nativeToScVal: (v) => v },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/milestones', router);
  return { app, state };
}

test('concurrent milestone approvals produce exactly one on-chain payment', async () => {
  const { app, state } = buildApp();
  const responses = await Promise.all([
    request(app).post('/api/milestones/m-1/approve').send({}),
    request(app).post('/api/milestones/m-1/approve').send({}),
  ]);
  assert.equal(state.submits, 1);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
});

test('a release whose DB commit failed is reconciled on retry without paying again', async () => {
  const { app, state } = buildApp({ commitFails: true });
  const res1 = await request(app).post('/api/milestones/m-1/approve').send({});
  assert.equal(res1.status, 500);
  assert.equal(state.submits, 1);
  assert.equal(state.txHashRecorded, 'hash-1');
  assert.equal(state.claimed, true);

  state.commitFails = false;
  const res2 = await request(app).post('/api/milestones/m-1/approve').send({});
  assert.equal(res2.status, 200);
  assert.equal(state.submits, 1);
  assert.equal(state.released, true);
});
