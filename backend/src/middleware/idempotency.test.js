const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp() {
  const store = new Map();
  const db = {
    query: async (text, params) => {
      const id = `${params[0]}:${params[1]}`;
      if (text.includes('INSERT INTO idempotency_keys')) {
        if (store.has(id)) return { rows: [] };
        store.set(id, { request_hash: params[4], completed_at: null });
        return { rows: [{ user_id: params[0] }] };
      }
      if (text.includes('SELECT request_hash')) {
        return { rows: store.has(id) ? [store.get(id)] : [] };
      }
      if (text.includes('UPDATE idempotency_keys')) {
        Object.assign(store.get(id), {
          response_status: params[2],
          response_body: JSON.parse(params[3]),
          completed_at: new Date(),
        });
        return { rows: [] };
      }
      if (text.includes('DELETE FROM idempotency_keys')) {
        store.delete(id);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const { idempotency } = proxyquire('./idempotency', {
    '../config/database': db,
    '../config/logger': { error: () => {} },
  });

  let calls = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 'user-1' };
    next();
  });
  app.post('/things', idempotency, (req, res) => {
    calls += 1;
    if (req.body.fail) return res.status(400).json({ error: 'bad' });
    res.status(201).json({ id: `thing-${calls}` });
  });
  return { app, getCalls: () => calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('replays the stored response for a repeated Idempotency-Key', async () => {
  const { app, getCalls } = buildApp();
  const first = await request(app).post('/things').set('Idempotency-Key', 'k1').send({ a: 1 });
  await flush();
  const second = await request(app).post('/things').set('Idempotency-Key', 'k1').send({ a: 1 });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(getCalls(), 1);
});

test('rejects reuse of a key with a different body', async () => {
  const { app } = buildApp();
  await request(app).post('/things').set('Idempotency-Key', 'k2').send({ a: 1 });
  await flush();
  const res = await request(app).post('/things').set('Idempotency-Key', 'k2').send({ a: 2 });
  assert.equal(res.status, 422);
});

test('does not store non-2xx responses so the client can retry', async () => {
  const { app, getCalls } = buildApp();
  await request(app).post('/things').set('Idempotency-Key', 'k3').send({ fail: true });
  await flush();
  const res = await request(app).post('/things').set('Idempotency-Key', 'k3').send({ fail: true });
  assert.equal(res.status, 400);
  assert.equal(getCalls(), 2);
});

test('runs normally without an Idempotency-Key header', async () => {
  const { app, getCalls } = buildApp();
  await request(app).post('/things').send({});
  await request(app).post('/things').send({});
  assert.equal(getCalls(), 2);
});
