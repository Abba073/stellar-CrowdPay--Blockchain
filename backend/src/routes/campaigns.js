const router = require('express').Router();
const multer = require('multer');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, requireRole } = require('../middleware/auth');
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
const { sendEmail } = require('../services/emailService');
const { uploadCampaignCoverImage } = require('../services/storage');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const { listCreatorCampaigns } = require('../services/userDashboardService');
const {
  createCampaignValidation,
  createCampaignUpdateValidation,
  getCampaignsValidation,
  validateRequest,
} = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');

const crypto = require('crypto');

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
 * @openapi
 * tags:
 *   - name: Campaigns
 *     description: Campaign discovery and management
 */

const requireCampaignMember = (...allowedRoles) => {
  return asyncHandler(async (req, res, next) => {
    const campaignId = req.params.id || req.params.campaign_id || req.body.campaign_id;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required' });

    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
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
      return res.status(403).json({ error: 'Insufficient permissions for this campaign' });
    }

    req.campaignRole = role;
    next();
  });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
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

function normalizeMilestonesInput(input) {
  if (input == null) return [];
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
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 total: { type: integer }
   *                 limit: { type: integer }
   *                 offset: { type: integer }
   *                 campaigns:
   *                   type: array
   *                   items:
   *                     type: object
   */
  const { search, status, asset, sort = 'newest' } = req.query;
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
  if (search) {
    const escaped = String(search).replace(/[%_\\]/g, '\\$&');
    params.push(`%${escaped}%`);
    filters.push(
      `(c.title ILIKE $${params.length} OR COALESCE(c.description, '') ILIKE $${params.length})`
    );
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const countQuery = `SELECT COUNT(*)::int AS total FROM campaigns c ${whereClause}`;
  const countResult = await db.query(countQuery, params);
  const total = countResult.rows[0]?.total || 0;

  const sortExpressions = {
    newest: 'c.created_at DESC',
    ending_soon: 'c.deadline ASC NULLS LAST',
    most_funded: 'c.raised_amount DESC',
    most_backed: '(SELECT COUNT(*) FROM contributions ctr WHERE ctr.campaign_id = c.id) DESC',
    closest_to_goal: '(c.raised_amount / NULLIF(c.target_amount, 0)) DESC NULLS LAST, c.raised_amount DESC',
    trending:
      "(SELECT COUNT(*) FROM contributions ctr WHERE ctr.campaign_id = c.id AND ctr.created_at >= NOW() - INTERVAL '7 days') DESC, c.created_at DESC",
  };
  const orderBy = sortExpressions[sort] || sortExpressions.newest;

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
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;
  const result = await db.query(query, [...params, limit, offset]);

  res.json({ total, limit, offset, campaigns: result.rows });
}));

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const campaigns = await listCreatorCampaigns(req.user.userId);
  res.json(campaigns);
}));

