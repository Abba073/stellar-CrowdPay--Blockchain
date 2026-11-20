const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const db = require('../config/database');
const { captureContext, runWithCapturedContext } = require('../config/requestContext');

/**
 * SSRF protection — validate a webhook callback URL before making an outbound request.
 *
 * Rules enforced:
 *  1. Scheme must be https (http is rejected to prevent plaintext credential leakage).
 *  2. Hostname must not be a loopback address (localhost, 127.x.x.x, ::1).
 *  3. Hostname must not fall inside private/link-local IP ranges:
 *       - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16  (RFC 1918)
 *       - 169.254.0.0/16  (link-local / AWS metadata endpoint)
 *       - fc00::/7, fe80::/10  (IPv6 ULA / link-local)
 *  4. After DNS resolution the resolved IPs are checked against the same ranges
 *     so that a public-looking hostname cannot CNAME to an internal address.
 *
 * @param {string} rawUrl
 * @throws {Error} if the URL is invalid or targets a forbidden range
 */
async function assertSafeWebhookUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid webhook URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Webhook URL must use HTTPS (got ${parsed.protocol})`);
  }

  const rawHostname = parsed.hostname;
  // URL keeps IPv6 literals wrapped in brackets, e.g. [::1] — strip them for net.isIP()
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // Reject numeric IP literals directly (no DNS needed)
  // URL parser strips brackets from IPv6 literals, e.g. [::1] → ::1
  if (net.isIP(hostname)) {
    assertNotPrivateIp(hostname);
  } else {
    // Reject well-known loopback/internal hostnames
    const lower = hostname.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) {
      throw new Error(`Webhook URL targets a forbidden host: ${hostname}`);
    }

    // DNS resolution check — protect against CNAME-to-internal tricks
    let addresses;
    try {
      addresses = await dns.resolve(hostname);
    } catch {
      // If we cannot resolve the host, fail safe
      throw new Error(`Webhook URL hostname could not be resolved: ${hostname}`);
    }

    for (const addr of addresses) {
      assertNotPrivateIp(addr);
    }
  }
}

/**
 * Throw if `ip` is a loopback, link-local, or private-range address.
 * Supports both IPv4 and IPv6.
 */
function assertNotPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;

    if (a === 127) throw new Error(`Webhook URL resolves to a loopback address: ${ip}`);
    if (a === 10) throw new Error(`Webhook URL resolves to a private address: ${ip}`);
    if (a === 172 && b >= 16 && b <= 31) throw new Error(`Webhook URL resolves to a private address: ${ip}`);
    if (a === 192 && b === 168) throw new Error(`Webhook URL resolves to a private address: ${ip}`);
    if (a === 169 && b === 254) throw new Error(`Webhook URL resolves to a link-local address: ${ip}`);
    if (a === 0) throw new Error(`Webhook URL resolves to a reserved address: ${ip}`);
    if (a === 100 && b >= 64 && b <= 127) throw new Error(`Webhook URL resolves to a shared-address-space (CGNAT) address: ${ip}`);
  } else if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();

    // ::1 loopback
    if (lower === '::1') throw new Error(`Webhook URL resolves to a loopback address: ${ip}`);

    // Expand and check common prefixes (simplified but sufficient for the threat model)
    // fe80::/10 link-local
    if (lower.startsWith('fe80:') || lower.startsWith('fe81:') ||
        lower.startsWith('fe82:') || lower.startsWith('fe83:') ||
        lower.startsWith('fe84:') || lower.startsWith('fe85:') ||
        lower.startsWith('fe86:') || lower.startsWith('fe87:') ||
        lower.startsWith('fe88:') || lower.startsWith('fe89:') ||
        lower.startsWith('fe8a:') || lower.startsWith('fe8b:') ||
        lower.startsWith('fe8c:') || lower.startsWith('fe8d:') ||
        lower.startsWith('fe8e:') || lower.startsWith('fe8f:') ||
        lower.startsWith('fe90:') || lower.startsWith('fe91:') ||
        lower.startsWith('fe92:') || lower.startsWith('fe93:') ||
        lower.startsWith('fe94:') || lower.startsWith('fe95:') ||
        lower.startsWith('fe96:') || lower.startsWith('fe97:') ||
        lower.startsWith('fe98:') || lower.startsWith('fe99:') ||
        lower.startsWith('fe9a:') || lower.startsWith('fe9b:') ||
        lower.startsWith('fe9c:') || lower.startsWith('fe9d:') ||
        lower.startsWith('fe9e:') || lower.startsWith('fe9f:') ||
        lower.startsWith('fea0:') || lower.startsWith('feb0:') ||
        lower.startsWith('febf:')) {
      throw new Error(`Webhook URL resolves to a link-local IPv6 address: ${ip}`);
    }
    // fc00::/7 ULA (fc00:: – fdff::)
    if (lower.startsWith('fc') || lower.startsWith('fd')) {
      throw new Error(`Webhook URL resolves to a private IPv6 ULA address: ${ip}`);
    }
    // ::ffff:0:0/96 — IPv4-mapped IPv6 addresses: recursively validate the v4 part
    if (lower.startsWith('::ffff:')) {
      const v4Part = ip.slice(7);
      if (net.isIPv4(v4Part)) {
        assertNotPrivateIp(v4Part);
      }
    }
  }
}

const WEBHOOK_EVENTS = {
  CAMPAIGN_FUNDED: 'campaign.funded',
  CAMPAIGN_FAILED: 'campaign.failed',
  CONTRIBUTION_RECEIVED: 'contribution.received',
  CONTRIBUTION_INDEXED: 'contribution.indexed', // campaign-level event
  MILESTONE_APPROVED: 'milestone.approved',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
};

const ALL_WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENTS);
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_CAMPAIGN_DELIVERY_ATTEMPTS = 3;

// A delivery flips to 'delivering' the moment the HTTP request starts. If the
// process crashes mid-request the row can be stuck in 'delivering' forever
// (the in-process retry timer dies with it). The poller treats a 'delivering'
// row whose lease has expired as abandoned and re-queues it. Kept comfortably
// above the 9s fetch timeout so live in-flight deliveries are never double-picked.
const DELIVERY_LEASE_SECONDS = 25;

function hmacSignature(secret, bodyUtf8) {
  return crypto.createHmac('sha256', secret).update(bodyUtf8, 'utf8').digest('hex');
}

/**
 * Sign a webhook payload together with its delivery timestamp so that a
 * captured delivery cannot be replayed with a fresh timestamp.
 *
 * The signed string is `${timestamp}.${bodyUtf8}` (Stripe-style). Consumers
 * must verify the timestamp window first, then recompute this HMAC, then
 * de-duplicate on the delivery id.
 *
 * @param {string} secret
 * @param {number|string} timestamp epoch seconds
 * @param {string} bodyUtf8 raw request body
 * @returns {string} hex HMAC-SHA256
 */
function signWebhookPayload(secret, timestamp, bodyUtf8) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${bodyUtf8}`, 'utf8')
    .digest('hex');
}

