const router = require('express').Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Keypair, TransactionBuilder } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const { networkPassphrase, isTestnet } = require('../config/stellar');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const logger = require('../config/logger');
const { sendAlert } = require('../services/alerting');
const { contributionValidation, contributionQuoteValidation, validateRequest } = require('../middleware/validation');
const {
  buildUnsignedContributionPayment,
  buildUnsignedContributionPathPayment,
  submitPreparedTransaction,
  submitWithFeeBumpFallback,
  getPathPaymentQuote,
  getSupportedAssetCodes,
  isBadSequenceError,
} = require("../services/stellarService");
const { CircuitOpenError } = require('../services/circuitBreaker');

const STELLAR_UNAVAILABLE_MESSAGE = 'Stellar network temporarily unavailable, retry shortly';

function isCircuitOpenError(err) {
  return err instanceof CircuitOpenError || err?.name === 'CircuitOpenError' || err?.code === 'CIRCUIT_OPEN';
}
const {
  insertContributionSubmitted,
} = require("../services/stellarTransactionService");
const { sendEmailSafe } = require("../services/emailService");
const { SLIPPAGE_BPS } = require("../config/constants");
const {
  buildContributionIntent,
  buildContributionMemo,
  submitCustodialContribution,
} = require('../services/contributionService');
const { listUserContributions } = require('../services/userDashboardService');
const { decodeCursor, pageWithCursor } = require('../utils/pagination');

/** Cursor namespace for the per-campaign backer wall. */
const BACKER_WALL_SORT = 'contributions_newest';
const asyncHandler = require('../utils/asyncHandler');
const { findVisibleCampaign } = require('../utils/campaignVisibility');
const { parseAmountToStroops, parseUserAmount, formatStroops } = require('../utils/amounts');
const { sendErrorResponse } = require('../middleware/errorHandler');

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const PREPARED_CONTRIBUTION_EXPIRES_IN = '10m';

const isTest = process.env.NODE_ENV === 'test';
const contributionPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 5,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

// Rate limiter for public read-only contribution listings
const publicContributionReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

const prepareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 10,
  keyGenerator: (req) => {
    const userId = req.user?.userId || req.user?.id;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    return userId ? `${userId}_${ip}` : String(ip);
  },
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many prepare requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

const submitSignedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 10,
  keyGenerator: (req) => {
    const userId = req.user?.userId || req.user?.id || req.ip;
    const prepareToken = req.body?.prepare_token || '';
    return prepareToken ? `${userId}_${prepareToken}` : `${userId}_${req.ip}`;
  },
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many submission requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

/**
 * @openapi
 * tags:
 *   - name: Contributions
 *     description: Contribution creation and quoting
 */

function validateFreighterPublicKey(publicKey) {
  try {
    Keypair.fromPublicKey(publicKey);
    return true;
  } catch (_err) {
    return false;
  }
}

