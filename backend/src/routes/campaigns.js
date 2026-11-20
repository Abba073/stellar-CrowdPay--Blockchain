const express = require('express');
const router = require('express').Router();
const { NOT_DELETED, findVisibleCampaign } = require('../utils/campaignVisibility');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const {
  createCampaignWallet,
  getCampaignBalance,
  getSupportedAssetCodes,
} = require('../services/stellarService');
const { watchCampaignWallet, addSSEClient, removeSSEClient } = require('../services/ledgerMonitor');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { refreshCampaignStatus, refreshActiveCampaignStatuses } = require('../services/campaignStatusService');
const { queueFailedCampaignRefunds } = require('../services/campaignStatusActions');
const { provisionCampaignContracts } = require('../services/sorobanService');
const { isValidContractId, isSorobanEnabled } = require('../services/sorobanService');
const { sendEmailSafe } = require('../services/emailService');
const { uploadCampaignCoverImage } = require('../services/storage');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const { listCreatorCampaigns } = require('../services/userDashboardService');
const { encryptSecret } = require('../services/walletService');
const {
  createCampaignValidation,
  getCampaignsValidation,
  validateRequest,
} = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');
const { decodeCursor, pageWithCursor } = require('../utils/pagination');

/** Listing sorts that support keyset (cursor) pagination. */
const KEYSET_SORTS = {
  newest: { name: 'newest', column: 'c.created_at', cast: 'timestamptz' },
  most_funded: { name: 'most_funded', column: 'c.raised_amount', cast: 'numeric' },
};
const cache = require('../utils/cache');

const crypto = require('crypto');
const { sendErrorResponse } = require('../middleware/errorHandler');

async function provisionSorobanContracts(campaign, creatorPublicKey, milestones) {
  try {
    const contracts = await provisionCampaignContracts({
      campaignId: campaign.id,
      creatorPublicKey,
      targetAmount: campaign.target_amount,
      assetType: campaign.asset_type,
      deadline: campaign.deadline,
      milestones,
    });
    if (!contracts) {
      logger.warn('Soroban provisioning not configured; campaign left pending', { campaign_id: campaign.id });
      return;
    }
    // Never persist a malformed contract id: a typo here would only surface
    // later during fund release, potentially locking the campaign.
    if (!isValidContractId(contracts.escrowContractId) || !isValidContractId(contracts.milestonesContractId)) {
      logger.error('Soroban provisioning returned invalid contract ids', {
        campaign_id: campaign.id,
        escrow_contract_id: contracts.escrowContractId,
        milestones_contract_id: contracts.milestonesContractId,
      });
      await db
        .query("UPDATE campaigns SET soroban_status = 'failed' WHERE id = $1", [campaign.id])
        .catch(() => {});
      return;
    }
    await db.query(
      `UPDATE campaigns
       SET escrow_contract_id = $1, milestones_contract_id = $2, soroban_status = 'verified'
       WHERE id = $3`,
      [contracts.escrowContractId, contracts.milestonesContractId, campaign.id]
    );
  } catch (err) {
    logger.error('Soroban contract provisioning failed', { campaign_id: campaign.id, error: err.message });
    await db
      .query("UPDATE campaigns SET soroban_status = 'failed' WHERE id = $1", [campaign.id])
      .catch(() => {});
  }
}

function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, '').trim();
}

/**
 * Validate admin/env-supplied Soroban contract ids before they are persisted.
 * Returns an error message string when invalid, otherwise null.
 */
function validateContractIdsInput({ escrow_contract_id, milestones_contract_id }) {
  const fields = {
    escrow_contract_id,
    milestones_contract_id,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (!isValidContractId(value)) {
      return `${field} must be a valid Soroban contract id (StrKey starting with "C", 56 characters)`;
    }
  }
  return null;
}

/**
 * @openapi
 * tags:
 *   - name: Campaigns
 *     description: Campaign discovery and management
 */

const requireCampaignMember = (...allowedRoles) => {
  return asyncHandler(async (req, res, next) => {
    const campaignId = req.params.id || req.params.campaign_id || req.body.campaign_id;
    if (!campaignId) return sendErrorResponse(res, 400, 'Campaign ID is required');

    if (!req.user || !req.user.userId) {
      return sendErrorResponse(res, 401, 'Unauthorized');
    }

    const { rows: campaignRows } = await db.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) {
      return sendErrorResponse(res, 404, 'Campaign not found');
    }
    const campaign = campaignRows[0];

    if (req.user.role === 'admin') {
      req.campaignRole = 'owner';
      return next();
    }

    const { rows: memberRows } = await db.query(
      'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
      [campaignId, req.user.userId]
    );

    let role = null;
    if (memberRows.length && memberRows[0].accepted_at) {
      role = memberRows[0].role;
    } else if (campaign.creator_id === req.user.userId) {
      role = 'owner';
    }

    if (!role || (allowedRoles.length && !allowedRoles.includes(role))) {
      return sendErrorResponse(res, 403, 'Insufficient permissions for this campaign');
    }

    req.campaignRole = role;
    next();
  });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Invalid image type. Only JPG, PNG and WEBP are allowed.'));
    }
    cb(null, true);
  },
});

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const MILESTONE_PERCENT_SCALE = 10000;
const MILESTONE_LIMIT = 5;

// Text-heavy campaign routes accept markdown/description bodies; cap them tighter
// than the global JSON limit so oversized payloads fail fast with a 413.
const campaignBodyParser = express.json({ limit: '10kb' });

