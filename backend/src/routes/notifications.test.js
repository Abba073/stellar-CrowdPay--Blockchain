const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const USER = 'u-1';
const ID = '3f2b8c1e-1d2a-4b3c-9d4e-5f6a7b8c9d0e';

function buildApp() {
  const calls = [];
  const router = proxyquire('./notifications', {
    '../config/database': {
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: text.includes('RETURNING id') ? [{ id: params[0] }] : [] };
      },
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: USER };
        next();
      },
    },
    '../services/notifications': {
      getNotificationPreferences: async () => ({ marketing: true }),
      upsertNotificationPreferences: async (userId, patch) => {
        calls.push({ upsert: [userId, patch] });
        return { marketing: patch.marketing };
      },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', router);
  return { app, calls };
}

test('PUT /preferences saves validated preferences (previously threw: wrong service import)', async () => {
  const { app, calls } = buildApp();
  const res = await request(app).put('/api/notifications/preferences').send({ marketing: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { marketing: false });
  assert.deepEqual(calls.find((c) => c.upsert).upsert, [USER, { marketing: false }]);
});

test('PUT /preferences rejects unknown or non-boolean preferences before touching the DB', async () => {
  const { app, calls } = buildApp();
  const res = await request(app).put('/api/notifications/preferences').send({ marketing: 'yes' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('PATCH /:id/read rejects a non-UUID id without a DB round-trip', async () => {
  const { app, calls } = buildApp();
  assert.equal((await request(app).patch('/api/notifications/abc/read')).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await request(app).patch(`/api/notifications/${ID}/read`)).status, 200);
});
