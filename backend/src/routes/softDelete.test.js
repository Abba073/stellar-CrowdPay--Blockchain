/**
 * A soft-deleted campaign must 404 on every secondary read path, not only on
 * GET /api/campaigns/:id. The fake DB below only hides the deleted campaign
 * when a query actually filters on deleted_at, so these tests fail for any
 * route that looks the campaign up (or joins it) without the filter.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const DELETED = '3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER = 'user-1';

const queries = [];
const softDeletedDb = {
  async query(text, params) {
    queries.push({ text, params });
    const touchesCampaigns = /FROM campaigns\b/.test(text) || /JOIN campaigns c\b/.test(text);
    if (touchesCampaigns) {
      if (/deleted_at IS NULL/.test(text)) return { rows: [] };
      return {
        rows: [{
          id: DELETED, campaign_id: DELETED, creator_id: USER, title: 'Gone', status: 'active',
          wallet_public_key: 'GWALLET', show_backer_amounts: true, deleted_at: new Date(),
        }],
      };
    }
    // Child rows (updates, milestones, contributions, disputes...) exist.
    return { rows: [{ id: OTHER, campaign_id: DELETED, title: 'leaked', sender_public_key: 'GPII' }], rowCount: 1 };
  },
  async connect() {
    return { query: softDeletedDb.query, release() {} };
  },
};

const authStub = {
  requireAuth: (req, _res, next) => {
    req.user = { userId: USER, role: 'admin' };
    next();
  },
  optionalAuth: (req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
};
const loggerStub = { info() {}, warn() {}, error() {}, debug() {} };

function mount(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

const apps = {
  updates: () =>
    mount('/api/campaigns', proxyquire('./campaignUpdates', {
      '../config/database': softDeletedDb,
      '../middleware/auth': authStub,
    })),
  stellarTx: () =>
    mount('/api/stellar/transactions', proxyquire('./stellarTransactions', {
      '../config/database': softDeletedDb,
      '../middleware/auth': authStub,
    })),
  disputes: () =>
    mount('/api', proxyquire('./disputes', {
      '../config/database': softDeletedDb,
      '../middleware/auth': authStub,
      '../services/emailService': { sendEmailSafe: async () => {} },
      '../config/logger': loggerStub,
    })),
  milestones: () =>
    mount('/api/milestones', proxyquire('./milestones', {
      '../config/database': softDeletedDb,
      '../config/logger': loggerStub,
      '../middleware/auth': authStub,
      '../middleware/idempotency': { idempotency: (_req, _res, next) => next() },
      '../services/alerting': { sendAlert: async () => {} },
      '../services/stellarService': {},
      '../services/stellarTransactionService': {},
      '../services/walletSecrets': {},
      '../services/webhookDispatcher': { emitWebhookEventForUser: async () => {}, WEBHOOK_EVENTS: {} },
      '../services/sorobanService': {},
      '../services/circuitBreaker': { CircuitOpenError: class extends Error {} },
    })),
};

const cases = [
  ['GET campaign updates', 'updates', 'get', `/api/campaigns/${DELETED}/updates`],
  ['POST a campaign update', 'updates', 'post', `/api/campaigns/${DELETED}/updates`, { title: 't', body: 'b' }],
  ['GET stellar transactions for the campaign', 'stellarTx', 'get', `/api/stellar/transactions?campaign_id=${DELETED}`],
  ['GET a stellar transaction of the campaign', 'stellarTx', 'get', `/api/stellar/transactions/${OTHER}`],
  ['POST a dispute', 'disputes', 'post', `/api/campaigns/${DELETED}/disputes`, { reason: 'other', description: 'x' }],
  ['GET the campaign disputes (admin)', 'disputes', 'get', `/api/campaigns/${DELETED}/disputes`],
  ['PATCH a dispute of the campaign (admin)', 'disputes', 'patch', `/api/disputes/${OTHER}`, { status: 'closed' }],
  ['GET campaign milestones', 'milestones', 'get', `/api/milestones/campaign/${DELETED}`],
];

for (const [name, appName, method, path, body] of cases) {
  test(`soft-deleted campaign: ${name} -> 404`, async () => {
    queries.length = 0;
    let req = request(apps[appName]())[method](path).set('Authorization', 'Bearer t');
    if (body) req = req.send(body);
    const res = await req;
    assert.equal(res.status, 404, `${method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(!JSON.stringify(res.body).includes('leaked'));
    assert.ok(!JSON.stringify(res.body).includes('GPII'));
  });
}

test('soft-deleted campaign: dispute events are not returned', async () => {
  const res = await request(apps.disputes()).get(`/api/disputes/${OTHER}/events`).set('Authorization', 'Bearer t');
  // The events query joins campaigns and filters deleted ones out.
  const eventsQuery = queries.find((q) => q.text.includes('FROM dispute_events'));
  assert.match(eventsQuery.text, /deleted_at IS NULL/);
  assert.equal(res.status, 200);
});
