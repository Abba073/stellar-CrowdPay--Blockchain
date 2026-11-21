const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { normalizeErrorResponse, errorHandler } = require('../middleware/errorHandler');
const { createLedgerHealthHandler, LEDGER_HEALTH_UNAVAILABLE } = require('./healthLedger');

function buildApp({ getLedgerStreamHealth }) {
  const alerts = [];
  const logs = [];
  const app = express();
  app.use(normalizeErrorResponse);
  app.get(
    '/health/ledger',
    createLedgerHealthHandler({
      getLedgerStreamHealth,
      sendAlert: (title, details) => alerts.push({ title, details }),
      logger: { error: (msg, meta) => logs.push({ msg, meta }) },
    })
  );
  app.use(errorHandler);
  return { app, alerts, logs };
}

test('GET /health/ledger returns the stream health body when healthy', async () => {
  const { app, alerts } = buildApp({
    getLedgerStreamHealth: async () => ({ status: 'healthy', last_ledger: 42 }),
  });

  const res = await request(app).get('/health/ledger');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'healthy', last_ledger: 42 });
  assert.equal(alerts.length, 0);
});

test('GET /health/ledger returns a fixed 503 body and never leaks the internal error', async () => {
  const internal =
    'connect ECONNREFUSED https://internal-horizon.example:8000/ledgers?cursor=12345 (stream state=reconnecting)';
  const { app, alerts, logs } = buildApp({
    getLedgerStreamHealth: async () => {
      throw new Error(internal);
    },
  });

  const res = await request(app).get('/health/ledger');

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, {
    error: { code: 'SERVICE_UNAVAILABLE', message: LEDGER_HEALTH_UNAVAILABLE },
  });
  for (const fragment of ['internal-horizon', 'ECONNREFUSED', 'cursor', 'reconnecting']) {
    assert.ok(!res.text.includes(fragment), `response leaked "${fragment}"`);
  }

  // Details still reach operators through the logs and the alert.
  assert.equal(logs.length, 1);
  assert.equal(logs[0].meta.error, internal);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].details.error, internal);
  assert.equal(alerts[0].details.severity, 'critical');
});

test('GET /health/ledger hides errors without a message too', async () => {
  const { app } = buildApp({
    getLedgerStreamHealth: async () => {
      throw new Error();
    },
  });

  const res = await request(app).get('/health/ledger');
  assert.equal(res.status, 503);
  assert.equal(res.body.error.message, LEDGER_HEALTH_UNAVAILABLE);
});