const isTest = process.env.NODE_ENV === 'test';

// Rate limiter for public read-only endpoints (backers, etc.)
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

function normalizeMilestonesInput(input) {
  if (input == null) return []; // eslint-disable-line eqeqeq
  if (!Array.isArray(input)) {
    throw new Error('milestones must be an array');
  }
  if (input.length === 0) return [];
  if (input.length > MILESTONE_LIMIT) {
    throw new Error(`Campaigns can define at most ${MILESTONE_LIMIT} milestones`);
  }

  const normalized = input.map((milestone, index) => {
    const title = String(milestone?.title || '').trim();
    const description = String(milestone?.description || '').trim();
    if (!title) {
      throw new Error(`Milestone ${index + 1} title is required`);
    }
    if (!description) {
      throw new Error(`Milestone ${index + 1} description is required`);
    }

    const releasePercentage = Number(milestone?.release_percentage);
    if (!Number.isFinite(releasePercentage) || releasePercentage <= 0) {
      throw new Error(`Milestone ${index + 1} release_percentage must be greater than zero`);
    }

    return {
      title,
      description,
      release_percentage: releasePercentage.toFixed(4),
      release_percentage_units: Math.round(releasePercentage * MILESTONE_PERCENT_SCALE),
      sort_order: index,
    };
  });

  const totalUnits = normalized.reduce((sum, milestone) => sum + milestone.release_percentage_units, 0);
  if (totalUnits !== 100 * MILESTONE_PERCENT_SCALE) {
    throw new Error('Milestone release percentages must sum to exactly 100%');
  }

  return normalized;
}

