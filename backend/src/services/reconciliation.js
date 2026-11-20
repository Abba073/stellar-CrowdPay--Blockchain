const db = require('../config/database');
const { getCampaignBalance } = require('./stellarService');
const logger = require('../config/logger');

async function reconcileCampaign(campaign) {
  try {
    const { rows: pendingRows } = await db.query(
      `SELECT id FROM withdrawal_requests WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
      [campaign.id]
    );
    if (pendingRows.length > 0) {
      logger.info(`[reconcile] Skipping campaign ${campaign.id} due to pending withdrawal`);
      return { skipped: true, reason: 'pending_withdrawal' };
    }

    const onChain = await getCampaignBalance(campaign.wallet_public_key);
    const liveBalance = parseFloat(onChain[campaign.asset_type] || '0');
    const dbBalance = parseFloat(campaign.raised_amount);

    if (Math.abs(liveBalance - dbBalance) > 0.0000001) {
      // #14 — raised_amount must be cumulative.
      //
      // The on-chain balance *decreases* after every legitimate withdrawal, so
      // overwriting raised_amount with liveBalance would silently regress a
      // funded campaign back to failed and corrupt contribution history.
      //
      // Correct behaviour:
      //   • If the chain shows MORE than the DB (e.g. an off-system deposit was
      //     missed), advance raised_amount to match — this is a genuine gap.
      //   • If the chain shows LESS (i.e. funds were withdrawn), the DB value is
      //     the ground truth; log the discrepancy but do NOT write it back.
      if (liveBalance > dbBalance) {
        logger.warn(
          `[reconcile] Campaign ${campaign.id}: chain=${liveBalance} > DB=${dbBalance}. ` +
          `Advancing raised_amount to match on-chain value.`
        );
        await db.query(
          `UPDATE campaigns SET raised_amount = $1 WHERE id = $2`,
          [liveBalance, campaign.id]
        );
        return { updated: true, direction: 'advanced', dbBalance, liveBalance };
      }

      // Chain < DB — funds have been withdrawn (expected) or there is a genuine
      // discrepancy.  Either way, raised_amount stays cumulative.
      logger.warn(
        `[reconcile] Campaign ${campaign.id}: chain=${liveBalance} < DB=${dbBalance}. ` +
        `Likely due to a withdrawal — raised_amount preserved (cumulative semantics).`
      );
      return { updated: false, direction: 'skipped_decrement', dbBalance, liveBalance };
    }
    return { updated: false, dbBalance, liveBalance };
  } catch (err) {
    logger.error(`[reconcile] Failed for campaign ${campaign.id}:`, { error: err.message });
    throw err;
  }
}

function positiveInt(raw, fallback) {
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Tunables, read per run so tests and operators can change them. */
function getReconcileConfig() {
  return {
    // How often the scheduled job runs (see src/index.js).
    intervalMs: positiveInt(process.env.RECONCILE_INTERVAL_MS, 15 * 60 * 1000),
    // Maximum campaigns (Horizon calls) per run.
    batchSize: positiveInt(process.env.RECONCILE_BATCH_SIZE, 50),
    // Every campaign is re-checked at least this often, even without activity.
    fullSweepHours: positiveInt(process.env.RECONCILE_FULL_SWEEP_HOURS, 24),
    // A campaign whose check failed is retried after this delay.
    retryMinutes: positiveInt(process.env.RECONCILE_RETRY_MINUTES, 15),
  };
}

/**
 * Campaigns due for reconciliation, oldest check first: never reconciled,
 * new contributions / withdrawal requests / ledger cursor movement since the
 * last check, or past the full-sweep period.
 */
async function selectCampaignsToReconcile({ batchSize, fullSweepHours }) {
  const { rows } = await db.query(
    `SELECT c.id, c.wallet_public_key, c.asset_type, c.raised_amount
       FROM campaigns c
      WHERE c.status IN ('active', 'funded')
        AND c.deleted_at IS NULL
        AND (
          c.last_reconciled_at IS NULL
          OR c.last_reconciled_at < NOW() - make_interval(hours => $2)
          OR EXISTS (SELECT 1 FROM contributions ct
                      WHERE ct.campaign_id = c.id AND ct.created_at > c.last_reconciled_at)
          OR EXISTS (SELECT 1 FROM withdrawal_requests w
                      WHERE w.campaign_id = c.id AND w.created_at > c.last_reconciled_at)
          OR EXISTS (SELECT 1 FROM ledger_stream_cursors lsc
                      WHERE lsc.campaign_id = c.id AND lsc.updated_at > c.last_reconciled_at)
        )
      ORDER BY c.last_reconciled_at ASC NULLS FIRST, c.id
      LIMIT $1`,
    [batchSize, fullSweepHours]
  );
  return rows;
}

/**
 * Reconcile one batch of changed campaigns. Each campaign's
 * last_reconciled_at is advanced after its check; a failed check is
 * back-dated so it is retried after RECONCILE_RETRY_MINUTES instead of
 * blocking the head of the queue.
 */
async function reconcileCampaignBalances(config = getReconcileConfig()) {
  const campaigns = await selectCampaignsToReconcile(config);
  const summary = { checked: 0, updated: 0, failed: 0, skipped: 0 };

  for (const campaign of campaigns) {
    try {
      const result = await reconcileCampaign(campaign);
      summary.checked += 1;
      if (result.updated) summary.updated += 1;
      if (result.skipped) summary.skipped += 1;
      await db.query('UPDATE campaigns SET last_reconciled_at = NOW() WHERE id = $1', [campaign.id]);
    } catch (err) {
      // Already logged inside reconcileCampaign.
      summary.failed += 1;
      await db
        .query(
          `UPDATE campaigns
              SET last_reconciled_at = NOW() - make_interval(hours => $2) + make_interval(mins => $3)
            WHERE id = $1`,
          [campaign.id, config.fullSweepHours, config.retryMinutes]
        )
        .catch((updateErr) =>
          logger.error('[reconcile] Failed to schedule retry', { campaign_id: campaign.id, error: updateErr.message })
        );
    }
  }

  return { ...summary, batchSize: config.batchSize, batchFull: campaigns.length === config.batchSize };
}

let runInProgress = null;

/**
 * Scheduled entry point with an overlap guard: if the previous run is still
 * going (slow Horizon, large batch), this tick is skipped rather than
 * starting a second concurrent run.
 */
async function runReconciliation(config = getReconcileConfig()) {
  if (runInProgress) {
    logger.warn('[reconcile] Previous run still in progress; skipping this tick');
    return { skipped: true, reason: 'overlap' };
  }
  const startedAt = Date.now();
  runInProgress = reconcileCampaignBalances(config);
  try {
    const summary = await runInProgress;
    logger.info('[reconcile] Run complete', { ...summary, duration_ms: Date.now() - startedAt });
    if (summary.batchFull) {
      logger.warn('[reconcile] Batch was full; consider raising RECONCILE_BATCH_SIZE or lowering RECONCILE_INTERVAL_MS', {
        batch_size: summary.batchSize,
      });
    }
    return summary;
  } finally {
    runInProgress = null;
  }
}

async function reconcileSingleCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!rows.length) {
    throw new Error('Campaign not found');
  }
  return await reconcileCampaign(rows[0]);
}

module.exports = {
  reconcileCampaignBalances,
  reconcileSingleCampaign,
  runReconciliation,
  getReconcileConfig,
};
