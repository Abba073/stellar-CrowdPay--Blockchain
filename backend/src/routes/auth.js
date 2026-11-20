const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { ensureCustodialAccountFundedAndTrusted } = require('../services/stellarService');
const { sendEmail, sendEmailSafe, reserveEmailSend } = require('../services/emailService');
const { requireAuth } = require('../middleware/auth');
const { encryptWalletSecret } = require('../services/walletSecrets');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const loginLockout = require('../services/loginLockout');
const {
  registerValidation,
  loginValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  validateRequest,
  validateRequestAsError,
} = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');
const { sendErrorResponse } = require('../middleware/errorHandler');

/**
 * @openapi
 * tags:
 *   - name: Users
 *     description: User registration and login
 */

const ACCESS_TOKEN_COOKIE_NAME = 'cp_token';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// __Host- binds the cookie to this exact host (no Domain, Path=/, Secure), blocking
// subdomain cookie tossing. Browsers only accept it over HTTPS, so it is production-only.
const REFRESH_TOKEN_COOKIE_NAME = IS_PRODUCTION ? '__Host-cp_refresh' : 'cp_refresh_token';
const REFRESH_TOKEN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_EMAIL_COOLDOWN_MS = 5 * 60 * 1000;
const FORGOT_PASSWORD_MESSAGE =
  'If that email exists, a password reset link has been sent.';

function parseJwtExpiresIn(value) {
  const match = String(value).match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return num;
  if (unit === 'm') return num * 60;
  if (unit === 'h') return num * 60 * 60;
  if (unit === 'd') return num * 24 * 60 * 60;
  return 15 * 60;
}

function setAccessTokenCookie(res, token) {
  res.cookie(ACCESS_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: parseJwtExpiresIn(process.env.JWT_EXPIRES_IN || '15m') * 1000,
  });
}

function clearAccessTokenCookie(res) {
  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
}

const isTest = process.env.NODE_ENV === 'test';
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTest ? 100000 : 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100000 : 20,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

/** 429 for a locked (or hourly-capped) account; same response whether or not it exists. */
function sendAccountLocked(res, retryAfterSeconds) {
  res.set('Retry-After', String(retryAfterSeconds));
  return sendErrorResponse(
    res,
    429,
    'Too many failed login attempts for this account. Try again later.',
    undefined,
    'ACCOUNT_LOCKED',
    { retry_after_seconds: retryAfterSeconds }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function generateTokens(user) {
  const accessToken = jwt.sign(
    { userId: user.id, role: user.role, tv: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = crypto.randomBytes(32).toString('hex');
  return { accessToken, refreshToken };
}

function setRefreshTokenCookie(res, token, expiresAt) {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/',
    maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE,
    expires: expiresAt,
  });
}

function clearRefreshTokenCookie(res) {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  });
}

async function createRefreshToken(userId, familyId = null) {
  const expiresInSeconds = parseRefreshExpiresIn(process.env.REFRESH_TOKEN_EXPIRES_IN || '7d');
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const resolvedFamilyId = familyId || crypto.randomUUID();
  try {
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id, token_version)
       SELECT $1, $2, $3, $4, COALESCE(token_version, 0) FROM users WHERE id = $1`,
      [userId, tokenHash, expiresAt, resolvedFamilyId]
    );
  } catch {
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id) VALUES ($1, $2, $3, $4)`,
      [userId, tokenHash, expiresAt, resolvedFamilyId]
    );
  }
  return { token, expiresAt, familyId: resolvedFamilyId };
}

function parseRefreshExpiresIn(value) {
  const match = value.match(/^(\d+)([dh])$/);
  if (!match) return 7 * 24 * 60 * 60;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return num * 60 * 60;
  return num * 24 * 60 * 60;
}

