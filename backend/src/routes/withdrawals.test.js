const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, stellarImpl, userId = 'creator-1', role = 'creator', platformApproverUserId } = {}) {
  const prevApprover = process.env.PLATFORM_APPROVER_USER_ID;
  if (platformApproverUserId !== false) {
    process.env.PLATFORM_APPROVER_USER_ID = platformApproverUserId ?? userId;
  }

  const stellarStub = {
    buildWithdrawalTransaction: async () => 'xdr-base',
    getAccountMultisigConfig: async () => ({
      thresholds: { med_threshold: 2 },
      signers: [{ key: 'GCREATOR', weight: 1 }, { key: 'GPLATFORM', weight: 1 }],
    }),
    signTransactionXdr: () => 'xdr-signed',
    signatureCountFromXdr: () => 2,
    submitSignedWithdrawal: async () => 'tx-hash',
    getTransactionHash: () => 'tx-hash',
    transactionExistsOnHorizon: async () => false,
    // Default: XDR is not expired. Override in specific tests via stellarImpl.
    isXdrExpired: () => false,
    PLATFORM_PUBLIC_KEY: 'GPLATFORM',
    ...stellarImpl,
  };

  const router = proxyquire('./withdrawals', {
    '../config/database': {
      connect: async () => ({
        query: queryImpl,
        release: () => {},
      }),
      query: queryImpl,
    },
    '../services/stellarService': stellarStub,
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SCREATOR'),
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId, role };
        next();
      },
      requireRole: (...roles) => (req, res, next) => {
        if (!roles.includes(req.user.role)) {
          return res.status(403).json({ error: 'Insufficient role for this action' });
        }
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/withdrawals', router);

  return { app, cleanup: () => {
    if (prevApprover === undefined) delete process.env.PLATFORM_APPROVER_USER_ID;
    else process.env.PLATFORM_APPROVER_USER_ID = prevApprover;
  } };
}

const VALID_DESTINATION = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';

function campaignRow(overrides = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    creator_id: 'creator-1',
    wallet_public_key: 'GCAMPAIGN',
    asset_type: 'USDC',
    status: 'active',
    ...overrides,
  };
}

test('GET /api/withdrawals/capabilities reflects platform approver status', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async () => ({ rows: [] }),
    userId: 'platform-1',
    role: 'admin',
    platformApproverUserId: 'platform-1',
  });
  const res = await request(app).get('/api/withdrawals/capabilities').set('Authorization', 'Bearer t');
  cleanup();
  assert.equal(res.status, 200);
  assert.equal(res.body.can_approve_platform, true);
});

test('GET /api/withdrawals/capabilities denies when user is not platform approver', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async () => ({ rows: [] }),
    userId: 'other-user',
    role: 'admin',
    platformApproverUserId: 'platform-1',
  });
  const res = await request(app).get('/api/withdrawals/capabilities').set('Authorization', 'Bearer t');
  cleanup();
  assert.equal(res.status, 200);
  assert.equal(res.body.can_approve_platform, false);
});

test('POST /api/withdrawals/request creates pending request and logs event', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    queryImpl: async (text, params) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow()] };
      }
      if (text.includes("FROM withdrawal_requests") && text.includes("status = 'pending'")) {
        return { rows: [] };
      }
      if (text.includes('wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR' }] };
      }
      if (text.includes('INSERT INTO withdrawal_requests')) {
        return { rows: [{ id: 'w-1', status: 'pending', creator_signed: false, platform_signed: false }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO stellar_transactions')) {
        return { rows: [{ id: 'stellar-1' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', destination_key: VALID_DESTINATION, amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 201);
  assert.equal(response.body.status, 'pending');
  assert.ok(calls.some((c) => c.includes('INSERT INTO withdrawal_approval_events')));
  assert.ok(calls.some((c) => c.includes('INSERT INTO stellar_transactions')));
});

test('POST /api/withdrawals/request blocks when campaign not active or funded', async () => {
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow({ status: 'closed' })] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', destination_key: VALID_DESTINATION, amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 409);
});

test('POST /api/withdrawals/request blocks duplicate pending', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow()] };
      }
      if (text.includes("status = 'pending'")) {
        return { rows: [{ id: 'existing' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', destination_key: VALID_DESTINATION, amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 409);
});

test('POST /api/withdrawals/request denies invalid multisig config', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow()] };
      }
      if (text.includes("status = 'pending'")) return { rows: [] };
      if (text.includes('wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      getAccountMultisigConfig: async () => ({
        thresholds: { med_threshold: 1 },
        signers: [{ key: 'GCREATOR', weight: 1 }],
      }),
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', destination_key: VALID_DESTINATION, amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 422);
});