async function loadActiveCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT c.*, u.email as creator_email FROM campaigns c 
     JOIN users u ON c.creator_id = u.id 
     WHERE c.id = $1 AND c.status = $2 AND c.deleted_at IS NULL`,
    [campaignId, 'active']
  );
  return rows[0] || null;
}

function createPreparedContributionToken(payload) {
  return jwt.sign(
    {
      kind: 'prepared_contribution',
      ...payload,
    },
    process.env.JWT_SECRET,
    { expiresIn: PREPARED_CONTRIBUTION_EXPIRES_IN }
  );
}

function verifyPreparedContributionToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (!payload || payload.kind !== 'prepared_contribution') {
    throw new Error('Invalid contribution prepare token');
  }
  return payload;
}

function validateSubmittedContributionXdr({ signedXdr, unsignedXdr, senderPublicKey }) {
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const unsignedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);

  if (signedTx.source !== senderPublicKey) {
    throw new Error('Signed transaction source account does not match the prepared contribution');
  }

  if (signedTx.hash().toString('hex') !== unsignedTx.hash().toString('hex')) {
    throw new Error('Signed transaction does not match the prepared contribution');
  }

  if (!signedTx.signatures.length) {
    throw new Error('Signed transaction is missing contributor signature');
  }

  const signer = Keypair.fromPublicKey(senderPublicKey);
  const signatureValid = signedTx.signatures.some((decoratedSignature) => {
    try {
      return signer.verify(signedTx.hash(), decoratedSignature.signature());
    } catch (_err) {
      return false;
    }
  });

  if (!signatureValid) {
    throw new Error('Signed transaction does not include a valid Freighter signature for the contributor');
  }
}

router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserContributions(req.user.userId);
  if (rows === null) return sendErrorResponse(res, 404, 'User not found');
  res.json(rows);
}));

// Get contributions for a campaign (public endpoint — sensitive fields are redacted for unauthenticated/unauthorised callers)
router.get('/campaign/:campaignId', publicContributionReadLimiter, optionalAuth, async (req, res) => {
  // A soft-deleted campaign's backer wall (contributor data) is not public.
  if (!(await findVisibleCampaign(db, req.params.campaignId))) {
    return sendErrorResponse(res, 404, 'Campaign not found');
  }
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  // Keyset pagination on (created_at, id): a cursor, or the first page with
  // no offset, avoids scanning and discarding OFFSET rows. ?offset=N keeps
  // working for older clients.
  const cursorParam = req.query.cursor;
  const useKeyset = cursorParam !== undefined || offset === 0;
  let cursor = null;
  if (cursorParam !== undefined) {
    try {
      cursor = decodeCursor(cursorParam, BACKER_WALL_SORT);
    } catch (err) {
      return sendErrorResponse(res, 400, err.message, undefined, 'INVALID_CURSOR');
    }
  }

  // Determine if the requester has elevated privileges (admin or campaign organizer)
  const requestUserId = req.user?.userId;
  const isAdmin = req.user?.is_admin === true;
  let isPrivileged = isAdmin;

  if (!isPrivileged && requestUserId) {
    const { rows: campaignRows } = await db.query(
      `SELECT creator_id FROM campaigns WHERE id = $1`,
      [req.params.campaignId]
    );
    if (campaignRows.length) {
      const isCreator = campaignRows[0].creator_id === requestUserId;
      const { rows: memberRows } = await db.query(
        `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
        [req.params.campaignId, requestUserId]
      );
      isPrivileged = isCreator || memberRows.length > 0;
    }
  }

  const params = [req.params.campaignId];
  let keysetFilter = '';
  if (cursor) {
    params.push(cursor.value, cursor.id);
    keysetFilter = 'AND (c.created_at, c.id) < ($2::timestamptz, $3::uuid)';
  }
  params.push(useKeyset ? limit + 1 : limit);
  const limitParam = `$${params.length}`;
  let offsetClause = '';
  if (!useKeyset) {
    params.push(offset);
    offsetClause = `OFFSET $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT c.id, c.sender_public_key, c.amount, c.asset, c.payment_type,
            c.anchor_id, c.anchor_transaction_id, c.anchor_asset, c.anchor_amount,
            c.source_amount, c.source_asset, c.conversion_rate, c.path,
            c.tx_hash, c.created_at, c.created_at::text AS _cursor_value,
            wr.status AS refund_status, wr.tx_hash AS refund_tx_hash
     FROM contributions c
     LEFT JOIN LATERAL (
       SELECT status, tx_hash
       FROM withdrawal_requests
       WHERE contribution_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) wr ON TRUE
     WHERE c.campaign_id = $1 ${keysetFilter}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${limitParam} ${offsetClause}`,
    params
  );

  // The total is only counted for the first page (or legacy offset pages).
  let total;
  if (!cursor) {
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS total FROM contributions WHERE campaign_id = $1',
      [req.params.campaignId]
    );
    total = Number(countRows[0]?.total ?? 0);
  }

  const { page, nextCursor } = useKeyset
    ? pageWithCursor(rows, limit, { sort: BACKER_WALL_SORT })
    : pageWithCursor(rows, rows.length + 1);
  const cleanedRows = page.map((row) => {
    if (isPrivileged) return row;
    // Redact sender identity and refund details from public view
    const { sender_public_key: _spk, refund_status: _rs, refund_tx_hash: _rth, ...publicRow } = row;
    return publicRow;
  });
  res.json({
    contributions: cleanedRows,
    ...(total !== undefined && { total }),
    limit,
    ...(!useKeyset && { offset }),
    next_cursor: nextCursor,
  });
});

// List contributions for the authenticated user (alias for /api/contributions/mine)
// Deprecated alias of GET /mine (see API.md).
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const rows = await listUserContributions(req.user.userId);
  if (rows === null) return sendErrorResponse(res, 404, 'User not found');
  res.json(rows);
}));

