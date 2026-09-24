const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({
  queryImpl,
  buildWithdrawalTransactionImpl,
  insertWithdrawalPendingSignaturesImpl,
  queueFailedCampaignRefundsImpl,
  authUser,
  campaignStatusImpl,
}) {
  const router = proxyquire('./campaigns', {
    '../services/campaignStatusService': campaignStatusImpl || {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../services/campaignStatusActions': {
      queueFailedCampaignRefunds:
        queueFailedCampaignRefundsImpl ||
        (async () => ({ refundsCreated: 0, refunds: [] })),
    },
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: buildWithdrawalTransactionImpl,
    },
    '../services/ledgerMonitor': {
      watchCampaignWallet: async () => {},
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: insertWithdrawalPendingSignaturesImpl,
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = authUser || { userId: 'platform-1', role: 'admin' };
        next();
      },
      requireRole: () => (req, _res, next) => {
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

test('POST /api/campaigns/cron/fail-expired returns failed and funded campaigns', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
    campaignStatusImpl: {
      refreshActiveCampaignStatuses: async () => ({
        failed: [{
          id: 'c-1',
          title: 'Campaign 1',
          target_amount: '100',
          raised_amount: '50',
          deadline: '2026-04-23',
          status: 'failed',
        }],
        funded: [{ id: 'c-2', title: 'Funded', status: 'funded' }],
      }),
    },
  });

  const response = await request(app)
    .post('/api/campaigns/cron/fail-expired')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.failedCampaigns.length, 1);
  assert.equal(response.body.fundedCampaigns.length, 1);
});

test('POST /api/campaigns blocks unverified creators when KYC gate is enabled', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'true';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'pending' }] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Verified only', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'KYC_REQUIRED');
});

test('POST /api/campaigns allows creation when KYC gate is disabled', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'unverified' }] };
      }
      if (text.includes('INSERT INTO campaigns')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Dev campaign',
              asset_type: 'USDC',
              creator_id: 'creator-1',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Dev campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'campaign-1');
});

test('POST /api/campaigns returns 500 and logs orphaned wallet when DB insert fails', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status FROM users')) {
        return { rows: [{ email: 'creator@test.com', wallet_public_key: 'GCREATOR', kyc_status: 'verified' }] };
      }
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('INSERT INTO campaigns')) {
        throw new Error('unique constraint violation');
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Broken campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 500);
  assert.match(response.body.error, /contact support/i);
});

test('POST /api/campaigns returns 400 with validation errors for invalid payload', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: '', target_amount: -5, asset_type: 'INVALID' });

  assert.equal(response.status, 400);
  assert.ok(Array.isArray(response.body.errors));
  assert.ok(response.body.errors.length >= 1);
});

test('POST /api/campaigns/:id/trigger-refunds creates refund requests for contributions', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT id, wallet_public_key, status FROM campaigns')) {
        return { rows: [{ id: 'c-1', wallet_public_key: 'GPK', status: 'failed' }] };
      }
      return { rows: [] };
    },
    queueFailedCampaignRefundsImpl: async (campaignId, actorUserId) => {
      assert.equal(campaignId, 'c-1');
      assert.equal(actorUserId, 'platform-1');
      return {
        refundsCreated: 1,
        refunds: [{ contribution_id: 'contrib-1', refund_request_id: 'wr-1' }],
      };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/c-1/trigger-refunds')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 201);
  assert.equal(response.body.refundsCreated, 1);
});

test('GET /api/campaigns supports search, asset filter, and sort', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) {
        return { rows: [{ total: 1 }] };
      }
      return {
        rows: [
          {
            id: 'camp-1',
            title: 'Solar panels',
            description: 'Clean energy',
            asset_type: 'USDC',
            status: 'active',
            raised_amount: '80',
            target_amount: '100',
          },
        ],
      };
    },
  });

  const response = await request(app).get(
    '/api/campaigns?search=solar&asset=USDC&sort=closest_to_goal'
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.campaigns.length, 1);
  const listQuery = queries.find((q) => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /ILIKE/i);
  assert.match(listQuery.text, /raised_amount \/ NULLIF/i);
  assert.ok(listQuery.params.includes('%solar%'));
  assert.ok(listQuery.params.includes('USDC'));
});

test('GET /api/campaigns accepts every valid status and passes it to the filter', async () => {
  const { VALID_CAMPAIGN_STATUSES } = require('../middleware/validation');
  for (const status of VALID_CAMPAIGN_STATUSES) {
    const queries = [];
    const app = buildApp({
      queryImpl: async (text, params) => {
        queries.push({ text, params });
        return text.includes('COUNT(*)') ? { rows: [{ total: 0 }] } : { rows: [] };
      },
    });
    const response = await request(app).get(`/api/campaigns?status=${status}`);
    assert.equal(response.status, 200, `status ${status} should be accepted`);
    assert.ok(queries.some((q) => q.params && q.params.includes(status)));
  }
});

test('GET /api/campaigns rejects an unknown status', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });
  const response = await request(app).get('/api/campaigns?status=bogus');
  assert.equal(response.status, 400);
});

test('GET /api/campaigns applies a distinct ORDER BY for every valid sort', async () => {
  const { VALID_ORDER_BY } = require('../middleware/validation');
  const seen = new Set();
  for (const sort of VALID_ORDER_BY) {
    let listQuery;
    const app = buildApp({
      queryImpl: async (text) => {
        if (text.includes('ORDER BY')) listQuery = text;
        return text.includes('COUNT(*)') ? { rows: [{ total: 0 }] } : { rows: [] };
      },
    });
    const response = await request(app).get(`/api/campaigns?sort=${sort}`);
    assert.equal(response.status, 200, `sort ${sort} should be accepted`);
    seen.add(listQuery.match(/ORDER BY([\s\S]*?)LIMIT/)[1].trim());
    if (sort === 'trending') assert.match(listQuery, /INTERVAL '7 days'/);
  }
  assert.equal(seen.size, VALID_ORDER_BY.length, 'every sort must map to its own clause');
});
