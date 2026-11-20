const express = require('express');
const router = express.Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { reconcileSingleCampaign } = require('../services/reconciliation');
const cache = require('../utils/cache');
const { getRequestContext } = require('../middleware/requestContext');
const { sendErrorResponse } = require('../middleware/errorHandler');

// Per-route JSON body limit for admin payloads (tighter than the global limit).
const adminJsonParser = express.json({ limit: '10kb' });

router.use(requireAuth);
router.use(requireAdmin);

/**
 * Extract request attribution context (IP, user-agent, request id) from an
 * Express request. `req.ip` is only trustworthy when `trust proxy` is set
 * correctly on the app (see index.js).
 */
function getRequestAttribution(req) {
  if (!req) {
    return { actorIp: null, userAgent: null, requestId: null };
  }

  let requestId = req.id || req.requestId || null;
  if (!requestId) {
    try {
      const ctx = getRequestContext();
      requestId = ctx?.requestId || null;
    } catch (_) {
      requestId = null;
    }
  }

  return {
    actorIp: req.ip || null,
    userAgent: req.headers?.['user-agent'] || null,
    requestId,
  };
}

/**
 * Log admin action to audit table
 */
async function logAdminAction(adminUserId, actionType, targetType, targetId, details = null, req = null) {
  try {
    const { actorIp, userAgent, requestId } = getRequestAttribution(req);
    await db.query(
      `INSERT INTO admin_actions
         (admin_user_id, action_type, target_type, target_id, details, actor_ip, user_agent, request_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        adminUserId,
        actionType,
        targetType,
        targetId,
        details ? JSON.stringify(details) : null,
        actorIp,
        userAgent,
        requestId,
      ]
    );
  } catch (err) {
    logger.error('Failed to log admin action', { error: err.message, actionType, targetType });
  }
}

/**
 * GET /api/admin/stats
 * Get platform statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const users = await db.query('SELECT COUNT(*) FROM users WHERE is_banned = false');
    const bannedUsers = await db.query('SELECT COUNT(*) FROM users WHERE is_banned = true');
    const campaigns = await db.query('SELECT status, COUNT(*) FROM campaigns WHERE deleted_at IS NULL GROUP BY status');
    const deletedCampaigns = await db.query('SELECT COUNT(*) FROM campaigns WHERE deleted_at IS NOT NULL');
    const raised = await db.query('SELECT SUM(raised_amount) as total FROM campaigns WHERE deleted_at IS NULL');
    const contributions = await db.query('SELECT COUNT(*) FROM contributions');

    res.json({
      total_users: parseInt(users.rows[0].count),
      banned_users: parseInt(bannedUsers.rows[0].count),
      campaign_status: campaigns.rows,
      deleted_campaigns: parseInt(deletedCampaigns.rows[0].count),
      total_raised: parseFloat(raised.rows[0]?.total || 0),
      total_contributions: parseInt(contributions.rows[0].count),
    });
  } catch (err) {
    logger.error('Error fetching admin stats', { error: err.message });
    sendErrorResponse(res, 500, 'Failed to fetch statistics');
  }
});

/**
 * GET /api/admin/metrics/db-pool
 * Database connection pool metrics
 */
router.get('/metrics/db-pool', (req, res) => {
  res.json({
    total: db.totalCount,
    idle: db.idleCount,
    waiting: db.waitingCount,
  });
});

/**
 * GET /api/admin/campaigns
 * List all campaigns with filters
 */
router.get('/campaigns', async (req, res) => {
  try {
    const { status, include_deleted } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (include_deleted !== 'true') {
      where += ' AND c.deleted_at IS NULL';
    }

    if (status) {
      params.push(status);
      where += ` AND c.status = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.raised_amount, c.target_amount, 
              c.asset_type, c.created_at, c.deleted_at,
              u.id as creator_id, u.name as creator_name, u.email as creator_email,
              (SELECT COUNT(*) FROM contributions WHERE campaign_id = c.id) as contribution_count
       FROM campaigns c 
       JOIN users u ON c.creator_id = u.id
       ${where}
       ORDER BY c.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching campaigns for admin', { error: err.message });
    sendErrorResponse(res, 500, 'Failed to fetch campaigns');
  }
});

/**
 * GET /api/admin/campaigns/deleted
 * List only deleted campaigns
 */
