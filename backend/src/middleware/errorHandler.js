const { STATUS_CODES } = require('http');
const logger = require('../config/logger');

/**
 * Standard error response builder
 * Ensures consistent error envelope across all routes
 */
function buildErrorResponse(status, code, message, fields = undefined) {
  return {
    error: {
      code,
      message,
      ...(fields && { fields }),
    },
  };
}

/**
 * HTTP status code to error code mapping
 */
function getErrorCodeForStatus(status) {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_ERROR';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 500:
      return 'INTERNAL_ERROR';
    case 502:
      return 'BAD_GATEWAY';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

/**
 * Send the standard error envelope: { error: { code, message, fields? } }.
 * Every route should use this rather than res.status(...).json({ error }).
 *
 * @param {object} [extra] Additional top-level keys kept for existing
 *   clients (e.g. { retryable: true }); the envelope itself is unchanged.
 */
function sendErrorResponse(res, status, message, fields = undefined, customCode = undefined, extra = undefined) {
  const code = customCode || getErrorCodeForStatus(status);
  return res.status(status).json({ ...extra, ...buildErrorResponse(status, code, message, fields) });
}

/**
 * Coerce an arbitrary error body into the standard envelope, keeping any
 * existing top-level keys and a pre-existing error.code untouched.
 */
function toErrorEnvelope(status, body) {
  const code = getErrorCodeForStatus(status);
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    const { error, ...rest } = body;
    return { ...rest, error: { code, message: error } };
  }
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    if (body.error.code) return body;
    return {
      ...body,
      error: {
        ...body.error,
        code,
        message: body.error.message || JSON.stringify(body.error),
      },
    };
  }
  return {
    ...(body && typeof body === 'object' ? body : {}),
    error: { code, message: typeof body === 'string' && body ? body : 'Request failed' },
  };
}

/**
 * Turn a raw res.send/res.end payload (string, Buffer, undefined) into
 * something toErrorEnvelope understands, unwrapping JSON text when present.
 */
function rawToBody(payload, encoding) {
  if (payload === undefined || payload === null) return undefined;
  const text = Buffer.isBuffer(payload)
    ? payload.toString(typeof encoding === 'string' ? encoding : 'utf8')
    : String(payload);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Plain text: use it as the message.
  }
  return text;
}

/**
 * Safety net for responses that bypass sendErrorResponse: any 4xx/5xx body
 * is coerced into the standard envelope, with a code derived from the status.
 *
 * Every way of finishing a response is covered (res.json, res.send,
 * res.sendStatus and res.end), so e.g. res.status(400).send('bad') or
 * res.sendStatus(404) still produce { error: { code, message } } as JSON.
 */
function normalizeErrorResponse(req, res, next) {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);

  // Express implements json -> send -> end internally; only the outermost
  // call normalizes, the nested ones pass straight through.
  let depth = 0;
  const isError = () => res.statusCode >= 400 && !res.headersSent;

  function sendEnvelope(body) {
    res.set('Content-Type', 'application/json; charset=utf-8');
    return originalJson(toErrorEnvelope(res.statusCode, body));
  }

  function guarded(fn) {
    depth += 1;
    try {
      return fn();
    } finally {
      depth -= 1;
    }
  }

  res.json = function json(body) {
    if (depth > 0 || !isError()) return guarded(() => originalJson(body));
    return guarded(() => sendEnvelope(body));
  };

  res.send = function send(body) {
    if (depth > 0 || !isError()) return guarded(() => originalSend(body));
    const normalized = body && typeof body === 'object' && !Buffer.isBuffer(body)
      ? body
      : rawToBody(body);
    return guarded(() => sendEnvelope(normalized));
  };

  // sendStatus is built on send, but wrap it explicitly so the behaviour does
  // not depend on Express internals.
  res.sendStatus = function sendStatus(statusCode) {
    res.status(statusCode);
    return res.send(STATUS_CODES[statusCode] || String(statusCode));
  };

  res.end = function end(chunk, encoding, cb) {
    if (depth > 0 || !isError()) return originalEnd(chunk, encoding, cb);
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (typeof cb === 'function') res.once('finish', cb);
    return guarded(() => sendEnvelope(rawToBody(chunk, encoding)));
  };

  next();
}

function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const isServerError = status >= 500;
  const message = isServerError && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Unexpected error';
  const code = err.code || getErrorCodeForStatus(status);
  const payload = {
    code,
    message,
  };

  if (err.fields) {
    payload.fields = err.fields;
  }

  logger.error('Unhandled request error', {
    error: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    status,
  });

  res.status(status).json({ error: payload });
}

module.exports = { 
  normalizeErrorResponse, 
  toErrorEnvelope, 
  errorHandler, 
  buildErrorResponse, 
  sendErrorResponse,
  getErrorCodeForStatus 
};