// Trace contribution settlement by Stellar tx hash (submitted vs indexed on ledger)
router.get('/finalization/:txHash', requireAuth, asyncHandler(async (req, res) => {
  const txHash = req.params.txHash;
  const { rows } = await db.query(
    `SELECT st.id, st.status, st.tx_hash, st.campaign_id, st.contribution_id,
            st.initiated_by_user_id, st.metadata, st.created_at, st.updated_at,
            c.creator_id,
            ct.id AS contribution_row_id, ct.sender_public_key, ct.amount,
            ct.asset, ct.created_at AS contribution_created_at
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     LEFT JOIN contributions ct ON ct.id = st.contribution_id
     WHERE st.tx_hash = $1 AND st.kind = 'contribution'`,
    [txHash]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'No contribution transaction found');
  const row = rows[0];

  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const userPk = userRows[0]?.wallet_public_key;
  const isInitiator = row.initiated_by_user_id === req.user.userId;
  const isCreator = row.creator_id === req.user.userId;
  const isContributor = userPk && row.sender_public_key && row.sender_public_key === userPk;
  const isPlatform = req.user.role === 'admin';

  if (!isInitiator && !isCreator && !isContributor && !isPlatform) {
    return sendErrorResponse(res, 403, 'Not authorized to view this transaction');
  }

  let finalizationStatus = 'awaiting_ledger';
  if (row.status === 'indexed') finalizationStatus = 'finalized';
  if (row.status === 'failed') finalizationStatus = 'failed';

  res.json({
    tx_hash: row.tx_hash,
    finalization_status: finalizationStatus,
    stellar_transaction_id: row.id,
    campaign_id: row.campaign_id,
    contribution: row.contribution_row_id
      ? {
          id: row.contribution_row_id,
          sender_public_key: row.sender_public_key,
          amount: row.amount,
          asset: row.asset,
          created_at: row.contribution_created_at,
        }
      : null,
    metadata: row.metadata,
    updated_at: row.updated_at,
  });
}));

// Quote conversion before a path payment contribution
router.get('/quote', requireAuth, contributionQuoteValidation, validateRequest, asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/contributions/quote:
   *   get:
   *     tags: [Contributions]
   *     summary: Get a DEX quote before submitting a conversion contribution
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: send_asset
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: dest_asset
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: dest_amount
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [send_asset, dest_asset, dest_amount, quoted_source_amount, max_send_amount, estimated_rate, path, path_count]
   *               properties:
   *                 send_asset: { type: string }
   *                 dest_asset: { type: string }
   *                 dest_amount: { type: string }
   *                 quoted_source_amount: { type: string }
   *                 max_send_amount: { type: string }
   *                 estimated_rate: { type: string }
   *                 path: { type: array, items: { type: string } }
   *                 path_count: { type: integer }
   *       400:
   *         description: Missing/invalid query params
   *       404:
   *         description: No path found
   */
  const { send_asset, dest_asset, dest_amount } = req.query;

  let paths;
  try {
    paths = await getPathPaymentQuote({
      sendAsset: send_asset,
      destAsset: dest_asset,
      destAmount: dest_amount,
    });
  } catch (err) {
    if (isCircuitOpenError(err)) {
      logger.warn('Contribution quote blocked by open circuit breaker', { error: err.message });
      return sendErrorResponse(res, 503, STELLAR_UNAVAILABLE_MESSAGE);
    }
    throw err;
  }

  if (!paths.length) {
    return sendErrorResponse(res, 404, 'No conversion path found for requested assets');
  }

  const bestPath = paths[0];
  // Apply slippage in integer stroop math to avoid float drift on the sendMax.
  const sourceStroops = parseAmountToStroops(bestPath.source_amount);
  const maxSendWithSlippage = formatStroops(
    (sourceStroops * BigInt(10000 + SLIPPAGE_BPS)) / 10000n
  );

  res.json({
    send_asset,
    dest_asset,
    dest_amount: formatStroops(parseUserAmount(dest_amount, 'dest_amount')),
    quoted_source_amount: bestPath.source_amount,
    max_send_amount: maxSendWithSlippage,
    estimated_rate: (
      parseFloat(dest_amount) / parseFloat(bestPath.source_amount)
    ).toFixed(15),
    path: bestPath.path,
    path_count: paths.length,
  });
}));

