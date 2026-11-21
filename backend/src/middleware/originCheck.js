const { sendErrorResponse } = require('./errorHandler');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Normalize an origin to a canonical `scheme://host[:port]` string.
 *
 * Lowercases scheme and host, omits default ports (80 for http, 443 for
 * https), and drops any path/query/fragment. Returns null when the value
 * cannot be parsed as an absolute URL.
 */
function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.protocol || !url.hostname) return null;
  return url.origin;
}

/**
 * Return the set of allowed origins, normalized to `scheme://host[:port]`.
 *
 * FRONTEND_URLS is a comma-separated list of allowed origins (preferred).
 * For backward-compatibility, FRONTEND_URL (single value) is used when
 * FRONTEND_URLS is not set. Falls back to http://localhost:5173.
 *
 * Entries that cannot be parsed are ignored.
 */
function getAllowedOrigins() {
  const raw = process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:5173';
  const origins = new Set();
  for (const entry of raw.split(',')) {
    const normalized = normalizeOrigin(entry.trim());
    if (normalized) origins.add(normalized);
  }
  return origins;
}

// Rejects cross-site state-changing requests. Non-browser clients (API keys,
// HMAC-signed webhooks) send neither Sec-Fetch-Site nor Origin and pass through.
//
// Sec-Fetch-Site is only used to reject explicit cross-site requests; it never
// authorizes a request on its own. Whenever an Origin header is present it is
// validated against the configured allowlist (full scheme://host[:port]).
function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite.toLowerCase() === 'cross-site') {
    return sendErrorResponse(res, 403, 'Cross-site request blocked');
  }

  const origin = req.get('origin');
  if (!origin) return next();

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return sendErrorResponse(res, 403, 'Cross-site request blocked');
  }

  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.has(normalizedOrigin)) return next();

  return sendErrorResponse(res, 403, 'Cross-site request blocked');
}

module.exports = { originCheck, getAllowedOrigins };
