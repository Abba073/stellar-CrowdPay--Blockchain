const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const { ensureCustodialAccountFundedAndTrusted, getSupportedAssetCodes, getCampaignBalance } = require('../services/stellarService');
const { buildContributionIntent, submitCustodialContribution } = require('../services/contributionService');
const {
  getAvailableAnchors,
  getAnchorById,
  publicAnchorInfo,
  isAnchorConfigured,
  authenticateWithAnchor,
  startInteractiveDeposit,
  getAnchorTransaction,
  isAnchorFailureStatus,
} = require('../services/anchorService');

function mapSessionForClient(row) {
  const session = {
    id: row.id,
    anchor_id: row.anchor_id,
    anchor_transaction_id: row.anchor_transaction_id,
    anchor_asset: row.anchor_asset,
    anchor_amount: row.anchor_amount,
    deposit_type: row.deposit_type,
    status: row.status,
    anchor_status: row.last_anchor_status,
    interactive_url: row.interactive_url,
    last_error: row.last_error,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
  if (row.campaign_id) {
    session.campaign_id = row.campaign_id;
    session.contribution_amount = row.contribution_amount;
    session.contribution_tx_hash = row.contribution_tx_hash;
    session.contribution_id = row.contribution_id;
    session.conversion_quote = row.conversion_quote;
  }
  return session;
}

async function loadUserWallet(userId) {
  const { rows } = await db.query(
    'SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

async function loadCampaignForContribution(campaignId) {
  const { rows } = await db.query(
    'SELECT c.*, u.email AS creator_email FROM campaigns c JOIN users u ON u.id = c.creator_id WHERE c.id = $1 AND c.status = $2',
    [campaignId, 'active']
  );
  return rows[0] || null;
}

async function issueAnchorAuthToken({ anchor, user }) {
  return withDecryptedWalletSecret(
    user.wallet_secret_encrypted,
    {
      userId: user.id,
      walletPublicKey: user.wallet_public_key,
    },
    async (userSecret) =>
      authenticateWithAnchor({
        anchor,
        userPublicKey: user.wallet_public_key,
        userSecret,
      })
  );
}

async function ensureAnchorAuth({ anchor, sessionRow, user }) {
  if (sessionRow.anchor_auth_token && sessionRow.anchor_auth_expires_at && new Date(sessionRow.anchor_auth_expires_at) > new Date(Date.now() + 30_000)) {
    return {
      token: sessionRow.anchor_auth_token,
      expiresAt: sessionRow.anchor_auth_expires_at,
      refreshed: false,
    };
  }

  const auth = await issueAnchorAuthToken({ anchor, user });
  await db.query(
    `UPDATE anchor_deposits
     SET anchor_auth_token = $1,
         anchor_auth_expires_at = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [auth.token, auth.expiresAt, sessionRow.id]
  );
  return { ...auth, refreshed: true };
}

router.get('/info', (_req, res) => {
  res.json({
    supported_assets: getSupportedAssetCodes(),
    anchors: getAvailableAnchors().map(publicAnchorInfo),
  });
});

router.post('/deposits/start', requireAuth, async (req, res) => {
  const { campaign_id, amount, anchor_id } = req.body || {};
  if (!campaign_id || !amount || !anchor_id) {
    return res.status(400).json({ error: 'campaign_id, amount and anchor_id are required' });
  }

  const anchor = getAnchorById(anchor_id);
  if (!anchor) {
    return res.status(404).json({ error: 'Anchor not found' });
  }
  if (!isAnchorConfigured(anchor)) {
    return res.status(503).json({ error: 'This anchor is not configured for the current backend environment' });
  }
  if (!getSupportedAssetCodes().includes(anchor.assetCode)) {
    return res.status(409).json({
      error: `Anchor asset ${anchor.assetCode} is not enabled in CrowdPay's Stellar asset config`,
    });
  }

  const campaign = await loadCampaignForContribution(campaign_id);
  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found or no longer active' });
  }

  const user = await loadUserWallet(req.user.userId);
  if (!user) {
    return res.status(404).json({ error: 'User wallet not found' });
  }

  try {
    const session = await withDecryptedWalletSecret(
      user.wallet_secret_encrypted,
      {
        userId: user.id,
        walletPublicKey: user.wallet_public_key,
      },
      async (userSecret) => {
        await ensureCustodialAccountFundedAndTrusted({
          publicKey: user.wallet_public_key,
          secret: userSecret,
        });

        const auth = await authenticateWithAnchor({
          anchor,
          userPublicKey: user.wallet_public_key,
          userSecret,
        });
        const intent = await buildContributionIntent({
          campaign,
          amount,
          sendAsset: anchor.assetCode,
          contributorPublicKey: user.wallet_public_key,
        });
        const anchorAmount = intent.kind === 'payment' ? String(amount) : intent.sendMax;
        const interactive = await startInteractiveDeposit({
          anchor,
          authToken: auth.token,
          userPublicKey: user.wallet_public_key,
          amount: anchorAmount,
        });

        const { rows } = await db.query(
          `INSERT INTO anchor_deposits
             (user_id, campaign_id, anchor_id, anchor_transaction_id, anchor_asset, anchor_amount,
              campaign_asset, contribution_amount, contribution_flow, conversion_quote, interactive_url,
              anchor_auth_token, anchor_auth_expires_at, status, last_anchor_status, last_anchor_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, 'pending_anchor', $14, $15::jsonb)
           RETURNING *`,
          [
            user.id,
            campaign_id,
            anchor.id,
            interactive.id,
            anchor.assetCode,
            anchorAmount,
            campaign.asset_type,
            String(amount),
            JSON.stringify(intent),
            JSON.stringify(intent.conversionQuote),
            interactive.url,
            auth.token,
            auth.expiresAt,
            interactive.status || 'pending_anchor',
            JSON.stringify(interactive),
          ]
        );

        return rows[0];
      }
    );

    res.status(201).json({
      ...mapSessionForClient(session),
      anchor: publicAnchorInfo(anchor),
    });
  } catch (err) {
    const status = err.statusCode || 503;
    logger.error('Anchor deposit start failed', {
      anchor_id,
      campaign_id,
      user_id: req.user.userId,
      error: err.message,
    });
    res.status(status).json({
      error: err.message || 'Could not start the anchor deposit flow right now',
    });
  }
});