router.post('/prepare', requireAuth, prepareLimiter, contributionValidation, validateRequest, asyncHandler(async (req, res) => {
  const { campaign_id, amount, send_asset, sender_public_key, display_name } = req.body;
  // Malformed amounts are a 422 VALIDATION_ERROR (field: amount), not a 500.
  parseUserAmount(amount);
  if (!sender_public_key) {
    return sendErrorResponse(res, 422, 'sender_public_key is required for Freighter contributions', {
      sender_public_key: 'sender_public_key is required for Freighter contributions',
    });
  }
  if (!validateFreighterPublicKey(sender_public_key)) {
    return sendErrorResponse(res, 422, 'sender_public_key must be a valid Stellar public key', {
      sender_public_key: 'Invalid Stellar public key',
    });
  }

  const campaign = await loadActiveCampaign(campaign_id);
  if (!campaign) return sendErrorResponse(res, 404, 'Campaign not found');

  if (campaign.min_contribution && parseUserAmount(amount) < parseAmountToStroops(campaign.min_contribution)) {
    return sendErrorResponse(res, 400, `Contribution amount is below the minimum limit of ${campaign.min_contribution} ${campaign.asset_type}`);
  }

  if (campaign.max_contribution) {
    const { rows: sumRows } = await db.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM contributions WHERE campaign_id = $1 AND sender_public_key = $2',
      [campaign_id, sender_public_key]
    );
    const totalExisting = parseAmountToStroops(sumRows[0].total);
    if (totalExisting + parseUserAmount(amount) > parseAmountToStroops(campaign.max_contribution)) {
      return sendErrorResponse(res, 400, `Contribution violates the maximum limit of ${campaign.max_contribution} ${campaign.asset_type} per backer`);
    }
  }

  try {
    const intent = await buildContributionIntent({
      campaign,
      amount,
      sendAsset: send_asset,
      contributorPublicKey: sender_public_key,
      displayName: display_name,
    });

    const unsignedXdr =
      intent.kind === 'payment'
        ? await buildUnsignedContributionPayment({
            senderPublicKey: sender_public_key,
            destinationPublicKey: campaign.wallet_public_key,
            asset: send_asset,
            amount,
            memo: buildContributionMemo(campaign_id),
          })
        : await buildUnsignedContributionPathPayment({
            senderPublicKey: sender_public_key,
            destinationPublicKey: campaign.wallet_public_key,
            sendAsset: send_asset,
            sendMax: intent.sendMax,
            destAmount: amount,
            destAssetCode: campaign.asset_type,
            memo: buildContributionMemo(campaign_id),
          });

    const prepareToken = createPreparedContributionToken({
      user_id: req.user.userId,
      campaign_id,
      sender_public_key,
      unsigned_xdr: unsignedXdr,
      flow_metadata: intent.flowMetadata,
      conversion_quote: intent.conversionQuote,
      amount,
      send_asset,
      campaign_wallet_public_key: campaign.wallet_public_key,
      campaign_min_contribution: campaign.min_contribution,
      campaign_max_contribution: campaign.max_contribution,
      campaign_target_amount: campaign.target_amount,
      campaign_asset_type: campaign.asset_type,
    });

    res.json({
      unsigned_xdr: unsignedXdr,
      prepare_token: prepareToken,
      conversion_quote: intent.conversionQuote,
      sender_public_key,
      network_passphrase: networkPassphrase,
      network_name: isTestnet ? 'TESTNET' : 'PUBLIC',
    });
  } catch (err) {
    if (err.statusCode === 422) {
      return sendErrorResponse(res, 422, err.message);
    }

    if (isCircuitOpenError(err)) {
      logger.warn('Freighter contribution preparation blocked by open circuit breaker', {
        campaign_id,
        error: err.message,
      });
      return sendErrorResponse(res, 503, STELLAR_UNAVAILABLE_MESSAGE);
    }

    logger.error('Freighter contribution preparation failed', { campaign_id, error: err.message });
    return sendErrorResponse(res, 503, 'Could not prepare the Stellar transaction right now. Please try again.');
  }
}));

