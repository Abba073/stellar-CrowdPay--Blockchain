const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

function buildAuthModule(overrides = {}) {
  const tokensDb = new Map();
  const queries = [];

  const mockDb = {
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('INSERT INTO refresh_tokens')) {
        const [userId, tokenHash, expiresAt, familyId] = params;
        const id = crypto.randomUUID();
        tokensDb.set(tokenHash, {
          id,
          user_id: userId,
          token_hash: tokenHash,
          expires_at: expiresAt,
          family_id: familyId,
          revoked_at: null,
        });
        return { rows: [{ id, family_id: familyId }] };
      }
      if (text.includes('SELECT rt.id AS token_id') && text.includes('FROM refresh_tokens rt')) {
        const [tokenHash] = params;
        const record = tokensDb.get(tokenHash);
        if (!record) return { rows: [] };
        return {
          rows: [
            {
              token_id: record.id,
              user_id: record.user_id,
              family_id: record.family_id,
              revoked_at: record.revoked_at,
              expires_at: record.expires_at,
              id: record.user_id,
              email: 'test@example.com',
              name: 'Test User',
              role: 'creator',
              wallet_public_key: 'GBTESTKEY123',
              wallet_type: 'custodial',
              kyc_status: 'approved',
              kyc_completed_at: new Date(),
              token_version: 0,
            },
          ],
        };
      }
      if (text.includes('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1')) {
        const [tokenHash] = params;
        const record = tokensDb.get(tokenHash);
        if (record) record.revoked_at = new Date();
        return { rows: [] };
      }
      if (text.includes('UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1')) {
        const [familyId] = params;
        for (const record of tokensDb.values()) {
          if (record.family_id === familyId) {
            record.revoked_at = new Date();
          }
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const auth = proxyquire('./auth', {
    '../config/database': overrides.db || mockDb,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../middleware/validation': {
      validateRequest: (req, res, next) => next(),
      validateRequestAsError: (req, res, next) => next(),
      registerValidation: [],
      loginValidation: [],
      forgotPasswordValidation: [],
      resetPasswordValidation: [],
    },
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {},
    },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => false,
    },
    '../services/emailService': {
      sendEmail: async () => {},
      sendEmailSafe: async () => {},
      reserveEmailSend: async () => true,
    },
    '../services/walletSecrets': {
      encryptWalletSecret: async () => 'encrypted-stub',
    },
    ...overrides.modules,
  });

  return { auth, tokensDb, queries };
}

test('refresh token creation assigns a family_id', async () => {
  const { auth, tokensDb } = buildAuthModule();
  const userId = crypto.randomUUID();
  const { token, familyId } = await auth.createRefreshToken(userId);

  assert.ok(token);
  assert.ok(familyId);
  const hash = auth.hashToken(token);
  const stored = tokensDb.get(hash);
  assert.equal(stored.family_id, familyId);
  assert.equal(stored.revoked_at, null);
});

test('single-use rotation revokes previous token and continues family', async () => {
  const { auth, tokensDb } = buildAuthModule();
  const userId = crypto.randomUUID();
  const { token: t1, familyId: f1 } = await auth.createRefreshToken(userId);

  const { token: t2, familyId: f2 } = await auth.rotateRefreshToken(t1, userId, f1);

  assert.equal(f1, f2, 'Rotated token should belong to the same session family');
  const h1 = auth.hashToken(t1);
  const h2 = auth.hashToken(t2);

  assert.ok(tokensDb.get(h1).revoked_at !== null, 'Prior token must be marked revoked');
  assert.equal(tokensDb.get(h2).revoked_at, null, 'New token must be active');
});