// List campaigns with optional search, filtering, sorting, and pagination
router.get('/', getCampaignsValidation, validateRequest, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns:
   *   get:
   *     tags: [Campaigns]
   *     summary: List campaigns
   *     parameters:
   *       - in: query
   *         name: status
   *         schema: { type: string }
   *       - in: query
   *         name: asset
   *         schema: { type: string }
   *       - in: query
   *         name: search
   *         schema: { type: string }
   *       - in: query
   *         name: sort
   *         schema: { type: string }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 50 }
   *       - in: query
   *         name: offset
   *         schema: { type: integer, minimum: 0 }
   *         description: Legacy offset paging. Prefer `cursor` for sort=newest / most_funded.
   *       - in: query
   *         name: cursor
   *         schema: { type: string }
   *         description: Opaque `next_cursor` from the previous page (sort=newest or most_funded).
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 total: { type: integer, description: Only on the first page }
   *                 limit: { type: integer }
   *                 offset: { type: integer, description: Only for offset-paged requests }
   *                 next_cursor: { type: string, nullable: true }
   *                 campaigns:
   *                   type: array
   *                   items:
   *                     type: object
   */
  const { search, status, asset, category, sort = 'newest' } = req.query;
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const filters = [];
  const params = [];

  // Exclude deleted campaigns from public listing
  filters.push(`c.deleted_at IS NULL`);

  if (status) {
    params.push(status);
    filters.push(`c.status = $${params.length}`);
  } else {
    filters.push(`c.status = 'active'`);
  }
  if (asset) {
    params.push(asset);
    filters.push(`c.asset_type = $${params.length}`);
  }
  let searchParam = null;
  if (search && String(search).trim()) {
    searchParam = String(search).trim();
    params.push(searchParam);
    // Use PostgreSQL full-text search via the generated tsvector column (search_vector)
    // set up by migration 20260602_campaign_search_vector.sql.
    // plainto_tsquery handles multi-word queries and is injection-safe.
    filters.push(`c.search_vector @@ plainto_tsquery('english', $${params.length})`);
  if (category) {
    params.push(category);
    filters.push(`c.category = $${params.length}`);
  }
  if (search) {
    const escaped = String(search).replace(/[%_\\]/g, '\\$&');
    params.push(`%${escaped}%`);
    filters.push(
      `(c.title ILIKE $${params.length} OR COALESCE(c.description, '') ILIKE $${params.length})`
    );
  }

  // Keyset (cursor) pagination for the hot sorts: a page is an index range
  // scan on (sort value, id) instead of scanning and discarding OFFSET rows.
  // Clients still paging with ?offset=N keep the legacy path.
  const cursorParam = req.query.cursor;
  const keyset = KEYSET_SORTS[sort] && (cursorParam !== undefined || offset === 0) ? KEYSET_SORTS[sort] : null;
  if (cursorParam !== undefined && !keyset) {
    return sendErrorResponse(res, 400, `cursor is only supported for sort=${Object.keys(KEYSET_SORTS).join(' or ')}`);
  }

  // The full count is only computed for the first page.
  let total;
  if (cursorParam === undefined) {
    const countWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countResult = await db.query(`SELECT COUNT(*)::int AS total FROM campaigns c ${countWhere}`, params);
    total = countResult.rows[0]?.total || 0;
  }

  if (keyset) {
    if (cursorParam !== undefined) {
      let cursor;
      try {
        cursor = decodeCursor(cursorParam, keyset.name);
      } catch (err) {
        return sendErrorResponse(res, 400, err.message, undefined, 'INVALID_CURSOR');
      }
      params.push(cursor.value, cursor.id);
      filters.push(`(${keyset.column}, c.id) < ($${params.length - 1}::${keyset.cast}, $${params.length}::uuid)`);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT c.*,
              ${keyset.column}::text AS _cursor_value,
              u.name AS creator_name,
              u.kyc_status AS creator_kyc_status,
              (SELECT COUNT(*)::int FROM campaign_updates cu WHERE cu.campaign_id = c.id) AS updates_count,
              (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions con WHERE con.campaign_id = c.id) AS contributor_count
         FROM campaigns c
         JOIN users u ON u.id = c.creator_id
         ${whereClause}
        ORDER BY ${keyset.column} DESC, c.id DESC
        LIMIT $${params.length + 1}`,
      [...params, limit + 1]
    );
    const { page, nextCursor } = pageWithCursor(rows, limit, { sort: keyset.name });
    return res.json({
      ...(total !== undefined && { total }),
      limit,
      next_cursor: nextCursor,
      campaigns: page,
    });
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sortExpressions = {
    newest: 'c.created_at DESC',
    ending_soon: 'c.deadline ASC NULLS LAST',
    most_funded: 'c.raised_amount DESC',
    most_backed: '(SELECT COUNT(*) FROM contributions ctr WHERE ctr.campaign_id = c.id) DESC',
    closest_to_goal: '(c.raised_amount / NULLIF(c.target_amount, 0)) DESC NULLS LAST, c.raised_amount DESC',
    trending:
      "(SELECT COUNT(*) FROM contributions ctr WHERE ctr.campaign_id = c.id AND ctr.created_at >= NOW() - INTERVAL '7 days') DESC, c.created_at DESC",
  };

  // When a search query is present, order by relevance (ts_rank) first, then the selected sort.
  // ts_rank requires a separate parameter reference to the tsquery.
  let orderBy;
  let queryParams;
  if (searchParam) {
    params.push(searchParam); // additional param for ts_rank
    const rankParamIdx = params.length;
    orderBy = `ts_rank(c.search_vector, plainto_tsquery('english', $${rankParamIdx})) DESC, ${sortExpressions[sort] || sortExpressions.newest}`;
    queryParams = [...params, limit, offset];
  } else {
    orderBy = sortExpressions[sort] || sortExpressions.newest;
    queryParams = [...params, limit, offset];
  }

  const query = `
    SELECT c.*,
           u.name AS creator_name,
           u.kyc_status AS creator_kyc_status,
           (SELECT COUNT(*)::int FROM campaign_updates cu WHERE cu.campaign_id = c.id) AS updates_count,
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions con WHERE con.campaign_id = c.id) AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $${queryParams.length - 1}
    OFFSET $${queryParams.length}
  `;
  const result = await db.query(query, queryParams);

  const payload = { total, limit, offset, campaigns: result.rows };
  cache.set(cacheKey, payload, 30_000); // 30 s TTL
  res.json(payload);
}));

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const campaigns = await listCreatorCampaigns(req.user.userId);
  res.json(campaigns);
}));

/**
 * @openapi
 * /api/campaigns/categories:
 *   get:
 *     tags: [Campaigns]
 *     summary: List campaign categories with active campaign counts
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   category: { type: string }
 *                   count: { type: integer }
 */
// Cached for 5 minutes — invalidated when a new campaign is created with a category.
router.get('/categories', asyncHandler(async (req, res) => {
  const CATEGORIES_CACHE_KEY = 'campaigns:categories';
  const cached = cache.get(CATEGORIES_CACHE_KEY);
  if (cached) return res.json(cached);

  const { rows } = await db.query(
    `SELECT category, COUNT(*)::int AS count
     FROM campaigns
     WHERE deleted_at IS NULL
       AND status NOT IN ('draft', 'failed')
       AND category IS NOT NULL
     GROUP BY category
     ORDER BY count DESC, category ASC`
  );

  cache.set(CATEGORIES_CACHE_KEY, rows, 5 * 60 * 1000); // 5 min TTL
  res.json(rows);
}));

router.get('/:id/milestones', asyncHandler(async (req, res) => {
  if (!(await findVisibleCampaign(db, req.params.id))) {
    return sendErrorResponse(res, 404, 'Campaign not found');
  }
  const { rows } = await db.query(
    `SELECT m.*, (c.milestones_contract_id IS NOT NULL AND c.soroban_status = 'verified') AS on_chain
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.campaign_id = $1
     ORDER BY m.sort_order ASC, m.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.post('/:id/milestones', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  let normalizedMilestones;
  try {
    normalizedMilestones = normalizeMilestonesInput(req.body?.milestones);
  } catch (err) {
    return sendErrorResponse(res, 400, err.message);
  }

  if (!normalizedMilestones.length) {
    return sendErrorResponse(res, 400, 'At least one milestone is required');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: campaignRows } = await client.query(
      'SELECT id, creator_id, status FROM campaigns WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!campaignRows.length) {
      await client.query('ROLLBACK');
      return sendErrorResponse(res, 404, 'Campaign not found');
    }
    const campaign = campaignRows[0];
    if (campaign.creator_id !== req.user.userId) {
      await client.query('ROLLBACK');
      return sendErrorResponse(res, 403, 'Only the campaign creator can define milestones');
    }
    if (!['active', 'funded', 'in_progress'].includes(campaign.status)) {
      await client.query('ROLLBACK');
      return sendErrorResponse(res, 409, `Milestones cannot be edited while campaign status is "${campaign.status}".`);
    }

    const { rows: existingRows } = await client.query(
      'SELECT status FROM milestones WHERE campaign_id = $1',
      [campaign.id]
    );
    if (existingRows.some((row) => row.status !== 'pending')) {
      await client.query('ROLLBACK');
      return sendErrorResponse(res, 409, 'Milestone plan cannot be changed after approvals or releases begin');
    }

    await client.query('DELETE FROM milestones WHERE campaign_id = $1', [campaign.id]);
    const inserted = [];
    for (const milestone of normalizedMilestones) {
      const { rows } = await client.query(
        `INSERT INTO milestones
           (campaign_id, title, description, release_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          campaign.id,
          milestone.title,
          milestone.description,
          milestone.release_percentage,
          milestone.sort_order,
        ]
      );
      inserted.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Campaign milestone plan update failed', { campaign_id: req.params.id, error: err.message });
    sendErrorResponse(res, 500, 'Could not save campaign milestones');
  } finally {
    client.release();
  }
}));

// Get active campaign counts per category
router.get('/categories', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT category, COUNT(*)::int AS count
    FROM campaigns
    WHERE status = 'active' AND deleted_at IS NULL AND category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC, category ASC
  `);
  res.json(rows);
}));

// Get single Campaign
// Get featured campaigns
router.get('/featured', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`
    SELECT c.id, c.title, c.description, c.target_amount, c.raised_amount,
           c.asset_type, c.status, c.deadline, c.featured_note,
           u.name AS creator_name,
           (SELECT COUNT(*) FROM contributions WHERE campaign_id = c.id) AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    WHERE c.featured = TRUE AND c.status = 'active' AND c.deleted_at IS NULL
    ORDER BY c.featured_at DESC
    LIMIT 3
  `);
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns/{id}:
   *   get:
   *     tags: [Campaigns]
   *     summary: Get campaign by id
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *       404:
   *         description: Not found
   */
  // Only cache unauthenticated (public) requests — authenticated requests may
  // include a user_role field that is user-specific and must not be shared.
  const isAuthenticated = !!(req.headers.authorization);
  const campaignCacheKey = `campaigns:id:${req.params.id}`;
  if (!isAuthenticated) {
    const cached = cache.get(campaignCacheKey);
    if (cached) return res.json(cached);
  }

  const query = `
    SELECT *,
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions WHERE campaign_id = $1) AS contributor_count
    FROM campaigns
    WHERE id = $1
  `;
  const { rows } = await db.query(query, [req.params.id]);
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');
  
  const campaign = rows[0];
  
  // Allow viewing suspended campaigns with a notice, but deleted campaigns are not accessible
  if (campaign.deleted_at) {
    return sendErrorResponse(res, 404, 'Campaign not found');
  }
  
  let userRole = null;
  // Cumulative amount the authenticated caller has already contributed to this
  // campaign (enforced via campaign.max_per_user). 0 for anonymous callers.
  let userContributedAmount = 0;

  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (payload && payload.userId) {
          if (payload.is_admin) {
            userRole = 'owner';
          } else if (campaign.creator_id === payload.userId) {
            userRole = 'owner';
          } else {
            const { rows: memberRows } = await db.query(
              'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
              [campaign.id, payload.userId]
            );
            if (memberRows.length && memberRows[0].accepted_at) {
              userRole = memberRows[0].role;
            }
          }

          // Return the caller's cumulative contribution for this campaign so the
          // frontend can enforce the per-contributor cap from an authoritative total
          // instead of summing a (possibly truncated) contributions list client-side.
          const { rows: callerWalletRows } = await db.query(
            'SELECT wallet_public_key FROM users WHERE id = $1',
            [payload.userId]
          );
          const callerWalletPublicKey = callerWalletRows[0]?.wallet_public_key;
          if (callerWalletPublicKey) {
            const { rows: callerContributionRows } = await db.query(
              `SELECT COALESCE(SUM(amount), 0) AS total FROM contributions WHERE campaign_id = $1 AND sender_public_key = $2`,
              [req.params.id, callerWalletPublicKey]
            );
            userContributedAmount = Number(callerContributionRows[0]?.total ?? 0);
          }
        }
      } catch (err) {
        // Ignore invalid token for public route
      }
    }
  }

  // Add notice if campaign is suspended
  const response = { ...campaign, user_role: userRole, user_contributed_amount: userContributedAmount };
  if (campaign.status === 'suspended') {
    response.suspended_notice = 'This campaign has been suspended and cannot receive new contributions';
  }

  // Cache only unauthenticated responses (no user-specific data) for 15 s.
  // Invalidated by ledgerMonitor after each contribution is indexed.
  if (!isAuthenticated) {
    cache.set(campaignCacheKey, response, 15_000);
  }

  res.json(response);
}));