router.get('/campaigns/deleted', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.raised_amount, c.target_amount, 
              c.asset_type, c.created_at, c.deleted_at,
              u.id as creator_id, u.name as creator_name, u.email as creator_email,
              (SELECT COUNT(*) FROM contributions WHERE campaign_id = c.id) as contribution_count
       FROM campaigns c 
       JOIN users u ON c.creator_id = u.id
       WHERE c.deleted_at IS NOT NULL
       ORDER BY c.deleted_at DESC`
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching deleted campaigns for admin', { error: err.message });
    sendErrorResponse(res, 500, 'Failed to fetch deleted campaigns');
  }
});

/**
 * PATCH /api/admin/campaigns/:id/suspend
 * Suspend a campaign (prevent new contributions)
 */
router.patch('/campaigns/:id/suspend', adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return sendErrorResponse(res, 404, 'Campaign not found');
    }

    const campaign = campaignRows[0];

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING id, title, status, created_at`,
      ['suspended', id]
    );

    await logAdminAction(req.user.userId, 'suspend', 'campaign', id, { 
      reason: reason || null,
      previous_status: campaign.status 
    }, req);

    logger.info('Campaign suspended', { campaignId: id, adminId: req.user.userId, reason });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign suspended', campaign: updated[0] });
  } catch (err) {
    logger.error('Error suspending campaign', { error: err.message, campaignId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to suspend campaign');
  }
});

/**
 * PATCH /api/admin/campaigns/:id/restore
 * Restore a suspended campaign to active, or restore a soft-deleted campaign
 */
router.patch('/campaigns/:id/restore', adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status, deleted_at FROM campaigns WHERE id = $1',
      [id]
    );

    if (!campaignRows.length) {
      return sendErrorResponse(res, 404, 'Campaign not found');
    }

    const campaign = campaignRows[0];

    // Handle soft-deleted campaign restoration
    if (campaign.deleted_at) {
      const { rows: updated } = await db.query(
        `UPDATE campaigns SET deleted_at = NULL, status = 'active' WHERE id = $1 RETURNING id, title, status, deleted_at`,
        [id]
      );

      await logAdminAction(req.user.userId, 'restore', 'campaign', id, { 
        restored_from: 'deleted'
      }, req);

      logger.info('Soft-deleted campaign restored', { campaignId: id, adminId: req.user.userId });
      cache.invalidate(`campaigns:id:${id}`);
      cache.invalidatePrefix('campaigns:list:');
      return res.json({ message: 'Campaign restored from deleted', campaign: updated[0] });
    }

    // Handle suspended campaign restoration
    if (campaign.status !== 'suspended') {
      return sendErrorResponse(res, 400, 'Only suspended or deleted campaigns can be restored');
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING id, title, status, created_at`,
      ['active', id]
    );

    await logAdminAction(req.user.userId, 'restore', 'campaign', id, { 
      previous_status: campaign.status 
    }, req);

    logger.info('Campaign restored', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign restored', campaign: updated[0] });
  } catch (err) {
    logger.error('Error restoring campaign', { error: err.message, campaignId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to restore campaign');
  }
});

/**
 * DELETE /api/admin/campaigns/:id
 * Soft-delete (archive) a campaign
 */
router.delete('/campaigns/:id', adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, title FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return sendErrorResponse(res, 404, 'Campaign not found');
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET deleted_at = NOW() WHERE id = $1 RETURNING id, title, deleted_at`,
      [id]
    );

    await logAdminAction(req.user.userId, 'delete', 'campaign', id, { 
      reason: reason || null
    }, req);

    logger.info('Campaign deleted', { campaignId: id, adminId: req.user.userId, reason });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign deleted', campaign: updated[0] });
  } catch (err) {
    logger.error('Error deleting campaign', { error: err.message, campaignId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to delete campaign');
  }
});

/**
 * PATCH /api/admin/campaigns/:id/feature
 * Mark a campaign as featured
 */