test('replay of an already-rotated token revokes all tokens in the family', async () => {
  const { auth, tokensDb } = buildAuthModule();
  const userId = crypto.randomUUID();
  const { token: t1, familyId } = await auth.createRefreshToken(userId);

  // Normal rotation: t1 -> t2
  const { token: t2 } = await auth.rotateRefreshToken(t1, userId, familyId);
  const h2 = auth.hashToken(t2);
  assert.equal(tokensDb.get(h2).revoked_at, null, 't2 is initially active');

  // Attacker replays already-rotated t1
  const validationResult = await auth.validateRefreshToken(t1);
  assert.ok(validationResult);
  assert.equal(validationResult.reuseDetected, true, 'Replay must be flagged');

  // Reuse detection must have revoked t2 as well
  assert.ok(tokensDb.get(h2).revoked_at !== null, 'Active sibling in family must be revoked on replay');
});

// ==========================================================================
// HTTP route integration tests — issue #65
// Covers register, login, refresh, logout, forgot-password, reset-password
// using Supertest + proxyquire so no real DB or Stellar calls are needed.
// ==========================================================================

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

/**
 * Build a minimal Express app wired to the auth router with all heavy
 * dependencies stubbed out.
 *
 * @param {object} opts.users   Array of existing user rows for SELECT queries
 * @param {object} opts.extra   Additional proxyquire module overrides
 */
function buildHttpApp(opts = {}) {
  const { users = [], extra = {} } = opts;

  const tokensDb = new Map();

  const mockDb = {
    query: async (text, params) => {
      // refresh_tokens INSERT
      if (text.includes('INSERT INTO refresh_tokens')) {
        const [userId, tokenHash, expiresAt, familyId] = params;
        const id = crypto.randomUUID();
        tokensDb.set(tokenHash, {
          id, user_id: userId, token_hash: tokenHash,
          expires_at: expiresAt, family_id: familyId, revoked_at: null,
        });
        return { rows: [{ id, family_id: familyId }] };
      }
      // refresh_tokens SELECT (validate)
      if (text.includes('SELECT rt.id AS token_id') && text.includes('FROM refresh_tokens rt')) {
        const [tokenHash] = params;
        const record = tokensDb.get(tokenHash);
        if (!record) return { rows: [] };
        const user = users.find((u) => u.id === record.user_id) || {
          id: record.user_id, email: 'test@example.com', name: 'Test', role: 'contributor',
          wallet_public_key: 'GTEST', wallet_type: 'custodial', kyc_status: 'none', kyc_completed_at: null,
        };
        return {
          rows: [{
            token_id: record.id, user_id: record.user_id, family_id: record.family_id,
            revoked_at: record.revoked_at, expires_at: record.expires_at,
            ...user,
          }],
        };
      }
      // refresh_tokens UPDATE (revoke by hash)
      if (text.includes('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash')) {
        const [tokenHash] = params;
        const record = tokensDb.get(tokenHash);
        if (record) record.revoked_at = new Date();
        return { rows: [] };
      }
      // refresh_tokens UPDATE (revoke by family)
      if (text.includes('UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id')) {
        const [familyId] = params;
        for (const r of tokensDb.values()) {
          if (r.family_id === familyId) r.revoked_at = new Date();
        }
        return { rows: [] };
      }
      // refresh_tokens UPDATE (revoke on password reset)
      if (text.includes('UPDATE refresh_tokens SET revoked_at = NOW()') && text.includes('user_id')) {
        return { rows: [] };
      }
      // users SELECT (login / register duplicate check)
      if (text.includes('SELECT') && text.includes('FROM users WHERE LOWER(email)')) {
        const email = params[0];
        const found = users.filter((u) => (u.email || '').toLowerCase() === email.toLowerCase());
        return { rows: found };
      }
      // users SELECT by id (wallets etc.)
      if (text.includes('SELECT') && text.includes('FROM users WHERE id')) {
        const id = params[0];
        const found = users.filter((u) => u.id === id);
        return { rows: found };
      }
      // users INSERT (register)
      if (text.includes('INSERT INTO users')) {
        const [email, _hash, name, walletKey, , role, walletType] = params;
        const newUser = {
          id: crypto.randomUUID(), email, name,
          wallet_public_key: walletKey, role: role || 'contributor',
          kyc_status: 'none', kyc_completed_at: null, wallet_type: walletType || 'custodial',
        };
        users.push(newUser);
        return { rows: [newUser] };
      }
      // password_reset_tokens INSERT
      if (text.includes('INSERT INTO password_reset_tokens')) {
        return { rows: [] };
      }
      // password_reset_tokens UPDATE (invalidate old)
      if (text.includes('UPDATE password_reset_tokens SET used_at')) {
        return { rows: [] };
      }
      // password_reset_tokens SELECT (reset-password validation)
      if (text.includes('SELECT prt.id, prt.user_id') && text.includes('password_reset_tokens')) {
        // Return a valid token row by default; tests that need an invalid token
        // can pass an empty users array so the UPDATE below finds nothing.
        return { rows: [{ id: 'reset-tok-1', user_id: users[0]?.id || 'uid-1' }] };
      }
      // users UPDATE (set new password)
      if (text.includes('UPDATE users SET password_hash')) {
        return { rows: [] };
      }
      // password_reset_tokens UPDATE (mark used)
      if (text.includes('UPDATE password_reset_tokens SET used_at = NOW() WHERE id')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const router = proxyquire('./auth', {
    '../config/database': mockDb,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../middleware/validation': {
      validateRequest: (req, res, next) => next(),
      validateRequestAsError: (req, res, next) => next(),
      registerValidation: [],
      loginValidation: [],
      forgotPasswordValidation: [],
      resetPasswordValidation: [],
    },
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {},
    },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => false,
    },
    '../services/kycService': {
      isKycRequiredForCampaigns: () => false,
    },
    '../services/emailService': {
      sendEmail: async () => {},
      sendEmailSafe: async () => {},
      reserveEmailSend: async () => true,
    },
    '../services/walletSecrets': {
      encryptWalletSecret: async () => 'encrypted-stub',
    },
    ...extra,
  });

  const app = express();
  app.use(express.json());
  app.use(require('cookie-parser')());
  app.use('/api/auth', router);
  return { app, tokensDb, users };
}