// Embeddable campaign widget data (public, with permissive CORS)
router.get('/:id/embed', asyncHandler(async (req, res) => {
  // Allow this endpoint to be accessed from any origin for embedding
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  const campaignId = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `SELECT id, title, description, target_amount, raised_amount, asset_type, status,
            (SELECT COUNT(*)::int FROM contributions c WHERE c.campaign_id = campaigns.id) AS backer_count
     FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`,
    [campaignId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');

  const campaign = rows[0];
  const pct = campaign.target_amount
    ? Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100)
    : 0;

  res.json({
    id: campaign.id,
    title: campaign.title,
    description: campaign.description?.slice(0, 200) + (campaign.description?.length > 200 ? '...' : ''),
    raised_amount: Number(campaign.raised_amount),
    target_amount: Number(campaign.target_amount),
    asset_type: campaign.asset_type,
    status: campaign.status,
    backer_count: campaign.backer_count,
    progress_percentage: Math.round(pct * 10) / 10,
    contribution_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${campaign.id}`,
  });
}));

// Get backers for a campaign
router.get('/:id/backers', publicReadLimiter, optionalAuth, asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { rows: campaignRows } = await db.query(
    `SELECT show_backer_amounts, creator_id FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`,
    [campaignId]
  );
  if (!campaignRows.length) return sendErrorResponse(res, 404, 'Campaign not found');
  const { show_backer_amounts, creator_id } = campaignRows[0];

  // Determine if the requester is privileged (admin or campaign organizer)
  const requestUserId = req.user?.userId;
  const isAdmin = req.user?.is_admin === true;
  const isOrganizer = requestUserId && (
    requestUserId === creator_id ||
    (await db.query(
      `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
      [campaignId, requestUserId]
    )).rows.length > 0
  );
  const isPrivileged = isAdmin || isOrganizer;

  const { rows } = await db.query(
    `SELECT
       display_name,
       sender_public_key,
       ${show_backer_amounts ? 'amount,' : ''}
       asset,
       created_at,
       wr.status AS refund_status,
       wr.tx_hash AS refund_tx_hash
     FROM contributions c
     LEFT JOIN LATERAL (
       SELECT status, tx_hash
       FROM withdrawal_requests
       WHERE contribution_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) wr ON TRUE
     WHERE c.campaign_id = $1
     ORDER BY c.created_at DESC`,
    [campaignId]
  );

  // Redact sensitive fields for non-privileged callers
  const responseRows = rows.map((row) => {
    if (isPrivileged) return row;
    const { sender_public_key: _spk, refund_status: _rs, refund_tx_hash: _rth, ...publicRow } = row;
    return publicRow;
  });

  res.json(responseRows);
}));

