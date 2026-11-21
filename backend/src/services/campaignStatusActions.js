const db = require('../config/database');
const logger = require('../config/logger');
const { sendEmailSafe } = require('./emailService');
const { createNotification } = require('./notifications');
const {
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  WEBHOOK_EVENTS,
} = require('./webhookDispatcher');
const { buildWithdrawalTransaction } = require('./stellarService');
const { insertWithdrawalPendingSignatures } = require('./stellarTransactionService');
const { invokeContract } = require('./sorobanService');
const { sendAlert } = require('./alerting');

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function refundActorUserId(creatorId) {
  return process.env.PLATFORM_APPROVER_USER_ID || creatorId;
}

async function logWithdrawalEvent(client, { withdrawalRequestId, actorUserId, action, note, metadata }) {
  const runner = client || db;
  await runner.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      withdrawalRequestId,
      actorUserId || null,
      action,
      note || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

/**
 * Record a terminal status transition. Returns the event row id when newly inserted,
 * or null when this transition was already processed (idempotency guard).
 */
async function recordStatusTransition(campaignId, previousStatus, newStatus) {
  const { rows } = await db.query(
    `INSERT INTO campaign_status_events (campaign_id, previous_status, new_status)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, new_status) DO NOTHING
     RETURNING id`,
    [campaignId, previousStatus, newStatus]
  );
  return rows[0]?.id || null;
}

async function loadCampaignContext(campaignId) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.status, c.target_amount, c.raised_amount, c.deadline,
            c.wallet_public_key, c.escrow_contract_id, c.creator_id,
            u.email AS creator_email, u.name AS creator_name
     FROM campaigns c
     JOIN users u ON u.id = c.creator_id
     WHERE c.id = $1`,
    [campaignId]
  );
  return rows[0] || null;
}

async function loadContributorRecipients(campaignId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (u.id) u.id, u.email, u.name
     FROM contributions c
     JOIN users u ON u.wallet_public_key = c.sender_public_key
        OR u.id IN (SELECT user_id FROM user_wallet_keys WHERE public_key = c.sender_public_key)
     WHERE c.campaign_id = $1
       AND u.email IS NOT NULL
     ORDER BY u.id, c.created_at ASC`,
    [campaignId]
  );
  return rows;
}

async function syncSorobanStatus(campaign) {
  if (!campaign.escrow_contract_id) return;

  const platformSecret = process.env.PLATFORM_SECRET_KEY;
  if (!platformSecret) {
    logger.warn('Skipping Soroban status sync — PLATFORM_SECRET_KEY not configured', {
      campaign_id: campaign.id,
    });
    return;
  }

  try {
    await invokeContract({
      contractId: campaign.escrow_contract_id,
      method: 'get_total_raised',
      args: [],
      signerSecret: platformSecret,
    });
    logger.info('Soroban escrow contract verified for campaign status transition', {
      campaign_id: campaign.id,
      contract_id: campaign.escrow_contract_id,
      status: campaign.status,
    });
    await db.query("UPDATE campaigns SET soroban_status = 'verified' WHERE id = $1", [campaign.id]);
  } catch (err) {
    await db
      .query("UPDATE campaigns SET soroban_status = 'failed' WHERE id = $1", [campaign.id])
      .catch(() => {});
    logger.error('Soroban escrow verification failed after status transition', {
      campaign_id: campaign.id,
      contract_id: campaign.escrow_contract_id,
      error: err.message,
    });
  }
}

async function sendFundedEmails(campaign, contributors) {
  const campaignUrl = `${frontendBaseUrl()}/campaigns/${campaign.id}`;
  const creatorName = campaign.creator_name || 'there';

  await sendEmailSafe({
    to: campaign.creator_email,
    subject: `Your campaign "${campaign.title}" has reached its goal`,
    text: [
      `Hi ${creatorName},`,
      '',
      `Congratulations! Your campaign "${campaign.title}" has reached its funding goal of ${campaign.target_amount}.`,
      '',
      `Total raised: ${campaign.raised_amount}`,
      '',
      `View your campaign: ${campaignUrl}`,
      '',
      'You can now request a withdrawal from your creator dashboard.',
    ].join('\n'),
  });

  await Promise.all(
    contributors.map((contributor) =>
      sendEmailSafe({
        to: contributor.email,
        subject: `Campaign you backed has been fully funded: "${campaign.title}"`,
        text: [
          `Hi ${contributor.name || 'there'},`,
          '',
          `Great news — "${campaign.title}" has reached its funding goal.`,
          '',
          `View the campaign: ${campaignUrl}`,
          '',
          'Thank you for backing this campaign on CrowdPay.',
        ].join('\n'),
      })
    )
  );
}