router.post('/submit-signed', requireAuth, submitSignedLimiter, idempotency, asyncHandler(async (req, res) => {
  const { signed_xdr, prepare_token } = req.body;
  if (!signed_xdr || !prepare_token) {
    return sendErrorResponse(res, 400, 'signed_xdr and prepare_token are required');
  }

  let prepared;
  try {
    prepared = verifyPreparedContributionToken(prepare_token);
  } catch (err) {
    return sendErrorResponse(res, 400, err.message || 'Invalid prepare_token');
  }

  if (prepared.user_id !== req.user.userId) {
    return sendErrorResponse(res, 403, 'Prepared contribution token does not belong to this user');
  }

  try {
    validateSubmittedContributionXdr({
      signedXdr: signed_xdr,
      unsignedXdr: prepared.unsigned_xdr,
      senderPublicKey: prepared.sender_public_key,
    });
  } catch (err) {
    return sendErrorResponse(res, 422, err.message);
  }

  // Re-load the campaign and re-validate the prepared claims against its
  // current state so that mid-flight changes (soft-delete, destination or
  // limit changes) cannot be bypassed by a previously issued prepare token.
  const campaign = await loadActiveCampaign(prepared.campaign_id);
  if (!campaign) {
    return sendErrorResponse(res, 409, 'Campaign is no longer available for contributions', undefined, 'CAMPAIGN_UNAVAILABLE');
  }

  if (
    prepared.campaign_asset_type !== undefined &&
    campaign.asset_type !== prepared.campaign_asset_type
  ) {
    return sendErrorResponse(res, 409, 'Campaign asset type changed since the contribution was prepared', undefined, 'CAMPAIGN_ASSET_CHANGED');
  }

  if (
    prepared.campaign_wallet_public_key !== undefined &&
    campaign.wallet_public_key !== prepared.campaign_wallet_public_key
  ) {
    return sendErrorResponse(res, 409, 'Campaign destination wallet changed since the contribution was prepared', undefined, 'CAMPAIGN_DESTINATION_CHANGED');
  }

  if (prepared.amount === undefined) {
    return sendErrorResponse(res, 422, 'Prepared contribution token is missing the contribution amount', undefined, 'PREPARE_TOKEN_INVALID');
  }

  const preparedAmountStroops = parseAmountToStroops(prepared.amount);

  if (
    campaign.min_contribution &&
    preparedAmountStroops < parseAmountToStroops(campaign.min_contribution)
  ) {
    return sendErrorResponse(res, 422, `Contribution amount is below the current minimum limit of ${campaign.min_contribution} ${campaign.asset_type}`, undefined, 'AMOUNT_BELOW_MINIMUM');
  }

  if (
    campaign.max_contribution &&
    preparedAmountStroops > parseAmountToStroops(campaign.max_contribution)
  ) {
    return sendErrorResponse(res, 422, `Contribution amount exceeds the current maximum limit of ${campaign.max_contribution} ${campaign.asset_type}`, undefined, 'AMOUNT_ABOVE_MAXIMUM');
  }

  let txHash;
  try {
    txHash = await submitWithFeeBumpFallback(signed_xdr);
  } catch (err) {
    if (isCircuitOpenError(err)) {
      logger.warn('Freighter contribution submission blocked by open circuit breaker', {
        campaign_id: prepared.campaign_id,
        error: err.message,
      });
      return sendErrorResponse(res, 503, STELLAR_UNAVAILABLE_MESSAGE);
    }
    logger.error('Freighter contribution submission failed', {
      campaign_id: prepared.campaign_id,
      error: err.message,
    });
    sendAlert('Freighter contribution submission failed', {
      alert_key: 'contribution.freighter_submission_failed',
      fingerprint: `${prepared.campaign_id}:${err.name || 'Error'}`,
      severity: 'critical',
      campaign_id: prepared.campaign_id,
      error: err.message,
    });
    return sendErrorResponse(res, 502, 'Stellar network rejected the transaction', undefined, undefined, { detail: err.message || String(err) });
  }

  const stellarTransactionId = await insertContributionSubmitted(null, {
    txHash,
    campaignId: prepared.campaign_id,
    userId: req.user.userId,
    unsignedXdr: prepared.unsigned_xdr,
    signedXdr: signed_xdr,
    metadata: prepared.flow_metadata,
  });

  res.status(202).json({
    tx_hash: txHash,
    stellar_transaction_id: stellarTransactionId,
    message: 'Transaction submitted',
    conversion_quote: prepared.conversion_quote || null,
  });
}));