// SSE stream for real-time campaign funding updates
router.get('/:id/stream', asyncHandler(async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const { rows } = await db.query(`SELECT id FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`, [campaignId]);
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write('data: {"type":"connected"}\n\n');

  addSSEClient(campaignId, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSSEClient(campaignId, res);
  });
}));

// Get live on-chain balance for a campaign
router.get('/:id/balance', asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns/{id}/balance:
   *   get:
   *     tags: [Campaigns]
   *     summary: Get live on-chain balance for a campaign wallet
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   asset_type: { type: string }
   *                   balance: { type: string }
   *       404:
   *         description: Campaign not found
   */
  const { rows } = await db.query(
    `SELECT wallet_public_key FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`,
    [req.params.id]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');
  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json(balance);
}));

// Scheduled endpoint to fail expired campaigns and prevent further contributions
router.post('/cron/fail-expired', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { failed, funded } = await refreshActiveCampaignStatuses();
  res.json({ failedCampaigns: failed, fundedCampaigns: funded });
}));

// Authorized on-demand endpoint to refresh campaign status
router.post('/:id/refresh-status', requireAuth, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns/{id}/refresh-status:
   *   post:
   *     tags: [Campaigns]
   *     summary: Refresh campaign status on demand (authorized)
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Status refreshed
   *       403:
   *         description: Forbidden
   *       404:
   *         description: Not found
   */
  const { id } = req.params;
  const { rows } = await db.query('SELECT creator_id, status FROM campaigns WHERE id = $1', [id]);
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');

  const isOwner = rows[0].creator_id === req.user.userId;
  const isAdmin = req.user.role === 'admin' || req.user.is_admin;
  if (!isOwner && !isAdmin) {
    return sendErrorResponse(res, 403, 'You do not have permission to refresh this campaign status');
  }

  const result = await refreshCampaignStatus(id);
  const { rows: updatedRows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [id]);
  res.json({ campaign: updatedRows[0], statusResult: result });
}));

// Scheduled endpoint to send 48h deadline reminders
router.post('/cron/reminders', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  // Find campaigns ending in exactly 2 days that are still active
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.deadline, u.email as creator_email
     FROM campaigns c
     JOIN users u ON c.creator_id = u.id
     WHERE c.status = 'active'
       AND c.deadline = CURRENT_DATE + INTERVAL '2 days'`
  );

  for (const campaign of rows) {
    sendEmailSafe({
      to: campaign.creator_email,
      subject: `Reminder: Campaign "${campaign.title}" ends in 48 hours`,
      text: `Your campaign "${campaign.title}" is approaching its deadline on ${new Date(campaign.deadline).toDateString()}. 
If your target is reached, you can request a withdrawal. Otherwise, contributions will be refunded.`
    });
  }

  res.json({ remindersSent: rows.length });
}));

// Trigger refund withdrawal requests for a failed campaign
router.post('/:id/trigger-refunds', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { rows: campaigns } = await db.query(
    `SELECT id, wallet_public_key, status FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!campaigns.length) return sendErrorResponse(res, 404, 'Campaign not found');
  const campaign = campaigns[0];
  if (campaign.status !== 'failed') {
    return sendErrorResponse(res, 409, 'Refunds may only be triggered for failed campaigns');
  }

  try {
    const { refundsCreated, refunds } = await queueFailedCampaignRefunds(campaignId, req.user.userId);
    if (refundsCreated === 0) {
      return res.json({ refundsCreated: 0 });
    }
    res.status(201).json({ refundsCreated, refunds });
  } catch (err) {
    logger.error('Refund trigger failed', { campaign_id: campaignId, error: err.message });
    sendErrorResponse(res, 500, 'Could not trigger refunds for campaign');
  }
}));