// ---- register ----------------------------------------------------------------

test('POST /api/auth/register creates a user and returns 201 + token', async () => {
  const { app } = buildHttpApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'new@example.com', password: 'pass1234', name: 'Alice' });

  assert.equal(res.status, 201);
  assert.ok(res.body.token, 'access token must be present');
  assert.ok(res.body.user, 'user object must be present');
  assert.equal(res.body.user.email, 'new@example.com');
  assert.equal(res.body.user.role, 'contributor');
});

test('POST /api/auth/register sets a refresh-token cookie', async () => {
  const { app } = buildHttpApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'cookie@example.com', password: 'pass1234', name: 'Bob' });

  assert.equal(res.status, 201);
  const cookies = res.headers['set-cookie'] || [];
  const refreshCookie = cookies.find((c) => c.startsWith('cp_refresh_token='));
  assert.ok(refreshCookie, 'refresh-token cookie must be set after register');
  assert.match(refreshCookie, /Path=\/(;|$)/);
  assert.match(refreshCookie, /SameSite=Strict/);
  assert.match(refreshCookie, /HttpOnly/);
});

test('POST /api/auth/register returns 409 for duplicate email', async () => {
  const existingUsers = [
    { id: 'uid-1', email: 'taken@example.com', password_hash: 'hash', name: 'Existing', role: 'contributor' },
  ];
  const { app } = buildHttpApp({ users: existingUsers });

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'taken@example.com', password: 'pass1234', name: 'NewUser' });

  assert.equal(res.status, 409);
});

test('POST /api/auth/register rejects invalid role', async () => {
  const { app } = buildHttpApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'roletest@example.com', password: 'pass1234', name: 'Test', role: 'admin' });

  assert.equal(res.status, 400);
});

// ---- login -------------------------------------------------------------------

test('POST /api/auth/login returns 200 + token for valid credentials', async () => {
  const passwordHash = await bcrypt.hash('correct-pass', 10);
  const existingUsers = [
    {
      id: 'uid-1', email: 'user@example.com', password_hash: passwordHash,
      name: 'Alice', role: 'contributor', wallet_public_key: 'GTEST',
      wallet_type: 'custodial', kyc_status: 'none', kyc_completed_at: null,
    },
  ];
  const { app } = buildHttpApp({ users: existingUsers });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'correct-pass' });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, 'user@example.com');
});

