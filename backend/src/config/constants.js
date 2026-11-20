/**
 * constants.js
 *
 * Single source of truth for named numeric constants used across the backend.
 * Changing a value here propagates everywhere it is imported.
 */

module.exports = {
  // ---------------------------------------------------------------------------
  // Stellar transaction timeouts (seconds)
  // ---------------------------------------------------------------------------

  /** Timeout for contribution transactions (create-account, trustlines, payments). */
  TX_TIMEOUT_CONTRIBUTION_S: 30,

  /** Timeout for withdrawal transactions — platform approver may not be available immediately (see issue #128). */
  TX_TIMEOUT_WITHDRAWAL_S: 60 * 60 * 24 * 7, // 7 days

  // ---------------------------------------------------------------------------
  // Path payment slippage buffer
  // ---------------------------------------------------------------------------

  /** Maximum slippage allowed on DEX path payments, in basis points (500 = 5.00%). */
  SLIPPAGE_BPS: 500,

  // ---------------------------------------------------------------------------
  // Custodial account XLM reserves
  // ---------------------------------------------------------------------------

  /** Base XLM reserve required for a new custodial account (covers account minimum + one entry). */
  CUSTODIAL_ACCOUNT_BASE_RESERVE_XLM: 2.5,

  /** Additional XLM reserve required per trustline on a custodial account. */
  CUSTODIAL_ACCOUNT_PER_TRUSTLINE_XLM: 0.51,

  // ---------------------------------------------------------------------------
  // Ledger monitor reconnect back-off
  // ---------------------------------------------------------------------------

  /** Initial reconnect delay for the ledger payment stream, in milliseconds. */
  LEDGER_MONITOR_RECONNECT_DELAY_MS: 5_000,

  // ---------------------------------------------------------------------------
  // Canonical status values (single source of truth)
  //
  // These arrays MUST stay in sync with the CHECK constraints / enum-like
  // columns in the database schema. Schema-integrity tests import them to
  // assert parity, so adding a new status here is the first step of any
  // status-related migration.
  // ---------------------------------------------------------------------------

  /** Campaign lifecycle statuses (campaigns.status). */
  CAMPAIGN_STATUSES: Object.freeze([
    'draft',
    'active',
    'funded',
    'in_progress',
    'completed',
    'failed',
    'suspended',
    'refunded',
    'cancelled',
  ]),

  /** Withdrawal request statuses (withdrawals.status). */
  WITHDRAWAL_STATUSES: Object.freeze([
    'pending',
    'approved',
    'processing',
    'completed',
    'failed',
    'rejected',
    'cancelled',
  ]),

  /** Dispute statuses (disputes.status). */
  DISPUTE_STATUSES: Object.freeze([
    'open',
    'under_review',
    'resolved',
    'rejected',
    'closed',
  ]),

  /** Milestone statuses (milestones.status). */
  MILESTONE_STATUSES: Object.freeze([
    'pending',
    'in_progress',
    'submitted',
    'approved',
    'rejected',
    'completed',
  ]),

  /** Contribution statuses (contributions.status). */
  CONTRIBUTION_STATUSES: Object.freeze([
    'pending',
    'confirmed',
    'failed',
    'refunded',
  ]),

  /** Refund statuses (refunds.status). */
  REFUND_STATUSES: Object.freeze([
    'pending',
    'processing',
    'completed',
    'failed',
  ]),
};