test('POST /api/withdrawals/:id/approve/platform denies non-platform user when approver is configured', async () => {
  const { app, cleanup } = buildApp({
    userId: 'other-user',
    role: 'admin',
    platformApproverUserId: 'platform-user',
    queryImpl: async () => ({ rows: [] }),
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 403);
});

test('POST /api/withdrawals/:id/approve/platform denies before creator approval', async () => {
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: async () => ({
      rows: [{
        id: 'w-1',
        status: 'pending',
        creator_signed: false,
        platform_signed: false,
        unsigned_xdr: 'xdr-base',
        campaign_status: 'active',
      }],
    }),
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 409);
  assert.match(response.body.error, /Creator approval/);
});

test('POST /api/withdrawals/:id/approve/creator signs withdrawal request', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT creator_id FROM campaigns WHERE id')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM withdrawal_requests wr')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: false,
            platform_signed: false,
            unsigned_xdr: 'xdr-base',
            creator_id: 'creator-1',
            campaign_id: '11111111-1111-1111-1111-111111111111',
            campaign_status: 'active',
          }],
        };
      }
      if (text.includes('wallet_secret_encrypted') && text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SCREATOR', wallet_public_key: 'GCREATOR' }] };
      }
      if (text.includes('UPDATE withdrawal_requests') && text.includes('creator_signed = TRUE')) {
        return { rows: [{ id: 'w-1', creator_signed: true, unsigned_xdr: 'xdr-signed' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/creator')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.creator_signed, true);
  assert.ok(calls.some((c) => c.includes('creator_signed')));
});

test('POST /api/withdrawals/:id/approve/platform denies insufficient signatures', async () => {
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: async () => ({
      rows: [{
        id: 'w-1',
        status: 'pending',
        creator_signed: true,
        platform_signed: false,
        unsigned_xdr: 'xdr-base',
        campaign_status: 'active',
      }],
    }),
    stellarImpl: {
      signatureCountFromXdr: () => 1,
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 422);
});

test('POST /api/withdrawals/:id/approve/platform submits with dual signatures', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: async (text) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT wr.*, c.status')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
            unsigned_xdr: 'xdr-creator-signed',
            campaign_status: 'active',
          }],
        };
      }
      if (text.includes('UPDATE withdrawal_requests') && text.includes("status = 'submitted'")) {
        return { rows: [{ id: 'w-1', status: 'submitted', tx_hash: 'tx-hash' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      if (text.includes('UPDATE stellar_transactions') && text.includes("kind = 'withdrawal'")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'submitted');
  assert.ok(calls.some((c) => c.includes("status = 'submitted'")));
  assert.ok(calls.some((c) => c.includes('UPDATE stellar_transactions')));
});

test('POST /api/withdrawals/:id/cancel denies after creator signed', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async () => ({
      rows: [{
        id: 'w-1',
        status: 'pending',
        creator_signed: true,
        creator_id: 'creator-1',
      }],
    }),
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/cancel')
    .set('Authorization', 'Bearer token')
    .send({ reason: 'Never mind' });

  cleanup();
  assert.equal(response.status, 409);
});

test('POST /api/withdrawals/:id/cancel succeeds before creator signs', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT creator_id FROM campaigns WHERE id')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM withdrawal_requests wr')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: false,
            creator_id: 'creator-1',
            campaign_id: '11111111-1111-1111-1111-111111111111',
          }],
        };
      }
      if (text.includes("SET status = 'denied'")) {
        return { rows: [{ id: 'w-1', status: 'denied', denial_reason: 'x' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/cancel')
    .set('Authorization', 'Bearer token')
    .send({ reason: 'Wrong destination' });

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'denied');
});

test('POST /api/withdrawals/:id/reject marks denied after creator signed', async () => {
  const { app, cleanup } = buildApp({
    userId: 'platform-user',
    role: 'admin',
    queryImpl: async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT * FROM withdrawal_requests WHERE id')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
          }],
        };
      }
      if (text.includes("SET status = 'denied'")) {
        return { rows: [{ id: 'w-1', status: 'denied' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/reject')
    .set('Authorization', 'Bearer t')
    .send({ reason: 'Compliance hold' });

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'denied');
});

test('POST /api/withdrawals/:id/approve/platform logs failure when Stellar rejects', async () => {
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT wr.*, c.status')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
            unsigned_xdr: 'xdr',
            campaign_status: 'active',
          }],
        };
      }
      if (text.includes("SET status = 'failed'")) return { rows: [] };
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      if (text.includes('UPDATE stellar_transactions') && text.includes("status = 'failed'")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      submitSignedWithdrawal: async () => {
        throw new Error('op_underfunded');
      },
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 502);
});

