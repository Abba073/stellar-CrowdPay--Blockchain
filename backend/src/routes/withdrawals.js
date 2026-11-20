const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
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
const { sendEmailSafe } = require('../services/emailService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const { createNotification } = require('../services/notifications');
const { getRequestContext } = require('../middleware/requestContext');
const { sendErrorResponse } = require('../middleware/errorHandler');

const ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST = ['active', 'funded'];

/** Fail closed when PLATFORM_APPROVER_USER_ID is unset. */
function canPerformPlatformSignature(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return false;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

function requirePlatformApprover(req, res, next) {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return sendErrorResponse(res, 403, 'Only the designated platform approver can perform this action');
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

/**
 * Extract request attribution context (client IP, user-agent, request id) from an
 * Express request so audit rows can be traced back to the originating request.
 */
function requestAuditContext(req) {
  if (!req) return { actorIp: null, userAgent: null, requestId: null };
  const ctx = getRequestContext() || {};
  return {
    actorIp: req.ip || null,
    userAgent: (req.headers && req.headers['user-agent']) || null,
    requestId: req.id || ctx.requestId || null,
  };
}

async function logWithdrawalEvent(client, {
  withdrawalRequestId,
  actorUserId,
  action,
  note,
  metadata,
  actorIp,
  userAgent,
  requestId,
}) {
  const runner = client || db;
  await runner.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata, actor_ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      withdrawalRequestId,
      actorUserId || null,
      action,
      note || null,
      metadata ? JSON.stringify(metadata) : null,
      actorIp || null,
      userAgent || null,
      requestId || null,
    ]
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

router.post('/request', requireAuth, idempotency, withdrawalValidation, validateRequest, async (req, res) => {
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
  if (!campaigns.length) return sendErrorResponse(res, 404, 'Campaign not found');
  const campaign = campaigns[0];

  const isOwner = await checkOwnerAccess(req, campaign_id);
  if (!isOwner) {
    return sendErrorResponse(res, 403, 'Only campaign owners can request withdrawals');
  }
  if (campaign.milestone_count > 0) {
    return sendErrorResponse(res, 409, 'This campaign uses milestone releases. Funds are released through approved milestones instead of manual withdrawals.');
  }
  if (!ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(campaign.status)) {
    return sendErrorResponse(res, 409, `Withdrawals cannot be requested while campaign status is "${campaign.status}".`);
  }

  // Block withdrawals while a dispute is open or under review
  const { rows: activeDisputes } = await db.query(
    `SELECT id FROM disputes
     WHERE campaign_id = $1 AND status IN ('open', 'under_review') LIMIT 1`,
    [campaign_id]
  );
  if (activeDisputes.length) {
    return sendErrorResponse(res, 403, 'Withdrawals are blocked while an active dispute is open for this campaign.', undefined, undefined, { dispute_id: activeDisputes[0].id });
  }

  const { rows: pending } = await db.query(
    `SELECT id FROM withdrawal_requests
     WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
    [campaign_id]
  );
  if (pending.length) {
    return sendErrorResponse(res, 409, 'A pending withdrawal already exists for this campaign. Cancel it or wait for completion before opening another.');
  }

  const { rows: creatorRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const creatorPublicKey = creatorRows[0].wallet_public_key;

  let multisig;
  let xdr;
  try {
    multisig = await getAccountMultisigConfig(campaign.wallet_public_key);
    if (
      multisig.thresholds.med_threshold < 2 ||
      !hasSigner(multisig.signers, creatorPublicKey) ||
      !hasSigner(multisig.signers, PLATFORM_PUBLIC_KEY)
    ) {
      return sendErrorResponse(res, 422, 'Campaign wallet multisig config invalid: creator + platform signatures are required');
    }

    xdr = await buildWithdrawalTransaction({
      campaignWalletPublicKey: campaign.wallet_public_key,
      destinationPublicKey: destination_key,
      amount,
      asset: campaign.asset_type,
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      logger.warn('Withdrawal request blocked by Stellar circuit breaker', {
        campaign_id,
        error: err.message,
      });
      return sendErrorResponse(res, 503, CIRCUIT_OPEN_MESSAGE, undefined, undefined, { retryable: true });
    }
    logger.error('Withdrawal request Stellar preparation failed', { error: err.message, campaign_id });
    return sendErrorResponse(res, 502, 'Could not prepare withdrawal transaction on Stellar');
  }

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
      ...requestAuditContext(req),
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
    sendErrorResponse(res, 500, 'Could not create withdrawal request');
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
  if (!requests.length) return sendErrorResponse(res, 404, 'Withdrawal request not found');
  const requestRow = requests[0];

  const isOwner = await checkOwnerAccess(req, requestRow.campaign_id);
  if (!isOwner) {
    return sendErrorResponse(res, 403, 'Only campaign owners can approve withdrawals');
  }
  if (!requestRow.is_refund && !ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(requestRow.campaign_status)) {
    return sendErrorResponse(res, 409, `Campaign status is "${requestRow.campaign_status}". Creator approval is not allowed.`);
  }
  if (requestRow.status !== 'pending') {
    return sendErrorResponse(res, 409, 'Withdrawal request is no longer pending');
  }
  if (requestRow.creator_signed) {
    return sendErrorResponse(res, 409, 'Creator already approved this withdrawal');
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
      if (!signed_xdr) return sendErrorResponse(res, 400, 'signed_xdr is required for freighter users');

      // Validate the signed_xdr contains a valid signature from the creator's public key
      // and strictly matches the withdrawal request destination and amount
      try {
        const StellarSdk = require('@stellar/stellar-sdk');
        const { networkPassphrase } = require('../config/stellar');
        const tx = StellarSdk.TransactionBuilder.fromXDR(signed_xdr, networkPassphrase);

        if (!tx.operations || tx.operations.length !== 1 || tx.operations[0].type !== 'payment') {
          return sendErrorResponse(res, 422, 'Signed transaction must contain exactly one payment operation');
        }

        const op = tx.operations[0];
        if (op.destination !== requestRow.destination_key) {
          return sendErrorResponse(res, 422, 'Signed transaction destination does not match withdrawal request');
        }

        if (parseFloat(op.amount) !== parseFloat(requestRow.amount)) {
          return sendErrorResponse(res, 422, 'Signed transaction amount does not match withdrawal request');
        }

        const signer = StellarSdk.Keypair.fromPublicKey(userRow.wallet_public_key);
        const signatureValid = tx.signatures.some((decorated) => {
          try {
            return signer.verify(tx.hash(), decorated.signature());
          } catch (_err) {
            return false;
          }
        });
        if (!signatureValid) {
          return sendErrorResponse(res, 422, 'Signed transaction does not include a valid signature by the creator');
        }
      } catch (err) {
        return sendErrorResponse(res, 422, err.message || 'Invalid signed_xdr');
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
    if (err instanceof CircuitOpenError) {
      logger.warn('Creator withdrawal signing blocked by Stellar circuit breaker', {
        withdrawal_id: req.params.id,
        error: err.message,
      });
      return sendErrorResponse(res, 503, CIRCUIT_OPEN_MESSAGE, undefined, undefined, { retryable: true });
    }
    logger.error('Creator withdrawal signing failed', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    return sendErrorResponse(res, 503, 'Creator wallet signing is unavailable; retry shortly.');
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
      return sendErrorResponse(res, 409, 'Withdrawal request changed; refresh and try again.');
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'creator_signed',
      note: null,
      metadata: {},
      ...requestAuditContext(req),
    });
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Creator approval recording failed', { withdrawal_id: req.params.id, error: err.message });
    sendErrorResponse(res, 500, 'Could not record creator approval');
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
  if (!requests.length) return sendErrorResponse(res, 404, 'Withdrawal request not found');
  const requestRow = requests[0];

  if (!requestRow.is_refund && !ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(requestRow.campaign_status)) {
    return sendErrorResponse(res, 409, `Campaign status is "${requestRow.campaign_status}". Platform release is blocked.`);
  }
  if (requestRow.status !== 'pending') {
    return sendErrorResponse(res, 409, 'Withdrawal request is no longer pending');
  }
  // #16 — For platform-initiated refunds (failed campaigns and dispute resolutions)
  // creator_signed is pre-set to TRUE at creation time, so this guard only applies
  // to voluntary creator-initiated withdrawals where the creator must sign first.
  if (!requestRow.is_refund && !requestRow.creator_signed) {
    return sendErrorResponse(res, 409, 'Creator approval is required before platform approval');
  }
  if (requestRow.platform_signed) {
    return sendErrorResponse(res, 409, 'Platform already approved this withdrawal');
  }

  // Check whether the XDR time bounds have already elapsed before adding our signature.
  // If expired, tell the creator to re-request so a fresh XDR is built.
  if (isXdrExpired(requestRow.unsigned_xdr)) {
    return sendErrorResponse(res, 410, 'Withdrawal XDR has expired. The creator must cancel and submit a new withdrawal request.');
  }

  // Validate transaction operations match requestRow before platform co-signing
  try {
    const StellarSdk = require('@stellar/stellar-sdk');
    const { networkPassphrase } = require('../config/stellar');
    const txToVerify = StellarSdk.TransactionBuilder.fromXDR(requestRow.unsigned_xdr, networkPassphrase);
    if (!txToVerify.operations || txToVerify.operations.length !== 1 || txToVerify.operations[0].type !== 'payment') {
      return sendErrorResponse(res, 422, 'Transaction must contain exactly one payment operation');
    }
    const op = txToVerify.operations[0];
    if (op.destination !== requestRow.destination_key) {
      return sendErrorResponse(res, 422, 'Transaction destination does not match approved withdrawal request');
    }
    if (parseFloat(op.amount) !== parseFloat(requestRow.amount)) {
      return sendErrorResponse(res, 422, 'Transaction amount does not match approved withdrawal request');
    }
  } catch (err) {
    return sendErrorResponse(res, 422, 'Malformed withdrawal transaction XDR');
  }

  const signedXdr = signTransactionXdr({
    xdr: requestRow.unsigned_xdr,
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });

  const signatureCount = signatureCountFromXdr(signedXdr);
  if (signatureCount < 2) {
    return sendErrorResponse(res, 422, 'Insufficient signatures: expected creator + platform');
  }

  // Claim the withdrawal BEFORE any on-chain submission; only one concurrent approval can win.
  const { rows: claimRows } = await db.query(
    `UPDATE withdrawal_requests
     SET platform_claimed_at = NOW()
     WHERE id = $1 AND status = 'pending' AND platform_signed = FALSE AND platform_claimed_at IS NULL
     RETURNING id`,
    [req.params.id]
  );
  if (!claimRows.length) {
    return sendErrorResponse(res, 409, 'Withdrawal request is already being processed; refresh and try again.');
  }
  const releaseClaim = () =>
    db.query('UPDATE withdrawal_requests SET platform_claimed_at = NULL WHERE id = $1', [req.params.id])
      .catch((e) => logger.error('Failed to release withdrawal claim', { withdrawal_id: req.params.id, error: e.message }));

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
      if (err instanceof CircuitOpenError) {
        logger.warn('Withdrawal submission blocked by Stellar circuit breaker', {
          withdrawal_id: req.params.id,
          error: err.message,
        });
        return sendErrorResponse(res, 503, CIRCUIT_OPEN_MESSAGE, undefined, undefined, { retryable: true });
      }
      submitError = err;
    }
  }

  if (submitError) {
    // The submit call may have failed after the network accepted the tx (timeout etc.).
    let landed;
    try {
      landed = await transactionExistsOnHorizon(expectedHash);
    } catch (lookupErr) {
      if (lookupErr instanceof CircuitOpenError) {
        logger.warn('Withdrawal reconciliation blocked by Stellar circuit breaker', {
          withdrawal_id: req.params.id,
          tx_hash: expectedHash,
          error: lookupErr.message,
        });
        return sendErrorResponse(res, 503, CIRCUIT_OPEN_MESSAGE, undefined, undefined, { retryable: true });
      }
      logger.error('Withdrawal submission outcome unknown', {
        withdrawal_id: req.params.id,
        tx_hash: expectedHash,
        error: lookupErr.message,
      });
      await releaseClaim();
      return sendErrorResponse(res, 503, 'Withdrawal submission outcome is unknown. Retry approval shortly; it will reconcile with Stellar without double-submitting.');
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
        ...requestAuditContext(req),
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
    return sendErrorResponse(res, 502, 'Stellar network rejected the transaction after dual approval. Request marked failed; see audit log.');
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
      return sendErrorResponse(res, 409, 'Withdrawal request changed; refresh and try again.');
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_signed',
      note: null,
      metadata: { tx_hash: txHash },
      ...requestAuditContext(req),
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
      sendEmailSafe({
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
    await releaseClaim();
    sendErrorResponse(res, 500, 'Transaction submitted but records could not be updated. Retry approval to reconcile; it will not resubmit.', undefined, undefined, { tx_hash: txHash });
  } finally {
    client.release();
  }
};

router.post('/:id/approve/platform', requireAuth, requirePlatformApprover, platformApproveHandler);
// Deprecated alias of POST /:id/approve/platform (see API.md).
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
  if (!requests.length) return sendErrorResponse(res, 404, 'Withdrawal request not found');
  const requestRow = requests[0];

  const isOwner = await checkOwnerAccess(req, requestRow.campaign_id);
  if (!isOwner) {
    return sendErrorResponse(res, 403, 'Only campaign owners can cancel this request');
  }
  if (requestRow.status !== 'pending') {
    return sendErrorResponse(res, 409, 'Only pending requests can be cancelled');
  }
  if (requestRow.creator_signed) {
    return sendErrorResponse(res, 409, 'Creator signature is already attached. Use platform reject flow instead of cancel.');
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
      return sendErrorResponse(res, 409, 'Withdrawal request changed; refresh and try again.');
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'creator_cancelled',
      note: reason,
      metadata: {},
      ...requestAuditContext(req),
    });
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Withdrawal cancellation failed', { withdrawal_id: req.params.id, error: err.message });
    sendErrorResponse(res, 500, 'Could not cancel withdrawal request');
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
  if (!requests.length) return sendErrorResponse(res, 404, 'Withdrawal request not found');
  const requestRow = requests[0];

  if (requestRow.status !== 'pending') {
    return sendErrorResponse(res, 409, 'Only pending requests can be rejected');
  }
  if (!requestRow.creator_signed) {
    return sendErrorResponse(res, 409, 'Creator must sign before platform can reject this release');
  }
  if (requestRow.platform_signed) {
    return sendErrorResponse(res, 409, 'Platform has already signed; cannot reject');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'denied', denial_reason = $1
       WHERE id = $2 AND status = 'pending' AND creator_signed = TRUE AND platform_signed = FALSE
         AND platform_claimed_at IS NULL
       RETURNING *`,
      [reason, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return sendErrorResponse(res, 409, 'Withdrawal request changed; refresh and try again.');
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_rejected',
      note: reason,
      metadata: {},
      ...requestAuditContext(req),
    });
    await client.query('COMMIT');

    const { rows: cRows } = await db.query(
      `SELECT u.email, c.creator_id FROM users u JOIN campaigns c ON c.creator_id = u.id WHERE c.id = $1`,
      [requestRow.campaign_id]
    );
    if (cRows.length) {
      sendEmailSafe({
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
    sendErrorResponse(res, 500, 'Could not reject withdrawal request');
  } finally {
    client.release();
  }
});

router.get('/campaign/:campaignId', requireAuth, async (req, res) => {
  const access = await assertWithdrawalAccess(req, req.params.campaignId);
  if (access.error) return sendErrorResponse(res, access.status, access.error);

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
  if (!rows.length) return sendErrorResponse(res, 404, 'Withdrawal request not found');
  const row = rows[0];
  const access = await assertWithdrawalAccess(req, row.campaign_id);
  if (access.error) return sendErrorResponse(res, access.status, access.error);

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
  if (!wr.length) return sendErrorResponse(res, 404, 'Withdrawal request not found');

  const access = await assertWithdrawalAccess(req, wr[0].campaign_id);
  if (access.error) return sendErrorResponse(res, access.status, access.error);

  const { rows } = await db.query(
    `SELECT e.id, e.withdrawal_request_id, e.actor_user_id, e.action, e.note, e.metadata,
            e.actor_ip, e.user_agent, e.request_id, e.created_at
     FROM withdrawal_approval_events e
     WHERE e.withdrawal_request_id = $1
     ORDER BY e.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
};

router.get('/:id/events', requireAuth, withdrawalAuditHandler);
// Deprecated alias of GET /:id/events (see API.md).
router.get('/:id/audit', requireAuth, withdrawalAuditHandler);

module.exports = router;