async function sendFailedEmails(campaign, contributors) {
  const campaignUrl = `${frontendBaseUrl()}/campaigns/${campaign.id}`;
  const refundsUrl = `${campaignUrl}?refund=1`;
  const creatorName = campaign.creator_name || 'there';
  const deadlineText = campaign.deadline
    ? new Date(campaign.deadline).toDateString()
    : 'the deadline';

  await sendEmailSafe({
    to: campaign.creator_email,
    subject: `Your campaign "${campaign.title}" ended below its goal`,
    text: [
      `Hi ${creatorName},`,
      '',
      `Your campaign "${campaign.title}" ended on ${deadlineText} without reaching its goal of ${campaign.target_amount}.`,
      '',
      `Amount raised: ${campaign.raised_amount}`,
      '',
      'Contributors will receive refund instructions automatically.',
      '',
      `Campaign page: ${campaignUrl}`,
    ].join('\n'),
  });

  await Promise.all(
    contributors.map((contributor) =>
      sendEmailSafe({
        to: contributor.email,
        subject: `Campaign ended — your refund is available: "${campaign.title}"`,
        text: [
          `Hi ${contributor.name || 'there'},`,
          '',
          `"${campaign.title}" did not reach its funding goal and has ended.`,
          '',
          'Your contribution is eligible for a refund. Sign in to CrowdPay to claim your refund:',
          refundsUrl,
          '',
          'Refunds are processed via the Stellar network back to the wallet you contributed from.',
          '',
          `Campaign page: ${campaignUrl}`,
        ].join('\n'),
      })
    )
  );
}

async function emitFundedWebhooks(campaign) {
  const payload = {
    campaign_id: campaign.id,
    title: campaign.title,
    target_amount: String(campaign.target_amount),
    raised_amount: String(campaign.raised_amount),
    status: 'funded',
    timestamp: new Date().toISOString(),
  };

  await emitWebhookEventForUser(campaign.creator_id, WEBHOOK_EVENTS.CAMPAIGN_FUNDED, {
    campaign: payload,
  });
  await emitWebhookEventForCampaign(campaign.id, WEBHOOK_EVENTS.CAMPAIGN_FUNDED, payload);
}

async function emitFailedWebhooks(campaign) {
  const payload = {
    campaign_id: campaign.id,
    title: campaign.title,
    target_amount: String(campaign.target_amount),
    raised_amount: String(campaign.raised_amount),
    status: 'failed',
    deadline: campaign.deadline,
    timestamp: new Date().toISOString(),
  };

  await emitWebhookEventForUser(campaign.creator_id, WEBHOOK_EVENTS.CAMPAIGN_FAILED, {
    campaign: payload,
  });
  await emitWebhookEventForCampaign(campaign.id, WEBHOOK_EVENTS.CAMPAIGN_FAILED, payload);
}

async function createFundedNotifications(campaign, contributors) {
  await createNotification(campaign.creator_id, {
    type: 'goal_reached',
    title: 'Goal reached!',
    body: `Your campaign "${campaign.title}" has reached its funding goal.`,
    link: `/campaigns/${campaign.id}`,
  });

  await Promise.all(
    contributors.map((contributor) =>
      createNotification(contributor.id, {
        type: 'campaign_funded',
        title: 'Campaign fully funded',
        body: `"${campaign.title}" has reached its funding goal.`,
        link: `/campaigns/${campaign.id}`,
      })
    )
  );
}

async function createFailedNotifications(campaign, contributors) {
  await createNotification(campaign.creator_id, {
    type: 'campaign_failed',
    title: 'Campaign ended',
    body: `"${campaign.title}" ended without reaching its goal.`,
    link: `/campaigns/${campaign.id}`,
  });

  await Promise.all(
    contributors.map((contributor) =>
      createNotification(contributor.id, {
        type: 'refund_available',
        title: 'Refund available',
        body: `"${campaign.title}" ended below its goal. You can claim a refund.`,
        link: `/campaigns/${campaign.id}?refund=1`,
      })
    )
  );
}

/**
 * Queue refund withdrawal requests for each Stellar contribution on a failed campaign.
 */
