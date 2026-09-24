const router = require('express').Router();
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const { sendAlert } = require('../services/alerting');
const {
  buildWithdrawalTransaction,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
} = require('../services/stellarService');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
} = require('../services/stellarTransactionService');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { invokeContract, nativeToScVal } = require('../services/sorobanService');
const crypto = require('crypto');

function canPerformPlatformSignature(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return false;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

function validatePublicKey(publicKey) {
  try {
    Keypair.fromPublicKey(publicKey);
    return true;
  } catch (_err) {
    return false;
  }
}

function toReleaseAmount(raisedAmount, releasePercentage) {
  return ((Number(raisedAmount) * Number(releasePercentage)) / 100).toFixed(7);
}

const MILESTONE_LIMIT = 5;

async function logWithdrawalEvent(client, { withdrawalRequestId, actorUserId, action, note, metadata }) {
  await client.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [withdrawalRequestId, actorUserId || null, action, note || null, metadata ? JSON.stringify(metadata) : null]
  );
}

async function setCampaignStatusFromMilestoneProgress(client, campaignId) {
  const { rows } = await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'released')::int AS released_count
     FROM milestones
     WHERE campaign_id = $1`,
    [campaignId]
  );
  const total = rows[0]?.total || 0;
  const releasedCount = rows[0]?.released_count || 0;

  if (!total || !releasedCount) return null;

  const nextStatus = releasedCount >= total ? 'completed' : 'in_progress';
  const { rows: updated } = await client.query(
    `UPDATE campaigns
     SET status = $1
     WHERE id = $2 AND status IN ('funded', 'in_progress', 'completed')
     RETURNING id, status`,
    [nextStatus, campaignId]
  );
  return updated[0] || null;
}

router.get('/campaign/:campaignId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.*, 
            (c.milestones_contract_id IS NOT NULL AND c.soroban_status = 'verified') AS on_chain
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.campaign_id = $1
     ORDER BY m.sort_order ASC, m.created_at ASC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

router.post('/', requireAuth, async (req, res) => {
  const {
    campaign_id: campaignId,
    title,
    description,
    release_percentage: releasePercentage,
    sort_order: sortOrder,
  } = req.body || {};

  if (!campaignId || !title || releasePercentage == null) { // eslint-disable-line eqeqeq
    return res.status(400).json({ error: 'campaign_id, title and release_percentage are required' });
  }

  const percentage = Number(releasePercentage);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    return res.status(400).json({ error: 'release_percentage must be between 0 and 100' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: camp } = await client.query(
      'SELECT id, creator_id FROM campaigns WHERE id = $1 FOR UPDATE',
      [campaignId]
    );
    if (!camp.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (camp[0].creator_id !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the campaign creator can add milestones' });
    }

    const { rows: stats } = await client.query(
      `SELECT
         COUNT(*)::int AS count,
         COALESCE(SUM(release_percentage), 0)::numeric AS total_percentage
       FROM milestones
       WHERE campaign_id = $1`,
      [campaignId]
    );
    if ((stats[0]?.count || 0) >= MILESTONE_LIMIT) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Campaigns can define at most ${MILESTONE_LIMIT} milestones` });
    }

    const newTotal = Number(stats[0]?.total_percentage || 0) + percentage;
    if (newTotal > 100.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Milestone release percentages cannot exceed 100% total' });
    }

    const { rows } = await client.query(
      `INSERT INTO milestones (campaign_id, title, description, release_percentage, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [campaignId, String(title).trim(), String(description || '').trim() || null, percentage.toFixed(4), Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : stats[0]?.count || 0]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not create milestone' });
  } finally {
    client.release();
  }
});

router.post('/:id/submit', requireAuth, async (req, res) => {
  const { evidence_url: evidenceUrl, destination_key: destinationKey } = req.body || {};
  if (!evidenceUrl || !destinationKey) {
    return res.status(400).json({ error: 'evidence_url and destination_key are required' });
  }
  if (!validatePublicKey(destinationKey)) {
    return res.status(400).json({ error: 'destination_key must be a valid Stellar public key' });
  }

  const { rows: milestones } = await db.query(
    `SELECT m.*, c.creator_id, c.status AS campaign_status
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.id = $1`,
    [req.params.id]
  );
  if (!milestones.length) return res.status(404).json({ error: 'Milestone not found' });
  const milestone = milestones[0];

  if (milestone.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only the campaign creator can submit milestone evidence' });
  }
  if (!['funded', 'in_progress'].includes(milestone.campaign_status)) {
    return res.status(409).json({ error: `Milestone submission is not available while campaign status is "${milestone.campaign_status}".` });
  }
  if (milestone.status === 'released') {
    return res.status(409).json({ error: 'This milestone has already been released' });
  }

  const { rows: updated } = await db.query(
    `UPDATE milestones
     SET evidence_url = $1,
         destination_key = $2,
         review_note = NULL,
         completed_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [String(evidenceUrl).trim(), destinationKey, req.params.id]
  );

  // Soroban integration: Submit milestone on-chain
  const { rows: campaignRows } = await db.query(
    'SELECT milestones_contract_id FROM campaigns WHERE id = $1',
    [milestone.campaign_id]
  );
  const contractId = campaignRows[0]?.milestones_contract_id;
  
  if (contractId) {
    try {
      const evidenceHash = crypto.createHash('sha256').update(evidenceUrl).digest();
      const { rows: userRows } = await db.query(
        'SELECT wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
        [req.user.userId]
      );
      const user = userRows[0];
      
      await withDecryptedWalletSecret(
        user.wallet_secret_encrypted,
        { userId: req.user.userId, walletPublicKey: user.wallet_public_key },
        async (secret) => {
          await invokeContract({
            contractId,
            method: 'submit_milestone',
            args: [nativeToScVal(milestone.sort_order), nativeToScVal(evidenceHash)],
            signerSecret: secret,
          });
        }
      );
    } catch (err) {
      logger.error('Soroban submit_milestone failed', { error: err.message, milestone_id: milestone.id });
    }
  }

  res.json(updated[0]);
});