router.patch('/campaigns/:id/feature', adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    const { rows: campaignRows } = await db.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return sendErrorResponse(res, 404, 'Campaign not found');
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns 
       SET featured = true, featured_at = NOW(), featured_note = $1 
       WHERE id = $2 RETURNING id, title, featured, featured_at, featured_note`,
      [note || null, id]
    );

    await logAdminAction(req.user.userId, 'feature', 'campaign', id, { note }, req);

    logger.info('Campaign featured', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    cache.invalidate('campaigns:featured');
    res.json({ message: 'Campaign featured', campaign: updated[0] });
  } catch (err) {
    logger.error('Error featuring campaign', { error: err.message, campaignId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to feature campaign');
  }
});

/**
 * PATCH /api/admin/campaigns/:id/unfeature
 * Remove featured status from a campaign
 */
router.patch('/campaigns/:id/unfeature', adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: campaignRows } = await db.query(
      'SELECT id FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return sendErrorResponse(res, 404, 'Campaign not found');
    }

    const { rows: updated } = await db.query(
      `UPDATE campaigns 
       SET featured = false, featured_at = NULL, featured_note = NULL 
       WHERE id = $1 RETURNING id, title, featured`,
      [id]
    );

    await logAdminAction(req.user.userId, 'unfeature', 'campaign', id, {}, req);

    logger.info('Campaign unfeatured', { campaignId: id, adminId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    cache.invalidate('campaigns:featured');
    res.json({ message: 'Campaign unfeatured', campaign: updated[0] });
  } catch (err) {
    logger.error('Error unfeaturing campaign', { error: err.message, campaignId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to unfeature campaign');
  }
});

/**
 * GET /api/admin/users
 * List all users with optional filtering
 */
router.get('/users', async (req, res) => {
  try {
    const { include_banned } = req.query;
    let where = 'WHERE 1=1';

    if (include_banned !== 'true') {
      where += ' AND u.is_banned = false';
    }

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_admin, u.is_banned, u.created_at,
              (SELECT COUNT(*) FROM campaigns WHERE creator_id = u.id AND deleted_at IS NULL) as campaign_count,
              (SELECT COUNT(*) FROM contributions WHERE sender_public_key = u.wallet_public_key
                 OR sender_public_key IN (SELECT public_key FROM user_wallet_keys WHERE user_id = u.id)) as contribution_count
       FROM users u
       ${where}
       ORDER BY u.created_at DESC`,
      []
    );
    res.json(rows);
  } catch (err) {
    logger.error('Error fetching users for admin', { error: err.message });
    sendErrorResponse(res, 500, 'Failed to fetch users');
  }
});

/**
 * PATCH /api/admin/users/:id/ban
 * Ban a user
 */
router.patch('/users/:id/ban', adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length === 0) {
      return sendErrorResponse(res, 400, 'Reason is required for banning a user');
    }

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_banned FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return sendErrorResponse(res, 404, 'User not found');
    }

    const user = userRows[0];

    if (user.is_banned) {
      return sendErrorResponse(res, 400, 'User is already banned');
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_banned = true WHERE id = $1 RETURNING id, email, is_banned`,
      [id]
    );

    await logAdminAction(req.user.userId, 'ban', 'user', id, { 
      reason: reason
    }, req);

    logger.info('User banned', { userId: id, adminId: req.user.userId, reason });
    res.json({ message: 'User banned', user: updated[0] });
  } catch (err) {
    logger.error('Error banning user', { error: err.message, userId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to ban user');
  }
});

/**
 * PATCH /api/admin/users/:id/unban
 * Unban a user
 */
router.patch('/users/:id/unban', adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_banned FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return sendErrorResponse(res, 404, 'User not found');
    }

    const user = userRows[0];

    if (!user.is_banned) {
      return sendErrorResponse(res, 400, 'User is not banned');
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_banned = false WHERE id = $1 RETURNING id, email, is_banned`,
      [id]
    );

    await logAdminAction(req.user.userId, 'unban', 'user', id, {}, req);

    logger.info('User unbanned', { userId: id, adminId: req.user.userId });
    res.json({ message: 'User unbanned', user: updated[0] });
  } catch (err) {
    logger.error('Error unbanning user', { error: err.message, userId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to unban user');
  }
});

/**
 * GET /api/admin/audit-log
 * Get admin action audit log
 */