test('POST /api/auth/login returns 401 for wrong password', async () => {
  const passwordHash = await bcrypt.hash('correct-pass', 10);
  const existingUsers = [
    {
      id: 'uid-1', email: 'user@example.com', password_hash: passwordHash,
      name: 'Alice', role: 'contributor', wallet_public_key: 'GTEST',
      wallet_type: 'custodial', kyc_status: 'none', kyc_completed_at: null,
    },
  ];
  const { app } = buildHttpApp({ users: existingUsers });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'wrong-pass' });

  assert.equal(res.status, 401);
});

function lockoutStub({ allowed = true, lockOnFailure = false } = {}) {
  const calls = [];
  return {
    calls,
    module: {
      checkLoginAllowed: async (db, email) => {
        calls.push(['check', email]);
        return allowed ? { allowed: true } : { allowed: false, reason: 'locked', retryAfterSeconds: 900 };
      },
      recordLoginFailure: async (db, email) => {
        calls.push(['failure', email]);
        return lockOnFailure
          ? { locked: true, failedCount: 5, lockedUntil: new Date(Date.now() + 900_000) }
          : { locked: false, failedCount: 1 };
      },
      recordLoginSuccess: async (db, email) => {
        calls.push(['success', email]);
      },
    },
  };
}

test('POST /api/auth/login rejects a locked account with 429 even with the correct password', async () => {
  const passwordHash = await bcrypt.hash('correct-pass', 10);
  const lockout = lockoutStub({ allowed: false });
  const { app } = buildHttpApp({
    users: [{ id: 'uid-1', email: 'user@example.com', password_hash: passwordHash, role: 'contributor' }],
    extra: { '../services/loginLockout': lockout.module },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'User@Example.com', password: 'correct-pass' });

  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'ACCOUNT_LOCKED');
  assert.equal(res.body.retry_after_seconds, 900);
  assert.equal(res.headers['retry-after'], '900');
  assert.ok(!res.body.token);
  assert.deepEqual(lockout.calls, [['check', 'user@example.com']]);
});

test('POST /api/auth/login records failures and answers 429 when the failure triggers a lock', async () => {
  const passwordHash = await bcrypt.hash('correct-pass', 10);
  const lockout = lockoutStub({ lockOnFailure: true });
  const { app } = buildHttpApp({
    users: [{ id: 'uid-1', email: 'user@example.com', password_hash: passwordHash, role: 'contributor' }],
    extra: { '../services/loginLockout': lockout.module },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'wrong-pass' });

  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'ACCOUNT_LOCKED');
  assert.deepEqual(lockout.calls.map((c) => c[0]), ['check', 'failure']);
});

test('POST /api/auth/login clears the failure state on success', async () => {
  const passwordHash = await bcrypt.hash('correct-pass', 10);
  const lockout = lockoutStub();
  const { app } = buildHttpApp({
    users: [{ id: 'uid-1', email: 'user@example.com', password_hash: passwordHash, role: 'contributor' }],
    extra: { '../services/loginLockout': lockout.module },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'correct-pass' });

  assert.equal(res.status, 200);
  assert.deepEqual(lockout.calls.map((c) => c[0]), ['check', 'success']);
});

test('POST /api/auth/login returns 401 for unknown email', async () => {
  const { app } = buildHttpApp({ users: [] });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'nobody@example.com', password: 'pass' });

  assert.equal(res.status, 401);
});

// ---- refresh -----------------------------------------------------------------

test('POST /api/auth/refresh issues new tokens from a valid refresh cookie', async () => {
  const { app, tokensDb } = buildHttpApp();

  // Register to get a valid refresh token cookie
  const regRes = await request(app)
    .post('/api/auth/register')
    .send({ email: 'refresh@example.com', password: 'pass1234', name: 'Refresh' });
  assert.equal(regRes.status, 201);

  const cookies = regRes.headers['set-cookie'];
  const res = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', cookies);

  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.user, 'user must be present');
});

