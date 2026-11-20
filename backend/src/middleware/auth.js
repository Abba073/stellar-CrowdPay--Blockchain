const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/database');
const Sentry = require('@sentry/node');
const { sendErrorResponse } = require('./errorHandler');

function apiKeyPepper() {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) {
    // This should never be reached in production because validateEnv() in
    // config/env.js fails the process at startup when API_KEY_PEPPER is unset.
    // In tests the value is injected via the test environment.
    throw new Error(
      'API_KEY_PEPPER environment variable is required. ' +
      'Set a dedicated secret independent of JWT_SECRET to prevent credential cross-contamination.'
    );
  }
  return pepper;
}

function hashApiKey(rawKey) {
  return crypto.createHmac('sha256', apiKeyPepper()).update(rawKey, 'utf8').digest('hex');
}

async function authenticate(req) {
  const header = req.headers.authorization;
  const token = req.cookies?.cp_token || (header && header.startsWith('Bearer ') ? header.slice(7).trim() : null);
  if (!token) throw new Error('Missing token');

  if (token.startsWith('cp_live_')) {
    const keyHash = hashApiKey(token);
    const { rows } = await db.query(
      `SELECT id, user_id, scopes FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
      [keyHash]
    );
    if (!rows.length) throw new Error('Invalid API key');
    await db.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [rows[0].id]);
    req.user = { userId: rows[0].user_id };
    req.auth = { kind: 'api_key', apiKeyId: rows[0].id, scopes: rows[0].scopes || [] };
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    req.auth = { kind: 'jwt', scopes: null };
    
    // Load admin status and validate token_version from database
    if (req.user.userId) {
      const { rows } = await db.query(
        'SELECT role, is_admin, is_super_admin, is_banned, token_version FROM users WHERE id = $1',
        [req.user.userId]
      );
      if (rows.length) {
        req.user.role = rows[0].role;
        req.user.is_admin = rows[0].is_admin;
        req.user.is_super_admin = rows[0].is_super_admin;
        req.user.is_banned = rows[0].is_banned;

        // Reject access tokens issued before the last password reset
        const dbVersion = rows[0].token_version ?? 0;
        const tokenVersion = payload.tv ?? 0;
        if (tokenVersion < dbVersion) {
          throw new Error('Token invalidated by password reset');
        }
      }
    }
  } catch {
    throw new Error('Invalid token');
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return sendErrorResponse(res, 403, 'Requires admin privileges');
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || !req.user.is_super_admin) {
    return sendErrorResponse(res, 403, 'Requires super-admin privileges');
  }
  next();
}

function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return sendErrorResponse(res, 403, 'Requires authenticated user role');
    }
    if (!allowed.has(req.user.role)) {
      return sendErrorResponse(res, 403, 'Insufficient role for this action');
    }
    next();
  };
}

/**
 * API keys carry scope arrays. JWT sessions retain full access.
 * @returns {boolean} false if response was sent (403)
 */
function assertApiKeyScopes(req, res) {
  if (!req.auth || req.auth.kind !== 'api_key') return true;
  const scopes = req.auth.scopes || [];
  if (scopes.includes('full')) return true;

  const path = req.originalUrl.split('?')[0];
  const method = req.method;

  if (path.startsWith('/api/api-keys') || path.startsWith('/api/webhooks')) {
    if (!scopes.includes('developer')) {
      sendErrorResponse(res, 403, 'API key requires developer scope for this resource');
      return false;
    }
    return true;
  }

  if (path.startsWith('/api/withdrawals')) {
    if (method === 'GET') {
      if (!scopes.includes('read')) {
        sendErrorResponse(res, 403, 'API key requires read scope');
        return false;
      }
      return true;
    }
    if (!scopes.includes('withdrawals')) {
      sendErrorResponse(res, 403, 'API key requires withdrawals scope for withdrawal actions');
      return false;
    }
    return true;
  }

  if (method === 'GET' || method === 'HEAD') {
    if (!scopes.includes('read')) {
      sendErrorResponse(res, 403, 'API key requires read scope');
      return false;
    }
    return true;
  }

  if (!scopes.includes('write')) {
    sendErrorResponse(res, 403, 'API key requires write scope');
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  authenticate(req)
    .then(() => {
      // #15 — Enforce the banned flag. is_banned is re-read from DB in
      // authenticate() so bans take effect immediately on every request.
      // Admins are exempt so that platform staff can still access the system
      // to investigate and manage banned accounts.
      if (req.user?.is_banned && !req.user?.is_admin) {
        return sendErrorResponse(res, 403, 'Your account has been suspended');
      }
      if (!assertApiKeyScopes(req, res)) return;
      if (req.user?.userId) Sentry.setUser({ id: req.user.userId });
      next();
    })
    .catch((err) => {
      const msg = err.message === 'Missing token' ? err.message : 'Unauthorized';
      sendErrorResponse(res, 401, msg);
    });
}

/**
 * Middleware that attempts authentication but does not reject unauthenticated requests.
 * Sets req.user if a valid token is present; leaves req.user undefined otherwise.
 */
function optionalAuth(req, res, next) {
  authenticate(req)
    .then(() => {
      next();
    })
    .catch(() => {
      // No token or invalid token — continue as anonymous
      next();
    });
}

module.exports = {
  requireAuth,
  optionalAuth,
  authenticate,
  assertApiKeyScopes,
  hashApiKey,
  requireAdmin,
  requireSuperAdmin,
  requireRole,
};
