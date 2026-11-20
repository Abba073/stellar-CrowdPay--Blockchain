const logger = require('../config/logger');

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// In-memory dedup cache: dedupKey -> timestamp of last delivery
const dedupCache = new Map();

function getCooldownMs() {
  const raw = process.env.ALERT_COOLDOWN_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COOLDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_COOLDOWN_MS;
  return parsed;
}

function buildDedupKey(alertKey, fingerprint) {
  return `${alertKey || 'default'}::${fingerprint || 'none'}`;
}

function isSuppressed(dedupKey, cooldownMs) {
  const lastSent = dedupCache.get(dedupKey);
  if (lastSent === undefined) return false;
  const now = Date.now();
  if (now - lastSent < cooldownMs) return true;
  // Expired entry; clean it up so the map does not grow unbounded.
  dedupCache.delete(dedupKey);
  return false;
}

function pruneExpired(cooldownMs) {
  const now = Date.now();
  for (const [key, ts] of dedupCache.entries()) {
    if (now - ts >= cooldownMs) dedupCache.delete(key);
  }
}

function resolveWebhook(severity) {
  if (severity === 'critical') {
    return process.env.ALERT_PAGING_WEBHOOK_URL || process.env.ALERT_WEBHOOK_URL;
  }
  return process.env.ALERT_WEBHOOK_URL;
}

function severityColor(severity) {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'info':
    default:
      return 'good';
  }
}

function normalizeArgs(input, context) {
  // Backwards-compatible: sendAlert(message, context)
  if (typeof input === 'string') {
    return {
      alert_key: undefined,
      fingerprint: undefined,
      severity: 'warning',
      message: input,
      context: context || {},
    };
  }

  const opts = input || {};
  return {
    alert_key: opts.alert_key,
    fingerprint: opts.fingerprint,
    severity: opts.severity || 'warning',
    message: opts.message || '',
    context: opts.context || {},
  };
}

async function sendAlert(input, context = {}) {
  const { alert_key, fingerprint, severity, message, context: ctx } = normalizeArgs(input, context);

  const cooldownMs = getCooldownMs();
  const dedupKey = buildDedupKey(alert_key, fingerprint);

  if (isSuppressed(dedupKey, cooldownMs)) {
    logger.debug('Alert suppressed by dedup cooldown', {
      alert_key,
      fingerprint,
      severity,
      cooldownMs,
    });
    return { delivered: false, suppressed: true };
  }

  const url = resolveWebhook(severity);
  if (!url) {
    logger.warn('No alert webhook configured; dropping alert', {
      alert_key,
      fingerprint,
      severity,
      message,
    });
    return { delivered: false, suppressed: false, reason: 'no_webhook' };
  }

  const hasContext = ctx && Object.keys(ctx).length > 0;
  const payload = {
    text: `*[CrowdPay Alert]* [${severity.toUpperCase()}] ${message}`,
    ...(hasContext && {
      attachments: [
        {
          text: '```' + JSON.stringify(ctx, null, 2) + '```',
          color: severityColor(severity),
        },
      ],
    }),
  };

  // Record the attempt before delivery so concurrent callers dedup correctly.
  dedupCache.set(dedupKey, Date.now());
  pruneExpired(cooldownMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.error('Alert webhook returned non-2xx', {
        status: res.status,
        alert_key,
        fingerprint,
        severity,
      });
      return { delivered: false, suppressed: false, reason: 'non_2xx', status: res.status };
    }
    return { delivered: true, suppressed: false };
  } catch (err) {
    logger.error('Failed to deliver alert', {
      error: err.message,
      alert_key,
      fingerprint,
      severity,
    });
    return { delivered: false, suppressed: false, reason: 'error', error: err.message };
  }
}

function resetAlertDedupCache() {
  dedupCache.clear();
}

module.exports = { sendAlert, resetAlertDedupCache };