async function validateRefreshToken(token) {
  const tokenHash = hashToken(token);
  let rows;
  try {
    const res = await db.query(
      `SELECT rt.id AS token_id, rt.user_id, rt.family_id, rt.revoked_at, rt.expires_at, rt.token_version AS rt_token_version,
              u.id AS id, u.email, u.name, u.role, u.wallet_public_key, u.wallet_type,
              u.kyc_status, u.kyc_completed_at, u.token_version
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );
    rows = res.rows;
  } catch {
    const res = await db.query(
      `SELECT rt.id AS token_id, rt.user_id, rt.family_id, rt.revoked_at, rt.expires_at,
              u.id AS id, u.email, u.name, u.role, u.wallet_public_key, u.wallet_type,
              u.kyc_status, u.kyc_completed_at, u.token_version
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );
    rows = res.rows;
  }
  if (!rows.length) return null;
  const rt = rows[0];

  if (rt.revoked_at) {
    logger.warn('Refresh token reuse detected, revoking session family', {
      user_id: rt.user_id,
      family_id: rt.family_id,
      token_id: rt.token_id,
    });
    if (rt.family_id) {
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL`,
        [rt.family_id]
      );
    } else {
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [rt.user_id]
      );
    }
    return { reuseDetected: true, user_id: rt.user_id, family_id: rt.family_id };
  }

  // Reject refresh tokens invalidated by password reset (stale token_version)
  if (rt.rt_token_version !== undefined && rt.rt_token_version !== null) {
    if (rt.rt_token_version < (rt.token_version ?? 0)) {
      logger.warn('Refresh token invalidated by password reset', {
        user_id: rt.user_id,
        family_id: rt.family_id,
      });
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`,
        [rt.token_id]
      );
      return null;
    }
  }

  if (new Date(rt.expires_at) <= new Date()) {
    return null;
  }

  return rt;
}

async function revokeRefreshToken(token) {
  const tokenHash = hashToken(token);
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
    [tokenHash]
  );
}

async function rotateRefreshToken(oldToken, userId, familyId = null) {
  await revokeRefreshToken(oldToken);
  return createRefreshToken(userId, familyId);
}

