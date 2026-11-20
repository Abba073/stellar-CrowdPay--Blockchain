/**
 * Tests for issue #18: JWT role claim trusted without DB equivalence.
 *
 * Verifies that:
 * 1. Role read from DB overwrites the stale JWT payload role.
 * 2. Banned users are rejected on every request (ban takes effect immediately).
 * 3. requireRole uses the DB-loaded role, not the token-embedded one.
 *
 * These tests use proxyquire to stub the DB so they run without a real
 * database connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-secret-for-issue-18';

/**
 * Build a minimal Express app whose /protected route requires requireAuth
 * and optionally requireRole.
 *
 * @param {object} opts
 * @param {object} opts.dbUser - row returned by `SELECT role, is_admin, is_super_admin, is_banned`
 * @param {string[]} [opts.roles] - if provided, wrap route in requireRole(...roles)
 */
function buildApp({ dbUser, roles }) {
  const { requireAuth, requireRole } = proxyquire('./auth', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('FROM users')) {
          return { rows: dbUser ? [dbUser] : [] };
        }
        return { rows: [] };
      },
    },
    '@sentry/node': {
      setUser: () => {},
    },
  });

  const app = express();
  app.use(express.json());

  const middlewares = [requireAuth];
  if (roles && roles.length) {
    middlewares.push(requireRole(...roles));
  }

  app.get('/protected', ...middlewares, (req, res) => {
    res.json({ userId: req.user.userId, role: req.user.role, is_banned: req.user.is_banned });
  });

  return app;
}

/**
 * Mint a JWT with the given payload using the test secret.
 * The token contains a stale role that the DB will override.
 */
function mintToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

// ---------------------------------------------------------------------------
// Ban enforcement
// ---------------------------------------------------------------------------

test('banned user is rejected immediately even with a valid token (403)', async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  const token = mintToken({ userId: 'user-banned', role: 'contributor' });
  const app = buildApp({
    dbUser: { role: 'contributor', is_admin: false, is_super_admin: false, is_banned: true },
  });

  const res = await request(app)
    .get('/protected')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /suspended/i);
});

test('non-banned user with valid token passes requireAuth (200)', async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  const token = mintToken({ userId: 'user-good', role: 'contributor' });
  const app = buildApp({
    dbUser: { role: 'contributor', is_admin: false, is_super_admin: false, is_banned: false },
  });

  const res = await request(app)
    .get('/protected')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.userId, 'user-good');
});

// ---------------------------------------------------------------------------
// Role change propagation
// ---------------------------------------------------------------------------

test('role demotion takes effect on next request — stale token role is overwritten by DB', async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  // Token says the user is 'admin' but DB now says 'contributor' (demoted)
  const token = mintToken({ userId: 'user-demoted', role: 'admin' });
  const app = buildApp({
    dbUser: { role: 'contributor', is_admin: false, is_super_admin: false, is_banned: false },
    roles: ['admin'],  // route requires admin role
  });

  const res = await request(app)
    .get('/protected')
    .set('Authorization', `Bearer ${token}`);

  // Even though token says 'admin', the DB says 'contributor', so 403
  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /Insufficient role/i);
});

test('role promotion takes effect on next request — DB role overrides stale token', async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  // Token says 'contributor' but DB now says 'creator' (promoted)
  const token = mintToken({ userId: 'user-promoted', role: 'contributor' });
  const app = buildApp({
    dbUser: { role: 'creator', is_admin: false, is_super_admin: false, is_banned: false },
    roles: ['creator', 'admin'],  // route requires creator or admin
  });

  const res = await request(app)
    .get('/protected')
    .set('Authorization', `Bearer ${token}`);

  // DB role 'creator' satisfies requireRole, so 200
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'creator');
});

test('DB role is returned in response — token role is not used', async () => {
  process.env.JWT_SECRET = JWT_SECRET;

  const token = mintToken({ userId: 'user-x', role: 'contributor' });
  const app = buildApp({
    dbUser: { role: 'creator', is_admin: false, is_super_admin: false, is_banned: false },
  });

  const res = await request(app)
    .get('/protected')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  // Must return 'creator' (DB value), NOT 'contributor' (token value)
  assert.equal(res.body.role, 'creator');
});
