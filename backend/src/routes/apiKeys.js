const crypto = require('crypto');
const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { hashApiKey } = require('../middleware/auth');
const { apiKeyCreateValidation, validateRequestUnprocessable } = require('../middleware/requestSchemas');
const { sendErrorResponse } = require('../middleware/errorHandler');

const ALLOWED_SCOPES = new Set(['read', 'write', 'withdrawals', 'developer', 'full']);

function normalizeScopes(input) {
  if (!input || !Array.isArray(input) || !input.length) {
    return ['read', 'write', 'withdrawals'];
  }
  const out = [...new Set(input.filter((s) => typeof s === 'string' && ALLOWED_SCOPES.has(s)))];
  return out.length ? out : ['read', 'write', 'withdrawals'];
}

/**
 * @openapi
 * /api/api-keys:
 *   get:
 *     summary: List the caller's API keys
 *     description: Returns all API keys owned by the authenticated user, including revoked ones.
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of API keys (never includes the raw key or hash)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ApiKey'
 *       401:
 *         description: Missing or invalid authentication
 */
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, label, scopes, key_prefix, last_used_at, created_at, revoked_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/api-keys:
 *   post:
 *     summary: Create a new API key
 *     description: >
 *       Creates an API key for the authenticated user. The raw key is returned
 *       exactly once in the `api_key` field and cannot be retrieved again.
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label:
 *                 type: string
 *                 example: CI deploy key
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [read, write, withdrawals, developer, full]
 *                 example: [read, write]
 *     responses:
 *       201:
 *         description: API key created; `api_key` contains the raw secret
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiKey'
 *                 - type: object
 *                   properties:
 *                     api_key:
 *                       type: string
 *                       example: cp_live_0123456789abcdef0123456789abcdef0123456789abcdef
 *                     message:
 *                       type: string
 *       401:
 *         description: Missing or invalid authentication
 */
router.post('/', requireAuth, apiKeyCreateValidation, validateRequestUnprocessable, async (req, res) => {
  const label = (req.body && req.body.label) || 'API key';
  const scopes = normalizeScopes(req.body && req.body.scopes);
  const rawKey = `cp_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = `${rawKey.slice(0, 14)}…`;
  const keyHash = hashApiKey(rawKey);

  const { rows } = await db.query(
    `INSERT INTO api_keys (user_id, key_prefix, key_hash, label, scopes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, label, scopes, key_prefix, created_at`,
    [req.user.userId, keyPrefix, keyHash, label, scopes]
  );

  res.status(201).json({
    ...rows[0],
    api_key: rawKey,
    message: 'Store this key securely; it cannot be shown again.',
  });
});

/**
 * @openapi
 * /api/api-keys/{id}:
 *   delete:
 *     summary: Revoke an API key
 *     description: Marks the key as revoked. Revoked keys can no longer authenticate.
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Key revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 revoked:
 *                   type: boolean
 *                   example: true
 *                 id:
 *                   type: string
 *                   format: uuid
 *       401:
 *         description: Missing or invalid authentication
 *       404:
 *         description: API key not found or already revoked
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'API key not found');
  res.json({ revoked: true, id: rows[0].id });
});

module.exports = router;
