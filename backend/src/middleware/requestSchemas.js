/**
 * express-validator schemas for request bodies/params that previously had
 * only ad-hoc `if (!x)` checks: disputes, notifications, API keys and
 * campaign updates. They enforce types (no arrays/objects where strings are
 * expected), lengths and enums before anything reaches the DB, and strip
 * HTML from free-text fields that are not otherwise sanitised.
 *
 * Kept separate from validation.js, which imports the Stellar service.
 */
const { body, param, validationResult } = require('express-validator');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DISPUTE_REASONS = ['non_delivery', 'misrepresentation', 'abandoned', 'other'];
const DISPUTE_STATUSES = ['open', 'under_review', 'resolved_creator', 'resolved_contributor', 'closed'];
const MAX_DISPUTE_TEXT = 5000;
const MAX_URL_LENGTH = 2048;
const API_KEY_SCOPES = ['read', 'write', 'withdrawals', 'developer', 'full'];
const MAX_API_KEY_LABEL = 100;
const NOTIFICATION_PREFERENCE_TYPES = ['system', 'message', 'listing', 'order', 'review', 'marketing'];
const MAX_UPDATE_TITLE = 200;
const MAX_UPDATE_BODY = 20000;

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, '').trim();
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const uuidParam = (name) =>
  param(name).custom((v) => UUID_PATTERN.test(String(v))).withMessage(`${name} must be a valid UUID`);

/** A required, non-empty string field (arrays/objects/numbers are rejected). */
const requiredText = (name, max, { sanitize = false } = {}) => {
  let chain = body(name).isString().withMessage(`${name} must be a string`).bail();
  if (sanitize) chain = chain.customSanitizer(stripHtml);
  return chain
    .trim()
    .notEmpty()
    .withMessage(`${name} is required`)
    .bail()
    .isLength({ max })
    .withMessage(`${name} must be at most ${max} characters`);
};

const disputeCreateValidation = [
  uuidParam('id'),
  body('reason')
    .isString()
    .withMessage('reason must be a string')
    .bail()
    .isIn(DISPUTE_REASONS)
    .withMessage(`reason must be one of: ${DISPUTE_REASONS.join(', ')}`),
  requiredText('description', MAX_DISPUTE_TEXT, { sanitize: true }),
  body('evidence_url')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('evidence_url must be a string')
    .bail()
    .isLength({ max: MAX_URL_LENGTH })
    .withMessage(`evidence_url must be at most ${MAX_URL_LENGTH} characters`)
    .bail()
    .custom(isHttpUrl)
    .withMessage('evidence_url must be an http(s) URL'),
];

const disputeUpdateValidation = [
  uuidParam('id'),
  body('status')
    .isString()
    .withMessage('status must be a string')
    .bail()
    .isIn(DISPUTE_STATUSES)
    .withMessage(`status must be one of: ${DISPUTE_STATUSES.join(', ')}`),
  body('resolution_note')
    .optional({ nullable: true })
    .isString()
    .withMessage('resolution_note must be a string')
    .bail()
    .customSanitizer(stripHtml)
    .isLength({ max: MAX_DISPUTE_TEXT })
    .withMessage(`resolution_note must be at most ${MAX_DISPUTE_TEXT} characters`),
];

const notificationIdValidation = [uuidParam('id')];

const notificationPreferencesValidation = [
  body()
    .custom((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('preferences must be an object');
      }
      for (const [key, flag] of Object.entries(value)) {
        if (!NOTIFICATION_PREFERENCE_TYPES.includes(key)) {
          throw new Error(`unknown preference "${key}"; expected one of: ${NOTIFICATION_PREFERENCE_TYPES.join(', ')}`);
        }
        if (typeof flag !== 'boolean') throw new Error(`${key} must be a boolean`);
      }
      return true;
    }),
];

const apiKeyCreateValidation = [
  body('label')
    .optional({ nullable: true })
    .isString()
    .withMessage('label must be a string')
    .bail()
    .customSanitizer(stripHtml)
    .isLength({ min: 1, max: MAX_API_KEY_LABEL })
    .withMessage(`label must be 1-${MAX_API_KEY_LABEL} characters`),
  body('scopes')
    .optional({ nullable: true })
    .isArray({ min: 1, max: API_KEY_SCOPES.length })
    .withMessage(`scopes must be a non-empty array of: ${API_KEY_SCOPES.join(', ')}`)
    .bail()
    .custom((scopes) => scopes.every((s) => typeof s === 'string' && API_KEY_SCOPES.includes(s)))
    .withMessage(`scopes must only contain: ${API_KEY_SCOPES.join(', ')}`),
];

// Markdown title/body are sanitised by the route itself; these enforce type
// and length on the raw input.
const campaignUpdateCreateValidation = [
  uuidParam('id'),
  requiredText('title', MAX_UPDATE_TITLE),
  requiredText('body', MAX_UPDATE_BODY),
];

const campaignUpdateEditValidation = [...campaignUpdateCreateValidation, uuidParam('updateId')];

const campaignUpdateDeleteValidation = [uuidParam('id'), uuidParam('updateId')];

/**
 * Like validateRequest, but with the status each endpoint documents:
 * { error: <first message>, errors: [...] }.
 */
function validateRequestWithStatus(status) {
  return function validate(req, res, next) {
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    const errors = result.array();
    return res.status(status).json({ error: errors[0].msg, errors });
  };
}

/** For endpoints that document 422 on invalid input. */
const validateRequestUnprocessable = validateRequestWithStatus(422);
/** For endpoints that document 400 on invalid input. */
const validateRequestBadRequest = validateRequestWithStatus(400);

module.exports = {
  DISPUTE_REASONS,
  DISPUTE_STATUSES,
  disputeCreateValidation,
  disputeUpdateValidation,
  notificationIdValidation,
  notificationPreferencesValidation,
  apiKeyCreateValidation,
  campaignUpdateCreateValidation,
  campaignUpdateEditValidation,
  campaignUpdateDeleteValidation,
  validateRequestUnprocessable,
  validateRequestBadRequest,
};