function backoffMs(attemptNumber) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attemptNumber - 1));
}

function backoffMsForCampaign(attemptNumber) {
  // Campaign webhooks: exponential backoff (5s, 30s, 5min)
  const delays = [5000, 30000, 300000];
  return delays[Math.min(attemptNumber - 1, delays.length - 1)];
}

/** Queue outbound webhook deliveries for every active endpoint owned by `ownerUserId`. */
async function emitWebhookEventForUser(ownerUserId, eventType, payload) {
  if (!ownerUserId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM webhooks
     WHERE user_id = $1 AND revoked_at IS NULL AND $2 = ANY(events)`,
    [ownerUserId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processDelivery(deliveryId).catch((err) =>
        console.error(`[webhooks] delivery ${deliveryId}:`, err.message)
      );
    });
  }
}

async function processDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.attempt_count, d.status, d.payload, d.event_type,
            w.url, w.secret, w.revoked_at
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (row.revoked_at) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook revoked', updated_at = NOW() WHERE id = $1`,
      [deliveryId]
    );
    return;
  }
  if (row.status === 'delivered') return;

  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt > MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [deliveryId, 'max delivery attempts exceeded']
    );
    return;
  }

  const bodyUtf8 = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signWebhookPayload(row.secret, timestamp, bodyUtf8);

  // SSRF protection: validate URL before sending the request
  try {
    await assertSafeWebhookUrl(row.url);
  } catch (ssrfErr) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [deliveryId, ssrfErr.message]
    );
    return;
  }

  await db.query(
    `UPDATE webhook_deliveries SET attempt_count = $2, status = 'delivering', updated_at = NOW() WHERE id = $1`,
    [deliveryId, nextAttempt]
  );

  let res;
  let responseText = '';
  try {
    res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': `sha256=${sig}`,
        'X-CrowdPay-Timestamp': String(timestamp),
        'X-CrowdPay-Event': row.event_type,
        'X-CrowdPay-Delivery-Id': String(deliveryId),
      },
      body: bodyUtf8,
      signal: AbortSignal.timeout(9000),
    });
    responseText = await res.text();
  } catch (err) {
    await scheduleRetry(deliveryId, nextAttempt, err.message || String(err), null, null);
    return;
  }

  const snippet = responseText.slice(0, 512);
  if (res.ok) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', response_status = $2, response_body_snippet = $3,
           delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, res.status, snippet]
    );
    return;
  }

  await scheduleRetry(
    deliveryId,
    nextAttempt,
    `HTTP ${res.status}`,
    res.status,
    snippet
  );
}

