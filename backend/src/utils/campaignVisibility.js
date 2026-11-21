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
 * Allowlist of columns that may be selected by findVisibleCampaign().
 * The columns argument is interpolated into SQL, so it must never accept
 * arbitrary caller input.
 */
const VISIBLE_CAMPAIGN_COLUMNS = Object.freeze([
  'id',
  'title',
  'description',
  'target_amount',
  'raised_amount',
  'asset_type',
  'wallet_public_key',
  'status',
  'deadline',
  'show_backer_amounts',
  'category',
  'min_contribution',
  'max_contribution',
  'max_per_user',
  'featured',
  'featured_at',
  'featured_note',
  'created_at',
  'deleted_at',
  'creator_id',
]);

const VISIBLE_CAMPAIGN_COLUMN_SET = new Set(VISIBLE_CAMPAIGN_COLUMNS);

/**
 * Validates a comma-separated column list against the allowlist.
 * @param {string} columns
 * @returns {string} the normalized, comma-separated column list
 * @throws {Error} if any requested column is not in the allowlist
 */
function sanitizeColumns(columns) {
  if (typeof columns !== 'string' || columns.trim() === '') {
    throw new Error('findVisibleCampaign: columns must be a non-empty string');
  }

  const requested = columns.split(',').map((col) => col.trim());

  for (const col of requested) {
    if (!VISIBLE_CAMPAIGN_COLUMN_SET.has(col)) {
      throw new Error(
        `findVisibleCampaign: invalid column "${col}"`
      );
    }
  }

  return requested.join(', ');
}

/**
 * Loads a campaign that has not been soft-deleted, or null.
 * @param {{ query: Function }} db
 * @param {string} campaignId
 * @param {string} [columns] comma-separated column list (allowlisted)
 */
async function findVisibleCampaign(db, campaignId, columns = 'id') {
  const safeColumns = sanitizeColumns(columns);
  const { rows } = await db.query(
    `SELECT ${safeColumns} FROM campaigns WHERE id = $1 AND ${NOT_DELETED}`,
    [campaignId]
  );
  return rows[0] || null;
}

module.exports = {
  NOT_DELETED,
  notDeleted,
  findVisibleCampaign,
  VISIBLE_CAMPAIGN_COLUMNS,
};