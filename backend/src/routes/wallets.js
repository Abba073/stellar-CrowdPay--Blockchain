const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  getAccountMultisigConfig,
  getWalletTransactionHistory,
  getWalletPayments,
  recoverWalletFromSecret,
} = require('../services/stellarService');
const { decryptSecret } = require('../services/walletService');
const { sendErrorResponse } = require('../middleware/errorHandler');

// Get wallet configuration (signers, thresholds)
router.get('/:campaignId/config', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');
  if (rows[0].creator_id !== req.user.userId) {
    return sendErrorResponse(res, 403, 'Unauthorized');
  }

  const config = await getAccountMultisigConfig(rows[0].wallet_public_key);
  res.json(config);
});

// Get wallet transaction history
router.get('/:campaignId/transactions', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');
  if (rows[0].creator_id !== req.user.userId) {
    return sendErrorResponse(res, 403, 'Unauthorized');
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const txs = await getWalletTransactionHistory(rows[0].wallet_public_key, limit);
  res.json(txs);
});

// Get wallet payment history (audit trail)
router.get('/:campaignId/payments', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');
  if (rows[0].creator_id !== req.user.userId) {
    return sendErrorResponse(res, 403, 'Unauthorized');
  }

  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const payments = await getWalletPayments(rows[0].wallet_public_key, limit);
  res.json(payments);
});

// Recover wallet keypair (creator only - requires encrypted secret)
router.post('/:campaignId/recover', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_secret_encrypted, wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return sendErrorResponse(res, 404, 'Campaign not found');
  if (rows[0].creator_id !== req.user.userId) {
    return sendErrorResponse(res, 403, 'Unauthorized');
  }
  if (!rows[0].wallet_secret_encrypted) {
    return sendErrorResponse(res, 400, 'No encrypted secret stored for this campaign');
  }

  try {
    const secret = decryptSecret(rows[0].wallet_secret_encrypted);
    const wallet = await recoverWalletFromSecret(secret);
    if (wallet.publicKey !== rows[0].wallet_public_key) {
      return sendErrorResponse(res, 500, 'Stored secret does not match the campaign wallet public key');
    }
    res.json({ publicKey: wallet.publicKey, verified: true });
  } catch {
    return sendErrorResponse(res, 500, 'Could not recover campaign wallet keypair');
  }
});

module.exports = router;