router.get('/sep24/assets', (_req, res) => {
  res.json({
    supported_assets: getSupportedAssetCodes(),
    anchors: getAvailableAnchors().map(publicAnchorInfo),
  });
});

router.post('/sep24/deposit', requireAuth, async (req, res) => {
  const { amount, anchor_id } = req.body || {};
  if (!amount || !anchor_id) {
    return res.status(400).json({ error: 'amount and anchor_id are required' });
  }

  const anchor = getAnchorById(anchor_id);
  if (!anchor) {
    return res.status(404).json({ error: 'Anchor not found' });
  }
  if (!isAnchorConfigured(anchor)) {
    return res.status(503).json({ error: 'This anchor is not configured for the current backend environment' });
  }
  if (!getSupportedAssetCodes().includes(anchor.assetCode)) {
    return res.status(409).json({
      error: `Anchor asset ${anchor.assetCode} is not enabled in CrowdPay's Stellar asset config`,
    });
  }

  const { rows: userRows } = await db.query(
    'SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!userRows.length) {
    return res.status(404).json({ error: 'User wallet not found' });
  }
  const user = userRows[0];

  try {
    const session = await withDecryptedWalletSecret(
      user.wallet_secret_encrypted,
      {
        userId: user.id,
        walletPublicKey: user.wallet_public_key,
      },
      async (userSecret) => {
        await ensureCustodialAccountFundedAndTrusted({
          publicKey: user.wallet_public_key,
          secret: userSecret,
        });

        const auth = await authenticateWithAnchor({
          anchor,
          userPublicKey: user.wallet_public_key,
          userSecret,
        });

        const interactive = await startInteractiveDeposit({
          anchor,
          authToken: auth.token,
          userPublicKey: user.wallet_public_key,
          amount: String(amount),
        });

        const { rows } = await db.query(
          `INSERT INTO anchor_deposits
             (user_id, deposit_type, anchor_id, anchor_transaction_id, anchor_asset, anchor_amount,
              interactive_url, anchor_auth_token, anchor_auth_expires_at, status, last_anchor_status, last_anchor_payload)
           VALUES ($1, 'wallet', $2, $3, $4, $5, $6, $7, $8, 'pending_anchor', $9, $10::jsonb)
           RETURNING *`,
          [
            user.id,
            anchor.id,
            interactive.id,
            anchor.assetCode,
            String(amount),
            interactive.url,
            auth.token,
            auth.expiresAt,
            interactive.status || 'pending_anchor',
            JSON.stringify(interactive),
          ]
        );

        return rows[0];
      }
    );

    res.status(201).json({
      ...mapSessionForClient(session),
      anchor: publicAnchorInfo(anchor),
    });
  } catch (err) {
    const status = err.statusCode || 503;
    logger.error('SEP-24 wallet deposit start failed', {
      anchor_id,
      user_id: req.user.userId,
      error: err.message,
    });
    res.status(status).json({
      error: err.message || 'Could not start the wallet deposit flow right now',
    });
  }
});

