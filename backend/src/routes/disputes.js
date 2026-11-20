const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { NOT_DELETED, notDeleted, findVisibleCampaign } = require('../utils/campaignVisibility');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  disputeCreateValidation,
  disputeUpdateValidation,
  validateRequestUnprocessable,
} = require('../middleware/requestSchemas');
const { sendEmailSafe } = require('../services/emailService');
const logger = require('../config/logger');
const { sendErrorResponse } = require('../middleware/errorHandler');

/**
 * Per-user cap on raising disputes (the global limiter allows ~100 requests
 * per 15 min, enough for one user to flood the moderation queue).
 * Defaults to 5 per hour; DISPUTE_CREATE_LIMIT_PER_HOUR overrides it.
 */
function createDisputeCreateLimiter({
  max = parseInt(process.env.DISPUTE_CREATE_LIMIT_PER_HOUR, 10) || 5,
  windowMs = 60 * 60 * 1000,
  skip = () => process.env.NODE_ENV === 'test',
} = {}) {
  return rateLimit({
    windowMs,
    max,
    // Runs after requireAuth, so every request has a user id.
    keyGenerator: (req) => `dispute-create:${req.user.userId}`,
    validate: { keyGeneratorIpFallback: false },
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler: (req, res, _next, options) =>
      res.status(options.statusCode).json({
        error: `Too many disputes raised; you can raise at most ${max} per hour.`,
        code: 'TOO_MANY_REQUESTS',
      }),
  });
}

const disputeCreateLimiter = createDisputeCreateLimiter();

const OPEN_DISPUTE_CONFLICT = 'You already have an open dispute for this campaign';

async function logDisputeEvent(client, { disputeId, actorId, action, note }) {
  await client.query(
    `INSERT INTO dispute_events (dispute_id, actor_id, action, note)
     VALUES ($1, $2, $3, $4)`,
    [disputeId, actorId || null, action, note || null]
  );
}

/**
 * @openapi
 * /campaigns/{id}/disputes:
 *   post:
 *     summary: Raise a dispute on a campaign
 *     description: >
 *       A contributor who has backed the campaign raises a dispute. Pending
 *       withdrawal requests for the campaign are frozen (set to `on_hold`)
 *       and the campaign creator is notified by email.
 *     tags:
 *       - Disputes
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Campaign ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *               - description
 *             properties:
 *               reason:
 *                 type: string
 *                 enum: [non_delivery, misrepresentation, abandoned, other]
 *               description:
 *                 type: string
 *               evidence_url:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Dispute created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Dispute'
 *       403:
 *         description: Caller has not contributed to this campaign
 *       404:
 *         description: Campaign not found
 *       409:
 *         description: Caller already has an open dispute for this campaign
 *       422:
 *         description: Invalid reason or missing description
 */
