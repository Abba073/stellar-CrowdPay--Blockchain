const { body, query, validationResult } = require('express-validator');
const { Keypair } = require('@stellar/stellar-sdk');
const { getSupportedAssetCodes } = require('../services/stellarService');

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const VALID_CAMPAIGN_STATUSES = [
  'active',
  'funded',
  'in_progress',
  'completed',
  'closed',
  'withdrawn',
  'failed',
  'suspended',
];
const VALID_ORDER_BY = ['newest', 'ending_soon', 'most_funded', 'most_backed', 'closest_to_goal', 'trending'];
const VALID_CATEGORIES = [
  'technology', 'community', 'arts', 'education',
  'environment', 'health', 'business', 'open_source', 'other',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, '').trim();
}

const passwordValidation = [
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/)
    .withMessage('Password must include a lowercase letter')
    .matches(/[A-Z]/)
    .withMessage('Password must include an uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must include a number'),
];

const registerValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
  ...passwordValidation,
  body('name')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Name is required'),
  // Optional wallet_type for non-custodial registration
  body('wallet_type')
    .optional()
    .isIn(['custodial', 'freighter'])
    .withMessage('wallet_type must be custodial or freighter'),
  // For freighter users we accept an optional wallet_public_key
  body('wallet_public_key')
    .optional()
    .custom((value, { req }) => {
      if (req.body.wallet_type === 'freighter') {
        try {
          Keypair.fromPublicKey(value);
          return true;
        } catch (_err) {
          throw new Error('wallet_public_key must be a valid Stellar public key');
        }
      }
      return true;
    }),
  body('role')
    .optional()
    .isIn(['contributor', 'creator'])
    .withMessage('Role must be contributor or creator'),
];

const loginValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
  body('password').notEmpty().withMessage('Password is required'),
];

const forgotPasswordValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format'),
];

const resetPasswordValidation = [
  body('token').notEmpty().withMessage('Reset token is required'),
  ...passwordValidation,
];

const createCampaignValidation = [
  body('title')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Title is required')
    .isLength({ max: 100 })
    .withMessage('Title must be at most 100 characters'),
  body('description')
    .optional({ nullable: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 1000 })
    .withMessage('Description must be at most 1000 characters'),
  body('target_amount')
    .exists()
    .withMessage('Target amount is required')
    .isFloat({ gt: 0 })
    .withMessage('Target amount must be greater than zero'),
  body('asset_type')
    .notEmpty()
    .withMessage('Asset type is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`Asset type must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  body('deadline')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Deadline must be a valid date')
    .custom((value) => {
      const deadline = new Date(value);
      const now = new Date();
      if (deadline <= now) {
        throw new Error('Deadline must be in the future');
      }
      return true;
    }),
  body('min_contribution')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Minimum contribution must be greater than zero'),
  body('max_contribution')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Maximum contribution must be greater than zero')
    .custom((value, { req }) => {
      if (value && req.body.min_contribution && parseFloat(value) <= parseFloat(req.body.min_contribution)) {
        throw new Error('Maximum contribution must be greater than minimum contribution');
      }
      if (value && req.body.target_amount && parseFloat(value) > parseFloat(req.body.target_amount)) {
        throw new Error('Maximum contribution cannot exceed the target amount');
      }
      return true;
    }),
  body('max_per_user')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Per-contributor cap must be greater than zero')
    .custom((value, { req }) => {
      if (value && req.body.min_contribution && parseFloat(value) <= parseFloat(req.body.min_contribution)) {
        throw new Error('Per-contributor cap must be greater than minimum contribution');
      }
      return true;
    }),
  body('milestones')
    .optional({ nullable: true })
    .custom((value) => {
      if (value == null) return true; // eslint-disable-line eqeqeq
      if (!Array.isArray(value)) throw new Error('Milestones must be an array');
      if (value.length > 10) throw new Error('Campaigns can define at most 10 milestones');
      for (const [index, milestone] of value.entries()) {
        if (!milestone || typeof milestone !== 'object') {
          throw new Error(`Milestone ${index + 1} must be an object`);
        }
        if (!String(milestone.title || '').trim()) {
          throw new Error(`Milestone ${index + 1} title is required`);
        }
        const release = Number(milestone.release_percentage);
        if (!Number.isFinite(release) || release <= 0) {
          throw new Error(`Milestone ${index + 1} release percentage must be greater than zero`);
        }
      }
      return true;
    }),
  body('milestones.*.title').optional().customSanitizer(stripHtml),
  body('milestones.*.description').optional().customSanitizer(stripHtml),
  body('show_backer_amounts')
    .optional()
    .isBoolean()
    .withMessage('show_backer_amounts must be a boolean'),
  body('category')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(VALID_CATEGORIES)
    .withMessage(`category must be one of: ${VALID_CATEGORIES.join(', ')}`),
];

