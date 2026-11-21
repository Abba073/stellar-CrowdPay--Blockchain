const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp() {
  const queries = [];
  const router = proxyquire('./campaignUpdates', {
    '../config/database': {
      query: async (text, params) => {
        queries.push({ text, params });
        return { rows: [{ id: 'update-1', title: 'Title', body: 'Body' }] };
      },
    },
    '../utils/campaignVisibility': {
      NOT_DELETED: 'deleted_at IS NULL',
      findVisibleCampaign: async () => ({ id: 'campaign-1' }),
    },
    '../middleware/auth': {
      requireAuth: (_req, _res, next) => next(),
    },
    '../middleware/requestSchemas': {
      campaignUpdateCreateValidation: (_req, _res, next) => next(),
      campaignUpdateEditValidation: (_req, _res, next) => next(),
      campaignUpdateDeleteValidation: (_req, _res, next) => next(),
      validateRequestUnprocessable: (_req, _res, next) => next(),
    },
  });
  const app = express();
  app.use('/api/campaigns', router);
  return { app, queries };
}

test('GET /:id/updates applies and returns effective pagination values', async () => {
  const { app, queries } = buildApp();
  const res = await request(app).get('/api/campaigns/campaign-1/updates?limit=5&offset=10');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    updates: [{
      id: 'update-1',
      title: 'Title',
      body: 'Body',
      title_raw: 'Title',
      title_sanitized: 'Title',
      body_raw: 'Body',
      body_sanitized: 'Body',
    }],
    limit: 5,
    offset: 10,
  });
  assert.match(queries[0].text, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(queries[0].params, ['campaign-1', 5, 10]);
  assert.match(queries[0].text, /ORDER BY cu\.created_at DESC, cu\.id DESC/);
});

test('GET /:id/updates defaults pagination and rejects invalid values before querying', async () => {
  const { app, queries } = buildApp();
  const defaults = await request(app).get('/api/campaigns/campaign-1/updates');
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.limit, 20);
  assert.equal(defaults.body.offset, 0);

  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=1.5']) {
    const res = await request(app).get(`/api/campaigns/campaign-1/updates?${query}`);
    assert.equal(res.status, 400, query);
  }
  assert.equal(queries.length, 1);
});
