const db = require('../config/database');

/**
 * Dashboard reads are single, set-based queries: one round trip each,
 * whatever the number of campaigns or contributions, so heavy creators and
 * backers do not churn the pg pool.
 */

async function listCreatorCampaigns(userId) {
  // Contributor counts and milestone presence are aggregated once for all of
  // the creator's campaigns (GROUP BY), not recomputed per campaign row.
  const { rows } = await db.query(
    `WITH mine AS (
       SELECT id, title, status, asset_type, target_amount, raised_amount, deadline, created_at
       FROM campaigns
       WHERE creator_id = $1
     ),
     contributor_stats AS (
       SELECT ctr.campaign_id, COUNT(DISTINCT ctr.sender_public_key)::int AS contributor_count
       FROM contributions ctr
       JOIN mine ON mine.id = ctr.campaign_id
       GROUP BY ctr.campaign_id
     ),
     milestone_campaigns AS (
       SELECT DISTINCT m.campaign_id
       FROM milestones m
       JOIN mine ON mine.id = m.campaign_id
     )
     SELECT mine.id, mine.title, mine.status, mine.asset_type, mine.target_amount,
            mine.raised_amount, mine.deadline, mine.created_at,
            COALESCE(cs.contributor_count, 0) AS contributor_count,
            (mc.campaign_id IS NOT NULL) AS has_milestones
     FROM mine
     LEFT JOIN contributor_stats cs ON cs.campaign_id = mine.id
     LEFT JOIN milestone_campaigns mc ON mc.campaign_id = mine.id
     ORDER BY mine.created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * The user's contributions under their current wallet key and every past
 * key (history survives wallet rotation), with campaign context.
 * Returns null when the user does not exist.
 */
async function listUserContributions(userId) {
  // One round trip: the user's keys are resolved in a CTE, and
  // sender_public_key = ANY(keys) can use the sender_public_key index (the
  // previous "= $2 OR IN (subquery)" form could not), so this no longer
  // needs a separate users lookup first.
  const { rows } = await db.query(
    `WITH u AS (
       SELECT id, wallet_public_key FROM users WHERE id = $1
     ),
     keys AS (
       SELECT COALESCE(array_agg(k), '{}') AS list
       FROM (
         SELECT wallet_public_key AS k FROM u WHERE wallet_public_key IS NOT NULL
         UNION
         SELECT public_key FROM user_wallet_keys WHERE user_id = $1
       ) all_keys
     )
     SELECT (SELECT COUNT(*) FROM u)::int AS user_exists,
            ctr.id, ctr.amount, ctr.asset, ctr.anchor_id, ctr.anchor_transaction_id,
            ctr.source_amount, ctr.source_asset, ctr.conversion_rate, ctr.payment_type,
            ctr.tx_hash, ctr.created_at,
            c.id AS campaign_id, c.title AS campaign_title, c.status AS campaign_status,
            c.target_amount, c.raised_amount
     FROM keys
     LEFT JOIN contributions ctr ON ctr.sender_public_key = ANY(keys.list)
     LEFT JOIN campaigns c ON c.id = ctr.campaign_id
     ORDER BY ctr.created_at DESC NULLS LAST`,
    [userId]
  );
  // A user with no contributions yields one row with ctr.* NULL; no row with
  // user_exists = 1 means the user does not exist.
  if (!rows.length || !rows[0].user_exists) return null;
  return rows
    .filter((row) => row.id !== null && row.id !== undefined)
    .map(({ user_exists: _exists, ...row }) => row);
}

module.exports = {
  listCreatorCampaigns,
  listUserContributions,
};
