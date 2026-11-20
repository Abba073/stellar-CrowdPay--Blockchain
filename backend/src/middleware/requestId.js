const { randomUUID } = require('crypto');
const { runWithContext } = require('../config/requestContext');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requestIdMiddleware(req, res, next) {
  const headerValue = req.headers['x-request-id'];
  const requestId =
    typeof headerValue === 'string' && REQUEST_ID_PATTERN.test(headerValue)
      ? headerValue
      : randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  runWithContext({ requestId }, next);
}

module.exports = { requestIdMiddleware };