router.get('/:id/milestones', asyncHandler(async (req, res) => {
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
    return res.status(400).json({ error: err.message });
  }

  if (!normalizedMilestones.length) {
    return res.status(400).json({ error: 'At least one milestone is required' });
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
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRows[0];
    if (campaign.creator_id !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the campaign creator can define milestones' });
    }
    if (!['active', 'funded', 'in_progress'].includes(campaign.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Milestones cannot be edited while campaign status is "${campaign.status}".` });
    }

    const { rows: existingRows } = await client.query(
      'SELECT status FROM milestones WHERE campaign_id = $1',
      [campaign.id]
    );
    if (existingRows.some((row) => row.status !== 'pending')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Milestone plan cannot be changed after approvals or releases begin' });
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
    res.status(500).json({ error: 'Could not save campaign milestones' });
  } finally {
    client.release();
  }
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
  const query = `
    SELECT *,
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions WHERE campaign_id = $1) AS contributor_count
    FROM campaigns
    WHERE id = $1
  `;
  await refreshCampaignStatus(req.params.id);
  const { rows } = await db.query(query, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  
  const campaign = rows[0];
  
  // Allow viewing suspended campaigns with a notice, but deleted campaigns are not accessible
  if (campaign.deleted_at) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  
  let userRole = null;

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
        }
      } catch (err) {
        // Ignore invalid token for public route
      }
    }
  }

  // Add notice if campaign is suspended
  const response = { ...campaign, user_role: userRole };
  if (campaign.status === 'suspended') {
    response.suspended_notice = 'This campaign has been suspended and cannot receive new contributions';
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
     FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

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
router.get('/:id/backers', asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { rows: campaignRows } = await db.query('SELECT show_backer_amounts FROM campaigns WHERE id = $1', [campaignId]);
  if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
  const { show_backer_amounts } = campaignRows[0];

  const query = `
    SELECT 
      display_name,
      sender_public_key,
      ${show_backer_amounts ? 'amount,' : ''}
      asset,
      created_at
    FROM contributions
    WHERE campaign_id = $1
    ORDER BY created_at DESC
  `;
  const { rows } = await db.query(query, [campaignId]);
  res.json(rows);
}));

// SSE stream for real-time campaign funding updates
router.get('/:id/stream', asyncHandler(async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

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
    'SELECT wallet_public_key FROM campaigns WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json(balance);
}));

// Scheduled endpoint to fail expired campaigns and prevent further contributions
router.post('/cron/fail-expired', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { failed, funded } = await refreshActiveCampaignStatuses();
  res.json({ failedCampaigns: failed, fundedCampaigns: funded });
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
    sendEmail({
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
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];
  if (campaign.status !== 'failed') {
    return res.status(409).json({ error: 'Refunds may only be triggered for failed campaigns' });
  }

  try {
    const { refundsCreated, refunds } = await queueFailedCampaignRefunds(campaignId, req.user.userId);
    if (refundsCreated === 0) {
      return res.json({ refundsCreated: 0 });
    }
    res.status(201).json({ refundsCreated, refunds });
  } catch (err) {
    logger.error('Refund trigger failed', { campaign_id: campaignId, error: err.message });
    res.status(500).json({ error: 'Could not trigger refunds for campaign' });
  }
}));

// Create campaign (authenticated)
router.post('/', requireAuth, requireRole('creator', 'admin'), createCampaignValidation, validateRequest, asyncHandler(async (req, res) => {
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
  const { title, description, target_amount, asset_type, deadline, milestones, min_contribution, max_contribution } = req.body;

  let normalizedMilestones;
  try {
    normalizedMilestones = normalizeMilestonesInput(milestones);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Get creator's info
  const { rows: userRows } = await db.query(
    'SELECT email, wallet_public_key, kyc_status FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!userRows.length) return res.status(404).json({ error: 'User not found' });
  
  if (isKycRequiredForCampaigns() && userRows[0].kyc_status !== 'verified') {
    return res.status(403).json({
      error: 'Verify your identity before creating a campaign.',
      code: 'KYC_REQUIRED',
      kyc_status: userRows[0].kyc_status,
    });
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
         (title, description, target_amount, asset_type, wallet_public_key, creator_id, deadline, 
          min_contribution, max_contribution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [title, description, target_amount, asset_type, wallet.publicKey, req.user.userId, deadline, 
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
    return res.status(500).json({
      error: 'Campaign could not be saved. Wallet creation may have succeeded — contact support.',
    });
  } finally {
    client.release();
  }

  watchCampaignWallet(campaign.id, wallet.publicKey);

  // Contracts are deployed in the background; the campaign stays soroban_status='pending'
  // (on_chain=false) until deploy + initialize + verification all succeed.
  provisionSorobanContracts(campaign, creatorPublicKey, normalizedMilestones);

  res.status(201).json(campaign);
}));

// PATCH /campaigns/:id - Update campaign (title, description, deadline)
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const campaignId = req.params.id;
  const { title, description, deadline } = req.body;

  // Check if campaign exists and belongs to user
  const { rows: campaignRows } = await db.query(
    'SELECT * FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaignRows.length) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const campaign = campaignRows[0];
  if (campaign.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'You do not have permission to edit this campaign' });
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
    return res.status(422).json({
      error: `Cannot edit a campaign with status: ${currentStatus}`
    });
  }

  // Validate and prepare update object
  const updates = {};
  const updateParams = [];
  let paramIndex = 1;

  if (title !== undefined) {
    const cleanTitle = stripHtml(title);
    if (!cleanTitle) {
      return res.status(422).json({ error: 'Title cannot be empty' });
    }
    if (cleanTitle.length > 100) {
      return res.status(422).json({ error: 'Title must be at most 100 characters' });
    }
    updates.title = cleanTitle;
    updateParams.push(['title', cleanTitle, `$${paramIndex++}`]);
  }

  if (description !== undefined) {
    const cleanDesc = stripHtml(description);
    if (cleanDesc.length > 1000) {
      return res.status(422).json({ error: 'Description must be at most 1000 characters' });
    }
    updates.description = cleanDesc;
    updateParams.push(['description', cleanDesc, `$${paramIndex++}`]);
  }

  if (deadline !== undefined && deadline !== null && deadline !== '') {
    // Validate ISO8601 format
    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime())) {
      return res.status(422).json({ error: 'Deadline must be a valid date' });
    }

    // Check deadline is not in the past
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    deadlineDate.setHours(0, 0, 0, 0);

    if (deadlineDate < today) {
      return res.status(422).json({ error: 'Deadline cannot be in the past' });
    }

    updates.deadline = deadline;
    updateParams.push(['deadline', deadline, `$${paramIndex++}`]);
  }

  // Check if any valid updates were provided
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // Check for invalid fields in request body
  const allowedFields = ['title', 'description', 'deadline'];
  for (const field of Object.keys(req.body)) {
    if (!allowedFields.includes(field)) {
      return res.status(422).json({
        error: `Cannot update field: ${field}`
      });
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
    return res.status(404).json({ error: 'Campaign not found' });
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
        return res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: err.message || 'Invalid cover image upload',
            fields: { cover_image: err.message || 'Invalid file' },
          },
        });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'cover_image is required',
          fields: { cover_image: 'No image uploaded' },
        },
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
      return res.status(500).json({ error: 'Could not upload campaign cover image' });
    }
  }
);

router.get('/:id/updates', asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await db.query(
    `SELECT cu.id, cu.campaign_id, cu.author_id, cu.title, cu.body, cu.created_at, u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
     ORDER BY cu.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.params.id, limit, offset]
  );
  res.json(rows);
}));