router.post('/register', registerLimiter, registerValidation, validateRequest, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/auth/register:
   *   post:
   *     tags: [Users]
   *     summary: Register a new user
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password, name]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string, minLength: 6 }
   *               name: { type: string }
   *               role: { type: string, enum: [contributor, creator] }
   *     responses:
   *       201:
   *         description: Created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [token, user]
   *               properties:
   *                 token: { type: string }
   *                 user:
   *                   type: object
   *                   properties:
   *                     id: { type: integer }
   *                     email: { type: string, format: email }
   *                     name: { type: string }
   *                     wallet_public_key: { type: string }
   *                     role: { type: string }
   *                     kyc_status: { type: string }
   *                     kyc_completed_at: { type: string, nullable: true }
   *                     kyc_required_for_campaigns: { type: boolean }
   *       409:
   *         description: Email already registered
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error: { type: string }
   */
  const { email, password, name, role } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedName = String(name || '').trim();
  const allowedRoles = new Set(['contributor', 'creator']);
  const userRole = role || 'contributor';
  if (!allowedRoles.has(userRole)) {
    return sendErrorResponse(res, 400, 'role must be contributor or creator');
  }

  const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
  if (existing.rows.length > 0) {
    return sendErrorResponse(res, 409, 'Email already registered');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // Support freighter (non-custodial) registration where frontend provides wallet_public_key
  let publicKey;
  let encryptedSecret = null;
  let secret = null;
  const walletType = req.body.wallet_type || 'custodial';

  if (walletType === 'freighter') {
    publicKey = req.body.wallet_public_key;
    try {
      Keypair.fromPublicKey(publicKey);
    } catch (_err) {
      return sendErrorResponse(res, 400, 'A valid wallet_public_key is required for Freighter registration');
    }
    encryptedSecret = null;
  } else {
    const keypair = Keypair.random();
    publicKey = keypair.publicKey();
    secret = keypair.secret();
    encryptedSecret = await encryptWalletSecret(secret, { walletPublicKey: publicKey });
  }

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted, role, wallet_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at, wallet_type`,
    [normalizedEmail, passwordHash, normalizedName, publicKey, encryptedSecret, userRole, walletType]
  );

  const user = {
    ...rows[0],
    kyc_required_for_campaigns: isKycRequiredForCampaigns(),
  };
  const { accessToken } = generateTokens(user);
  const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

  setRefreshTokenCookie(res, refreshToken, expiresAt);
  setAccessTokenCookie(res, accessToken);

  // Generate email verification token
  const verificationToken = crypto.randomBytes(32).toString('hex');
  await db.query(
    `UPDATE users SET verification_token = $1, verification_sent_at = NOW()
     WHERE id = $2`,
    [verificationToken, user.id]
  );

  const requestId = req.id;
  const verifyUrl = `${getFrontendUrl()}/verify-email?token=${verificationToken}`;
  setImmediate(() => {
    // Only fund and setup trustlines for custodial wallets
    if (walletType === 'custodial' && secret) {
      ensureCustodialAccountFundedAndTrusted({ publicKey, secret }).catch((err) => {
        logger.error('Background Stellar funding/trustlines failed', {
          request_id: requestId,
          error: err.message,
        });
      });
    }

    sendEmailSafe({
      to: normalizedEmail,
      subject: 'Verify your CrowdPay email address',
      text: `Welcome to CrowdPay, ${normalizedName}!\n\nPlease verify your email address by opening this link:\n\n${verifyUrl}\n\nThis link is valid for 24 hours.\n\nIf you did not create this account, you can ignore this email.`,
      html: `<p>Welcome to CrowdPay, ${normalizedName}!</p><p>Please <a href="${verifyUrl}">verify your email address</a> to unlock all features (creating campaigns, withdrawals, etc.).</p><p>This link is valid for 24 hours.</p><p>If you did not create this account, you can ignore this email.</p>`,
    }).catch((err) => {
      logger.error('Verification email send failed', { request_id: requestId, error: err.message });
    });
  });

  res.status(201).json({ token: accessToken, user });
}));

router.post('/login', loginLimiter, loginValidation, validateRequest, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/auth/login:
   *   post:
   *     tags: [Users]
   *     summary: Login
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [token, user]
   *               properties:
   *                 token: { type: string }
   *                 user:
   *                   type: object
   *                   properties:
   *                     id: { type: integer }
   *                     email: { type: string, format: email }
   *                     name: { type: string }
   *                     wallet_public_key: { type: string }
   *                     role: { type: string }
   *                     kyc_status: { type: string }
   *                     kyc_completed_at: { type: string, nullable: true }
   *                     kyc_required_for_campaigns: { type: boolean }
   *       401:
   *         description: Invalid credentials
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error: { type: string }
   */
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  // Per-account protection, checked before any password comparison: a locked
  // email is rejected even with the correct password.
  const gate = await loginLockout.checkLoginAllowed(db, normalizedEmail, { ip: req.ip });
  if (!gate.allowed) {
    return sendAccountLocked(res, gate.retryAfterSeconds);
  }

  const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);

  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    const failure = await loginLockout.recordLoginFailure(db, normalizedEmail, {
      userId: rows[0]?.id ?? null,
      ip: req.ip,
    });
    if (failure.locked) {
      return sendAccountLocked(res, Math.ceil((failure.lockedUntil - Date.now()) / 1000));
    }
    return sendErrorResponse(res, 401, 'Invalid credentials');
  }

  await loginLockout.recordLoginSuccess(db, normalizedEmail, { userId: rows[0].id, ip: req.ip });

  const user = rows[0];
  const { accessToken } = generateTokens(user);
  const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

  setRefreshTokenCookie(res, refreshToken, expiresAt);
  setAccessTokenCookie(res, accessToken);

  res.json({
    token: accessToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      wallet_public_key: user.wallet_public_key,
      wallet_type: user.wallet_type || 'custodial',
      role: user.role,
      kyc_status: user.kyc_status,
      kyc_completed_at: user.kyc_completed_at,
      kyc_required_for_campaigns: isKycRequiredForCampaigns(),
    },
  });
}));

/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [Users]
 *     summary: Rotate the refresh token and issue a new access token
 *     description: >
 *       Reads the refresh token from the `cp_refresh_token` httpOnly cookie,
 *       revokes it, and issues a new access token plus a rotated refresh token
 *       in the same session family. Reuse of an already-revoked refresh token
 *       revokes the entire session family and clears both auth cookies.
 *     responses:
 *       200:
 *         description: Tokens rotated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     email: { type: string, format: email }
 *                     name: { type: string }
 *                     wallet_public_key: { type: string }
 *                     wallet_type: { type: string, enum: [custodial, freighter] }
 *                     role: { type: string }
 *                     kyc_status: { type: string }
 *                     kyc_completed_at: { type: string, nullable: true }
 *                     kyc_required_for_campaigns: { type: boolean }
 *       401:
 *         description: Missing, invalid, expired, or reused refresh token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 */
router.post('/refresh', asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
  if (!token) {
    return sendErrorResponse(res, 401, 'No refresh token provided');
  }

  const user = await validateRefreshToken(token);
  if (!user || user.reuseDetected) {
    clearRefreshTokenCookie(res);
    clearAccessTokenCookie(res);
    return sendErrorResponse(res, 401, user?.reuseDetected
        ? 'Refresh token reuse detected; session revoked'
        : 'Invalid or expired refresh token');
  }

  const { accessToken } = generateTokens(user);
  const { token: newRefreshToken, expiresAt } = await rotateRefreshToken(token, user.id, user.family_id);

  setRefreshTokenCookie(res, newRefreshToken, expiresAt);
  setAccessTokenCookie(res, accessToken);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      wallet_public_key: user.wallet_public_key,
      wallet_type: user.wallet_type || 'custodial',
      role: user.role,
      kyc_status: user.kyc_status,
      kyc_completed_at: user.kyc_completed_at,
      kyc_required_for_campaigns: isKycRequiredForCampaigns(),
    },
  });
}));

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [Users]
 *     summary: Log out and revoke the current refresh token
 *     description: >
 *       Revokes the refresh token supplied in the `cp_refresh_token` cookie and
 *       clears both the refresh and access token cookies. Safe to call without
 *       an active session.
 *     responses:
 *       200:
 *         description: Logged out
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 */
router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
  if (token) {
    await revokeRefreshToken(token);
  }
  clearRefreshTokenCookie(res);
  clearAccessTokenCookie(res);
  res.json({ ok: true });
}));

// Email verification TTL: 24 hours
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between resend attempts

const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTest ? 100000 : 5,
  message: { error: 'Too many verification requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

/**
 * @openapi
 * /api/auth/verify-email:
 *   post:
 *     tags: [Users]
 *     summary: Verify email address using the token sent at registration
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200: { description: Email verified }
 *       400: { description: Invalid or expired token }
 */
router.post('/verify-email', async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return sendErrorResponse(res, 400, 'Verification token is required');
  }

  const { rows } = await db.query(
    `SELECT id, email_verified, verification_sent_at
     FROM users
     WHERE verification_token = $1`,
    [token]
  );

  if (!rows.length) {
    return sendErrorResponse(res, 400, 'Invalid or expired verification link.');
  }

  const user = rows[0];

  if (user.email_verified) {
    return res.json({ message: 'Email already verified.' });
  }

  const sentAt = user.verification_sent_at ? new Date(user.verification_sent_at) : null;
  if (!sentAt || Date.now() - sentAt.getTime() > EMAIL_VERIFICATION_TTL_MS) {
    return sendErrorResponse(res, 400, 'Verification link has expired. Please request a new one.', undefined, 'VERIFICATION_EXPIRED');
  }

  await db.query(
    `UPDATE users
     SET email_verified = true,
         verification_token = NULL,
         verification_sent_at = NULL
     WHERE id = $1`,
    [user.id]
  );

  res.json({ message: 'Email verified successfully. You can now create campaigns.' });
});

/**
 * @openapi
 * /api/auth/resend-verification:
 *   post:
 *     tags: [Users]
 *     summary: Resend the email verification link
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Verification email sent }
 *       400: { description: Email already verified or cooldown active }
 *       401: { description: Unauthorized }
 */
router.post('/resend-verification', resendVerificationLimiter, requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, email_verified, verification_sent_at
     FROM users
     WHERE id = $1`,
    [req.user.userId]
  );

  if (!rows.length) {
    return sendErrorResponse(res, 404, 'User not found');
  }

  const user = rows[0];

  if (user.email_verified) {
    return sendErrorResponse(res, 400, 'Email is already verified.');
  }

  // Enforce cooldown to prevent spam
  const lastSent = user.verification_sent_at ? new Date(user.verification_sent_at) : null;
  if (lastSent && Date.now() - lastSent.getTime() < RESEND_COOLDOWN_MS) {
    return sendErrorResponse(res, 429, 'Please wait before requesting another verification email.', undefined, undefined, { retry_after_ms: RESEND_COOLDOWN_MS - (Date.now() - lastSent.getTime()) });
  }

  if (!(await reserveEmailSend(user.email, 'email_verification', RESEND_COOLDOWN_MS))) {
    return sendErrorResponse(res, 429, 'Please wait before requesting another verification email.');
  }

  const verificationToken = crypto.randomBytes(32).toString('hex');
  await db.query(
    `UPDATE users
     SET verification_token = $1,
         verification_sent_at = NOW(),
         verification_attempts_count = COALESCE(verification_attempts_count, 0) + 1,
         last_verification_attempt_at = NOW()
     WHERE id = $2`,
    [verificationToken, user.id]
  );

  const verifyUrl = `${getFrontendUrl()}/verify-email?token=${verificationToken}`;
  Promise.resolve(sendEmail({
    to: user.email,
    subject: 'Verify your CrowdPay email address',
    text: `Hi ${user.name},\n\nHere is your new verification link:\n\n${verifyUrl}\n\nThis link is valid for 24 hours.`,
    html: `<p>Hi ${user.name},</p><p>Please <a href="${verifyUrl}">verify your email address</a>. This link is valid for 24 hours.</p>`,
  })).catch((err) => {
    logger.error('Resend verification email failed', { user_id: user.id, error: err.message });
  });

  res.json({ message: 'Verification email sent. Please check your inbox.' });
});