router.get('/audit-log', async (req, res) => {
  try {
    const { limit = 100, offset = 0, before_id: beforeId } = req.query;
    const limitNum = Math.min(parseInt(limit) || 100, 100);
    const offsetNum = beforeId ? 0 : parseInt(offset) || 0;

    if (beforeId && !/^[0-9a-f-]{36}$/i.test(beforeId)) {
      return sendErrorResponse(res, 400, 'before_id must be a UUID');
    }

    // Keyset pagination: pass the last row's id as before_id to fetch the next page.
    const { rows } = await db.query(
      `SELECT a.id, a.admin_user_id, u.email as admin_email, a.action_type, 
              a.target_type, a.target_id, a.details, a.actor_ip, a.user_agent,
              a.request_id, a.created_at
       FROM admin_actions a
       JOIN users u ON a.admin_user_id = u.id
       WHERE $3::uuid IS NULL
          OR (a.created_at, a.id) < (SELECT created_at, id FROM admin_actions WHERE id = $3::uuid)
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $1 OFFSET $2`,
      [limitNum, offsetNum, beforeId || null]
    );

    const { rows: countRows } = await db.query('SELECT COUNT(*) FROM admin_actions');
    const total = parseInt(countRows[0].count);

    res.json({
      actions: rows,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: total,
        next_before_id: rows.length === limitNum ? rows[rows.length - 1].id : null,
      }
    });
  } catch (err) {
    logger.error('Error fetching audit log', { error: err.message });
    sendErrorResponse(res, 500, 'Failed to fetch audit log');
  }
});

/**
 * PATCH /api/admin/users/:id/promote
 * Promote a user to admin — only super-admins may do this.
 */
