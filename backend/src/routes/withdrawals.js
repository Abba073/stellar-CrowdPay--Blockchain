const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const { sendAlert } = require('../services/alerting');
const { withdrawalValidation, validateRequest } = require('../middleware/validation');
const {
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  getTransactionHash,
  transactionExistsOnHorizon,
  isXdrExpired,
  PLATFORM_PUBLIC_KEY,
} = require('../services/stellarService');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
  markWithdrawalFailed,
} = require('../services/stellarTransactionService');
const { sendEmail } = require('../services/emailService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const { createNotification } = require('../services/notifications');

const ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST = ['active', 'funded'];

/** Fail closed when PLATFORM_APPROVER_USER_ID is unset. */
function canPerformPlatformSignature(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return false;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

function requirePlatformApprover(req, res, next) {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return res.status(403).json({ error: 'Only the designated platform approver can perform this action' });
  }
  next();
}

/**
 * @openapi
 * tags:
 *   - name: Withdrawals
 *     description: Withdrawal requests and audit timeline
 */

function hasSigner(signers, publicKey) {
  return signers.some((s) => s.key === publicKey && s.weight >= 1);
}

async function logWithdrawalEvent(client, { withdrawalRequestId, actorUserId, action, note, metadata }) {
  const runner = client || db;
  await runner.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [withdrawalRequestId, actorUserId || null, action, note || null, metadata ? JSON.stringify(metadata) : null]
  );
}

async function checkOwnerAccess(req, campaignId) {
  if (req.user.role === 'admin') return true;

  const { rows: campaignRows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [campaignId]);
  if (campaignRows.length && campaignRows[0].creator_id === req.user.userId) {
    return true;
  }

  const { rows: memberRows } = await db.query(
    "SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2 AND role = 'owner'",
    [campaignId, req.user.userId]
  );
  if (memberRows.length && memberRows[0].accepted_at) {
    return true;
  }

  return false;
}

