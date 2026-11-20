/**
 * Tests for issue #19: Super-admin tier, self-demotion guard, last-admin quorum.
 *
 * Uses proxyquire to stub DB and auth so the test suite runs without a
 * real database connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

/**
 * Build an Express app backed by the admin router with mocked dependencies.
 *
 * @param {object} opts
 * @param {Function} opts.queryImpl   - mock db.query
 * @param {object}  opts.authUser     - the user attached to req.user by requireAuth
 * @param {boolean} opts.isAdmin      - whether the acting user is_admin
 * @param {boolean} opts.isSuperAdmin - whether the acting user is_super_admin
 */
function buildAdminApp({ queryImpl, authUser, isAdmin = true, isSuperAdmin = false }) {
  const user = authUser || {
    userId: 'super-1',
    is_admin: isAdmin,
    is_super_admin: isSuperAdmin,
  };

  const router = proxyquire('./admin', {
    '../config/database': {
      query: queryImpl,
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
    },
    '../services/reconciliation': {
      reconcileSingleCampaign: async () => ({}),
    },
    '../utils/cache': {
      invalidate: () => {},
      invalidatePrefix: () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = user;
        next();
      },
      requireAdmin: (req, res, next) => {
        if (!req.user.is_admin) return res.status(403).json({ error: 'Requires admin privileges' });
        next();
      },
      requireSuperAdmin: (req, res, next) => {
        if (!req.user.is_super_admin) return res.status(403).json({ error: 'Requires super-admin privileges' });
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  return app;
}

// ---------------------------------------------------------------------------
// Promote — only super-admin can promote
// ---------------------------------------------------------------------------

test('PATCH /promote: non-super-admin admin gets 403', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: false,
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .patch('/api/admin/users/user-1/promote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /super-admin/i);
});

test('PATCH /promote: super-admin can promote a regular user', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: true,
    queryImpl: async (text) => {
      if (text.includes('SELECT id, email, is_admin FROM users')) {
        return { rows: [{ id: 'user-1', email: 'user@example.com', is_admin: false }] };
      }
      if (text.includes('UPDATE users SET is_admin = true')) {
        return { rows: [{ id: 'user-1', email: 'user@example.com', is_admin: true }] };
      }
      if (text.includes('INSERT INTO admin_actions')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch('/api/admin/users/user-1/promote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 200);
  assert.equal(res.body.user.is_admin, true);
});

test('PATCH /promote: returns 400 if user is already an admin', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: true,
    queryImpl: async (text) => {
      if (text.includes('SELECT id, email, is_admin FROM users')) {
        return { rows: [{ id: 'admin-2', email: 'admin2@example.com', is_admin: true }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch('/api/admin/users/admin-2/promote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /already an admin/i);
});

// ---------------------------------------------------------------------------
// Demote — only super-admin, no self-demotion, no last-admin demotion
// ---------------------------------------------------------------------------

test('PATCH /demote: non-super-admin gets 403', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: false,
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .patch('/api/admin/users/admin-2/demote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /super-admin/i);
});

test('PATCH /demote: self-demotion is blocked (403)', async () => {
  // Acting user id is 'super-1' (the default in buildAdminApp)
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: true,
    authUser: { userId: 'super-1', is_admin: true, is_super_admin: true },
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .patch('/api/admin/users/super-1/demote') // same id as acting user
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /cannot demote yourself/i);
});

test('PATCH /demote: blocks demoting the last admin (409)', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: true,
    authUser: { userId: 'super-1', is_admin: true, is_super_admin: true },
    queryImpl: async (text) => {
      if (text.includes('SELECT id, email, is_admin FROM users')) {
        return { rows: [{ id: 'admin-2', email: 'admin2@example.com', is_admin: true }] };
      }
      // No other admin besides the one being demoted
      if (text.includes('COUNT(*) FROM users WHERE is_admin')) {
        return { rows: [{ count: '0' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch('/api/admin/users/admin-2/demote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /last admin/i);
});

test('PATCH /demote: super-admin can demote another admin when quorum is maintained', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: true,
    authUser: { userId: 'super-1', is_admin: true, is_super_admin: true },
    queryImpl: async (text) => {
      if (text.includes('SELECT id, email, is_admin FROM users')) {
        return { rows: [{ id: 'admin-2', email: 'admin2@example.com', is_admin: true }] };
      }
      // 1 other admin remains
      if (text.includes('COUNT(*) FROM users WHERE is_admin')) {
        return { rows: [{ count: '1' }] };
      }
      if (text.includes('UPDATE users SET is_admin = false')) {
        return { rows: [{ id: 'admin-2', email: 'admin2@example.com', is_admin: false }] };
      }
      if (text.includes('INSERT INTO admin_actions')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch('/api/admin/users/admin-2/demote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 200);
  assert.equal(res.body.user.is_admin, false);
});

test('PATCH /demote: returns 404 if user does not exist', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: true,
    authUser: { userId: 'super-1', is_admin: true, is_super_admin: true },
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .patch('/api/admin/users/nonexistent/demote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 404);
});

test('PATCH /demote: returns 400 when target is not an admin', async () => {
  const app = buildAdminApp({
    isAdmin: true,
    isSuperAdmin: true,
    authUser: { userId: 'super-1', is_admin: true, is_super_admin: true },
    queryImpl: async (text) => {
      if (text.includes('SELECT id, email, is_admin FROM users')) {
        return { rows: [{ id: 'user-5', email: 'user5@example.com', is_admin: false }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .patch('/api/admin/users/user-5/demote')
    .set('Authorization', 'Bearer token');

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /not an admin/i);
});
