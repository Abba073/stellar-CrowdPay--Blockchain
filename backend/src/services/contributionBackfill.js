const db = require('../config/database');

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildContributionRow(transaction) {
  const metadata = transaction.metadata || {};
  const flow = metadata.flow === 'path_payment_strict_receive' || metadata.dest_amount
    ? metadata
    : metadata;
  const senderPublicKey = flow.contributor_public_key || flow.sender_public_key;
  const amount = numberOrNull(flow.dest_amount || flow.amount);
  const asset = flow.dest_asset || transaction.asset_type || flow.send_asset;

  if (!senderPublicKey || amount === null || !asset) return null;

  const anchor = metadata.anchor || {};
  const sourceAmount = numberOrNull(flow.source_amount || flow.quoted_source_amount);
  return {
    campaignId: transaction.campaign_id,
    senderPublicKey,
    amount,
    asset,
    anchorId: anchor.anchor_id || null,
    anchorTransactionId: anchor.anchor_transaction_id || null,
    anchorAsset: anchor.anchor_asset || null,
    anchorAmount: numberOrNull(anchor.anchor_amount),
    paymentType: flow.flow === 'path_payment_strict_receive'
      ? 'path_payment_strict_receive'
      : 'payment',
    sourceAmount,
    sourceAsset: flow.send_asset && flow.send_asset !== asset ? flow.send_asset : null,
    conversionRate: sourceAmount ? amount / sourceAmount : null,
    path: flow.path || null,
    txHash: transaction.tx_hash,
    displayName: flow.display_name || null,
    createdAt: transaction.created_at,
  };
}

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;
const PROGRESS_JOB = 'contributions';

/**
 * One keyset page of contribution transactions after `cursor`, ordered by
 * (created_at, tx_hash). `existing_contribution_id` is joined in, so there
 * is no per-row lookup. created_at is also returned as Postgres text so the
 * cursor keeps full microsecond precision.
 */