async function assertWithdrawalAccess(req, campaignId) {
  const { rows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return { error: 'Campaign not found', status: 404 };
  
  const isOwner = await checkOwnerAccess(req, campaignId);
  if (!isOwner) {
    return { error: 'Not authorized to view or manage withdrawals for this campaign', status: 403 };
  }
  return { creatorId: rows[0].creator_id, isCreator: true, isAdmin: req.user.role === 'admin' };
}

router.get('/capabilities', requireAuth, (req, res) => {
  res.json({ can_approve_platform: canPerformPlatformSignature(req.user.userId) });
});

router.post('/request', requireAuth, withdrawalValidation, validateRequest, async (req, res) => {
  /**
   * @openapi
   * /api/withdrawals/request:
   *   post:
   *     tags: [Withdrawals]
   *     summary: Create a pending withdrawal request
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [campaign_id, destination_key, amount]
   *             properties:
   *               campaign_id: { type: string }
   *               destination_key: { type: string }
   *               amount: { type: string }
   *     responses:
   *       201:
   *         description: Created
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden
   *       404:
   *         description: Campaign not found
   */
  const { campaign_id, destination_key, amount } = req.body;

  const { rows: campaigns } = await db.query(
    `SELECT id, creator_id, wallet_public_key, asset_type, status,
            (SELECT COUNT(*)::int FROM milestones m WHERE m.campaign_id = campaigns.id) AS milestone_count
     FROM campaigns WHERE id = $1`,
    [campaign_id]
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];

  const isOwner = await checkOwnerAccess(req, campaign_id);
  if (!isOwner) {
    return res.status(403).json({ error: 'Only campaign owners can request withdrawals' });
  }
  if (campaign.milestone_count > 0) {
    return res.status(409).json({
      error: 'This campaign uses milestone releases. Funds are released through approved milestones instead of manual withdrawals.',
    });
  }
  if (!ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(campaign.status)) {
    return res.status(409).json({
      error: `Withdrawals cannot be requested while campaign status is "${campaign.status}".`,
    });
  }

  // Block withdrawals while a dispute is open or under review
  const { rows: activeDisputes } = await db.query(
    `SELECT id FROM disputes
     WHERE campaign_id = $1 AND status IN ('open', 'under_review') LIMIT 1`,
    [campaign_id]
  );
  if (activeDisputes.length) {
    return res.status(403).json({
      error: 'Withdrawals are blocked while an active dispute is open for this campaign.',
      dispute_id: activeDisputes[0].id,
    });
  }

  const { rows: pending } = await db.query(
    `SELECT id FROM withdrawal_requests
     WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
    [campaign_id]
  );
  if (pending.length) {
    return res.status(409).json({
      error: 'A pending withdrawal already exists for this campaign. Cancel it or wait for completion before opening another.',
    });
  }

  const { rows: creatorRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const creatorPublicKey = creatorRows[0].wallet_public_key;

  const multisig = await getAccountMultisigConfig(campaign.wallet_public_key);
  if (
    multisig.thresholds.med_threshold < 2 ||
    !hasSigner(multisig.signers, creatorPublicKey) ||
    !hasSigner(multisig.signers, PLATFORM_PUBLIC_KEY)
  ) {
    return res.status(422).json({
      error: 'Campaign wallet multisig config invalid: creator + platform signatures are required',
    });
  }

  const xdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: campaign.wallet_public_key,
    destinationPublicKey: destination_key,
    amount,
    asset: campaign.asset_type,
  });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO withdrawal_requests
         (campaign_id, requested_by, amount, destination_key, unsigned_xdr, creator_signed, platform_signed)
       VALUES ($1, $2, $3, $4, $5, FALSE, FALSE)
       RETURNING *`,
      [campaign_id, req.user.userId, amount, destination_key, xdr]
    );
    await logWithdrawalEvent(client, {
      withdrawalRequestId: rows[0].id,
      actorUserId: req.user.userId,
      action: 'requested',
      note: null,
      metadata: { amount, destination_key, asset_type: campaign.asset_type },
    });
    await insertWithdrawalPendingSignatures(client, {
      campaignId: campaign_id,
      withdrawalRequestId: rows[0].id,
      userId: req.user.userId,
      unsignedXdr: xdr,
      metadata: {
        amount,
        destination_key,
        asset_type: campaign.asset_type,
      },
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Withdrawal request creation failed', { error: err.message, campaign_id });
    res.status(500).json({ error: 'Could not create withdrawal request' });
  } finally {
    client.release();
  }
});

router.post('/:id/approve/creator', requireAuth, async (req, res) => {
  const { rows: requests } = await db.query(
    `SELECT wr.*, c.creator_id, c.status AS campaign_status
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  const isOwner = await checkOwnerAccess(req, requestRow.campaign_id);
  if (!isOwner) {
    return res.status(403).json({ error: 'Only campaign owners can approve withdrawals' });
  }
  if (!requestRow.is_refund && !ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(requestRow.campaign_status)) {
    return res.status(409).json({
      error: `Campaign status is "${requestRow.campaign_status}". Creator approval is not allowed.`,
    });
  }
  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Withdrawal request is no longer pending' });
  }
  if (requestRow.creator_signed) {
    return res.status(409).json({ error: 'Creator already approved this withdrawal' });
  }

  const { rows: users } = await db.query(
    'SELECT wallet_secret_encrypted, wallet_public_key, wallet_type FROM users WHERE id = $1',
    [req.user.userId]
  );
  let signedXdr;
  const userRow = users[0];
  try {
    if (userRow.wallet_type === 'freighter') {
      // Expect frontend to submit signed_xdr for freighter users
      const { signed_xdr } = req.body || {};
      if (!signed_xdr) return res.status(400).json({ error: 'signed_xdr is required for freighter users' });

      // Validate the signed_xdr contains a valid signature from the creator's public key
      try {
        // validate signature by verifying at least one signature matches user's public key
        const tx = require('@stellar/stellar-sdk').TransactionBuilder.fromXDR(signed_xdr, require('../config/stellar').networkPassphrase);
        const signer = require('@stellar/stellar-sdk').Keypair.fromPublicKey(userRow.wallet_public_key);
        const signatureValid = tx.signatures.some((decorated) => {
          try {
            return signer.verify(tx.hash(), decorated.signature());
          } catch (_err) {
            return false;
          }
        });
        if (!signatureValid) {
          return res.status(422).json({ error: 'Signed transaction does not include a valid signature by the creator' });
        }
      } catch (err) {
        return res.status(422).json({ error: 'Invalid signed_xdr' });
      }

      signedXdr = signed_xdr;
    } else {
      signedXdr = await withDecryptedWalletSecret(
        userRow.wallet_secret_encrypted,
        {
          userId: req.user.userId,
          walletPublicKey: userRow.wallet_public_key,
        },
        async (creatorSecret) =>
          signTransactionXdr({
            xdr: requestRow.unsigned_xdr,
            signerSecret: creatorSecret,
          })
      );
    }
  } catch (err) {
    logger.error('Creator withdrawal signing failed', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    return res.status(503).json({ error: 'Creator wallet signing is unavailable; retry shortly.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET unsigned_xdr = $1, creator_signed = TRUE
       WHERE id = $2 AND status = 'pending' AND creator_signed = FALSE
       RETURNING *`,
      [signedXdr, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'creator_signed',
      note: null,
      metadata: {},
    });
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Creator approval recording failed', { withdrawal_id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Could not record creator approval' });
  } finally {
    client.release();
  }
});