async function scheduleRetry(deliveryId, attemptJustUsed, errMsg, httpStatus, snippet) {
  if (attemptJustUsed >= MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'failed', last_error = $2, response_status = $3, response_body_snippet = $4, updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, errMsg, httpStatus, snippet]
    );
    return;
  }

  const delay = backoffMs(attemptJustUsed);
  const nextAt = new Date(Date.now() + delay);
  await db.query(
    `UPDATE webhook_deliveries
     SET status = 'retrying', next_retry_at = $2, last_error = $3,
         response_status = $4, response_body_snippet = $5, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, nextAt.toISOString(), errMsg, httpStatus, snippet]
  );

  // Capture the originating request context so the deferred retry re-enters
  // the same AsyncLocalStorage scope and its logs carry the request_id.
  const captured = captureContext();
  setTimeout(() => {
    runWithCapturedContext(captured, () =>
      processDelivery(deliveryId).catch((err) =>
        console.error(`[webhooks] retry ${deliveryId}:`, err.message)
      )
    );
  }, delay);
}

async function processDueRetries() {
  const { rows } = await db.query(
    `SELECT id FROM webhook_deliveries
     WHERE (status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW())
        OR (status = 'delivering' AND updated_at <= NOW() - make_interval(secs => $1))
     LIMIT 25`,
    [DELIVERY_LEASE_SECONDS]
  );
  for (const r of rows) {
    await processDelivery(r.id).catch((err) =>
      console.error(`[webhooks] poller ${r.id}:`, err.message)
    );
  }
}

/** Queue outbound webhook deliveries for campaign webhooks */
async function emitWebhookEventForCampaign(campaignId, eventType, payload) {
  if (!campaignId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM campaign_webhooks
     WHERE campaign_id = $1 AND active = TRUE AND $2 = ANY(events)`,
    [campaignId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO campaign_webhook_deliveries (webhook_id, event, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processCampaignWebhookDelivery(deliveryId).catch((err) =>
        console.error(`[campaign-webhooks] delivery ${deliveryId}:`, err.message)
      );
    });
  }
}

