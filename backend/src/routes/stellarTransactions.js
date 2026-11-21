const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { NOT_DELETED, notDeleted } = require('../utils/campaignVisibility');
const { sendErrorResponse } = require('../middleware/errorHandler');

function isPlatformApprover(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return false;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

async function assertCampaignReportingAccess(req, campaignId) {
  const { rows } = await db.query(`SELECT creator_id FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`, [campaignId]);
  if (!rows.length) return { error: 'Campaign not found', status: 404 };
  const isCreator = rows[0].creator_id === req.user.userId;
  if (!isCreator && !isPlatformApprover(req.user.userId)) {
    return { error: 'Not authorized to view on-chain activity for this campaign', status: 403 };
  }
  return {};
}

/**
 * Reporting index: Stellar transactions auditable by campaign creators and platform operators.
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { campaign_id: campaignId, status, limit } = req.query;
  const max = Math.min(parseInt(limit, 10) || 50, 200);

  if (!campaignId && !isPlatformApprover(req.user.userId)) {
    return sendErrorResponse(res, 400, 'campaign_id is required unless using a platform operator account');
  }

  if (campaignId) {
    const access = await assertCampaignReportingAccess(req, campaignId);
    if (access.error) return sendErrorResponse(res, access.status, access.error);
  }

  const params = [];
  let where = `WHERE ${notDeleted('c')}`;
  if (campaignId) {
    params.push(campaignId);
    where += ` AND st.campaign_id = $${params.length}`;
  }
  const allowedStatuses = ['pending_signatures', 'submitted', 'indexed', 'failed'];
  if (status) {
    if (!allowedStatuses.includes(status)) {
      return sendErrorResponse(res, 400, `status must be one of: ${allowedStatuses.join(', ')}`);
    }
    params.push(status);
    where += ` AND st.status = $${params.length}`;
  }
  params.push(max);

  const { rows } = await db.query(
    `SELECT st.id, st.kind, st.status, st.tx_hash, st.campaign_id, st.withdrawal_request_id,
            st.initiated_by_user_id, st.metadata, st.contribution_id, st.failure_reason,
            st.created_at, st.updated_at,
            c.title AS campaign_title
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     ${where}
     ORDER BY st.created_at DESC
     LIMIT $${params.length}`,
    params
  );

  res.json(rows);
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT st.*, c.title AS campaign_title, c.creator_id
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     WHERE st.id = $1 AND ${notDeleted('c')}`,
    [req.params.id]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Record not found');

  const row = rows[0];
  const isCreator = row.creator_id === req.user.userId;
  if (!isCreator && !isPlatformApprover(req.user.userId)) {
    return sendErrorResponse(res, 403, 'Not authorized');
  }

  delete row.creator_id;
  res.json(row);
}));

module.exports = router;