router.post('/:id/reject', requireAuth, async (req, res) => {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return res.status(403).json({ error: 'Only the designated platform approver can reject milestones' });
  }

  const reason = String(req.body?.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ error: 'reason is required' });
  }

  const { rows } = await db.query(
    `UPDATE milestones
     SET status = 'pending',
         review_note = $1,
         approved_at = NULL
     WHERE id = $2 AND status <> 'released'
     RETURNING *`,
    [reason, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Milestone not found or already released' });

  // Soroban integration: Reject milestone on-chain
  const { rows: campaignRows } = await db.query(
    'SELECT milestones_contract_id FROM campaigns WHERE id = $1',
    [rows[0].campaign_id]
  );
  const contractId = campaignRows[0]?.milestones_contract_id;
  if (contractId) {
    try {
      const reasonHash = crypto.createHash('sha256').update(reason).digest();
      await invokeContract({
        contractId,
        method: 'reject_milestone',
        args: [nativeToScVal(rows[0].sort_order), nativeToScVal(reasonHash)],
        signerSecret: process.env.PLATFORM_SECRET_KEY,
      });
    } catch (err) {
      logger.error('Soroban reject_milestone failed', { error: err.message, milestone_id: req.params.id });
    }
  }

  res.json(rows[0]);
});

const approveMilestoneReleaseHandler = async (req, res) => {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return res.status(403).json({ error: 'Only the designated platform approver can approve milestones' });
  }

  const reviewNote = String(req.body?.reason || '').trim() || null;

  const { rows: milestoneRows } = await db.query(
    `SELECT m.*, c.status AS campaign_status, c.wallet_public_key AS campaign_wallet_public_key,
            c.asset_type, c.raised_amount, c.target_amount, c.title AS campaign_title,
            c.creator_id, u.wallet_public_key AS creator_wallet_public_key,
            u.wallet_secret_encrypted
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     JOIN users u ON u.id = c.creator_id
     WHERE m.id = $1`,
    [req.params.id]
  );
  if (!milestoneRows.length) return res.status(404).json({ error: 'Milestone not found' });
  const milestone = milestoneRows[0];

  if (!['funded', 'in_progress'].includes(milestone.campaign_status)) {
    return res.status(409).json({ error: `Milestone approval is not available while campaign status is "${milestone.campaign_status}".` });
  }
  if (!milestone.evidence_url) {
    return res.status(409).json({ error: 'Creator must submit milestone evidence before approval' });
  }
  if (!milestone.destination_key || !validatePublicKey(milestone.destination_key)) {
    return res.status(409).json({ error: 'Creator must provide a valid payout destination before approval' });
  }
  if (milestone.status === 'released') {
    return res.status(409).json({ error: 'Milestone already released' });
  }

  let releaseAmount;
  let unsignedXdr = null;
  let fullySignedXdr;
  let txHash;

  if (milestone.release_tx_hash) {
    // A previous approval submitted the payout on-chain but its DB commit failed: reconcile
    // from the recorded transaction instead of paying again.
    releaseAmount = milestone.release_amount ?? toReleaseAmount(milestone.raised_amount, milestone.release_percentage);
    fullySignedXdr = milestone.release_signed_xdr;
    txHash = milestone.release_tx_hash;
    logger.warn('Reconciling milestone release that was submitted on-chain', { milestone_id: milestone.id, tx_hash: txHash });
  } else {
    // Claim the release BEFORE any on-chain submission; only one concurrent approval can win.
    const { rows: claimRows } = await db.query(
      `UPDATE milestones m
       SET release_claimed_at = NOW()
       WHERE m.id = $1
         AND m.status <> 'released'
         AND m.release_claimed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM withdrawal_requests w WHERE w.milestone_id = m.id)
       RETURNING m.id`,
      [milestone.id]
    );
    if (!claimRows.length) {
      return res.status(409).json({ error: 'A release is already in progress or recorded for this milestone' });
    }

    const releaseClaim = async () => {
      await db.query('UPDATE milestones SET release_claimed_at = NULL WHERE id = $1', [milestone.id])
        .catch((e) => logger.error('Failed to release milestone claim', { milestone_id: milestone.id, error: e.message }));
    };

    releaseAmount = toReleaseAmount(milestone.raised_amount, milestone.release_percentage);
    try {
      unsignedXdr = await buildWithdrawalTransaction({
        campaignWalletPublicKey: milestone.campaign_wallet_public_key,
        destinationPublicKey: milestone.destination_key,
        amount: releaseAmount,
        asset: milestone.asset_type,
      });
    } catch (err) {
      await releaseClaim();
      logger.error('Milestone release transaction build failed', { milestone_id: milestone.id, error: err.message });
      return res.status(502).json({ error: 'Could not build the milestone release transaction' });
    }

    let creatorSignedXdr;
    try {
      creatorSignedXdr = await withDecryptedWalletSecret(
        milestone.wallet_secret_encrypted,
        {
          userId: milestone.creator_id,
          walletPublicKey: milestone.creator_wallet_public_key,
        },
        async (creatorSecret) =>
          signTransactionXdr({
            xdr: unsignedXdr,
            signerSecret: creatorSecret,
          })
      );
    } catch (err) {
      await releaseClaim();
      logger.error('Milestone creator signature failed', { milestone_id: milestone.id, error: err.message });
      return res.status(503).json({ error: 'Creator signature could not be produced for this milestone release.' });
    }

    fullySignedXdr = signTransactionXdr({
      xdr: creatorSignedXdr,
      signerSecret: process.env.PLATFORM_SECRET_KEY,
    });

    if (signatureCountFromXdr(fullySignedXdr) < 2) {
      await releaseClaim();
      return res.status(422).json({ error: 'Milestone release requires both creator and platform signatures' });
    }

    try {
      txHash = await submitSignedWithdrawal({ xdr: fullySignedXdr });
    } catch (err) {
      await releaseClaim();
      logger.error('Milestone release submission failed', { milestone_id: milestone.id, error: err.message });
      sendAlert('Milestone release submission failed', { milestone_id: milestone.id, error: err.message });
      return res.status(502).json({
        error: 'Stellar network rejected the milestone release transaction',
        detail: err.message || String(err),
      });
    }

    // Record the on-chain payout immediately so a failed DB commit below can be reconciled.
    try {
      await db.query(
        `UPDATE milestones
         SET release_tx_hash = $1, release_signed_xdr = $2, release_amount = $3
         WHERE id = $4`,
        [txHash, fullySignedXdr, releaseAmount, milestone.id]
      );
    } catch (err) {
      logger.error('Failed to record milestone release tx hash', { milestone_id: milestone.id, tx_hash: txHash, error: err.message });
      sendAlert('Milestone release paid on-chain but tx hash not recorded', { milestone_id: milestone.id, tx_hash: txHash });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRelease } = await client.query(
      'SELECT id FROM withdrawal_requests WHERE milestone_id = $1 LIMIT 1',
      [milestone.id]
    );
    if (existingRelease.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A release has already been recorded for this milestone' });
    }

    const { rows: releaseRows } = await client.query(
      `INSERT INTO withdrawal_requests
         (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
          creator_signed, platform_signed, status, tx_hash, milestone_id)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'submitted', $6, $7)
       RETURNING *`,
      [
        milestone.campaign_id,
        req.user.userId,
        releaseAmount,
        milestone.destination_key,
        fullySignedXdr,
        txHash,
        milestone.id,
      ]
    );
    const withdrawalRequest = releaseRows[0];

    await logWithdrawalEvent(client, {
      withdrawalRequestId: withdrawalRequest.id,
      actorUserId: req.user.userId,
      action: 'requested',
      note: 'Milestone release approved by platform',
      metadata: { milestone_id: milestone.id, release_percentage: milestone.release_percentage, release_amount: releaseAmount },
    });
    await logWithdrawalEvent(client, {
      withdrawalRequestId: withdrawalRequest.id,
      actorUserId: milestone.creator_id,
      action: 'creator_signed',
      note: 'Creator signature applied during milestone release',
      metadata: { milestone_id: milestone.id },
    });
    await logWithdrawalEvent(client, {
      withdrawalRequestId: withdrawalRequest.id,
      actorUserId: req.user.userId,
      action: 'platform_signed',
      note: reviewNote || 'Platform approved milestone release',
      metadata: { milestone_id: milestone.id, tx_hash: txHash },
    });

    await insertWithdrawalPendingSignatures(client, {
      campaignId: milestone.campaign_id,
      withdrawalRequestId: withdrawalRequest.id,
      userId: req.user.userId,
      unsignedXdr: unsignedXdr || fullySignedXdr,
      metadata: {
        milestone_id: milestone.id,
        milestone_title: milestone.title,
        amount: releaseAmount,
        asset_type: milestone.asset_type,
      },
    });
    await finalizeWithdrawalSubmitted(client, {
      withdrawalRequestId: withdrawalRequest.id,
      txHash,
      signedXdr: fullySignedXdr,
    });

    const { rows: updatedMilestones } = await client.query(
      `UPDATE milestones
       SET status = 'released',
           review_note = $1,
           approved_at = COALESCE(approved_at, NOW()),
           released_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reviewNote, milestone.id]
    );

    // Soroban integration: Approve milestone on-chain
    const { rows: campaignRows } = await client.query(
      'SELECT milestones_contract_id FROM campaigns WHERE id = $1',
      [milestone.campaign_id]
    );
    const contractId = campaignRows[0]?.milestones_contract_id;
    if (contractId) {
      try {
        await invokeContract({
          contractId,
          method: 'approve_milestone',
          args: [nativeToScVal(milestone.sort_order)],
          signerSecret: process.env.PLATFORM_SECRET_KEY,
        });
      } catch (err) {
        logger.error('Soroban approve_milestone failed', { error: err.message, milestone_id: milestone.id });
        // Note: Funds might have been released by the backend call already, 
        // or the contract might fail if it's already approved.
      }
    }

    const campaignStatus = await setCampaignStatusFromMilestoneProgress(client, milestone.campaign_id);

    await client.query('COMMIT');

    setImmediate(() => {
      emitWebhookEventForUser(milestone.creator_id, WEBHOOK_EVENTS.MILESTONE_APPROVED, {
        milestone: updatedMilestones[0],
        campaign_id: milestone.campaign_id,
        withdrawal_request_id: withdrawalRequest.id,
        tx_hash: txHash,
      }).catch((e) => logger.error('Milestone webhook emit failed', { error: e.message }));
    });

    res.json({
      milestone: updatedMilestones[0],
      withdrawal_request: withdrawalRequest,
      campaign_status: campaignStatus?.status || milestone.campaign_status,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Milestone approval persistence failed after Stellar submit', {
      milestone_id: milestone.id,
      tx_hash: txHash,
      error: err.message,
    });
    sendAlert('Milestone approval persistence failed after Stellar submit', {
      milestone_id: milestone.id,
      tx_hash: txHash,
      error: err.message,
    });
    res.status(500).json({ error: 'Milestone release was submitted but could not be recorded cleanly' });
  } finally {
    client.release();
  }
};

router.post('/:id/approve', requireAuth, approveMilestoneReleaseHandler);
router.post('/:id/release', requireAuth, approveMilestoneReleaseHandler);

module.exports = router;