async function listRecoverableTransactions(runner, { cursor = null, limit = DEFAULT_BATCH_SIZE } = {}) {
  const params = [];
  let after = '';
  if (cursor) {
    params.push(cursor.createdAt, cursor.txHash);
    after = 'AND (st.created_at, st.tx_hash) > ($1::timestamptz, $2)';
  }
  params.push(limit);
  const { rows } = await runner.query(
    `SELECT st.tx_hash, st.campaign_id, st.metadata, st.created_at,
            st.created_at::text AS cursor_created_at,
            c.asset_type,
            ct.id AS existing_contribution_id
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     LEFT JOIN contributions ct ON ct.tx_hash = st.tx_hash
     WHERE st.kind = 'contribution'
       AND st.tx_hash IS NOT NULL
       ${after}
     ORDER BY st.created_at ASC, st.tx_hash ASC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function loadProgress(runner) {
  const { rows } = await runner.query(
    'SELECT last_created_at::text AS created_at, last_tx_hash FROM contribution_backfill_progress WHERE job = $1',
    [PROGRESS_JOB]
  );
  return rows.length ? { createdAt: rows[0].created_at, txHash: rows[0].last_tx_hash } : null;
}

async function saveProgress(client, cursor, processed) {
  await client.query(
    `INSERT INTO contribution_backfill_progress (job, last_created_at, last_tx_hash, processed)
     VALUES ($1, $2::timestamptz, $3, $4)
     ON CONFLICT (job) DO UPDATE
       SET last_created_at = EXCLUDED.last_created_at,
           last_tx_hash = EXCLUDED.last_tx_hash,
           processed = contribution_backfill_progress.processed + EXCLUDED.processed,
           updated_at = NOW()`,
    [PROGRESS_JOB, cursor.createdAt, cursor.txHash, processed]
  );
}

/** Forget the stored cursor so the next --resume run starts from the beginning. */
async function resetBackfillProgress(runner = db) {
  await runner.query('DELETE FROM contribution_backfill_progress WHERE job = $1', [PROGRESS_JOB]);
}

async function recordAudit(runner, transaction, action, details) {
  await runner.query(
    `INSERT INTO contribution_backfill_audit (tx_hash, action, details)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (tx_hash) DO UPDATE
       SET action = EXCLUDED.action, details = EXCLUDED.details, updated_at = NOW()`,
    [transaction.tx_hash, action, JSON.stringify(details || {})]
  );
}

/** Counts what a chunk would do, without writing anything. */
function classifyChunk(rows) {
  const counts = { restored: 0, existing: 0, skipped: 0 };
  for (const transaction of rows) {
    if (!buildContributionRow(transaction)) counts.skipped += 1;
    else if (transaction.existing_contribution_id) counts.existing += 1;
    else counts.restored += 1;
  }
  return counts;
}

/**
 * Applies one chunk in a single short transaction: inserts, audit rows,
 * one raised_amount update per campaign, and the progress cursor commit
 * together, so a crash leaves either the whole chunk or none of it.
 */
async function applyChunk(runner, rows, cursor) {
  const counts = { restored: 0, existing: 0, skipped: 0 };
  const raisedByCampaign = new Map();
  const client = await runner.connect();
  try {
    await client.query('BEGIN');
    for (const transaction of rows) {
      const contribution = buildContributionRow(transaction);
      if (!contribution) {
        counts.skipped += 1;
        await recordAudit(client, transaction, 'skipped', { reason: 'insufficient_metadata' });
        continue;
      }
      if (transaction.existing_contribution_id) {
        counts.existing += 1;
        await recordAudit(client, transaction, 'existing', { contribution_id: transaction.existing_contribution_id });
        continue;
      }

      const { rows: insertedRows } = await client.query(
        `INSERT INTO contributions
           (campaign_id, sender_public_key, amount, asset, anchor_id, anchor_transaction_id,
            anchor_asset, anchor_amount, payment_type, source_amount, source_asset,
            conversion_rate, path, tx_hash, display_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)
         ON CONFLICT (tx_hash) DO NOTHING
         RETURNING id`,
        [
          contribution.campaignId,
          contribution.senderPublicKey,
          contribution.amount,
          contribution.asset,
          contribution.anchorId,
          contribution.anchorTransactionId,
          contribution.anchorAsset,
          contribution.anchorAmount,
          contribution.paymentType,
          contribution.sourceAmount,
          contribution.sourceAsset,
          contribution.conversionRate,
          contribution.path ? JSON.stringify(contribution.path) : null,
          contribution.txHash,
          contribution.displayName,
          contribution.createdAt,
        ]
      );

      if (!insertedRows.length) {
        counts.existing += 1;
        await recordAudit(client, transaction, 'existing', { reason: 'concurrent_insert' });
        continue;
      }

      const contributionId = insertedRows[0].id;
      raisedByCampaign.set(
        contribution.campaignId,
        (raisedByCampaign.get(contribution.campaignId) || 0) + contribution.amount
      );
      await client.query(
        `UPDATE stellar_transactions
         SET contribution_id = $1, status = 'indexed', updated_at = NOW()
         WHERE tx_hash = $2 AND kind = 'contribution'`,
        [contributionId, contribution.txHash]
      );
      await recordAudit(client, transaction, 'restored', { contribution_id: contributionId });
      counts.restored += 1;
    }

    // One UPDATE per campaign per chunk instead of one per contribution.
    for (const [campaignId, amount] of raisedByCampaign) {
      await client.query(
        `UPDATE campaigns
         SET raised_amount = raised_amount + $1,
             status = CASE WHEN raised_amount + $1 >= target_amount THEN 'funded' ELSE status END
         WHERE id = $2`,
        [amount, campaignId]
      );
    }
    await saveProgress(client, cursor, rows.length);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Restores contributions from stellar_transactions in fixed-size chunks.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true]  report counts only; nothing is written
 * @param {number} [options.batchSize=500] rows per chunk/transaction (max 5000)
 * @param {boolean} [options.resume=false] continue after the stored cursor
 * @param {number} [options.maxBatches]    stop after this many chunks
 * @param {Function} [options.onBatch]     called with progress after each chunk
 */
async function backfillContributions({
  runner = db,
  dryRun = true,
  batchSize = DEFAULT_BATCH_SIZE,
  resume = false,
  maxBatches = Infinity,
  onBatch = () => {},
} = {}) {
  const limit = Math.min(Math.max(parseInt(batchSize, 10) || DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  let cursor = resume ? await loadProgress(runner) : null;
  const result = { scanned: 0, restored: 0, existing: 0, skipped: 0, batches: 0, resumed_from: cursor };

  while (result.batches < maxBatches) {
    const rows = await listRecoverableTransactions(runner, { cursor, limit });
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    const nextCursor = { createdAt: last.cursor_created_at, txHash: last.tx_hash };

    const counts = dryRun ? classifyChunk(rows) : await applyChunk(runner, rows, nextCursor);
    result.scanned += rows.length;
    result.restored += counts.restored;
    result.existing += counts.existing;
    result.skipped += counts.skipped;
    result.batches += 1;
    cursor = nextCursor;
    onBatch({ ...counts, batch: result.batches, rows: rows.length, cursor });

    if (rows.length < limit) break;
  }

  return { ...result, cursor };
}

module.exports = {
  backfillContributions,
  buildContributionRow,
  resetBackfillProgress,
  DEFAULT_BATCH_SIZE,
};