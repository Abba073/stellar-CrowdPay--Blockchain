const db = require('../config/database');
const logger = require('../config/logger');
const { triggerCampaignStatusActions } = require('./campaignStatusActions');
const { runWithRequestContext, getRequestId } = require('../config/requestContext');

const PREVIOUS_STATUS = 'active';
const CRON_REQUEST_ID = 'campaign-status-cron';

// Arbitrary constant key for the pg advisory lock guarding the batch refresh.
const STATUS_REFRESH_ADVISORY_LOCK_KEY = 0x53544154; // "STAT"

// In-flight guard: prevents overlapping invocations within this process.
let isRunning = false;

async function runStatusActionsForCampaign(campaign) {
  if (!campaign) return;
  const correlationId = requestId || getRequestId() || CRON_REQUEST_ID;
  try {
    await runWithRequestContext({ requestId: correlationId }, () =>
      triggerCampaignStatusActions(campaign, PREVIOUS_STATUS)
    );
  } catch (err) {
    logger.error('Campaign status actions failed', {
      campaign_id: campaign.id,
      status: campaign.status,
      error: err.message,
    });
  }
}

/**
 * Reconcile status for one campaign (active → funded or failed based on goal/deadline).
 */
async function refreshCampaignStatus(campaignId, client) {
  const runner = client || db;
  const { rows: failed } = await runner.query(
    `UPDATE campaigns
     SET status = 'failed'
     WHERE id = $1
       AND status = 'active'
       AND deadline IS NOT NULL
       AND deadline < CURRENT_DATE
       AND raised_amount < target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`,
    [campaignId]
  );

  const { rows: funded } = await runner.query(
    `UPDATE campaigns
     SET status = 'funded'
     WHERE id = $1
       AND status = 'active'
       AND raised_amount >= target_amount
     RETURNING id, title, target_amount, raised_amount, deadline, status`,
    [campaignId]
  );

  const result = {
    failed: failed[0] || null,
    funded: funded[0] || null,
  };

  if (result.funded) await runStatusActionsForCampaign(result.funded);
  if (result.failed) await runStatusActionsForCampaign(result.failed);

  return result;
}

/**
 * Batch refresh for all still-active campaigns (hourly cron).
 *
 * Guarded by an in-process `isRunning` flag and a pg advisory lock so that
 * overlapping runs (slow runs, multiple replicas) are skipped rather than
 * executing concurrent status transitions for the same campaigns.
 */
async function refreshActiveCampaignStatuses() {
  if (isRunning) {
    logger.warn('Campaign status refresh skipped: previous run still in progress');
    return { funded: [], failed: [], skipped: true };
  }

  isRunning = true;
  let lockClient = null;
  let lockAcquired = false;

  try {
    // Try to acquire a session-level advisory lock on a dedicated connection so
    // only one replica runs the batch at a time.
    try {
      lockClient = await db.connect();
      const { rows } = await lockClient.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [STATUS_REFRESH_ADVISORY_LOCK_KEY]
      );
      lockAcquired = Boolean(rows[0] && rows[0].locked);
    } catch (err) {
      logger.error('Failed to acquire campaign status refresh advisory lock', {
        error: err.message,
      });
      lockAcquired = false;
    }

    if (!lockAcquired) {
      logger.warn('Campaign status refresh skipped: advisory lock held by another instance');
      return { funded: [], failed: [], skipped: true };
    }

    const { rows: funded } = await db.query(
      `UPDATE campaigns
       SET status = 'funded'
       WHERE status = 'active'
         AND raised_amount >= target_amount
       RETURNING id, title, target_amount, raised_amount, deadline, status`
    );

    const { rows: failed } = await db.query(
      `UPDATE campaigns
       SET status = 'failed'
       WHERE status = 'active'
         AND deadline IS NOT NULL
         AND deadline < CURRENT_DATE
         AND raised_amount < target_amount
       RETURNING id, title, target_amount, raised_amount, deadline, status`
    );

    if (funded.length || failed.length) {
      logger.info('Campaign status refresh completed', {
        funded_count: funded.length,
        failed_count: failed.length,
      });
    }

    for (const campaign of funded) {
      await runStatusActionsForCampaign(campaign);
    }
    for (const campaign of failed) {
      await runStatusActionsForCampaign(campaign);
    }

    return { funded, failed };
  } finally {
    if (lockClient) {
      if (lockAcquired) {
        try {
          await lockClient.query(
            'SELECT pg_advisory_unlock($1)',
            [STATUS_REFRESH_ADVISORY_LOCK_KEY]
          );
        } catch (err) {
          logger.error('Failed to release campaign status refresh advisory lock', {
            error: err.message,
          });
        }
      }
      try {
        lockClient.release();
      } catch (err) {
        logger.error('Failed to release campaign status refresh lock client', {
          error: err.message,
        });
      }
    }
    isRunning = false;
  }
}

module.exports = {
  refreshCampaignStatus,
  refreshActiveCampaignStatuses,
};
