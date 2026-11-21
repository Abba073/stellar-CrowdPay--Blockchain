const logger = require('../config/logger');

const SENSITIVE_QUERY_PARAMS = [
  'token',
  'secret',
  'key',
  'signature',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'password',
];

const REDACTED = '[REDACTED]';

function isSensitiveParam(name) {
  const lower = String(name).toLowerCase();
  return SENSITIVE_QUERY_PARAMS.some((param) => lower === param || lower.endsWith(`_${param}`) || lower.startsWith(`${param}_`));
}

function redactQueryString(queryString) {
  if (!queryString) return queryString;

  return queryString
    .split('&')
    .map((pair) => {
      if (!pair) return pair;
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) {
        return pair;
      }
      const rawName = pair.slice(0, eqIndex);
      const name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      if (isSensitiveParam(name)) {
        return `${rawName}=${encodeURIComponent(REDACTED)}`;
      }
      return pair;
    })
    .join('&');
}

function redactUrl(url) {
  if (!url) return url;
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;
  const base = url.slice(0, queryIndex);
  const query = url.slice(queryIndex + 1);
  return `${base}?${redactQueryString(query)}`;
}

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const duration_ms = Math.round(elapsedMs * 100) / 100;

    const rawPath = req.originalUrl || req.url || req.path;
    const path = redactUrl(rawPath);
    const method = req.method;
    const status = res.statusCode;

    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]('request', { method, path, status, duration_ms });
  });

  next();
}

module.exports = { requestLogger, redactUrl, redactQueryString };