const createCampaignUpdateValidation = [
  body('title')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Title is required'),
  body('body')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Body is required'),
];

const contributionQuoteValidation = [
  query('send_asset')
    .notEmpty()
    .withMessage('send_asset is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`send_asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  query('dest_asset')
    .notEmpty()
    .withMessage('dest_asset is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`dest_asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  query('dest_amount')
    .notEmpty()
    .withMessage('dest_amount is required')
    .isFloat({ gt: 0 })
    .withMessage('dest_amount must be greater than zero'),
];

const contributionValidation = [
  body('campaign_id')
    .notEmpty()
    .withMessage('campaign_id is required')
    .custom((value) => {
      if (!isUuid(value)) throw new Error('campaign_id must be a valid UUID');
      return true;
    }),
  body('amount')
    .exists()
    .withMessage('amount is required')
    .isFloat({ gt: 0 })
    .withMessage('amount must be greater than zero'),
  body('send_asset')
    .notEmpty()
    .withMessage('send_asset is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`send_asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  body('display_name')
    .optional({ nullable: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 50 })
    .withMessage('Display name must be at most 50 characters'),
];

const withdrawalValidation = [
  body('campaign_id')
    .notEmpty()
    .withMessage('campaign_id is required')
    .custom((value) => {
      if (!isUuid(value)) throw new Error('campaign_id must be a valid UUID');
      return true;
    }),
  body('amount')
    .exists()
    .withMessage('amount is required')
    .isFloat({ gt: 0 })
    .withMessage('amount must be greater than zero'),
  body('destination_key')
    .notEmpty()
    .withMessage('destination_key is required')
    .custom((value) => {
      try {
        Keypair.fromPublicKey(value);
        return true;
      } catch (_err) {
        throw new Error('destination_key must be a valid Stellar public key');
      }
    }),
];

const getCampaignsValidation = [
  query('search').optional().customSanitizer(stripHtml),
  query('status')
    .optional()
    .isIn(VALID_CAMPAIGN_STATUSES)
    .withMessage(`status must be one of: ${VALID_CAMPAIGN_STATUSES.join(', ')}`),
  query('asset')
    .optional()
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  query('category')
    .optional()
    .isIn(VALID_CATEGORIES)
    .withMessage(`category must be one of: ${VALID_CATEGORIES.join(', ')}`),
  query('sort')
    .optional()
    .isIn(VALID_ORDER_BY)
    .withMessage(`sort must be one of: ${VALID_ORDER_BY.join(', ')}`),
  query('limit')
    .optional()
    .toInt()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be a positive integer up to 100'),
  query('offset')
    .optional()
    .toInt()
    .isInt({ min: 0 })
    .withMessage('offset must be a non-negative integer'),
];

function validateRequest(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  return res.status(400).json({ errors: result.array() });
}

function validateRequestAsError(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  return res.status(400).json({ error: result.array()[0].msg });
}

module.exports = {
  VALID_CAMPAIGN_STATUSES,
  VALID_ORDER_BY,
  registerValidation,
  loginValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  passwordValidation,
  validateRequestAsError,
  createCampaignValidation,
  createCampaignUpdateValidation,
  contributionValidation,
  contributionQuoteValidation,
  withdrawalValidation,
  getCampaignsValidation,
  validateRequest,
};