// Create campaign (authenticated)
router.post('/', requireAuth, requireRole('creator', 'admin'), idempotency, createCampaignValidation, validateRequest, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/campaigns:
   *   post:
   *     tags: [Campaigns]
   *     summary: Create campaign
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [title, target_amount, asset_type]
   *             properties:
   *               title: { type: string }
   *               description: { type: string, nullable: true }
   *               target_amount: { type: string }
   *               asset_type: { type: string }
   *               deadline: { type: string, nullable: true }
   *               milestones: { type: array, items: { type: object }, nullable: true }
   *               min_contribution: { type: string, nullable: true }
   *               max_contribution: { type: string, nullable: true }
   *     responses:
   *       201:
   *         description: Created
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden
   */
  const {
    title,
    description,
    target_amount,
    asset_type,
    deadline,
    milestones,
    min_contribution,
    max_contribution,
    escrow_contract_id,
    milestones_contract_id,
  } = req.body;

  if (isSorobanEnabled()) {
    const contractIdError = validateContractIdsInput({ escrow_contract_id, milestones_contract_id });
    if (contractIdError) {
      return sendErrorResponse(res, 400, contractIdError, undefined, 'INVALID_CONTRACT_ID');
    }
  }

  let normalizedMilestones;
  try {
    normalizedMilestones = normalizeMilestonesInput(milestones);
  } catch (err) {
    return sendErrorResponse(res, 400, err.message);
  }

  // Get creator's info
  const { rows: userRows } = await db.query(
    'SELECT email, wallet_public_key, kyc_status, email_verified FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!userRows.length) return sendErrorResponse(res, 404, 'User not found');

  if (!userRows[0].email_verified) {
    return sendErrorResponse(res, 403, 'You must verify your email address before creating a campaign.', undefined, 'EMAIL_NOT_VERIFIED');
  }

  if (isKycRequiredForCampaigns() && userRows[0].kyc_status !== 'verified') {
    return sendErrorResponse(res, 403, 'Verify your identity before creating a campaign.', undefined, 'KYC_REQUIRED', { kyc_status: userRows[0].kyc_status });
  }

  const creatorPublicKey = userRows[0].wallet_public_key;
  const creatorEmail = userRows[0].email;

  // 1. Create the on-chain campaign wallet
  const wallet = await createCampaignWallet(creatorPublicKey);

  const client = await db.connect();
  let campaign;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO campaigns
         (title, description, target_amount, asset_type, wallet_public_key, wallet_secret_encrypted,
          creator_id, deadline, min_contribution, max_contribution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [title, description, target_amount, asset_type, wallet.publicKey,
       encryptSecret(wallet.secret), req.user.userId, deadline,
       min_contribution || null, max_contribution || null]
    );
    campaign = rows[0];

    await client.query(
      `INSERT INTO campaign_members
         (campaign_id, user_id, email, role, accepted_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [campaign.id, req.user.userId, creatorEmail, 'owner']
    );

    for (const milestone of normalizedMilestones) {
      await client.query(
        `INSERT INTO milestones
           (campaign_id, title, description, release_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          campaign.id,
          milestone.title,
          milestone.description,
          milestone.release_percentage,
          milestone.sort_order,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[campaigns] DB insert failed after wallet creation. Orphaned wallet:', {
      publicKey: wallet.publicKey,
      creatorUserId: req.user.userId,
      error: err.message,
    });
    return sendErrorResponse(res, 500, 'Campaign could not be saved. Wallet creation may have succeeded — contact support.');
  } finally {
    client.release();
  }

  watchCampaignWallet(campaign.id, wallet.publicKey);

  // Invalidate the public campaign list and categories caches so the new campaign
  // appears immediately on the next request.
  cache.invalidatePrefix('campaigns:list:');
  cache.invalidate('campaigns:categories');

  // Contracts are deployed in the background; the campaign stays soroban_status='pending'
  // (on_chain=false) until deploy + initialize + verification all succeed.
  provisionSorobanContracts(campaign, creatorPublicKey, normalizedMilestones);

  res.status(201).json(campaign);
}));