// POST /campaigns/:id/disputes — contributor raises a dispute
router.post(
  '/campaigns/:id/disputes',
  requireAuth,
  disputeCreateLimiter,
  disputeCreateValidation,
  validateRequestUnprocessable,
  async (req, res) => {
  // reason, description (HTML-stripped, trimmed) and evidence_url are
  // validated by disputeCreateValidation.
  const { reason, description, evidence_url } = req.body;

  const { rows: campaigns } = await db.query(
    `SELECT id, creator_id, title FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`,
    [req.params.id]
  );
  if (!campaigns.length) return sendErrorResponse(res, 404, 'Campaign not found');
  const campaign = campaigns[0];

  // Must have contributed
  const { rows: contributions } = await db.query(
    `SELECT id FROM contributions
     WHERE campaign_id = $1 AND sender_public_key = (
       SELECT wallet_public_key FROM users WHERE id = $2
     ) LIMIT 1`,
    [campaign.id, req.user.userId]
  );
  if (!contributions.length) {
    return sendErrorResponse(res, 403, 'Only contributors who have backed this campaign can raise a dispute');
  }

  // One open/under_review dispute per contributor per campaign (also enforced
  // by the disputes_one_open_per_contributor index for concurrent requests).
  const { rows: openRows } = await db.query(
    `SELECT id FROM disputes
     WHERE campaign_id = $1 AND raised_by = $2 AND status IN ('open', 'under_review')
     LIMIT 1`,
    [campaign.id, req.user.userId]
  );
  if (openRows.length) {
    return res.status(409).json({ error: OPEN_DISPUTE_CONFLICT, dispute_id: openRows[0].id });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let rows;
    try {
      ({ rows } = await client.query(
        `INSERT INTO disputes (campaign_id, raised_by, reason, description, evidence_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [campaign.id, req.user.userId, reason, description.trim(), evidence_url || null]
      ));
    } catch (err) {
      if (err.code === '23505') {
        // Lost a race with a concurrent request from the same contributor.
        await client.query('ROLLBACK');
        return res.status(409).json({ error: OPEN_DISPUTE_CONFLICT });
      }
      throw err;
    }
    const dispute = rows[0];

    await logDisputeEvent(client, {
      disputeId: dispute.id,
      actorId: req.user.userId,
      action: 'raised',
      note: reason,
    });

    // Freeze any pending withdrawal requests for this campaign
    await client.query(
      `UPDATE withdrawal_requests
       SET status = 'on_hold', dispute_id = $1
       WHERE campaign_id = $2 AND status = 'pending'`,
      [dispute.id, campaign.id]
    );

    await client.query('COMMIT');

    // Notify creator
    const { rows: creatorRows } = await db.query(
      'SELECT email FROM users WHERE id = $1',
      [campaign.creator_id]
    );
    if (creatorRows.length) {
      sendEmailSafe({
        to: creatorRows[0].email,
        subject: `Dispute raised on your campaign "${campaign.title}"`,
        text: `A contributor has raised a dispute on your campaign "${campaign.title}".\nReason: ${reason}\n\nThe platform team will review and contact you shortly.`,
      });
    }

    logger.info('Dispute raised', { dispute_id: dispute.id, campaign_id: campaign.id });
    res.status(201).json(dispute);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return sendErrorResponse(res, 409, 'You already have an open dispute for this campaign');
    }
    logger.error('Dispute creation failed', { error: err.message });
    sendErrorResponse(res, 500, 'Could not raise dispute');
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /campaigns/{id}/disputes:
 *   get:
 *     summary: List disputes for a campaign (admin only)
 *     tags:
 *       - Disputes
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Disputes for the campaign, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 allOf:
 *                   - $ref: '#/components/schemas/Dispute'
 *                   - type: object
 *                     properties:
 *                       raised_by_name:
 *                         type: string
 *                       raised_by_email:
 *                         type: string
 *       403:
 *         description: Admin role required
 */
// GET /campaigns/:id/disputes — admin only
router.get('/campaigns/:id/disputes', requireAuth, requireRole('admin'), async (req, res) => {
  if (!(await findVisibleCampaign(db, req.params.id))) {
    return sendErrorResponse(res, 404, 'Campaign not found');
  }
  const { rows } = await db.query(
    `SELECT d.*, u.name AS raised_by_name, u.email AS raised_by_email
     FROM disputes d
     JOIN users u ON u.id = d.raised_by
     WHERE d.campaign_id = $1
     ORDER BY d.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

/**
 * @openapi
 * /disputes/{id}:
 *   patch:
 *     summary: Update dispute status and resolution note (admin only)
 *     description: >
 *       Resolving in favour of the contributor (`resolved_contributor`)
 *       initiates refunds for the disputing contributor's contributions.
 *       Resolving in favour of the creator (`resolved_creator`) unfreezes
 *       withdrawals placed on hold by the dispute.
 *     tags:
 *       - Disputes
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Dispute ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [open, under_review, resolved_creator, resolved_contributor, closed]
 *               resolution_note:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Updated dispute
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Dispute'
 *       403:
 *         description: Admin role required
 *       404:
 *         description: Dispute not found
 *       422:
 *         description: Invalid status
 */
// PATCH /disputes/:id — admin updates status + resolution note
router.patch(
  '/disputes/:id',
  requireAuth,
  requireRole('admin'),
  disputeUpdateValidation,
  validateRequestUnprocessable,
  async (req, res) => {
  const { status, resolution_note } = req.body;

  const { rows: disputes } = await db.query(
    `SELECT d.* FROM disputes d
       JOIN campaigns c ON c.id = d.campaign_id
      WHERE d.id = $1 AND ${notDeleted('c')}`,
    [req.params.id]
  );
  if (!disputes.length) return sendErrorResponse(res, 404, 'Dispute not found');
  const dispute = disputes[0];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const resolvedAt = ['resolved_creator', 'resolved_contributor', 'closed'].includes(status)
      ? 'NOW()'
      : 'NULL';

    const { rows: updated } = await client.query(
      `UPDATE disputes
       SET status = $1, resolution_note = $2, resolved_at = ${resolvedAt}
       WHERE id = $3
       RETURNING *`,
      [status, resolution_note || null, dispute.id]
    );

    await logDisputeEvent(client, {
      disputeId: dispute.id,
      actorId: req.user.userId,
      action: `status_changed_to_${status}`,
      note: resolution_note || null,
    });

    if (status === 'resolved_contributor') {
      // Trigger refund for the disputing contributor
      const { rows: campaigns } = await client.query(
        'SELECT wallet_public_key FROM campaigns WHERE id = $1',
        [dispute.campaign_id]
      );
      const { rows: contributorRows } = await client.query(
        'SELECT wallet_public_key FROM users WHERE id = $1',
        [dispute.raised_by]
      );
      const { rows: contributions } = await client.query(
        `SELECT id, amount, asset FROM contributions
         WHERE campaign_id = $1 AND sender_public_key = $2
         AND NOT EXISTS (
           SELECT 1 FROM withdrawal_requests wr WHERE wr.contribution_id = contributions.id
         )`,
        [dispute.campaign_id, contributorRows[0].wallet_public_key]
      );

      const { buildWithdrawalTransaction } = require('../services/stellarService');
      const { insertWithdrawalPendingSignatures } = require('../services/stellarTransactionService');

      for (const contribution of contributions) {
        const unsignedXdr = await buildWithdrawalTransaction({
          campaignWalletPublicKey: campaigns[0].wallet_public_key,
          destinationPublicKey: contributorRows[0].wallet_public_key,
          amount: contribution.amount,
          asset: contribution.asset,
        });
        const { rows: refundRows } = await client.query(
          `INSERT INTO withdrawal_requests
             (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
              creator_signed, platform_signed, contribution_id, is_refund, dispute_id)
           VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6, TRUE, $7)
           RETURNING id`,
          [
            dispute.campaign_id, req.user.userId, contribution.amount,
            contributorRows[0].wallet_public_key, unsignedXdr,
            contribution.id, dispute.id,
          ]
        );
        await insertWithdrawalPendingSignatures(client, {
          campaignId: dispute.campaign_id,
          withdrawalRequestId: refundRows[0].id,
          userId: req.user.userId,
          unsignedXdr,
          metadata: { dispute_id: dispute.id, contribution_id: contribution.id },
        });
      }

      // Notify contributor
      const { rows: userRows } = await db.query(
        'SELECT email FROM users WHERE id = $1',
        [dispute.raised_by]
      );
      if (userRows.length) {
        sendEmailSafe({
          to: userRows[0].email,
          subject: 'Your dispute has been resolved in your favour',
          text: `Your dispute has been resolved. A refund has been initiated for your contributions. ${resolution_note ? `\nNote: ${resolution_note}` : ''}`,
        });
      }
    }

    if (status === 'resolved_creator') {
      // Unfreeze pending on_hold withdrawals for this campaign
      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'pending', dispute_id = NULL
         WHERE campaign_id = $1 AND status = 'on_hold' AND dispute_id = $2`,
        [dispute.campaign_id, dispute.id]
      );
    }

    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Dispute update failed', { dispute_id: dispute.id, error: err.message });
    sendErrorResponse(res, 500, 'Could not update dispute');
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /disputes/{id}/events:
 *   get:
 *     summary: Get the audit log for a dispute (admin only)
 *     tags:
 *       - Disputes
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Dispute ID
 *     responses:
 *       200:
 *         description: Dispute events, oldest first
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/DisputeEvent'
 *       403:
 *         description: Admin role required
 */
// GET /disputes/:id/events — audit log (admin only)
router.get('/disputes/:id/events', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT de.*, u.name AS actor_name
     FROM dispute_events de
     JOIN disputes d ON d.id = de.dispute_id
     JOIN campaigns c ON c.id = d.campaign_id
     LEFT JOIN users u ON u.id = de.actor_id
     WHERE de.dispute_id = $1 AND ${notDeleted('c')}
     ORDER BY de.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

module.exports = router;
module.exports.createDisputeCreateLimiter = createDisputeCreateLimiter;