const db = require('../config/database');

async function listCreatorCampaigns(userId) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.status, c.asset_type, c.target_amount, c.raised_amount,
            c.deadline, c.created_at,
            COALESCE(stats.contributor_count, 0) AS contributor_count,
            EXISTS (
              SELECT 1 FROM milestones m WHERE m.campaign_id = c.id LIMIT 1
            ) AS has_milestones
     FROM campaigns c
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT sender_public_key)::int AS contributor_count
       FROM contributions ctr
       WHERE ctr.campaign_id = c.id
     ) stats ON TRUE
     WHERE c.creator_id = $1
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows;
}

async function listUserContributions(userId) {
  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [userId]
  );
  if (!userRows.length) return null;

  // Current key plus every past key, so history survives wallet rotation.
  const { rows } = await db.query(
    `SELECT ctr.id, ctr.amount, ctr.asset, ctr.anchor_id, ctr.anchor_transaction_id,
            ctr.source_amount, ctr.source_asset, ctr.conversion_rate, ctr.payment_type,
            ctr.tx_hash, ctr.created_at,
            c.id AS campaign_id, c.title AS campaign_title, c.status AS campaign_status,
            c.target_amount, c.raised_amount
     FROM contributions ctr
     JOIN campaigns c ON c.id = ctr.campaign_id
     WHERE ctr.sender_public_key = $2
        OR ctr.sender_public_key IN (SELECT public_key FROM user_wallet_keys WHERE user_id = $1)
     ORDER BY ctr.created_at DESC`,
    [userId, userRows[0].wallet_public_key]
  );
  return rows;
}

module.exports = {
  listCreatorCampaigns,
  listUserContributions,
};
