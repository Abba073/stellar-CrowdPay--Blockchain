const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, stellarImpl, sendEmailImpl, bcryptImpl } = {}) {
  const stellarStub = {
    ensureCustodialAccountFundedAndTrusted: async () => {},
    ...stellarImpl,
  };
  const sendEmail = sendEmailImpl || (() => {});
  const bcryptStub = {
    hash: async () => 'hashed',
    compare: async () => false,
    ...bcryptImpl,
  };

  const router = proxyquire('./auth', {
    '@stellar/stellar-sdk': {
      Keypair: {
        random: () => ({
          publicKey: () => 'GUSER',
          secret: () => 'SA3D5Z7Z7PLQANRPW6VYJEXAMPLE7WBZIY2ORP2X5Z5D4GS6Q27Q2H',
        }),
      },
    },
    '../config/database': { query: queryImpl },
    '../services/stellarService': stellarStub,
    '../services/walletSecrets': {
      encryptWalletSecret: async (secret) => `cpws:v1:${secret.slice(0, 8)}`,
    },
    '../services/emailService': { sendEmail, reserveEmailSend: async () => true },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => false,
    },
    '../middleware/auth': {
      requireAuth: (_req, _res, next) => next(),
    },
    jsonwebtoken: {
      sign: () => 'jwt-token',
    },
    bcryptjs: bcryptStub,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  return { app, sendEmail };
}

test('POST /api/auth/register encrypts wallet secret before insert and schedules funding', async () => {
  let ensureCalled = false;
  let insertedSecret = null;
  const { app } = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id FROM users WHERE email')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO users')) {
        insertedSecret = params[4];
        return {
          rows: [
            {
              id: 'user-new',
              email: 'user@example.com',
              name: 'N',
              wallet_public_key: 'GUSER',
              role: 'contributor',
            },
          ],
        };
      }
      if (text.includes('INSERT INTO refresh_tokens')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      ensureCustodialAccountFundedAndTrusted: async ({ publicKey, secret }) => {
        assert.equal(publicKey, 'GUSER');
        assert.equal(secret, 'SA3D5Z7Z7PLQANRPW6VYJEXAMPLE7WBZIY2ORP2X5Z5D4GS6Q27Q2H');
        ensureCalled = true;
      },
    },
  });

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'user@example.com', password: 'Longpassword1', name: 'N' });

  assert.equal(res.status, 201);
  assert.equal(res.body.token, 'jwt-token');
  assert.notEqual(insertedSecret, 'SA3D5Z7Z7PLQANRPW6VYJEXAMPLE7WBZIY2ORP2X5Z5D4GS6Q27Q2H');
  assert.match(insertedSecret, /^cpws:v1:/);

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensureCalled, true);
});

test('POST /api/auth/register returns 400 with validation errors for invalid input', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'not-an-email', password: 'short', name: '' });

  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.ok(res.body.errors.length >= 1);
});

test('POST /api/auth/login returns 400 with validation errors for invalid email', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'bad-email', password: '' });

  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('POST /api/auth/forgot-password returns generic message for unknown email', async () => {
  let insertResetToken = false;
  let emailSent = false;
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM users WHERE LOWER(email)')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO password_reset_tokens')) {
        insertResetToken = true;
      }
      return { rows: [] };
    },
    sendEmailImpl: () => {
      emailSent = true;
    },
  });

  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'missing@example.com' });

  assert.equal(res.status, 200);
  assert.equal(
    res.body.message,
    'If that email exists, a password reset link has been sent.'
  );
  assert.equal(insertResetToken, false);
  assert.equal(emailSent, false);
});

test('POST /api/auth/forgot-password creates token and sends email for known user', async () => {
  let insertResetToken = false;
  let emailPayload = null;
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM users WHERE LOWER(email)')) {
        return { rows: [{ id: 'user-1', email: 'user@example.com' }] };
      }
      if (text.includes('INSERT INTO password_reset_tokens')) {
        insertResetToken = true;
      }
      return { rows: [] };
    },
    sendEmailImpl: (payload) => {
      emailPayload = payload;
    },
  });

  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'user@example.com' });

  assert.equal(res.status, 200);
  assert.equal(insertResetToken, true);
  assert.ok(emailPayload);
  assert.match(emailPayload.text, /reset-password\?token=/);
});

test('POST /api/auth/reset-password updates password and revokes refresh tokens', async () => {
  let updatedPassword = false;
  let markedUsed = false;
  let revokedRefresh = false;
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM password_reset_tokens prt')) {
        return { rows: [{ id: 'prt-1', user_id: 'user-1' }] };
      }
      if (text.includes('UPDATE users SET password_hash')) {
        updatedPassword = true;
      }
      if (text.includes('UPDATE password_reset_tokens SET used_at')) {
        markedUsed = true;
      }
      if (text.includes('UPDATE refresh_tokens SET revoked_at')) {
        revokedRefresh = true;
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: 'raw-reset-token', password: 'Newpassword1' });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /Password reset successfully/);
  assert.equal(updatedPassword, true);
  assert.equal(markedUsed, true);
  assert.equal(revokedRefresh, true);
});

test('POST /api/auth/reset-password returns 400 for invalid or expired token', async () => {
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM password_reset_tokens prt')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: 'bad-token', password: 'Newpassword1' });

  assert.equal(res.status, 400);
  assert.equal(
    res.body.error.message,
    'Invalid or expired reset link. Please request a new one.'
  );
});

test('POST /api/auth/login rejects old password after reset', async () => {
  const { app } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT * FROM users WHERE LOWER(email)')) {
        return {
          rows: [
            {
              id: 'user-1',
              email: 'user@example.com',
              password_hash: 'hashed-new',
              name: 'User',
              wallet_public_key: 'GUSER',
              role: 'contributor',
              kyc_status: 'unverified',
            },
          ],
        };
      }
      return { rows: [] };
    },
    bcryptImpl: {
      hash: async () => 'hashed-new',
      compare: async (plain, hash) => plain === 'Newpassword1' && hash === 'hashed-new',
    },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'Oldpassword1' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Invalid credentials');
});