// PATCH /campaigns/:id - Update campaign (title, description, deadline)
router.patch('/:id', campaignBodyParser, requireAuth, asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { title, description, deadline, escrow_contract_id, milestones_contract_id } = req.body;

  if (isSorobanEnabled()) {
    const contractIdError = validateContractIdsInput({ escrow_contract_id, milestones_contract_id });
    if (contractIdError) {
      return sendErrorResponse(res, 400, contractIdError, undefined, 'INVALID_CONTRACT_ID');
    }
  }

  // Check if campaign exists and belongs to user
  const { rows: campaignRows } = await db.query(
    'SELECT * FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaignRows.length) {
    return sendErrorResponse(res, 404, 'Campaign not found');
  }

  const campaign = campaignRows[0];
  if (campaign.creator_id !== req.user.userId) {
    return sendErrorResponse(res, 403, 'You do not have permission to edit this campaign');
  }

  // Refresh campaign status to check current state
  await refreshCampaignStatus(campaignId);

  const { rows: updatedStatusRows } = await db.query(
    'SELECT status FROM campaigns WHERE id = $1',
    [campaignId]
  );
  const currentStatus = updatedStatusRows[0].status;

  // Only allow editing active or funded campaigns
  if (!['active', 'funded'].includes(currentStatus)) {
    return sendErrorResponse(res, 422, `Cannot edit a campaign with status: ${currentStatus}`);
  }

  // Validate and prepare update object
  const updates = {};
  const updateParams = [];
  let paramIndex = 1;

  if (title !== undefined) {
    const cleanTitle = stripHtml(title);
    if (!cleanTitle) {
      return sendErrorResponse(res, 422, 'Title cannot be empty');
    }
    if (cleanTitle.length > 100) {
      return sendErrorResponse(res, 422, 'Title must be at most 100 characters');
    }
    updates.title = cleanTitle;
    updateParams.push(['title', cleanTitle, `$${paramIndex++}`]);
  }

  if (description !== undefined) {
    const cleanDesc = stripHtml(description);
    if (cleanDesc.length > 1000) {
      return sendErrorResponse(res, 422, 'Description must be at most 1000 characters');
    }
    updates.description = cleanDesc;
    updateParams.push(['description', cleanDesc, `$${paramIndex++}`]);
  }

  if (deadline !== undefined && deadline !== null && deadline !== '') {
    // Validate ISO8601 format
    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime())) {
      return sendErrorResponse(res, 422, 'Deadline must be a valid date');
    }

    // Check deadline is not in the past
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    deadlineDate.setHours(0, 0, 0, 0);

    if (deadlineDate < today) {
      return sendErrorResponse(res, 422, 'Deadline cannot be in the past');
    }

    updates.deadline = deadline;
    updateParams.push(['deadline', deadline, `$${paramIndex++}`]);
  }

  if (escrow_contract_id !== undefined) {
    updates.escrow_contract_id = escrow_contract_id || null;
    updateParams.push(['escrow_contract_id', escrow_contract_id || null, `$${paramIndex++}`]);
  }

  if (milestones_contract_id !== undefined) {
    updates.milestones_contract_id = milestones_contract_id || null;
    updateParams.push(['milestones_contract_id', milestones_contract_id || null, `$${paramIndex++}`]);
  }

  // Check if any valid updates were provided
  if (Object.keys(updates).length === 0) {
    return sendErrorResponse(res, 400, 'No valid fields to update');
  }

  // Check for invalid fields in request body
  const allowedFields = ['title', 'description', 'deadline', 'escrow_contract_id', 'milestones_contract_id'];
  for (const field of Object.keys(req.body)) {
    if (!allowedFields.includes(field)) {
      return sendErrorResponse(res, 422, `Cannot update field: ${field}`);
    }
  }

  // Build and execute update query
  const setClause = updateParams.map(([field, , placeholder]) => `${field} = ${placeholder}`).join(', ');
  const values = updateParams.map(([, value]) => value);
  values.push(campaignId);
  values.push(req.user.userId);

  const query = `
    UPDATE campaigns
    SET ${setClause}
    WHERE id = $${paramIndex} AND creator_id = $${paramIndex + 1}
    RETURNING *
  `;

  const { rows: updatedRows } = await db.query(query, values);
  if (!updatedRows.length) {
    return sendErrorResponse(res, 404, 'Campaign not found');
  }

  res.json(updatedRows[0]);
}));

router.post(
  '/:id/cover-image',
  requireAuth,
  requireCampaignMember('owner'),
  (req, res, next) => {
    upload.single('cover_image')(req, res, (err) => {
      if (err) {
        return sendErrorResponse(res, 422, err.message || 'Invalid cover image upload', {
          cover_image: err.message || 'Invalid file',
        });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return sendErrorResponse(res, 422, 'cover_image is required', {
        cover_image: 'No image uploaded',
      });
    }

    try {
      const coverImageUrl = await uploadCampaignCoverImage(req.params.id, req.file);
      const { rows: updatedRows } = await db.query(
        'UPDATE campaigns SET cover_image_url = $1 WHERE id = $2 RETURNING *',
        [coverImageUrl, req.params.id]
      );
      res.json(updatedRows[0]);
    } catch (err) {
      return sendErrorResponse(res, 500, 'Could not upload campaign cover image');
    }
  }
);

// POST /campaigns/:id/members — owner invites a user by email
router.post('/:id/members', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return sendErrorResponse(res, 422, 'Email and role are required');
  if (!['owner', 'manager', 'viewer'].includes(role)) {
    return sendErrorResponse(res, 422, 'Invalid role. Must be owner, manager, or viewer');
  }

  const { rows: users } = await db.query('SELECT id FROM users WHERE email = $1', [email.trim()]);
  const inviteeUserId = users.length ? users[0].id : null;

  const { rows: existing } = await db.query(
    'SELECT id, accepted_at FROM campaign_members WHERE campaign_id = $1 AND email = $2',
    [req.params.id, email.trim()]
  );
  if (existing.length) {
    if (existing[0].accepted_at) {
      return sendErrorResponse(res, 409, 'User is already a member of this campaign');
    } else {
      return sendErrorResponse(res, 409, 'Invitation already sent to this user');
    }
  }

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const { rows: memberRows } = await db.query(
    `INSERT INTO campaign_members (campaign_id, user_id, email, role, invited_by, invite_token, invite_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, campaign_id, email, role, created_at`,
    [req.params.id, inviteeUserId, email.trim(), role, req.user.userId, inviteToken, inviteExpiresAt]
  );

  const campaignUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}/invite/${inviteToken}`;
  try {
    await sendEmailSafe({
      to: email.trim(),
      subject: `Invitation to join campaign team`,
      text: `You have been invited to join a campaign as a ${role}. Click here to accept: ${campaignUrl}`,
    });
  } catch (e) {
    logger.error('Failed to send invite email', {
      campaign_id: req.params.id,
      error: e.message || String(e),
    });
  }

  res.status(201).json(memberRows[0]);
}));

// GET /campaigns/:id/members — list current team (owner only)
router.get('/:id/members', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT cm.id, cm.user_id, cm.email, cm.role, cm.accepted_at, cm.created_at,
            u.name AS user_name
     FROM campaign_members cm
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.campaign_id = $1
     ORDER BY cm.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
}));

// PATCH /campaigns/:id/members/:userId — change role (owner only)
router.patch('/:id/members/:userId', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!role || !['owner', 'manager', 'viewer'].includes(role)) {
    return sendErrorResponse(res, 422, 'Invalid role. Must be owner, manager, or viewer');
  }

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET role = $1
     WHERE campaign_id = $2 AND user_id = $3
     RETURNING id, campaign_id, user_id, role, accepted_at`,
    [role, req.params.id, req.params.userId]
  );

  if (!rows.length) {
    return sendErrorResponse(res, 404, 'Member not found');
  }

  res.json(rows[0]);
}));