router.get('/deposits/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT ad.*, u.wallet_public_key, u.wallet_secret_encrypted
     FROM anchor_deposits ad
     JOIN users u ON u.id = ad.user_id
     WHERE ad.id = $1 AND ad.user_id = $2`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'Anchor deposit session not found' });
  }

  let session = rows[0];
  const anchor = getAnchorById(session.anchor_id);
  if (!anchor) {
    return res.status(503).json({ error: 'This anchor is no longer available in the current backend configuration' });
  }

  const user = {
    id: req.user.userId,
    wallet_public_key: session.wallet_public_key,
    wallet_secret_encrypted: session.wallet_secret_encrypted,
  };

  try {
    let auth = await ensureAnchorAuth({ anchor, sessionRow: session, user });
    let remote;
    try {
      remote = await getAnchorTransaction({
        anchor,
        authToken: auth.token,
        transactionId: session.anchor_transaction_id,
      });
    } catch (err) {
      if (err.statusCode !== 401) throw err;
      auth = await issueAnchorAuthToken({ anchor, user });
      await db.query(
        `UPDATE anchor_deposits
         SET anchor_auth_token = $1,
             anchor_auth_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [auth.token, auth.expiresAt, session.id]
      );
      remote = await getAnchorTransaction({
        anchor,
        authToken: auth.token,
        transactionId: session.anchor_transaction_id,
      });
    }

    const remoteTx = remote.transaction || remote;
    const remoteStatus = remoteTx.status || session.last_anchor_status || 'pending_anchor';
    let localStatus = session.status;
    if (isAnchorFailureStatus(remoteStatus)) {
      localStatus = 'failed';
    } else if (remoteStatus === 'completed' && session.contribution_id) {
      localStatus = 'completed';
    } else if (remoteStatus === 'completed' && session.contribution_tx_hash) {
      localStatus = 'contribution_submitted';
    } else if (remoteStatus === 'completed') {
      localStatus = 'deposit_completed';
    } else {
      localStatus = 'pending_anchor';
    }

    await db.query(
      `UPDATE anchor_deposits
       SET status = $1,
           last_anchor_status = $2,
           last_anchor_payload = $3::jsonb,
           updated_at = NOW(),
           completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN COALESCE(completed_at, NOW()) ELSE completed_at END
       WHERE id = $4
         AND NOT (contribution_tx_hash IS NOT NULL AND $1 = 'deposit_completed')`,
      [localStatus, remoteStatus, JSON.stringify(remoteTx), session.id]
    );

    session = {
      ...session,
      status: localStatus,
      last_anchor_status: remoteStatus,
      last_anchor_payload: remoteTx,
    };

    if (remoteStatus === 'completed' && !session.contribution_tx_hash && !session.contribution_id) {
      if (session.deposit_type === 'wallet') {
        await db.query(
          `UPDATE anchor_deposits
           SET status = 'completed',
               last_error = NULL,
               updated_at = NOW(),
               completed_at = COALESCE(completed_at, NOW())
           WHERE id = $1`,
          [session.id]
        );
      } else {
        const campaign = await loadCampaignForContribution(session.campaign_id);
        if (!campaign) {
          await db.query(
            `UPDATE anchor_deposits
             SET status = 'failed',
                 last_error = $1,
                 updated_at = NOW(),
                 completed_at = COALESCE(completed_at, NOW())
             WHERE id = $2`,
            ['Deposit completed, but the campaign is no longer accepting contributions.', session.id]
          );
        } else {
          // Atomically claim the submission so concurrent polls/retries cannot double-fund.
          const { rows: claimed } = await db.query(
            `UPDATE anchor_deposits
             SET contribution_submitting_at = NOW()
             WHERE id = $1
               AND contribution_tx_hash IS NULL
               AND contribution_id IS NULL
               AND contribution_submitting_at IS NULL
             RETURNING id`,
            [session.id]
          );
          // Another poll already owns the submission when the claim returns no row.
          if (claimed.length) {
            let result = null;
            try {
              result = await submitCustodialContribution({
                campaign,
                campaignId: session.campaign_id,
                userId: req.user.userId,
                walletPublicKey: session.wallet_public_key,
                walletSecretEncrypted: session.wallet_secret_encrypted,
                amount: session.contribution_amount,
                sendAsset: session.anchor_asset,
                intentOverride: session.contribution_flow,
                anchorMetadata: {
                  anchor_id: session.anchor_id,
                  anchor_transaction_id: session.anchor_transaction_id,
                  anchor_asset: session.anchor_asset,
                  anchor_amount: session.anchor_amount,
                  anchor_deposit_id: session.id,
                },
              });
            } catch (err) {
              logger.error('Anchor contribution submission failed after deposit completion', {
                anchor_deposit_id: session.id,
                error: err.message,
              });
              // Submission definitively failed: release the claim so a later poll can retry.
              await db.query(
                `UPDATE anchor_deposits
                 SET status = 'deposit_completed',
                     contribution_submitting_at = NULL,
                     last_error = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [err.message || 'Contribution submission failed after deposit completion', session.id]
              );
            }
            // The claim stays set after a successful on-chain submission so it is never re-sent.
            if (result) {
              await db.query(
                `UPDATE anchor_deposits
                 SET status = 'contribution_submitted',
                     contribution_tx_hash = $1,
                     contribution_stellar_transaction_id = $2,
                     last_error = NULL,
                     updated_at = NOW()
                 WHERE id = $3`,
                [result.txHash, result.stellarTransactionId, session.id]
              );
            }
          }
        }
      }
    }

    const { rows: refreshed } = await db.query(
      'SELECT * FROM anchor_deposits WHERE id = $1',
      [session.id]
    );
    res.json(mapSessionForClient(refreshed[0]));
  } catch (err) {
    logger.error('Anchor deposit status sync failed', {
      anchor_deposit_id: session.id,
      error: err.message,
    });
    res.status(err.statusCode || 502).json({
      error: err.message || 'Could not refresh anchor transaction status',
    });
  }
});

module.exports = router;