// Contribute to a campaign (authenticated, custodial)
router.post(
  '/',
  contributionPostLimiter,
  requireAuth,
  contributionValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/contributions:
     *   post:
     *     tags: [Contributions]
     *     summary: Submit a contribution (custodial)
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [campaign_id, amount, send_asset]
     *             properties:
     *               campaign_id: { type: string }
     *               amount: { type: string }
     *               send_asset: { type: string }
     *               display_name: { type: string, nullable: true }
     *     responses:
     *       202:
     *         description: Accepted
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               required: [tx_hash, stellar_transaction_id, message, conversion_quote]
     *               properties:
     *                 tx_hash: { type: string }
     *                 stellar_transaction_id: { type: string }
     *                 message: { type: string }
     *                 conversion_quote: { type: object, nullable: true }
     *       401:
     *         description: Unauthorized
     *       404:
     *         description: Campaign not found
     */
    const { campaign_id, amount, send_asset, display_name } = req.body;
    // Malformed amounts are a 422 VALIDATION_ERROR (field: amount), not a 500.
    parseUserAmount(amount);

    const campaign = await loadActiveCampaign(campaign_id);
    if (!campaign) return sendErrorResponse(res, 404, 'Campaign not found');

    // Load contributor's custodial secret
    const { rows: users } = await db.query(
      'SELECT wallet_secret_encrypted, wallet_public_key FROM users WHERE id = $1',
      [req.user.userId],
    );
    const contributorPublicKey = users[0].wallet_public_key;

if (
    campaign.min_contribution &&
    parseUserAmount(amount) < parseAmountToStroops(campaign.min_contribution)
  ) {
    return sendErrorResponse(res, 400, `Minimum contribution is ${campaign.min_contribution} ${campaign.asset_type}`);
  }

  if (campaign.max_contribution && parseUserAmount(amount) > parseAmountToStroops(campaign.max_contribution)) {
    return sendErrorResponse(res, 400, `Maximum contribution is ${campaign.max_contribution} ${campaign.asset_type}`);
  }

  if (campaign.max_per_user) {
    const { rows: userCapRows } = await db.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM contributions WHERE campaign_id = $1 AND sender_public_key = $2',
      [campaign_id, contributorPublicKey],
    );
    const alreadyContributed = parseAmountToStroops(userCapRows[0].total);
    if (alreadyContributed + parseUserAmount(amount) > parseAmountToStroops(campaign.max_per_user)) {
      return sendErrorResponse(res, 400, `You have already contributed ${formatStroops(alreadyContributed)} ${campaign.asset_type}. The per-contributor limit is ${campaign.max_per_user}.`);
    }
  }

    try {
      const result = await submitCustodialContribution({
        campaign,
        campaignId: campaign_id,
        userId: req.user.userId,
        walletPublicKey: contributorPublicKey,
        walletSecretEncrypted: users[0].wallet_secret_encrypted,
        amount,
        sendAsset: send_asset,
        displayName: display_name,
      });
      res.status(202).json({
        tx_hash: result.txHash,
        stellar_transaction_id: result.stellarTransactionId,
        message: "Transaction submitted",
        conversion_quote: result.conversionQuote,
        ...(result.platform_fee_amount !== null && result.platform_fee_amount !== undefined
          ? { platform_fee_amount: result.platform_fee_amount }
          : {}),
      });
    } catch (err) {
      if (isCircuitOpenError(err)) {
        logger.warn('Custodial contribution blocked by open circuit breaker', {
          campaign_id,
          error: err.message,
        });
        return sendErrorResponse(res, 503, STELLAR_UNAVAILABLE_MESSAGE);
      }
      if (err.statusCode === 422) {
        return sendErrorResponse(res, 422, err.message);
      }
      if (err.statusCode === 502) {
        logger.error("Stellar transaction submission failed", {
          campaign_id,
          error: err.message,
        });
        sendAlert("Stellar transaction submission failed", {
          campaign_id,
          error: err.message,
        });
        return sendErrorResponse(res, 502, "Stellar network rejected the transaction", undefined, undefined, { detail: err.message || String(err) });
      }

      logger.error("Custodial contribution signing failed", {
        campaign_id,
        error: err.message,
      });
      return sendErrorResponse(res, 503, "Wallet setup is still completing; please retry in a few seconds.");
    }

    if (parseAmountToStroops(campaign.raised_amount) + parseUserAmount(amount) >= parseAmountToStroops(campaign.target_amount)) {
      sendEmailSafe({
        to: campaign.creator_email,
        subject: `Target Reached for ${campaign.title}!`,
        text: `Congratulations! Your campaign "${campaign.title}" has reached its target of ${campaign.target_amount} ${campaign.asset_type}. You can now start the withdrawal process.`
      });
    }
  }),
);

module.exports = router;