async function queueFailedCampaignRefunds(campaignId, actorUserId) {
  const { rows: campaigns } = await db.query(
    `SELECT id, wallet_public_key, status, creator_id FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!campaigns.length || campaigns[0].status !== 'failed') {
    return { refundsCreated: 0, refunds: [] };
  }
  const campaign = campaigns[0];

  const { rows: contributions } = await db.query(
    `SELECT c.*,
            COALESCE(
              (SELECT u.wallet_public_key FROM user_wallet_keys k
                 JOIN users u ON u.id = k.user_id
                WHERE k.public_key = c.sender_public_key),
              c.sender_public_key
            ) AS refund_destination_key
       FROM contributions c
       WHERE c.campaign_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM withdrawal_requests wr WHERE wr.contribution_id = c.id
         )
       ORDER BY c.created_at ASC`,
    [campaignId]
  );

  if (!contributions.length) {
    return { refundsCreated: 0, refunds: [] };
  }

  const client = await db.connect();
  const created = [];
  try {
    await client.query('BEGIN');

    for (const contribution of contributions) {
      const unsignedXdr = await buildWithdrawalTransaction({
        campaignWalletPublicKey: campaign.wallet_public_key,
        destinationPublicKey: contribution.refund_destination_key || contribution.sender_public_key,
        amount: contribution.amount,
        asset: contribution.asset,
      });

      const { rows: requestRows } = await client.query(
        `INSERT INTO withdrawal_requests
           (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
            creator_signed, platform_signed, contribution_id, is_refund)
         VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6, TRUE)
         RETURNING id`,
        [
          campaignId,
          actorUserId || refundActorUserId(campaign.creator_id),
          contribution.amount,
          contribution.refund_destination_key || contribution.sender_public_key,
          unsignedXdr,
          contribution.id,
        ]
      );

      const refundRequestId = requestRows[0].id;
      await logWithdrawalEvent(client, {
        withdrawalRequestId: refundRequestId,
        actorUserId: actorUserId || refundActorUserId(campaign.creator_id),
        action: 'requested',
        note: 'Automatic refund queued for failed campaign',
        metadata: {
          contribution_id: contribution.id,
          amount: contribution.amount,
          asset: contribution.asset,
          automated: true,
        },
      });
      await insertWithdrawalPendingSignatures(client, {
        campaignId,
        withdrawalRequestId: refundRequestId,
        userId: actorUserId || refundActorUserId(campaign.creator_id),
        unsignedXdr,
        metadata: {
          refund_for_contribution_id: contribution.id,
          amount: contribution.amount,
          asset: contribution.asset,
          automated: true,
        },
      });

      created.push({ contribution_id: contribution.id, refund_request_id: refundRequestId });
    }

    await client.query('COMMIT');
    return { refundsCreated: created.length, refunds: created };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Automatic refund queue failed', { campaign_id: campaignId, error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function handleFundedTransition(campaign) {
  const contributors = await loadContributorRecipients(campaign.id);

  await Promise.all([
    sendFundedEmails(campaign, contributors),
    emitFundedWebhooks(campaign),
    createFundedNotifications(campaign, contributors),
    syncSorobanStatus(campaign),
  ]);
}

async function handleFailedTransition(campaign) {
  const contributors = await loadContributorRecipients(campaign.id);
  const actorUserId = refundActorUserId(campaign.creator_id);

  await Promise.all([
    sendFailedEmails(campaign, contributors),
    emitFailedWebhooks(campaign),
    createFailedNotifications(campaign, contributors),
  ]);

  const refundResult = await queueFailedCampaignRefunds(campaign.id, actorUserId);
  logger.info('Failed campaign refund queue completed', {
    campaign_id: campaign.id,
    refunds_created: refundResult.refundsCreated,
  });
}

async function executeWithRetry(fn, retries = 2, delayMs = 50) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Run downstream actions after a campaign transitions to funded or failed.
 * Idempotent: duplicate calls for the same terminal status are no-ops.
 */
async function triggerCampaignStatusActions(campaign, previousStatus) {
  if (!campaign?.id || !campaign?.status) return;
  if (campaign.status !== 'funded' && campaign.status !== 'failed') return;

  const eventId = await recordStatusTransition(campaign.id, previousStatus, campaign.status);
  if (!eventId) {
    logger.debug('Campaign status actions already processed', {
      campaign_id: campaign.id,
      status: campaign.status,
    });
    return;
  }

  const fullCampaign = await loadCampaignContext(campaign.id);
  if (!fullCampaign) {
    logger.error('Campaign not found for status actions', { campaign_id: campaign.id });
    await db.query('DELETE FROM campaign_status_events WHERE id = $1', [eventId]).catch(() => {});
    return;
  }

  logger.info('Triggering campaign status actions', {
    campaign_id: campaign.id,
    previous_status: previousStatus,
    new_status: campaign.status,
    event_id: eventId,
  });

  try {
    await executeWithRetry(async () => {
      if (campaign.status === 'funded') {
        await handleFundedTransition(fullCampaign);
      } else {
        await handleFailedTransition(fullCampaign);
      }
    });
  } catch (err) {
    logger.error('Campaign status downstream side effects failed', {
      campaign_id: campaign.id,
      status: campaign.status,
      error: err.message,
    });
    await sendAlert('Campaign status downstream side effects failed', {
      campaign_id: campaign.id,
      status: campaign.status,
      error: err.message,
    });
    // Remove the recorded transition so that subsequent replays are not suppressed
    await db.query('DELETE FROM campaign_status_events WHERE id = $1', [eventId]).catch(() => {});
    throw err;
  }
}


module.exports = {
  triggerCampaignStatusActions,
  recordStatusTransition,
  queueFailedCampaignRefunds,
  refundActorUserId,
};
