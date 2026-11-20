'use strict';

/**
 * webhooks route tests — issue #65
 *
 * Covers:
 *  - POST /api/webhooks/kyc  (unauthenticated)
 *  - GET  /api/webhooks/     (authenticated)
 *  - POST /api/webhooks/     (authenticated — register a webhook)
 *  - DELETE /api/webhooks/:id (authenticated)
 *  - GET  /api/webhooks/deliveries (authenticated)
 *  - Tampered / invalid payloads
 *  - Unauthenticated-webhook regression (KYC must NOT require auth)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

process.env.KYC_WEBHOOK_SECRET = 'test-kyc-webhook-secret';

function signKycPayload(body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body || {});
  const digest = crypto
    .createHmac('sha256', process.env.KYC_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

const ALL_WEBHOOK_EVENTS = [
  'contribution.received',
  'campaign.funded',
  'campaign.failed',
  'withdrawal.approved',
  'milestone.approved',
];

/**
 * Build a minimal Express app wired to the webhooks router.
 *
 * @param {object} opts.userId        Authenticated user id injected by requireAuth stub
 * @param {object} opts.queryImpl     Optional replacement for db.query
 * @param {object} opts.requireAuth   Optional override for the auth middleware
 */
function buildApp({ userId = 'user-1', queryImpl, requireAuth } = {}) {
  const defaultQuery = async (text, params) => {
    // KYC webhook — UPDATE users
    if (text.includes('UPDATE users') && text.includes('kyc_status')) {
      // Simulate finding a user for the default happy-path tests
      return {
        rows: [{
          id: 'user-1',
          kyc_status: (params[0] || 'verified'),
          kyc_completed_at: new Date(),
        }],
      };
    }
    // webhooks SELECT (list)
    if (text.includes('SELECT') && text.includes('FROM webhooks WHERE user_id')) {
      return {
        rows: [
          {
            id: 'wh-1',
            url: 'https://example.com/hook',
            events: ['contribution.received'],
            secret_hint: 'whsec_abcde…xyz',
            created_at: new Date(),
            revoked_at: null,
          },
        ],
      };
    }
    // webhooks INSERT (create)
    if (text.includes('INSERT INTO webhooks')) {
      return {
        rows: [{
          id: 'wh-new',
          url: params[1],
          events: params[2],
          created_at: new Date(),
        }],
      };
    }
    // webhooks UPDATE (revoke)
    if (text.includes('UPDATE webhooks SET revoked_at')) {
      return { rows: [{ id: params[0] }] };
    }
    // webhook_deliveries SELECT
    if (text.includes('FROM webhook_deliveries d')) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const router = proxyquire('./webhooks', {
    '../config/database': { query: queryImpl || defaultQuery },
    '../middleware/auth': {
      requireAuth: requireAuth || ((req, _res, next) => {
        req.user = { userId };
        next();
      }),
    },
    '../services/webhookDispatcher': {
      ALL_WEBHOOK_EVENTS,
    },
    '../services/kycProvider': {
      extractWebhookResult: (payload = {}) => ({
        kycStatus: payload.status || 'verified',
        providerReference: payload.inquiry_id || payload.applicant_id || null,
        userId: payload.userId || null,
      }),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', router);
  return app;
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/kyc — unauthenticated KYC webhook (regression test)
// ---------------------------------------------------------------------------

test('POST /api/webhooks/kyc rejects unsigned request with 401', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/kyc')
    .send({ status: 'verified', inquiry_id: 'inq_abc123' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error?.message || res.body.error, 'KYC webhook signature verification failed');
});

test('POST /api/webhooks/kyc succeeds WITHOUT an Authorization header (unauthenticated but HMAC signed)', async () => {
  const app = buildApp();
  const payload = { status: 'verified', inquiry_id: 'inq_abc123' };

  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('Persona-Signature', signKycPayload(payload))
    .send(payload);

  // Must be accessible without auth
  assert.notEqual(res.status, 401, 'KYC webhook must not require authentication');
  assert.notEqual(res.status, 403, 'KYC webhook must not require authentication');
  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
});

test('POST /api/webhooks/kyc returns 400 for a payload with no provider reference or userId', async () => {
  const app = buildApp();
  const payload = { status: 'verified' };

  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('Persona-Signature', signKycPayload(payload))
    .send(payload);

  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('POST /api/webhooks/kyc returns 400 for an unsupported KYC status', async () => {
  const app = buildApp();
  const payload = { status: 'unknown_state', inquiry_id: 'inq_abc' };

  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('Persona-Signature', signKycPayload(payload))
    .send(payload);

  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('POST /api/webhooks/kyc returns 404 when the user is not found in DB', async () => {
  const notFoundQuery = async (text) => {
    if (text.includes('UPDATE users') && text.includes('kyc_status')) {
      return { rows: [] }; // no user found
    }
    return { rows: [] };
  };

  const app = buildApp({ queryImpl: notFoundQuery });
  const payload = { status: 'verified', inquiry_id: 'inq_notfound' };
  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('Persona-Signature', signKycPayload(payload))
    .send(payload);

  assert.equal(res.status, 404);
});

test('POST /api/webhooks/kyc accepts all three valid KYC statuses', async () => {
  for (const status of ['verified', 'rejected', 'pending']) {
    const app = buildApp();
    const payload = { status, inquiry_id: `inq_${status}` };
    const res = await request(app)
      .post('/api/webhooks/kyc')
      .set('Persona-Signature', signKycPayload(payload))
      .send(payload);

    assert.equal(res.status, 200, `Expected 200 for status=${status}, got ${res.status}`);
    assert.equal(res.body.received, true);
  }
});

// ---------------------------------------------------------------------------
// Tampered / malformed payload regression tests
// ---------------------------------------------------------------------------

test('POST /api/webhooks/kyc with an empty body returns 400', async () => {
  const app = buildApp();
  const payload = {};
  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('Persona-Signature', signKycPayload(payload))
    .send(payload);

  assert.equal(res.status, 400);
});

test('POST /api/webhooks/kyc with a completely garbage payload returns 400', async () => {
  const tamperedApp = buildApp();
  const payload = { not_a_real_field: true, another_junk_key: 'hello' };
  const res = await request(tamperedApp)
    .post('/api/webhooks/kyc')
    .set('Persona-Signature', signKycPayload(payload))
    .send(payload);

  // Should 400 — no provider reference or userId extractable, unsupported status.
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// GET /api/webhooks/ — list (authenticated)
// ---------------------------------------------------------------------------

test('GET /api/webhooks/ returns the list of webhooks for the authenticated user', async () => {
  const app = buildApp();
  const res = await request(app).get('/api/webhooks/');

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  assert.ok(res.body[0].url);
  // Secret must NOT be exposed in plain text
  assert.equal(res.body[0].secret, undefined, 'raw secret must not appear in list response');
});

test('GET /api/webhooks/ returns 401 when the auth middleware rejects the request', async () => {
  const unauthMiddleware = (_req, res) => res.status(401).json({ error: 'Unauthorized' });
  const app = buildApp({ requireAuth: unauthMiddleware });

  const res = await request(app).get('/api/webhooks/');
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/ — register (authenticated)
// ---------------------------------------------------------------------------

test('POST /api/webhooks/ creates a webhook and returns the signing secret once', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/')
    .send({ url: 'https://example.com/hook', events: ['contribution.received'] });

  assert.equal(res.status, 201);
  assert.ok(res.body.secret, 'signing secret must be returned on creation');
  assert.ok(res.body.secret.startsWith('whsec_'), 'secret must use the whsec_ prefix');
  assert.ok(res.body.message, 'should warn that the secret is only shown once');
});

test('POST /api/webhooks/ returns 400 when url is missing', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/')
    .send({ events: ['contribution.received'] });

  assert.equal(res.status, 400);
});

test('POST /api/webhooks/ returns 400 when events are missing', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/')
    .send({ url: 'https://example.com/hook' });

  assert.equal(res.status, 400);
});

test('POST /api/webhooks/ rejects non-https URLs (except localhost)', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/')
    .send({ url: 'http://external.example.com/hook', events: ['contribution.received'] });

  assert.equal(res.status, 400);
});

test('POST /api/webhooks/ accepts http://localhost for development', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/')
    .send({ url: 'http://localhost:3000/hook', events: ['contribution.received'] });

  assert.equal(res.status, 201);
});

test('POST /api/webhooks/ returns 400 for unrecognised event types', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/webhooks/')
    .send({ url: 'https://example.com/hook', events: ['not.a.real.event'] });

  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// DELETE /api/webhooks/:id — revoke (authenticated)
// ---------------------------------------------------------------------------

test('DELETE /api/webhooks/:id revokes the webhook and returns revoked:true', async () => {
  const app = buildApp();
  const res = await request(app).delete('/api/webhooks/wh-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, true);
  assert.ok(res.body.id);
});

test('DELETE /api/webhooks/:id returns 404 when the webhook is not owned by the user', async () => {
  const notFoundQuery = async (text) => {
    if (text.includes('UPDATE webhooks SET revoked_at')) {
      return { rows: [] }; // no matching owned webhook
    }
    return { rows: [] };
  };

  const app = buildApp({ queryImpl: notFoundQuery });
  const res = await request(app).delete('/api/webhooks/wh-foreign');

  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// GET /api/webhooks/deliveries — delivery history (authenticated)
// ---------------------------------------------------------------------------

test('GET /api/webhooks/deliveries returns an array (empty when none)', async () => {
  const app = buildApp();
  const res = await request(app).get('/api/webhooks/deliveries');

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});