test('POST /api/auth/refresh returns 401 when no cookie is present', async () => {
  const { app } = buildHttpApp();

  const res = await request(app).post('/api/auth/refresh');
  assert.equal(res.status, 401);
});

test('POST /api/auth/refresh returns 401 for an invalid token', async () => {
  const { app } = buildHttpApp();

  const res = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', ['cp_refresh_token=totally-invalid-token']);

  assert.equal(res.status, 401);
});

// ---- logout ------------------------------------------------------------------

test('POST /api/auth/logout clears cookies and returns ok:true', async () => {
  const { app } = buildHttpApp();

  const regRes = await request(app)
    .post('/api/auth/register')
    .send({ email: 'logout@example.com', password: 'pass1234', name: 'Logout' });
  assert.equal(regRes.status, 201);

  const cookies = regRes.headers['set-cookie'];
  const res = await request(app)
    .post('/api/auth/logout')
    .set('Cookie', cookies);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // Refresh token cookie must be cleared (maxAge=0 or expires in the past)
  const setCookies = res.headers['set-cookie'] || [];
  const refreshCookie = setCookies.find((c) => c.startsWith('cp_refresh_token='));
  assert.ok(refreshCookie, 'a set-cookie for the refresh token must be present to clear it');
  assert.ok(
    refreshCookie.includes('Max-Age=0') ||
    refreshCookie.includes('Expires=Thu, 01 Jan 1970'),
    'refresh-token cookie must be expired/cleared on logout'
  );
});

test('POST /api/auth/logout succeeds even without a cookie (idempotent)', async () => {
  const { app } = buildHttpApp();
  const res = await request(app).post('/api/auth/logout');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// ---- forgot-password ---------------------------------------------------------

test('POST /api/auth/forgot-password always returns the generic message', async () => {
  const { app } = buildHttpApp({ users: [] });

  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'anyone@example.com' });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.message === 'string');
  // Must not reveal whether the email exists
  assert.ok(!res.body.message.toLowerCase().includes('not found'));
});

test('POST /api/auth/forgot-password returns the same response for known and unknown emails (no oracle)', async () => {
  const existingUsers = [{ id: 'uid-1', email: 'known@example.com', password_hash: 'hash', name: 'Known', role: 'contributor' }];
  const { app } = buildHttpApp({ users: existingUsers });

  const knownRes = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'known@example.com' });
  const unknownRes = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'unknown@example.com' });

  assert.equal(knownRes.status, 200);
  assert.equal(unknownRes.status, 200);
  assert.equal(knownRes.body.message, unknownRes.body.message, 'Response must be identical to prevent email enumeration');
});

// ---- reset-password ----------------------------------------------------------

test('POST /api/auth/reset-password accepts a valid token and returns 200', async () => {
  const existingUsers = [{ id: 'uid-1', email: 'reset@example.com', password_hash: 'hash', name: 'Reset', role: 'contributor' }];
  const { app } = buildHttpApp({ users: existingUsers });

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: 'any-token', password: 'newpassword123' });

  // The mock DB always returns a valid reset token row, so this should succeed.
  assert.equal(res.status, 200);
  assert.ok(res.body.message);
});

test('POST /api/auth/reset-password returns 400 for an invalid/expired token', async () => {
  // Override query to return no rows for the password_reset_tokens SELECT.
  const noTokenDb = {
    query: async (text) => {
      if (text.includes('SELECT prt.id, prt.user_id') && text.includes('password_reset_tokens')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const { app } = buildHttpApp({
    extra: { '../config/database': noTokenDb },
  });

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: 'expired-or-invalid', password: 'newpass' });

  assert.equal(res.status, 400);
});

// ---- role enforcement --------------------------------------------------------

test('POST /api/auth/register accepts creator role', async () => {
  const { app } = buildHttpApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'creator@example.com', password: 'pass1234', name: 'Creator', role: 'creator' });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'creator');
});
