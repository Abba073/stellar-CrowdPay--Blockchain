const crypto = require('crypto');
const express = require('express');
const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { ALL_WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { extractWebhookResult } = require('../services/kycProvider');
const { suppressEmail } = require('../services/emailService');
const { sendErrorResponse } = require('../middleware/errorHandler');

// #280 — Per-route JSON body limit for webhook admin payloads (registration,
// echo, etc.). Kept tight so oversized payloads fail fast with a 413 instead
// of relying on the global parser limit.
const webhookJsonParser = express.json({ limit: '10kb' });

function isValidWebhookUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol === 'https:') return true;
    if (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function normalizeEvents(events) {
  if (!events || !Array.isArray(events)) return [];
  const allowed = new Set(ALL_WEBHOOK_EVENTS);
  return [...new Set(events.filter((e) => typeof e === 'string' && allowed.has(e)))];
}

/**
 * Verify the HMAC-SHA256 signature on an inbound KYC webhook.
 *
 * Persona (and dev-mode) sign payloads with a shared secret delivered in the
 * `Persona-Signature` header (format: `t=<timestamp>,v1=<hex-digest>`).
 * We re-compute the digest over `<timestamp>.<raw-body>` and compare in
 * constant time to prevent timing attacks.
 *
 * Returns true when the signature is valid, false otherwise.
 */
function verifyKycWebhookSignature(req) {
  const secret = process.env.KYC_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed: if no secret is configured we must reject the request.
    return false;
  }

  const header = req.headers['persona-signature'] || req.headers['x-kyc-signature'] || '';
  if (!header) return false;

  // Parse `t=<ts>,v1=<digest>` — both fields are required.
  const tMatch = header.match(/t=([^,]+)/);
  const v1Match = header.match(/v1=([^,]+)/);
  if (!tMatch || !v1Match) return false;

  const timestamp = tMatch[1];
  const receivedDigest = v1Match[1];

  // Protect against replay attacks: reject payloads older than 5 minutes.
  const tsSec = parseInt(timestamp, 10);
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) {
    return false;
  }

  // The raw body must have been captured by express.json with `verify` callback or
  // stored in req.rawBody. Fall back to re-serialising from req.body if unavailable
  // (acceptable for dev; in production raw body capture should be configured).
  const rawBody = req.rawBody || JSON.stringify(req.body || {});

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(receivedDigest, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    // timingSafeEqual throws when lengths differ
    return false;
  }
}

router.post('/kyc', async (req, res) => {
  // #13 — Reject any request that does not carry a valid HMAC signature.
  if (!verifyKycWebhookSignature(req)) {
    return sendErrorResponse(res, 401, 'KYC webhook signature verification failed');
  }

  const result = extractWebhookResult(req.body || {});

  // #13 — Require a provider-issued reference; never fall back to a bare userId
  // supplied by the caller so that an attacker cannot self-verify an arbitrary account.
  if (!result.providerReference) {
    return sendErrorResponse(res, 400, 'KYC webhook payload missing provider reference');
  }

  if (!['verified', 'rejected', 'pending'].includes(result.kycStatus)) {
    return sendErrorResponse(res, 400, 'Unsupported KYC status');
  }

  // Lookup is strictly by the signed provider reference — never by raw userId.
  const { rows } = await db.query(
    `UPDATE users
     SET kyc_status = $1::kyc_status,
         kyc_provider_reference = COALESCE($2, kyc_provider_reference),
         kyc_completed_at = CASE WHEN $1::kyc_status = 'verified' THEN NOW() ELSE NULL END
     WHERE kyc_provider_reference = $2
     RETURNING id, kyc_status, kyc_completed_at`,
    [result.kycStatus, result.providerReference]
  );

  if (!rows.length) {
    return sendErrorResponse(res, 404, 'KYC subject not found');
  }

  res.json({
    received: true,
    user_id: rows[0].id,
    kyc_status: rows[0].kyc_status,
    kyc_completed_at: rows[0].kyc_completed_at,
  });
});

// SendGrid (bounce/dropped/spamreport) and Mailgun (permanent failed/complained) events.
const SUPPRESSING_EMAIL_EVENTS = new Set(['bounce', 'dropped', 'spamreport', 'complained']);

function verifyEmailWebhookToken(req) {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  if (!secret) return false;
  const received = String(req.headers['x-email-webhook-token'] || req.query.token || '');
  const a = Buffer.from(received);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/email-events', async (req, res) => {
  if (!verifyEmailWebhookToken(req)) {
    return sendErrorResponse(res, 401, 'Email webhook verification failed');
  }

  const events = Array.isArray(req.body) ? req.body : [req.body?.['event-data'] || req.body || {}];
  let suppressed = 0;
  for (const evt of events) {
    const email = evt.email || evt.recipient;
    const type = evt.event;
    const permanentFailure = type === 'failed' && evt.severity === 'permanent';
    if (typeof email !== 'string' || !(SUPPRESSING_EMAIL_EVENTS.has(type) || permanentFailure)) continue;
    await suppressEmail(email, type);
    suppressed++;
  }

  res.json({ received: true, suppressed });
});

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, url, events,
            CONCAT(LEFT(secret, 10), '…', RIGHT(secret, 4)) AS secret_hint,
            created_at, revoked_at
     FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
});

router.post('/', requireAuth, webhookJsonParser, async (req, res) => {
  const { url, events } = req.body || {};
  if (!url || !events) {
    return sendErrorResponse(res, 400, 'url and events array are required');
  }
  if (!isValidWebhookUrl(url)) {
    return sendErrorResponse(res, 400, 'url must be https, or http://localhost for development');
  }
  const ev = normalizeEvents(events);
  if (!ev.length) {
    return sendErrorResponse(res, 400, `events must include at least one of: ${ALL_WEBHOOK_EVENTS.join(', ')}`);
  }

  const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
  const { rows } = await db.query(
    `INSERT INTO webhooks (user_id, url, events, secret)
     VALUES ($1, $2, $3, $4)
     RETURNING id, url, events, created_at`,
    [req.user.userId, url, ev, secret]
  );

  res.status(201).json({
    ...rows[0],
    secret,
    message: 'Store the signing secret; it is only shown once.',
  });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE webhooks SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Webhook not found');
  res.json({ revoked: true, id: rows[0].id });
});

router.get('/deliveries', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const webhookId = req.query.webhook_id || null;

  const params = [req.user.userId];
  let whClause = '';
  if (webhookId) {
    params.push(webhookId);
    whClause = ` AND w.id = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT d.id, d.webhook_id, d.event_type, d.status, d.response_status,
            d.response_body_snippet, d.attempt_count, d.last_error, d.next_retry_at,
            d.delivered_at, d.created_at, d.updated_at, w.url AS webhook_url
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE w.user_id = $1 ${whClause}
     ORDER BY d.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  res.json(rows);
});

module.exports = router;
