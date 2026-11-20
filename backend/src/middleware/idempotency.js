const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { sendErrorResponse } = require('./errorHandler');

const MAX_KEY_LENGTH = 255;

function hashRequest(req) {
  return crypto
    .createHash('sha256')
    .update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? {})}`)
    .digest('hex');
}

/**
 * Honors an optional `Idempotency-Key` header on authenticated POSTs. The first
 * request with a key runs normally and its 2xx response is stored per user; a
 * replay with the same key and body returns that stored response instead of
 * executing the handler again. Non-2xx outcomes are discarded so the client can retry.
 * Must run after requireAuth.
 */
async function idempotency(req, res, next) {
  const key = req.get('idempotency-key');
  const userId = req.user?.userId;
  if (!key || !userId) return next();
  if (key.length > MAX_KEY_LENGTH) {
    return sendErrorResponse(res, 400, `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`);
  }

  const requestHash = hashRequest(req);
  try {
    const { rows: inserted } = await db.query(
      `INSERT INTO idempotency_keys (user_id, idempotency_key, request_method, request_path, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING user_id`,
      [userId, key, req.method, req.originalUrl, requestHash]
    );

    if (!inserted.length) {
      const { rows } = await db.query(
        `SELECT request_hash, response_status, response_body, completed_at
         FROM idempotency_keys
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, key]
      );
      const existing = rows[0];
      if (existing && existing.request_hash !== requestHash) {
        return sendErrorResponse(res, 422, 'Idempotency-Key was already used with a different request');
      }
      if (!existing || !existing.completed_at) {
        return sendErrorResponse(res, 409, 'A request with this Idempotency-Key is still in progress');
      }
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.response_status).json(existing.response_body);
    }
  } catch (err) {
    return next(err);
  }

  let settled = false;
  const settle = (status, body) => {
    if (settled) return;
    settled = true;
    const query = status >= 200 && status < 300
      ? db.query(
        `UPDATE idempotency_keys
         SET response_status = $3, response_body = $4::jsonb, completed_at = NOW()
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, key, status, JSON.stringify(body ?? null)]
      )
      : db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
    query.catch((err) => logger.error('Failed to persist idempotency key', { error: err.message }));
  };

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    settle(res.statusCode, body);
    return originalJson(body);
  };
  // Responses not sent through res.json cannot be replayed; free the key.
  res.on('finish', () => settle(0));

  next();
}

module.exports = { idempotency };