const platformApproveHandler = async (req, res) => {
  /**
   * @openapi
   * /api/withdrawals/{id}/approve:
   *   post:
   *     tags: [Withdrawals]
   *     summary: Platform approval (alias of /approve/platform)
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden
   */
  const { rows: requests } = await db.query(
    `SELECT wr.*, c.status AS campaign_status
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  if (!requestRow.is_refund && !ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(requestRow.campaign_status)) {
    return res.status(409).json({
      error: `Campaign status is "${requestRow.campaign_status}". Platform release is blocked.`,
    });
  }
  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Withdrawal request is no longer pending' });
  }
  if (!requestRow.creator_signed) {
    return res.status(409).json({ error: 'Creator approval is required before platform approval' });
  }
  if (requestRow.platform_signed) {
    return res.status(409).json({ error: 'Platform already approved this withdrawal' });
  }

  // Check whether the XDR time bounds have already elapsed before adding our signature.
  // If expired, tell the creator to re-request so a fresh XDR is built.
  if (isXdrExpired(requestRow.unsigned_xdr)) {
    return res.status(410).json({
      error: 'Withdrawal XDR has expired. The creator must cancel and submit a new withdrawal request.',
    });
  }

  const signedXdr = signTransactionXdr({
    xdr: requestRow.unsigned_xdr,
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });

  const signatureCount = signatureCountFromXdr(signedXdr);
  if (signatureCount < 2) {
    return res.status(422).json({ error: 'Insufficient signatures: expected creator + platform' });
  }

  // Idempotency: the tx hash is derived from the envelope body, so a retry after an ambiguous
  // outcome (submitted but DB update lost) resolves to the same hash. Reconcile against Horizon
  // instead of submitting again.
  const expectedHash = getTransactionHash(signedXdr);
  let txHash;
  let alreadyOnChain = false;
  try {
    alreadyOnChain = await transactionExistsOnHorizon(expectedHash);
  } catch (lookupErr) {
    logger.warn('Horizon pre-submit lookup failed; proceeding to submit', {
      withdrawal_id: req.params.id,
      error: lookupErr.message,
    });
  }

  let submitError = null;
  if (alreadyOnChain) {
    txHash = expectedHash;
    logger.warn('Withdrawal already on Stellar; reconciling records without resubmitting', {
      withdrawal_id: req.params.id,
      tx_hash: txHash,
    });
  } else {
    try {
      txHash = await submitSignedWithdrawal({ xdr: signedXdr });
    } catch (err) {
      submitError = err;
    }
  }

  if (submitError) {
    // The submit call may have failed after the network accepted the tx (timeout etc.).
    let landed;
    try {
      landed = await transactionExistsOnHorizon(expectedHash);
    } catch (lookupErr) {
      logger.error('Withdrawal submission outcome unknown', {
        withdrawal_id: req.params.id,
        tx_hash: expectedHash,
        error: lookupErr.message,
      });
      return res.status(503).json({
        error: 'Withdrawal submission outcome is unknown. Retry approval shortly; it will reconcile with Stellar without double-submitting.',
      });
    }
    if (landed) {
      txHash = expectedHash;
      submitError = null;
    }
  }

  if (submitError) {
    const err = submitError;
    logger.error('Withdrawal Stellar submission failed', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    sendAlert('Withdrawal submission failed', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE withdrawal_requests SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
        [req.params.id]
      );
      await logWithdrawalEvent(client, {
        withdrawalRequestId: req.params.id,
        actorUserId: req.user.userId,
        action: 'submit_failed',
        note: err.message || 'Stellar submit failed',
        metadata: { detail: String(err) },
      });
      await markWithdrawalFailed(client, {
        withdrawalRequestId: req.params.id,
        reason: err.message || 'Stellar submit failed',
      });
      await client.query('COMMIT');
    } catch (logErr) {
      await client.query('ROLLBACK');
      logger.error('Failed to persist withdrawal submit error', { withdrawal_id: req.params.id, error: logErr.message });
    } finally {
      client.release();
    }
    return res.status(502).json({
      error: 'Stellar network rejected the transaction after dual approval. Request marked failed; see audit log.',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET unsigned_xdr = $1, platform_signed = TRUE, status = 'submitted', tx_hash = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [signedXdr, txHash, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_signed',
      note: null,
      metadata: { tx_hash: txHash },
    });
    await finalizeWithdrawalSubmitted(client, {
      withdrawalRequestId: req.params.id,
      txHash,
      signedXdr,
    });
    await client.query('COMMIT');

    // Notify creator
    const { rows: cRows } = await db.query(
      `SELECT u.email, c.creator_id FROM users u JOIN campaigns c ON c.creator_id = u.id WHERE c.id = $1`,
      [requestRow.campaign_id]
    );
    if (cRows.length) {
      sendEmail({
        to: cRows[0].email,
        subject: 'Withdrawal Approved',
        text: `Your withdrawal for ${requestRow.amount} has been approved by the platform. Transaction Hash: ${txHash}`
      });
      createNotification(cRows[0].creator_id, {
        type: 'withdrawal_approved',
        title: 'Withdrawal approved',
        body: `Your withdrawal of ${requestRow.amount} was approved and submitted on-chain.`,
        link: `/campaigns/${requestRow.campaign_id}`,
      }).catch(() => {});
    }

    const withdrawalRow = updated[0];
    setImmediate(() => {
      db.query('SELECT creator_id FROM campaigns WHERE id = $1', [withdrawalRow.campaign_id])
        .then(({ rows: cr }) => {
          if (!cr.length) return;
          return emitWebhookEventForUser(cr[0].creator_id, WEBHOOK_EVENTS.WITHDRAWAL_COMPLETED, {
            withdrawal: { ...withdrawalRow, tx_hash: txHash },
          });
        })
        .catch((e) => logger.error('Withdrawal webhook emit failed', { error: e.message }));
    });
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Platform approval persistence failed after Stellar submit', {
      withdrawal_id: req.params.id,
      tx_hash: txHash,
      error: err.message,
    });
    res.status(500).json({
      error: 'Transaction submitted but records could not be updated. Retry approval to reconcile; it will not resubmit.',
      tx_hash: txHash,
    });
  } finally {
    client.release();
  }
};

router.post('/:id/approve/platform', requireAuth, requirePlatformApprover, platformApproveHandler);
// Alias for docs + issue acceptance criteria
router.post('/:id/approve', requireAuth, requirePlatformApprover, platformApproveHandler);

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const reason = (req.body && req.body.reason) || 'Cancelled by creator';

  const { rows: requests } = await db.query(
    `SELECT wr.*, c.creator_id
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  const isOwner = await checkOwnerAccess(req, requestRow.campaign_id);
  if (!isOwner) {
    return res.status(403).json({ error: 'Only campaign owners can cancel this request' });
  }
  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending requests can be cancelled' });
  }
  if (requestRow.creator_signed) {
    return res.status(409).json({
      error: 'Creator signature is already attached. Use platform reject flow instead of cancel.',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'denied', denial_reason = $1
       WHERE id = $2 AND status = 'pending' AND creator_signed = FALSE
       RETURNING *`,
      [reason, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'creator_cancelled',
      note: reason,
      metadata: {},
    });
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Withdrawal cancellation failed', { withdrawal_id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Could not cancel withdrawal request' });
  } finally {
    client.release();
  }
});

router.post('/:id/reject', requireAuth, requirePlatformApprover, async (req, res) => {
  /**
   * @openapi
   * /api/withdrawals/{id}/reject:
   *   post:
   *     tags: [Withdrawals]
   *     summary: Platform rejection
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden
   */
  const reason = (req.body && req.body.reason) || 'Rejected by platform';

  const { rows: requests } = await db.query(
    'SELECT * FROM withdrawal_requests WHERE id = $1',
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending requests can be rejected' });
  }
  if (!requestRow.creator_signed) {
    return res.status(409).json({ error: 'Creator must sign before platform can reject this release' });
  }
  if (requestRow.platform_signed) {
    return res.status(409).json({ error: 'Platform has already signed; cannot reject' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'denied', denial_reason = $1
       WHERE id = $2 AND status = 'pending' AND creator_signed = TRUE AND platform_signed = FALSE
       RETURNING *`,
      [reason, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_rejected',
      note: reason,
      metadata: {},
    });
    await client.query('COMMIT');

    const { rows: cRows } = await db.query(
      `SELECT u.email, c.creator_id FROM users u JOIN campaigns c ON c.creator_id = u.id WHERE c.id = $1`,
      [requestRow.campaign_id]
    );
    if (cRows.length) {
      sendEmail({
        to: cRows[0].email,
        subject: 'Withdrawal Rejected',
        text: `Your withdrawal request has been rejected by the platform. Reason: ${reason}`
      });
      createNotification(cRows[0].creator_id, {
        type: 'withdrawal_rejected',
        title: 'Withdrawal rejected',
        body: `Your withdrawal request was rejected. Reason: ${reason}`,
        link: `/campaigns/${requestRow.campaign_id}`,
      }).catch(() => {});
    }

    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Withdrawal rejection failed', { withdrawal_id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Could not reject withdrawal request' });
  } finally {
    client.release();
  }
});

