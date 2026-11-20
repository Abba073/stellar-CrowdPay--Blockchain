const { sendErrorResponse } = require('./errorHandler');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Return the set of allowed origins.
 *
 * FRONTEND_URLS is a comma-separated list of allowed origins (preferred).
 * For backward-compatibility, FRONTEND_URL (single value) is used when
 * FRONTEND_URLS is not set. Falls back to http://localhost:5173.
 *
 * Trailing slashes are stripped so comparisons are consistent.
 */
function getAllowedOrigins() {
  const raw = process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:5173';
  return new Set(
    raw
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean)
  );
}

// Rejects cross-site state-changing requests. Non-browser clients (API keys,
// HMAC-signed webhooks) send neither Sec-Fetch-Site nor Origin and pass through.
function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite) {
    if (fetchSite === 'cross-site') {
      return sendErrorResponse(res, 403, 'Cross-site request blocked');
    }
    return next();
  }

  const origin = req.get('origin');
  if (!origin) return next();

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return sendErrorResponse(res, 403, 'Cross-site request blocked');
  }

  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.has(origin) || originHost === req.get('host')) return next();

  return sendErrorResponse(res, 403, 'Cross-site request blocked');
}

module.exports = { originCheck, getAllowedOrigins };
