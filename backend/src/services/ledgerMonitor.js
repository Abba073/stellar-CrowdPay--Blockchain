/**
 * ledgerMonitor.js
 *
 * Streams Horizon payments for campaign wallets. Persists paging cursors so
 * restarts can REST-replay missed operations, then resumes the SSE stream.
 * Reconnects with exponential backoff on stream errors.
 */

const { server } = require("../config/stellar");
const db = require("../config/database");
const logger = require("../config/logger");
const { markContributionIndexed } = require("./stellarTransactionService");
const { sendContributionReceipt } = require("./emailService");
const {
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  WEBHOOK_EVENTS,
} = require("./webhookDispatcher");
const cache = require("../utils/cache");
const { sendAlert } = require("./alerting");
const Sentry = require("@sentry/node");
const { runWithCapturedContext } = require("../config/requestContext");

/** wallet_public_key -> stream metadata */
const streamRegistry = new Map();

/** Consecutive stream failures per wallet (survives registry clears between errors). */
const reconnectAttempts = new Map();

// Map of campaignId -> Set<res> for SSE clients
const sseClients = new Map();

function addSSEClient(campaignId, res) {
  if (!sseClients.has(campaignId)) {
    sseClients.set(campaignId, new Set());
  }
  sseClients.get(campaignId).add(res);
}

function removeSSEClient(campaignId, res) {
  const clients = sseClients.get(campaignId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(campaignId);
  }
}

function broadcastCampaignUpdate(campaignId, data) {
  const clients = sseClients.get(campaignId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // client likely disconnected; cleanup handled by close event
    }
  }
}

const MAX_RECONNECT_DELAY_MS = 60_000;