/**
 * @openapi
 * /api/auth/forgot-password:
 *   post:
 *     tags: [Users]
 *     summary: Request a password reset link
 *     description: >
 *       Always responds with the same generic message so the endpoint cannot be
 *       used to enumerate registered email addresses. When the email exists, a
 *       reset link valid for 1 hour is sent and any previous unused reset
 *       tokens are invalidated.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Generic confirmation message
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *       429:
 *         description: Too many requests
 */
router.post(
  '/forgot-password',
  loginLimiter,
  forgotPasswordValidation,
  validateRequestAsError,
  asyncHandler(async (req, res) => {
    const normalizedEmail = req.body.email.trim().toLowerCase();

    const { rows } = await db.query(
      'SELECT id, email FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );

    // Silently skip (same response) when the account is in cooldown or the address is suppressed.
    if (rows.length && await reserveEmailSend(rows[0].email, 'password_reset', PASSWORD_RESET_EMAIL_COOLDOWN_MS)) {
      const user = rows[0];
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

      await db.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );
      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${getFrontendUrl()}/reset-password?token=${rawToken}`;
      sendEmailSafe({
        to: user.email,
        subject: 'Reset your CrowdPay password',
        text: `You requested a password reset. Open this link within 1 hour to choose a new password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>You requested a password reset. <a href="${resetUrl}">Reset your password</a> within 1 hour.</p><p>If you did not request this, you can ignore this email.</p>`,
      });
    }

    res.json({ message: FORGOT_PASSWORD_MESSAGE });
  }));

/**
 * @openapi
 * /api/auth/reset-password:
 *   post:
 *     tags: [Users]
 *     summary: Reset a password using a reset token
 *     description: >
 *       Consumes a single-use reset token, updates the password, bumps the
 *       user's token version, and revokes all active refresh tokens so every
 *       existing session is invalidated.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token: { type: string }
 *               password: { type: string, minLength: 6 }
 *     responses:
 *       200:
 *         description: Password reset successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: Invalid or expired reset link, or validation error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *       429:
 *         description: Too many requests
 */
router.post(
  '/reset-password',
  loginLimiter,
  resetPasswordValidation,
  validateRequestAsError,
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    const tokenHash = hashToken(token);

    const { rows } = await db.query(
      `SELECT prt.id, prt.user_id
       FROM password_reset_tokens prt
       WHERE prt.token_hash = $1
         AND prt.used_at IS NULL
         AND prt.expires_at > NOW()`,
      [tokenHash]
    );

    if (!rows.length) {
      return sendErrorResponse(res, 400, 'Invalid or expired reset link. Please request a new one.');
    }

    const resetToken = rows[0];
    const passwordHash = await bcrypt.hash(password, 10);

    await db.query(
      'UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2',
      [passwordHash, resetToken.user_id]
    );
    await db.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
      [resetToken.id]
    );
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [resetToken.user_id]
    );

    res.json({ message: 'Password reset successfully. All existing sessions have been invalidated.' });
  })
);

module.exports = router;
module.exports.createRefreshToken = createRefreshToken;
module.exports.validateRefreshToken = validateRefreshToken;
module.exports.revokeRefreshToken = revokeRefreshToken;
module.exports.rotateRefreshToken = rotateRefreshToken;
module.exports.hashToken = hashToken;
module.exports.REFRESH_TOKEN_COOKIE_NAME = REFRESH_TOKEN_COOKIE_NAME;