// DELETE /campaigns/:id/members/:userId — remove member or self-leave
router.delete('/:id/members/:userId', requireAuth, asyncHandler(async (req, res) => {
  const memberUserId = req.params.userId;
  const isSelf = String(memberUserId) === String(req.user.userId);

  let isOwner = false;
  if (req.user.role === 'admin') {
    isOwner = true;
  } else {
    const { rows: ownerRows } = await db.query(
      `SELECT role, accepted_at FROM campaign_members
       WHERE campaign_id = $1 AND user_id = $2 AND role = 'owner'`,
      [req.params.id, req.user.userId]
    );
    if (ownerRows.length && ownerRows[0].accepted_at) isOwner = true;

    const { rows: creatorRows } = await db.query(
      `SELECT creator_id FROM campaigns WHERE id = $1`,
      [req.params.id]
    );
    if (creatorRows.length && creatorRows[0].creator_id === req.user.userId) isOwner = true;
  }

  if (!isSelf && !isOwner) {
    return sendErrorResponse(res, 403, 'Insufficient permissions');
  }

  const { rows } = await db.query(
    `DELETE FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2
     RETURNING id`,
    [req.params.id, memberUserId]
  );

  if (!rows.length) {
    return sendErrorResponse(res, 404, 'Member not found');
  }

  res.json({ message: 'Member removed successfully' });
}));

// POST /campaigns/:id/members/accept — accept invitation (token-based)
router.post('/:id/members/accept', requireAuth, asyncHandler(async (req, res) => {
  const { token: inviteToken } = req.body;
  if (!inviteToken) return sendErrorResponse(res, 422, 'Invitation token is required');

  const { rows: invites } = await db.query(
    `SELECT id, accepted_at, email, invite_expires_at FROM campaign_members
     WHERE campaign_id = $1 AND invite_token = $2`,
    [req.params.id, inviteToken]
  );

  if (!invites.length) {
    return sendErrorResponse(res, 404, 'Invalid invitation token');
  }
  if (invites[0].accepted_at) {
    return sendErrorResponse(res, 409, 'Invitation already accepted');
  }

  // Check invite expiry
  if (invites[0].invite_expires_at && new Date(invites[0].invite_expires_at) < new Date()) {
    return sendErrorResponse(res, 410, 'Invitation has expired');
  }

  // Enforce identity binding: the accepting user must own the invited email address.
  // Look up the current user's email from the DB — the JWT payload does not carry it.
  const { rows: userRows } = await db.query(
    'SELECT email FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!userRows.length) {
    return sendErrorResponse(res, 401, 'Authenticated user not found');
  }
  const currentUserEmail = userRows[0].email.toLowerCase().trim();
  const invitedEmail = (invites[0].email || '').toLowerCase().trim();

  if (!invitedEmail || currentUserEmail !== invitedEmail) {
    return sendErrorResponse(res, 403, 'This invitation was sent to a different email address');
  }

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET user_id = $1, accepted_at = NOW(), invite_token = NULL
     WHERE id = $2
     RETURNING id, campaign_id, user_id, role, accepted_at`,
    [req.user.userId, invites[0].id]
  );

  res.json(rows[0]);
}));

// GET /campaigns/:id/analytics — campaign analytics
router.get('/:id/analytics', requireAuth, asyncHandler(async (req, res) => {
  const { rows: owner } = await db.query(`SELECT creator_id FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`, [req.params.id]);
  if (!owner.length) return sendErrorResponse(res, 404, 'Campaign not found');
  if (owner[0].creator_id !== req.user.userId && req.user.role !== 'admin') {
    return sendErrorResponse(res, 403, 'Not authorized to view analytics');
  }
  const { rows: dailyTotals } = await db.query(`
    SELECT
      DATE(created_at) AS day,
      COUNT(*)          AS contribution_count,
      SUM(amount)       AS total_amount,
      asset
    FROM contributions
    WHERE campaign_id = $1
      AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at), asset
    ORDER BY day ASC
  `, [req.params.id]);

  const { rows: assetBreakdown } = await db.query(`
    SELECT
      COALESCE(source_asset, asset) AS paid_with,
      COUNT(*)      AS count,
      SUM(COALESCE(source_amount, amount)) AS total_sent
    FROM contributions
    WHERE campaign_id = $1
    GROUP BY paid_with
  `, [req.params.id]);

  const { rows: topContributors } = await db.query(`
    SELECT sender_public_key, SUM(amount) AS total, COUNT(*) AS times
    FROM contributions
    WHERE campaign_id = $1
    GROUP BY sender_public_key
    ORDER BY total DESC
    LIMIT 5
  `, [req.params.id]);

  res.json({ dailyTotals, assetBreakdown, topContributors });
}));

module.exports = router;