test('POST /api/withdrawals/:id/approve/platform returns 410 when XDR time bounds are expired', async () => {
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: async (text) => {
      if (text.includes('SELECT wr.*, c.status')) {
        return {
          rows: [{
            id: 'w-expired',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
            unsigned_xdr: 'xdr-expired',
            campaign_status: 'active',
          }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      // Simulate an expired XDR — isXdrExpired returns true
      isXdrExpired: () => true,
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-expired/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 410);
  assert.match(response.body.error, /expired/i);
});

function approveQueryImpl({ failUpdate = false, state = { status: 'pending' } } = {}) {
  return async (text) => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (text.includes('SELECT wr.*, c.status')) {
      return {
        rows: [{
          id: 'w-1',
          status: state.status,
          creator_signed: true,
          platform_signed: false,
          unsigned_xdr: 'xdr',
          campaign_id: 'camp-1',
          campaign_status: 'active',
        }],
      };
    }
    if (text.includes("SET unsigned_xdr = $1, platform_signed = TRUE")) {
      if (failUpdate) throw new Error('db connection lost');
      state.status = 'submitted';
      return { rows: [{ id: 'w-1', status: 'submitted', tx_hash: 'tx-hash', campaign_id: 'camp-1' }] };
    }
    return { rows: [] };
  };
}

test('approve: DB failure after submission returns 500 with tx_hash, retry reconciles without resubmitting', async () => {
  let submitCalls = 0;
  let landed = false;
  const stellarImpl = {
    submitSignedWithdrawal: async () => {
      submitCalls += 1;
      landed = true;
      return 'tx-hash';
    },
    transactionExistsOnHorizon: async () => landed,
  };

  const first = buildApp({ role: 'admin', queryImpl: approveQueryImpl({ failUpdate: true }), stellarImpl });
  const r1 = await request(first.app).post('/api/withdrawals/w-1/approve/platform').set('Authorization', 'Bearer t').send({});
  first.cleanup();
  assert.equal(r1.status, 500);
  assert.equal(r1.body.tx_hash, 'tx-hash');
  assert.equal(submitCalls, 1);

  // Retry: row is still 'pending' in the DB, but the tx is already on Horizon.
  const second = buildApp({ role: 'admin', queryImpl: approveQueryImpl(), stellarImpl });
  const r2 = await request(second.app).post('/api/withdrawals/w-1/approve/platform').set('Authorization', 'Bearer t').send({});
  second.cleanup();
  assert.equal(r2.status, 200);
  assert.equal(r2.body.status, 'submitted');
  assert.equal(r2.body.tx_hash, 'tx-hash');
  assert.equal(submitCalls, 1, 'retry must not submit a second time');
});

test('approve: submit error that actually landed on Horizon is reconciled as submitted', async () => {
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: approveQueryImpl(),
    stellarImpl: {
      submitSignedWithdrawal: async () => { throw new Error('timeout'); },
      transactionExistsOnHorizon: async () => true,
    },
  });
  const res = await request(app).post('/api/withdrawals/w-1/approve/platform').set('Authorization', 'Bearer t').send({});
  cleanup();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');
});

test('approve: unknown outcome (Horizon lookup fails after submit error) returns 503 and does not mark failed', async () => {
  const queries = [];
  const base = approveQueryImpl();
  const { app, cleanup } = buildApp({
    role: 'admin',
    queryImpl: async (text, params) => { queries.push(text); return base(text, params); },
    stellarImpl: {
      submitSignedWithdrawal: async () => { throw new Error('timeout'); },
      transactionExistsOnHorizon: async () => { throw new Error('horizon down'); },
    },
  });
  const res = await request(app).post('/api/withdrawals/w-1/approve/platform').set('Authorization', 'Bearer t').send({});
  cleanup();
  assert.equal(res.status, 503);
  assert.ok(!queries.some((q) => q.includes("SET status = 'failed'")));
});