router.get('/campaign/:campaignId', requireAuth, async (req, res) => {
  const access = await assertWithdrawalAccess(req, req.params.campaignId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { rows } = await db.query(
    `SELECT id, campaign_id, requested_by, amount, destination_key, creator_signed,
            platform_signed, status, denial_reason, tx_hash, created_at
     FROM withdrawal_requests
     WHERE campaign_id = $1
     ORDER BY created_at DESC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

// Get a single withdrawal request (including unsigned_xdr) for authorized users
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM withdrawal_requests WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const row = rows[0];
  const access = await assertWithdrawalAccess(req, row.campaign_id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  // Only return unsigned_xdr to owners/admins
  res.json(row);
});

const withdrawalAuditHandler = async (req, res) => {
  /**
   * @openapi
   * /api/withdrawals/{id}/audit:
   *   get:
   *     tags: [Withdrawals]
   *     summary: Withdrawal audit timeline (alias of /events)
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden
   *       404:
   *         description: Not found
   */
  const { rows: wr } = await db.query(
    `SELECT wr.campaign_id FROM withdrawal_requests wr WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!wr.length) return res.status(404).json({ error: 'Withdrawal request not found' });

  const access = await assertWithdrawalAccess(req, wr[0].campaign_id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { rows } = await db.query(
    `SELECT e.id, e.withdrawal_request_id, e.actor_user_id, e.action, e.note, e.metadata, e.created_at
     FROM withdrawal_approval_events e
     WHERE e.withdrawal_request_id = $1
     ORDER BY e.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
};

router.get('/:id/events', requireAuth, withdrawalAuditHandler);
// Alias for docs + issue acceptance criteria
router.get('/:id/audit', requireAuth, withdrawalAuditHandler);

module.exports = router;