function positiveInt(raw, fallback) {
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Startup and stream limits, read per call so operators/tests can tune them.
 * Horizon rate-limits per IP; opening hundreds of streams at once caused
 * dropped connections and long cursor loss after restarts.
 */
function getWatchConfig() {
  return {
    // Wallets whose replay+stream setup may be in flight at once.
    concurrency: positiveInt(process.env.LEDGER_WATCH_CONCURRENCY, 5),
    // Pause between starting consecutive wallet watches.
    staggerMs: positiveInt(process.env.LEDGER_WATCH_STAGGER_MS, 200),
    // Hard cap on open SSE streams; further wallets are polled instead.
    maxStreams: positiveInt(process.env.LEDGER_MAX_STREAMS, 200),
    // How often polled (over-cap) wallets are caught up via REST.
    pollIntervalMs: positiveInt(process.env.LEDGER_POLL_INTERVAL_MS, 60_000),
    // Polled wallets caught up per tick (round-robin).
    pollBatchSize: positiveInt(process.env.LEDGER_POLL_BATCH_SIZE, 20),
  };
}

/** wallet_public_key -> campaign_id for wallets polled instead of streamed. */
const polledWallets = new Map();

/** Backoff between in-place indexing retries for a single payment. */
const INDEX_RETRY_DELAYS_MS = [500, 2000, 8000];
/** Delay before re-replaying from the stored cursor after a payment failed to index. */
const STALLED_REPLAY_DELAY_MS = 60_000;

/** wallet_public_key -> campaign_id for wallets whose cursor is frozen by a failed payment. */
const stalledWallets = new Map();

function extractPagingToken(record) {
  if (!record || typeof record !== "object") return null;
  return record.paging_token || record.pagingToken || record.id || null;
}

async function loadCursor(campaignId) {
  const { rows } = await db.query(
    "SELECT last_cursor FROM ledger_stream_cursors WHERE campaign_id = $1",
    [campaignId],
  );
  return rows.length ? rows[0].last_cursor : null;
}

async function saveCursor(campaignId, walletPublicKey, cursorToken) {
  if (!cursorToken) return;
  await db.query(
    `INSERT INTO ledger_stream_cursors (campaign_id, wallet_public_key, last_cursor, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (campaign_id) DO UPDATE
     SET last_cursor = EXCLUDED.last_cursor,
         wallet_public_key = EXCLUDED.wallet_public_key,
         updated_at = NOW()`,
    [campaignId, walletPublicKey, String(cursorToken)],
  );
}

function registrySet(walletPublicKey, patch) {
  const prev = streamRegistry.get(walletPublicKey) || {
    wallet_public_key: walletPublicKey,
    state: "idle",
    last_message_at: null,
    last_error: null,
    reconnect_attempt: 0,
  };
  streamRegistry.set(walletPublicKey, {
    ...prev,
    ...patch,
    wallet_public_key: walletPublicKey,
  });
}

/**
 * REST page through operations after stored cursor (missed while server was down).
 */
async function replayMissedPayments(campaignId, walletPublicKey) {
  let cursor = await loadCursor(campaignId);
  // A stalled wallet with no stored cursor failed on its first payment: replay from the start.
  if (!cursor && stalledWallets.has(walletPublicKey)) cursor = "0";
  if (!cursor) return;

  for (;;) {
    let page;
    try {
      page = await server
        .payments()
        .forAccount(walletPublicKey)
        .cursor(cursor)
        .order("asc")
        .limit(100)
        .call();
    } catch (err) {
      logger.error("Ledger REST replay failed; continuing with stream", {
        wallet_public_key: walletPublicKey,
        campaign_id: campaignId,
        error: err.message,
      });
      if (stalledWallets.has(walletPublicKey)) {
        scheduleStalledReplay(campaignId, walletPublicKey, STALLED_REPLAY_DELAY_MS);
      }
      return;
    }

    const records = page.records || [];
    if (!records.length) break;

    for (const record of records) {
      const ok = await onPaymentRecord(campaignId, walletPublicKey, record, {
        replay: true,
      });
      if (!ok) {
        // Cursor stays at the last indexed payment; try again later.
        scheduleStalledReplay(campaignId, walletPublicKey, STALLED_REPLAY_DELAY_MS);
        return;
      }
    }

    const pageToken =
      page.paging_token || extractPagingToken(records[records.length - 1]);
    if (!pageToken || pageToken === cursor) break;
    cursor = pageToken;
    if (records.length < 100) break;
  }
  stalledWallets.delete(walletPublicKey);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scheduleStalledReplay(campaignId, walletPublicKey, delayMs) {
  const timer = setTimeout(() => {
    runWithCapturedContext(() =>
      replayMissedPayments(campaignId, walletPublicKey).catch((err) =>
        logger.error("Stalled ledger replay failed", {
          wallet_public_key: walletPublicKey,
          campaign_id: campaignId,
          error: err.message,
        }),
      ),
    );
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Process one Horizon payment record. The stored cursor only advances after the
 * payment is durably indexed. On failure the payment is retried with backoff; if
 * it still fails the cursor stays put, an alert is sent and a replay is scheduled.
 * While a wallet is stalled, later stream records do not move the cursor either
 * (indexing is idempotent on tx_hash, so the replay re-processes them safely).
 *
 * @returns {Promise<boolean>} true when the payment was indexed.
 */
async function onPaymentRecord(campaignId, walletPublicKey, record, opts = {}) {
  const token = extractPagingToken(record);
  const retryDelays = opts.retryDelaysMs || INDEX_RETRY_DELAYS_MS;

  let lastError = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await handlePayment(campaignId, walletPublicKey, record);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < retryDelays.length) await sleep(retryDelays[attempt]);
    }
  }

  if (lastError) {
    logger.error("Payment indexing failed; ledger cursor not advanced", {
      wallet_public_key: walletPublicKey,
      campaign_id: campaignId,
      tx_hash: record?.transaction_hash,
      cursor: token,
      error: lastError.message,
    });
    sendAlert("Ledger monitor failed to index payment; cursor held for retry", {
      campaign_id: campaignId,
      wallet_public_key: walletPublicKey,
      tx_hash: record?.transaction_hash,
      error: lastError.message,
    }, {
      alert_key: "ledger_monitor_index_failure",
      fingerprint: `${walletPublicKey}:${lastError.name || "Error"}`,
      severity: "critical",
    });
    if (!stalledWallets.has(walletPublicKey)) {
      stalledWallets.set(walletPublicKey, campaignId);
      if (!opts.replay) {
        scheduleStalledReplay(
          campaignId,
          walletPublicKey,
          opts.replayDelayMs ?? STALLED_REPLAY_DELAY_MS,
        );
      }
    }
    return false;
  }

  if (token && (opts.replay || !stalledWallets.has(walletPublicKey))) {
    try {
      await saveCursor(campaignId, walletPublicKey, token);
    } catch (e) {
      logger.error("Failed to persist ledger cursor", {
        wallet_public_key: walletPublicKey,
        campaign_id: campaignId,
        error: e.message,
      });
    }
  }
  return true;
}

async function handlePayment(campaignId, walletPublicKey, payment) {
  if (payment.to !== walletPublicKey) return;
  if (
    payment.type !== "payment" &&
    payment.type !== "path_payment_strict_receive"
  )
    return;

  const { rows: campaignRows } = await db.query(
    "SELECT status FROM campaigns WHERE id = $1",
    [campaignId],
  );
  if (
    !campaignRows.length ||
    !["active", "funded"].includes(campaignRows[0].status)
  )
    return;

  const destinationAsset =
    payment.asset_type === "native" ? "XLM" : payment.asset_code;
  const destinationAmount = parseFloat(payment.amount);
  const sourceAsset = payment.source_asset_type
    ? payment.source_asset_type === "native"
      ? "XLM"
      : payment.source_asset_code
    : null;
  const sourceAmount = payment.source_amount
    ? parseFloat(payment.source_amount)
    : null;
  const path = Array.isArray(payment.path)
    ? payment.path.map((asset) =>
        asset.asset_type === "native" ? "XLM" : asset.asset_code,
      )
    : null;
  const paymentType = payment.type;
  const conversionRate =
    sourceAmount && destinationAmount ? destinationAmount / sourceAmount : null;
  const txHash = payment.transaction_hash;

  const client = await db.connect();
  let postCommitHooks = null;
  try {
    const existing = await client.query(
      "SELECT id FROM contributions WHERE tx_hash = $1",
      [txHash],
    );
    if (existing.rows.length > 0) return;

    const { rows: txRows } = await client.query(
      `SELECT metadata FROM stellar_transactions WHERE tx_hash = $1 AND kind = 'contribution'`,
      [txHash],
    );
    const platformFeeAmount = txRows[0]?.metadata?.platform_fee_amount ?? null;

    await client.query("BEGIN");

    const { rows: creatorRows } = await client.query(
      "SELECT creator_id FROM campaigns WHERE id = $1",
      [campaignId],
    );
    const creatorId = creatorRows[0].creator_id;

    const { rows: submittedRows } = await client.query(
      `SELECT metadata
       FROM stellar_transactions
       WHERE tx_hash = $1 AND kind = 'contribution'
       LIMIT 1`,
      [txHash],
    );
    const anchorMetadata = submittedRows[0]?.metadata?.anchor || null;
    const displayName = submittedRows[0]?.metadata?.display_name || null;

    const { rows: inserted } = await client.query(
      `INSERT INTO contributions
         (campaign_id, sender_public_key, amount, asset, anchor_id, anchor_transaction_id,
          anchor_asset, anchor_amount, payment_type, source_amount, source_asset,
          conversion_rate, path, tx_hash, platform_fee_amount, display_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)
       RETURNING id`,
      [
        campaignId,
        payment.from,
        destinationAmount,
        destinationAsset,
        anchorMetadata?.anchor_id || null,
        anchorMetadata?.anchor_transaction_id || null,
        anchorMetadata?.anchor_asset || null,
        anchorMetadata?.anchor_amount || null,
        paymentType,
        sourceAmount,
        sourceAsset,
        conversionRate,
        path ? JSON.stringify(path) : null,
        txHash,
        platformFeeAmount,
        displayName,
      ],
    );

    const { rows: fundedRows } = await client.query(
      `UPDATE campaigns
       SET raised_amount = raised_amount + $1,
           status = CASE
             WHEN raised_amount + $1 >= target_amount THEN 'funded'
             ELSE status
           END
       WHERE id = $2
       RETURNING id, creator_id, title, raised_amount, target_amount, asset_type,
         (raised_amount >= target_amount AND raised_amount - $1 < target_amount) AS newly_funded`,
      [destinationAmount, campaignId],
    );

    await markContributionIndexed(client, txHash, inserted[0].id);

    if (anchorMetadata?.anchor_deposit_id) {
      await client.query(
        `UPDATE anchor_deposits
         SET contribution_id = $1,
             status = 'completed',
             updated_at = NOW(),
             completed_at = COALESCE(completed_at, NOW())
         WHERE id = $2`,
        [inserted[0].id, anchorMetadata.anchor_deposit_id],
      );
    }

    const { rows: updatedCampaign } = await client.query(
      "SELECT raised_amount, status FROM campaigns WHERE id = $1",
      [campaignId],
    );

    await client.query("COMMIT");
    postCommitHooks = {
      creatorId,
      contributionId: inserted[0].id,
      campaignId,
      fundedCampaign: fundedRows[0]?.newly_funded ? fundedRows[0] : null,
      contributionPayload: {
        id: inserted[0].id,
        campaign_id: campaignId,
        tx_hash: txHash,
        sender_public_key: payment.from,
        amount: String(destinationAmount),
        asset: destinationAsset,
        payment_type: paymentType,
        anchor_transaction_id: anchorMetadata?.anchor_transaction_id || null,
      },
      receiptPayload: {
        campaignId,
        txHash,
        amount: destinationAmount,
        asset: destinationAsset,
        senderPublicKey: payment.from,
      },
    };
    logger.info("Contribution indexed", {
      campaign_id: campaignId,
      wallet_public_key: walletPublicKey,
      amount: destinationAmount,
      asset: destinationAsset,
      tx_hash: txHash,
    });

    broadcastCampaignUpdate(campaignId, {
      type: "contribution",
      contribution: {
        id: inserted[0].id,
        campaign_id: campaignId,
        sender_public_key: payment.from,
        amount: destinationAmount,
        asset: destinationAsset,
        payment_type: paymentType,
        source_amount: sourceAmount,
        source_asset: sourceAsset,
        conversion_rate: conversionRate,
        path,
        tx_hash: txHash,
        display_name: displayName,
      },
      raised_amount: updatedCampaign[0]?.raised_amount,
      status: updatedCampaign[0]?.status,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors after failed work
    }
    Sentry.withScope((scope) => {
      scope.setTag("stellar.network", process.env.STELLAR_NETWORK);
      scope.setExtra("tx_hash", txHash);
      scope.setExtra("campaign_id", campaignId);
      Sentry.captureException(err);
    });
    logger.error("Failed to index contribution", {
      campaign_id: campaignId,
      tx_hash: txHash,
      error: err.message,
    });
    throw err;
  } finally {
    client.release();
  }

  if (postCommitHooks) {
    // Capture the originating request context (request_id) before deferring so
    // receipt emails, webhook emits and status actions stay correlated.
    const hooks = postCommitHooks;
    setImmediate(() => {
      runWithCapturedContext(() => {
        // Bust public caches — contribution changes raised_amount and contributor_count
        cache.invalidate(`campaigns:id:${hooks.campaignId}`);
        cache.invalidatePrefix('campaigns:list:');
        cache.invalidatePrefix('stats:');

        sendContributionReceipt(hooks.receiptPayload).catch((e) =>
          logger.error("[receipt] Email failed", {
            campaign_id: hooks.campaignId,
            tx_hash: hooks.receiptPayload.txHash,
            error: e.message,
          }),
        );

        // User-level webhooks (legacy)
        emitWebhookEventForUser(
          hooks.creatorId,
          WEBHOOK_EVENTS.CONTRIBUTION_RECEIVED,
          hooks.contributionPayload,
        ).catch((e) =>
          logger.error("Contribution webhook emit failed", { error: e.message }),
        );

        // Campaign-level webhooks
        emitWebhookEventForCampaign(
          hooks.campaignId,
          WEBHOOK_EVENTS.CONTRIBUTION_INDEXED,
          {
            campaign_id: hooks.campaignId,
            tx_hash: hooks.receiptPayload.txHash,
            amount: hooks.receiptPayload.amount,
            asset: hooks.receiptPayload.asset,
            sender: hooks.receiptPayload.senderPublicKey,
            timestamp: new Date().toISOString(),
          },
        ).catch((e) =>
          logger.error("Campaign contribution webhook emit failed", { error: e.message }),
        );

        if (hooks.fundedCampaign) {
          const { triggerCampaignStatusActions } = require('./campaignStatusActions');
          triggerCampaignStatusActions(
            { id: hooks.campaignId, status: 'funded' },
            'active',
          ).catch((e) =>
            logger.error('Funded status actions failed', {
              campaign_id: hooks.campaignId,
              error: e.message,
            }),
          );
        }
      });
    });
  }
}

  function scheduleStreamReconnect(campaignId, walletPublicKey, attempt) {
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      1000 * 2 ** Math.max(0, attempt - 1),
    );
    registrySet(walletPublicKey, {
      state: "reconnecting",
      reconnect_attempt: attempt,
      next_reconnect_at: new Date(Date.now() + delay).toISOString(),
    });
    logger.info("Scheduling ledger stream reconnect", {
      wallet_public_key: walletPublicKey,
      campaign_id: campaignId,
      delay_ms: delay,
      attempt,
    });
    setTimeout(() => {
      runWithCapturedContext(() =>
        watchCampaignWallet(campaignId, walletPublicKey)
          .then(() => reconnectAttempts.delete(walletPublicKey))
          .catch((err) =>
            logger.error("Ledger stream reconnect failed", {
              wallet_public_key: walletPublicKey,
              campaign_id: campaignId,
              error: err.message,
            }),
          ),
      );
    }, delay);
  }

  async function openStreamForWallet(campaignId, walletPublicKey) {
    const stored = await loadCursor(campaignId);
    const streamCursor = stored || "now";

    logger.info("Opening ledger stream", {
      wallet_public_key: walletPublicKey,
      campaign_id: campaignId,
      cursor_mode: stored ? "resumed" : "now",
    });

    const closeStream = server
      .payments()
      .forAccount(walletPublicKey)
      .cursor(streamCursor)
      .stream({
        onmessage: (record) => {
          reconnectAttempts.delete(walletPublicKey);
          registrySet(walletPublicKey, {
            state: "connected",
            last_message_at: new Date().toISOString(),
            reconnect_attempt: 0,
            last_error: null,
          });
          onPaymentRecord(campaignId, walletPublicKey, record).catch((err) =>
            logger.error("Ledger onPaymentRecord failed", {
              wallet_public_key: walletPublicKey,
              campaign_id: campaignId,
              error: err.message,
            }),
          );
        },
        onerror: (err) => {
          logger.error("Ledger stream error", {
            wallet_public_key: walletPublicKey,
            campaign_id: campaignId,
            error: err.message,
          });
          const snap = streamRegistry.get(walletPublicKey);
          const attempt = (reconnectAttempts.get(walletPublicKey) || 0) + 1;
          reconnectAttempts.set(walletPublicKey, attempt);
          try {
            if (snap && typeof snap.close === "function") snap.close();
          } catch {
            // ignore
          }
          streamRegistry.delete(walletPublicKey);
          scheduleStreamReconnect(campaignId, walletPublicKey, attempt);
        },
      });

    registrySet(walletPublicKey, {
      close: closeStream,
      campaign_id: campaignId,
      wallet_public_key: walletPublicKey,
      state: "connected",
      stream_cursor: streamCursor,
      opened_at: new Date().toISOString(),
      reconnect_attempt: 0,
      last_error: null,
    });
  }

  function openStreamCount() {
    let count = 0;
    for (const entry of streamRegistry.values()) {
      if (typeof entry.close === "function") count += 1;
    }
    return count;
  }

  /**
   * Polled wallets have no stream to start them at "now", so make sure they
   * have a stored cursor before their first catch-up: the newest payment, or
   * "0" for an account with none (nothing to replay).
   */
  async function ensurePollCursor(campaignId, walletPublicKey) {
    if (await loadCursor(campaignId)) return;
    const page = await server
      .payments()
      .forAccount(walletPublicKey)
      .order("desc")
      .limit(1)
      .call();
    const newest = (page.records || [])[0];
    await saveCursor(campaignId, walletPublicKey, newest ? extractPagingToken(newest) : "0");
  }

  /** Track a wallet for REST polling because the stream cap is reached. */
  async function pollCampaignWallet(campaignId, walletPublicKey) {
    await ensurePollCursor(campaignId, walletPublicKey);
    polledWallets.set(walletPublicKey, campaignId);
    registrySet(walletPublicKey, {
      campaign_id: campaignId,
      state: "polling",
      opened_at: new Date().toISOString(),
      last_error: null,
    });
  }

  let pollCursorIndex = 0;
  let pollInProgress = false;

  /** Catch up the next batch of polled wallets (round-robin, no overlap). */
  async function pollWalletsOnce({ pollBatchSize } = getWatchConfig()) {
    if (pollInProgress || polledWallets.size === 0) return 0;
    pollInProgress = true;
    try {
      const entries = [...polledWallets.entries()];
      const batch = [];
      for (let i = 0; i < Math.min(pollBatchSize, entries.length); i += 1) {
        batch.push(entries[(pollCursorIndex + i) % entries.length]);
      }
      pollCursorIndex = (pollCursorIndex + batch.length) % entries.length;
      for (const [walletPublicKey, campaignId] of batch) {
        try {
          await replayMissedPayments(campaignId, walletPublicKey);
          registrySet(walletPublicKey, { state: "polling", last_message_at: new Date().toISOString() });
        } catch (err) {
          registrySet(walletPublicKey, { state: "polling", last_error: err.message });
          logger.error("Ledger poll failed", {
            wallet_public_key: walletPublicKey,
            campaign_id: campaignId,
            error: err.message,
          });
        }
      }
      return batch.length;
    } finally {
      pollInProgress = false;
    }
  }

  /**
   * Runs worker(item) for every item with at most `concurrency` in flight,
   * waiting `staggerMs` between starts. Never rejects; failures are logged.
   */
  async function runStaggered(items, worker, { concurrency, staggerMs }) {
    let next = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await worker(item);
        if (next < items.length) await sleep(staggerMs);
      }
    });
    await Promise.all(runners);
  }

  /**
   * REST-replay from DB cursor, then open SSE stream (with auto-reconnect on
   * errors). Once LEDGER_MAX_STREAMS streams are open, further wallets are
   * caught up by REST polling instead.
   */
  async function watchCampaignWallet(campaignId, walletPublicKey) {
    if (polledWallets.has(walletPublicKey)) return;
    const existing = streamRegistry.get(walletPublicKey);
    if (
      existing &&
      existing.state === "connected" &&
      typeof existing.close === "function"
    ) {
      return;
    }
    if (existing) {
      try {
        if (typeof existing.close === "function") existing.close();
      } catch {
        // ignore
      }
      streamRegistry.delete(walletPublicKey);
    }

    await replayMissedPayments(campaignId, walletPublicKey);
    if (openStreamCount() >= getWatchConfig().maxStreams) {
      logger.warn("Ledger stream cap reached; polling wallet instead", {
        wallet_public_key: walletPublicKey,
        campaign_id: campaignId,
        max_streams: getWatchConfig().maxStreams,
      });
      await pollCampaignWallet(campaignId, walletPublicKey);
      return;
    }
    await openStreamForWallet(campaignId, walletPublicKey);
  }

  /**
   * Balance reconciliation lives in services/reconciliation (incremental,
   * batched, overlap-guarded) and is scheduled once from src/index.js. This
   * module used to run a second, full-table scan every 10 minutes.
   */
  function reconcileCampaignBalances() {
    return require("./reconciliation").runReconciliation();
  }

  async function startLedgerMonitor() {
    const { rows } = await db.query(
      `SELECT id, wallet_public_key FROM campaigns WHERE status IN ('active', 'funded')`,
    );

    const config = getWatchConfig();

    // Poll over-cap wallets on a fixed interval (no overlap between ticks).
    const pollTimer = setInterval(() => {
      runWithCapturedContext(() =>
        pollWalletsOnce(config).catch((err) =>
          logger.error("Ledger poll tick failed", { error: err.message }),
        ),
      );
    }, config.pollIntervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();

    // Stagger startup instead of opening every wallet's replay + stream at
    // once: at most `concurrency` in flight, `staggerMs` apart.
    await runStaggered(
      rows,
      (campaign) =>
        watchCampaignWallet(campaign.id, campaign.wallet_public_key).catch((err) =>
          logger.error("Failed to watch campaign wallet", {
            wallet_public_key: campaign.wallet_public_key,
            campaign_id: campaign.id,
            error: err.message,
          }),
        ),
      config,
    );

    logger.info("Watching active and funded campaigns", {
      campaign_count: rows.length,
      streams_open: openStreamCount(),
      wallets_polled: polledWallets.size,
    });

    const healthTimer = setInterval(
      () => {
        runWithCapturedContext(() =>
          getLedgerStreamHealth()
            .then((h) => {
              const bad = h.streams.filter((s) => s.stale_stream_no_messages_15m);
              if (bad.length) {
                logger.warn("Ledger stream health: connected streams idle >15m", {
                  wallet_public_keys: bad.map((b) => b.wallet_public_key),
                });
              }
            })
            .catch(() => {}),
        );
      },
      5 * 60 * 1000,
    );
    if (typeof healthTimer.unref === "function") healthTimer.unref();
  }

  /** For GET /health/ledger — in-process stream status + DB cursors. */
  async function getLedgerStreamHealth() {
    const { rows: dbCursors } = await db.query(
      `SELECT c.id AS campaign_id, c.wallet_public_key, c.status AS campaign_status,
            lc.last_cursor, lc.updated_at AS cursor_updated_at
     FROM campaigns c
     LEFT JOIN ledger_stream_cursors lc ON lc.campaign_id = c.id
     WHERE c.status IN ('active', 'funded')`,
    );

    const streams = dbCursors.map((row) => {
      const live = streamRegistry.get(row.wallet_public_key) || {};
      return {
        campaign_id: row.campaign_id,
        wallet_public_key: row.wallet_public_key,
        campaign_status: row.campaign_status,
        last_cursor: row.last_cursor || null,
        cursor_updated_at: row.cursor_updated_at || null,
        stream_state: live.state || "not_connected",
        stream_opened_at: live.opened_at || null,
        last_stream_message_at: live.last_message_at || null,
        last_stream_error: live.last_error || null,
        reconnect_attempt:
          live.reconnect_attempt ||
          reconnectAttempts.get(row.wallet_public_key) ||
          0,
        next_reconnect_at: live.next_reconnect_at || null,
      };
    });

    const staleMs = 15 * 60 * 1000;
    const now = Date.now();
    const streamsWithStale = streams.map((s) => {
      const last = s.last_stream_message_at
        ? new Date(s.last_stream_message_at).getTime()
        : 0;
      const stale =
        s.stream_state === "connected" && last > 0 && now - last > staleMs;
      return { ...s, stale_stream_no_messages_15m: stale };
    });

    return {
      active_campaigns: streamsWithStale.length,
      streams_open: openStreamCount(),
      wallets_polled: polledWallets.size,
      streams: streamsWithStale,
    };
  }

  module.exports = {
    startLedgerMonitor,
    watchCampaignWallet,
    pollWalletsOnce,
    getWatchConfig,
    handlePayment,
    onPaymentRecord,
    reconcileCampaignBalances,
    getLedgerStreamHealth,
    addSSEClient,
    removeSSEClient,
  };