async function processCampaignWebhookDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.attempt_count, d.status, d.payload, d.event,
            w.url, w.secret, w.active
     FROM campaign_webhook_deliveries d
     JOIN campaign_webhooks w ON w.id = d.webhook_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (!row.active) {
    await db.query(
      `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = 'webhook disabled', updated_at = NOW() WHERE id = $1`,
      [deliveryId]
    );
    return;
  }
  if (row.status === 'delivered') return;

  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt > MAX_CAMPAIGN_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [deliveryId, 'max delivery attempts exceeded']
    );
    return;
  }

  const bodyUtf8 = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signWebhookPayload(row.secret, timestamp, bodyUtf8);

  // SSRF protection: validate URL before sending the request
  try {
    await assertSafeWebhookUrl(row.url);
  } catch (ssrfErr) {
    await db.query(
      `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [deliveryId, ssrfErr.message]
    );
    return;
  }

  await db.query(
    `UPDATE campaign_webhook_deliveries SET attempt_count = $2, status = 'delivering', updated_at = NOW() WHERE id = $1`,
    [deliveryId, nextAttempt]
  );

  let res;
  let responseText = '';
  try {
    res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': `sha256=${sig}`,
        'X-CrowdPay-Timestamp': String(timestamp),
        'X-CrowdPay-Event': row.event,
        'X-CrowdPay-Delivery-Id': String(deliveryId),
      },
      body: bodyUtf8,
      signal: AbortSignal.timeout(9000),
    });
    responseText = await res.text();
  } catch (err) {
    await scheduleCampaignWebhookRetry(deliveryId, nextAttempt, err.message || String(err), null);
    return;
  }

  if (res.ok) {
    await db.query(
      `UPDATE campaign_webhook_deliveries
       SET status = 'delivered', response_status = $2, delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, res.status]
    );
    return;
  }

  await scheduleCampaignWebhookRetry(
    deliveryId,
    nextAttempt,
    `HTTP ${res.status}`,
    res.status
  );
}

async function scheduleCampaignWebhookRetry(deliveryId, attemptJustUsed, errMsg, httpStatus) {
  if (attemptJustUsed >= MAX_CAMPAIGN_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE campaign_webhook_deliveries
       SET status = 'failed', last_error = $2, response_status = $3, failed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, errMsg, httpStatus]
    );
    return;
  }

  const delay = backoffMsForCampaign(attemptJustUsed);
  const nextAt = new Date(Date.now() + delay);
  await db.query(
    `UPDATE campaign_webhook_deliveries
     SET status = 'retrying', next_retry_at = $2, last_error = $3,
         response_status = $4, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, nextAt.toISOString(), errMsg, httpStatus]
  );

  // Capture the originating request context so the deferred retry re-enters
  // the same AsyncLocalStorage scope and its logs carry the request_id.
  const captured = captureContext();
  setTimeout(() => {
    runWithCapturedContext(captured, () =>
      processCampaignWebhookDelivery(deliveryId).catch((err) =>
        console.error(`[campaign-webhooks] retry ${deliveryId}:`, err.message)
      )
    );
  }, delay);
}

async function processDueCampaignWebhookRetries() {
  const { rows } = await db.query(
    `SELECT id FROM campaign_webhook_deliveries
     WHERE (status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW())
        OR (status = 'delivering' AND updated_at <= NOW() - make_interval(secs => $1))
     LIMIT 25`,
    [DELIVERY_LEASE_SECONDS]
  );
  for (const r of rows) {
    await processCampaignWebhookDelivery(r.id).catch((err) =>
      console.error(`[campaign-webhooks] poller ${r.id}:`, err.message)
    );
  }
}

function startWebhookRetryPoller() {
  // The poller runs outside any request scope; give it a synthetic context so
  // its logs are identifiable and correlation ids are never undefined.
  const pollerContext = { requestId: 'webhook-poller' };
  setInterval(() => {
    runWithCapturedContext(pollerContext, () => {
      processDueRetries().catch((e) => console.error('[webhooks] poller:', e.message));
      processDueCampaignWebhookRetries().catch((e) => console.error('[campaign-webhooks] poller:', e.message));
    });
  }, 5000);
}

module.exports = {
  WEBHOOK_EVENTS,
  ALL_WEBHOOK_EVENTS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_CAMPAIGN_DELIVERY_ATTEMPTS,
  hmacSignature,
  signWebhookPayload,
  assertSafeWebhookUrl,
  assertNotPrivateIp,
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  processDelivery,
  processCampaignWebhookDelivery,
  processDueRetries,
  processDueCampaignWebhookRetries,
  startWebhookRetryPoller,
};