router.post('/:id/updates', requireAuth, requireCampaignMember('owner', 'manager'), createCampaignUpdateValidation, validateRequest, asyncHandler(async (req, res) => {
  const { title, body } = req.body;

  const { rows } = await db.query(
    `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, campaign_id, author_id, title, body, created_at`,
    [req.params.id, req.user.userId, title.trim(), body.trim()]
  );
  res.status(201).json(rows[0]);
}));

// POST /campaigns/:id/members — owner invites a user by email
router.post('/:id/members', requireAuth, requireCampaignMember('owner'), asyncHandler(async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(422).json({ error: 'Email and role are required' });
  if (!['owner', 'manager', 'viewer'].includes(role)) {
    return res.status(422).json({ error: 'Invalid role. Must be owner, manager, or viewer' });
  }

  const { rows: users } = await db.query('SELECT id FROM users WHERE email = $1', [email.trim()]);
  const inviteeUserId = users.length ? users[0].id : null;

  const { rows: existing } = await db.query(
    'SELECT id, accepted_at FROM campaign_members WHERE campaign_id = $1 AND email = $2',
    [req.params.id, email.trim()]
  );
  if (existing.length) {
    if (existing[0].accepted_at) {
      return res.status(409).json({ error: 'User is already a member of this campaign' });
    } else {
      return res.status(409).json({ error: 'Invitation already sent to this user' });
    }
  }

  const inviteToken = crypto.randomBytes(32).toString('hex');

  const { rows: memberRows } = await db.query(
    `INSERT INTO campaign_members (campaign_id, user_id, email, role, invited_by, invite_token)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, campaign_id, email, role, created_at`,
    [req.params.id, inviteeUserId, email.trim(), role, req.user.userId, inviteToken]
  );

  const campaignUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}/invite/${inviteToken}`;
  try {
    await sendEmail({
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
    return res.status(422).json({ error: 'Invalid role. Must be owner, manager, or viewer' });
  }

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET role = $1
     WHERE campaign_id = $2 AND user_id = $3
     RETURNING id, campaign_id, user_id, role, accepted_at`,
    [role, req.params.id, req.params.userId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Member not found' });
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
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const { rows } = await db.query(
    `DELETE FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2
     RETURNING id`,
    [req.params.id, memberUserId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Member not found' });
  }

  res.json({ message: 'Member removed successfully' });
}));

// POST /campaigns/:id/members/accept — accept invitation (token-based)
router.post('/:id/members/accept', requireAuth, asyncHandler(async (req, res) => {
  const { token: inviteToken } = req.body;
  if (!inviteToken) return res.status(422).json({ error: 'Invitation token is required' });

  const { rows: invites } = await db.query(
    `SELECT id, accepted_at, email FROM campaign_members
     WHERE campaign_id = $1 AND invite_token = $2`,
    [req.params.id, inviteToken]
  );

  if (!invites.length) {
    return res.status(404).json({ error: 'Invalid invitation token' });
  }
  if (invites[0].accepted_at) {
    return res.status(409).json({ error: 'Invitation already accepted' });
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
router.get('/:id/analytics', asyncHandler(async (req, res) => {
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