router.patch('/users/:id/promote', requireSuperAdmin, adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_admin FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return sendErrorResponse(res, 404, 'User not found');
    }

    const user = userRows[0];

    if (user.is_admin) {
      return sendErrorResponse(res, 400, 'User is already an admin');
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_admin = true WHERE id = $1 RETURNING id, email, is_admin`,
      [id]
    );

    await logAdminAction(req.user.userId, 'promote', 'user', id, {}, req);

    logger.info('User promoted to admin', { userId: id, adminId: req.user.userId });
    res.json({ message: 'User promoted to admin', user: updated[0] });
  } catch (err) {
    logger.error('Error promoting user', { error: err.message, userId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to promote user');
  }
});

/**
 * PATCH /api/admin/users/:id/demote
 * Demote an admin to regular user — only super-admins may do this.
 * Self-demotion is blocked. Demoting the last admin is blocked.
 */
router.patch('/users/:id/demote', requireSuperAdmin, adminJsonParser, async (req, res) => {
  try {
    const { id } = req.params;

    // Block self-demotion
    if (String(id) === String(req.user.userId)) {
      return sendErrorResponse(res, 403, 'You cannot demote yourself');
    }

    const { rows: userRows } = await db.query(
      'SELECT id, email, is_admin FROM users WHERE id = $1',
      [id]
    );

    if (!userRows.length) {
      return sendErrorResponse(res, 404, 'User not found');
    }

    const user = userRows[0];

    if (!user.is_admin) {
      return sendErrorResponse(res, 400, 'User is not an admin');
    }

    // Quorum guard: ensure at least one admin (besides the target) will remain
    const { rows: adminCountRows } = await db.query(
      `SELECT COUNT(*) FROM users WHERE is_admin = true AND id != $1`,
      [id]
    );
    const remainingAdmins = parseInt(adminCountRows[0].count, 10);
    if (remainingAdmins < 1) {
      return sendErrorResponse(res, 409, 'Cannot demote the last admin — the platform would be locked out');
    }

    const { rows: updated } = await db.query(
      `UPDATE users SET is_admin = false WHERE id = $1 RETURNING id, email, is_admin`,
      [id]
    );

    await logAdminAction(req.user.userId, 'demote', 'user', id, {}, req);

    logger.info('Admin demoted to user', { userId: id, adminId: req.user.userId });
    res.json({ message: 'Admin demoted to user', user: updated[0] });
  } catch (err) {
    logger.error('Error demoting admin', { error: err.message, userId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to demote user');
  }
});

// Migrate old /milestones endpoint if needed
router.get('/milestones', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const allowedStatuses = ['pending', 'approved', 'released'];
  if (status && !allowedStatuses.includes(status)) {
    return sendErrorResponse(res, 400, `status must be one of: ${allowedStatuses.join(', ')}`);
  }

  const params = [];
  let where = 'WHERE 1=1';
  if (status) {
    params.push(status);
    where += ` AND m.status = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT m.*, c.title AS campaign_title, c.status AS campaign_status, c.asset_type,
            c.raised_amount, u.email AS creator_email, u.name AS creator_name
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     JOIN users u ON u.id = c.creator_id
     ${where}
     ORDER BY m.created_at DESC`,
    params
  );
  res.json(rows);
});

/**
 * POST /api/admin/campaigns/:id/reconcile
 * Manually force a sync for a specific campaign's raised_amount.
 */
router.post('/campaigns/:id/reconcile', adminJsonParser, async (req, res) => {
  try {
    const result = await reconcileSingleCampaign(req.params.id);
    res.json({ message: 'Reconciliation completed', result });
  } catch (err) {
    if (err.message === 'Campaign not found') {
      return sendErrorResponse(res, 404, 'Campaign not found');
    }
    logger.error('Error during manual reconciliation', { error: err.message, campaignId: req.params.id });
    sendErrorResponse(res, 500, 'Failed to reconcile campaign');
  }
});

/**
 * GET /api/admin/refund-queue
 * List all pending refunds awaiting approval with SLA tracking
 */
router.get('/refund-queue', async (req, res) => {
  try {
    const { status, overdue_only, limit = 50, offset = 0 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offsetNum = parseInt(offset) || 0;

    let where = `WHERE wr.is_refund = true`;
    const params = [];

    if (status) {
      params.push(status);
      where += ` AND wr.status = $${params.length}`;
    }

    // Add overdue filter: refunds older than 7 days with status 'pending' or 'on_hold'
    if (overdue_only === 'true') {
      where += ` AND wr.status IN ('pending', 'on_hold') AND wr.created_at < NOW() - INTERVAL '7 days'`;
    }

    const { rows } = await db.query(
      `SELECT wr.id, wr.campaign_id, wr.amount, wr.asset, wr.destination_key, wr.status,
              wr.is_refund, wr.dispute_id, wr.created_at, wr.creator_signed, wr.platform_signed,
              c.title as campaign_title,
              u.email as contributor_email,
              CASE
                WHEN wr.status IN ('pending', 'on_hold') AND wr.created_at < NOW() - INTERVAL '7 days'
                THEN true
                ELSE false
              END as is_overdue,
              EXTRACT(EPOCH FROM (NOW() - wr.created_at)) / 86400 as days_pending
       FROM withdrawal_requests wr
       JOIN campaigns c ON c.id = wr.campaign_id
       LEFT JOIN users u ON u.wallet_public_key = wr.destination_key
       ${where}
       ORDER BY wr.created_at ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limitNum, offsetNum]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM withdrawal_requests wr ${where}`,
      params
    );
    const total = parseInt(countRows[0].count);

    res.json({
      refunds: rows.map(r => ({
        ...r,
        amount: parseFloat(r.amount),
        days_pending: parseFloat(r.days_pending.toFixed(2)),
        is_overdue: r.is_overdue,
      })),
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total,
      },
    });
  } catch (err) {
    logger.error('Error fetching refund queue', { error: err.message });
    sendErrorResponse(res, 500, 'Failed to fetch refund queue');
  }
});

/**
 * @openapi
 * /api/admin/disputes:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List all disputes (admin only, paginated)
 *     description: Returns a paginated list of disputes across all campaigns. Requires admin authentication.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Max number of disputes to return (default 50, max 200)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Number of disputes to skip (default 0)
 *     responses:
 *       200:
 *         description: Paginated list of disputes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disputes:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dispute'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     total:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to fetch disputes
 */
router.get('/disputes', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offsetNum = parseInt(offset) || 0;

    const { rows } = await db.query(
      `SELECT d.*, u.name AS raised_by_name, u.email AS raised_by_email, c.title AS campaign_title
       FROM disputes d
       JOIN users u ON u.id = d.raised_by
       JOIN campaigns c ON c.id = d.campaign_id
       ORDER BY d.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limitNum, offsetNum]
    );

    const { rows: countRows } = await db.query('SELECT COUNT(*) FROM disputes');
    const total = parseInt(countRows[0].count);

    res.json({
      disputes: rows,
      pagination: { limit: limitNum, offset: offsetNum, total },
    });
  } catch (err) {
    logger.error('Error fetching admin disputes', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

module.exports = router;
