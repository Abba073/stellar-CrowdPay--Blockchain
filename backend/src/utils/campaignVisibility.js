/**
 * Soft-deleted campaigns (campaigns.deleted_at, migration
 * 20260602_add_campaign_soft_delete.sql) must be unreachable from every
 * public or secondary read path, not just the campaign detail and listing:
 * backers, updates, milestones, contributions, stellar transactions and
 * disputes otherwise keep exposing a "deleted" campaign's data and its
 * contributors' details.
 *
 * Use NOT_DELETED / notDeleted(alias) in any query that reads campaigns, and
 * findVisibleCampaign() before reading child rows by campaign_id alone.
 * Admin moderation endpoints (list/restore deleted campaigns) are the only
 * intended exception.
 */

/** Predicate for queries over `campaigns` without an alias. */
const NOT_DELETED = 'deleted_at IS NULL';

/** Predicate for an aliased `campaigns` table, e.g. notDeleted('c'). */
function notDeleted(alias) {
  return `${alias}.deleted_at IS NULL`;
}

/**
 * Loads a campaign that has not been soft-deleted, or null.
 * @param {{ query: Function }} db
 * @param {string} campaignId
 * @param {string} [columns] comma-separated column list
 */
async function findVisibleCampaign(db, campaignId, columns = 'id') {
  const { rows } = await db.query(
    `SELECT ${columns} FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`,
    [campaignId]
  );
  return rows[0] || null;
}

module.exports = { NOT_DELETED, notDeleted, findVisibleCampaign };
