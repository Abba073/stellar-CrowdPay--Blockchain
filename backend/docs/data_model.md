# Data Model

This document describes every table in the CrowdPay database and the valid values for all runtime-critical status columns. It is generated from `backend/db/schema.sql` and the migrations under `backend/db/migrations/`.

## Entities

- **users** – Platform users. A user may be a contributor, campaign creator, or admin. Tracks KYC state and email-verification state.
- **campaigns** – Funding campaigns created by users. Each campaign holds a Stellar wallet and progresses through a defined status lifecycle.
- **contributions** – Individual on-chain payments made to a campaign, including path-payment conversion details.
- **withdrawal_requests** – Multi-sig withdrawal requests that require both the creator's signature and a platform co-signature before submission to Stellar.
- **withdrawal_approval_events** – Immutable audit log of every signature or rejection action on a withdrawal request.
- **milestones** – Milestone-based fund-release schedule attached to a campaign.
- **disputes** – Contributor disputes raised against a campaign with their own resolution lifecycle.
- **dispute_events** – Audit log for every action taken on a dispute.
- **notifications** – In-app notifications delivered to users.
- **stellar_transactions** – Unified on-chain audit table for all Stellar transactions (contributions and withdrawals).
- **anchor_deposits** – SEP-24 anchor deposit flows, tracking status from interactive URL through to a completed contribution.
- **campaign_updates** – Creator-posted updates on a campaign.
- **campaign_status_events** – Immutable audit trail for `funded` and `failed` status transitions.
- **admin_actions** – Audit log of moderation actions taken by admins.
- **api_keys** – Server-to-server API keys for integrations.
- **webhooks / webhook_deliveries** – Outbound webhook endpoints and their delivery attempts.
- **password_reset_tokens** – Short-lived tokens for password-reset flows.
- **refresh_tokens** – JWT refresh-token store.
- **ledger_stream_cursors** – Horizon paging cursor per campaign wallet for stream resume.

---

## Runtime-Critical Status Values

### `campaigns.status`

| Value | Meaning |
|---|---|
| `active` | Accepting contributions |
| `funded` | Target reached, funds held pending milestones |
| `in_progress` | Milestone work under way |
| `completed` | All milestones released, campaign closed successfully |
| `closed` | Manually closed before funding |
| `withdrawn` | Funds fully withdrawn |
| `failed` | Deadline passed without reaching target; refunds issued |
| `suspended` | Suspended by an admin pending moderation review |

### `withdrawal_requests.status`

| Value | Meaning |
|---|---|
| `pending` | Awaiting creator and/or platform signature |
| `on_hold` | Paused due to an open dispute |
| `submitted` | Signed XDR submitted to Stellar |
| `failed` | Submission failed on-chain |
| `denied` | Rejected by the platform |

### `milestones.status`

| Value | Meaning |
|---|---|
| `pending` | Not yet submitted for review |
| `approved` | Approved by the platform, ready to release |
| `released` | Funds released on-chain |

### `disputes.status`

| Value | Meaning |
|---|---|
| `open` | Newly raised |
| `under_review` | Platform is reviewing |
| `resolved_creator` | Resolved in the campaign creator's favour |
| `resolved_contributor` | Resolved in the contributor's favour |
| `closed` | Closed without a binding resolution |

### `anchor_deposits.status`

| Value | Meaning |
|---|---|
| `pending_anchor` | Waiting for the SEP-24 anchor to complete the deposit |
| `deposit_completed` | Anchor deposit confirmed, contribution not yet submitted |
| `contribution_submitted` | Contribution transaction submitted to Stellar |
| `completed` | Contribution confirmed and recorded |
| `failed` | Flow failed at any step |

### `stellar_transactions.status`

| Value | Meaning |
|---|---|
| `pending_signatures` | Collecting required signatures |
| `submitted` | Submitted to Stellar network |
| `indexed` | Confirmed and indexed |
| `failed` | Submission or confirmation failed |

### `webhook_deliveries.status`

| Value | Meaning |
|---|---|
| `pending` | Queued for first attempt |
| `delivering` | Attempt in flight |
| `delivered` | Successful HTTP 2xx response received |
| `retrying` | Scheduled for a retry |
| `failed` | All retry attempts exhausted |

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    users ||--o{ campaigns : creates
    users ||--o{ contributions : "makes (via key)"
    users ||--o{ withdrawal_requests : requests
    users ||--o{ disputes : raises
    users ||--o{ notifications : receives
    users ||--o{ api_keys : owns
    users ||--o{ webhooks : owns
    users ||--o{ refresh_tokens : holds
    users ||--o{ password_reset_tokens : holds
    users ||--o{ anchor_deposits : initiates
    users ||--o{ admin_actions : "performs (admin)"
    users ||--o{ campaign_updates : authors

    campaigns ||--o{ contributions : receives
    campaigns ||--o{ withdrawal_requests : has
    campaigns ||--o{ milestones : defines
    campaigns ||--o{ disputes : subject_of
    campaigns ||--o{ stellar_transactions : tracks
    campaigns ||--o{ anchor_deposits : receives
    campaigns ||--o{ campaign_updates : has
    campaigns ||--o{ campaign_status_events : logs
    campaigns ||--|| ledger_stream_cursors : "tracked_by"

    withdrawal_requests ||--o{ withdrawal_approval_events : logs
    withdrawal_requests ||--o| milestones : "releases (optional)"
    withdrawal_requests ||--o| disputes : "held_by (optional)"
    withdrawal_requests ||--o{ stellar_transactions : recorded_in

    disputes ||--o{ dispute_events : logs

    webhooks ||--o{ webhook_deliveries : generates

    anchor_deposits ||--o| contributions : produces
    anchor_deposits ||--o| stellar_transactions : recorded_in

    stellar_transactions ||--o| contributions : "audit_of (contribution)"

    users {
        UUID id PK
        TEXT email "UNIQUE NOT NULL"
        TEXT password_hash
        TEXT name
        TEXT wallet_public_key "UNIQUE NOT NULL"
        TEXT wallet_secret_encrypted
        TEXT role "contributor | creator | admin"
        kyc_status kyc_status "unverified | pending | verified | rejected"
        TEXT kyc_provider_reference
        TIMESTAMPTZ kyc_completed_at
        BOOLEAN is_admin
        BOOLEAN is_banned
        BOOLEAN email_verified
        TEXT verification_token
        TIMESTAMPTZ verification_sent_at
        INT verification_attempts_count
        TIMESTAMPTZ last_verification_attempt_at
        TIMESTAMPTZ created_at
    }

    campaigns {
        UUID id PK
        UUID creator_id FK
        TEXT title
        TEXT description
        NUMERIC target_amount
        NUMERIC raised_amount
        TEXT asset_type "XLM | USDC"
        TEXT wallet_public_key "UNIQUE NOT NULL"
        TEXT status "active|funded|in_progress|completed|closed|withdrawn|failed|suspended"
        DATE deadline
        BOOLEAN show_backer_amounts
        TEXT category
        NUMERIC min_contribution
        NUMERIC max_contribution
        NUMERIC max_per_user
        BOOLEAN featured
        TIMESTAMPTZ featured_at
        TEXT featured_note
        TIMESTAMPTZ deleted_at
        TIMESTAMPTZ created_at
    }

    contributions {
        UUID id PK
        UUID campaign_id FK
        TEXT sender_public_key
        NUMERIC amount
        TEXT asset
        TEXT anchor_id
        TEXT anchor_transaction_id
        TEXT anchor_asset
        NUMERIC anchor_amount
        TEXT payment_type "payment | path_payment_strict_receive"
        NUMERIC source_amount
        TEXT source_asset
        NUMERIC conversion_rate
        JSONB path
        TEXT tx_hash "UNIQUE NOT NULL"
        TEXT display_name
        TIMESTAMPTZ created_at
    }

    withdrawal_requests {
        UUID id PK
        UUID campaign_id FK
        UUID requested_by FK
        UUID milestone_id FK "nullable"
        UUID dispute_id FK "nullable"
        NUMERIC amount
        TEXT destination_key
        TEXT unsigned_xdr
        BOOLEAN creator_signed
        BOOLEAN platform_signed
        TEXT status "pending|on_hold|submitted|failed|denied"
        TEXT denial_reason
        TEXT tx_hash
        TIMESTAMPTZ created_at
    }

    withdrawal_approval_events {
        UUID id PK
        UUID withdrawal_request_id FK
        UUID actor_user_id FK "nullable"
        TEXT action "requested|creator_signed|platform_signed|creator_cancelled|platform_rejected|submit_failed"
        TEXT note
        JSONB metadata
        TIMESTAMPTZ created_at
    }

    milestones {
        UUID id PK
        UUID campaign_id FK
        TEXT title
        TEXT description
        NUMERIC release_percentage
        INT sort_order
        TEXT evidence_url
        TEXT destination_key
        TEXT review_note
        TEXT status "pending | approved | released"
        TIMESTAMPTZ created_at
        TIMESTAMPTZ completed_at
        TIMESTAMPTZ approved_at
        TIMESTAMPTZ released_at
    }

    disputes {
        UUID id PK
        UUID campaign_id FK
        UUID raised_by FK
        TEXT reason "non_delivery|misrepresentation|abandoned|other"
        TEXT description
        TEXT evidence_url
        TEXT status "open|under_review|resolved_creator|resolved_contributor|closed"
        TEXT resolution_note
        TIMESTAMPTZ created_at
        TIMESTAMPTZ resolved_at
    }

    dispute_events {
        UUID id PK
        UUID dispute_id FK
        UUID actor_id FK "nullable"
        TEXT action
        TEXT note
        TIMESTAMPTZ created_at
    }

    notifications {
        UUID id PK
        UUID user_id FK
        TEXT type
        TEXT title
        TEXT body
        TEXT link
        TIMESTAMPTZ read_at
        TIMESTAMPTZ created_at
    }

    stellar_transactions {
        UUID id PK
        TEXT kind "contribution | withdrawal"
        TEXT status "pending_signatures|submitted|indexed|failed"
        TEXT tx_hash "UNIQUE"
        UUID campaign_id FK
        UUID withdrawal_request_id FK "nullable"
        UUID initiated_by_user_id FK "nullable"
        UUID contribution_id FK "nullable"
        TEXT unsigned_xdr
        TEXT signed_xdr
        JSONB metadata
        TEXT failure_reason
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    anchor_deposits {
        UUID id PK
        UUID user_id FK
        UUID campaign_id FK
        TEXT anchor_id
        TEXT anchor_transaction_id
        TEXT anchor_asset
        NUMERIC anchor_amount
        TEXT campaign_asset
        NUMERIC contribution_amount
        JSONB contribution_flow
        JSONB conversion_quote
        TEXT interactive_url
        TEXT anchor_auth_token
        TIMESTAMPTZ anchor_auth_expires_at
        TEXT status "pending_anchor|deposit_completed|contribution_submitted|completed|failed"
        TEXT last_anchor_status
        JSONB last_anchor_payload
        TEXT last_error
        TEXT contribution_tx_hash
        UUID contribution_stellar_transaction_id FK "nullable"
        UUID contribution_id FK "nullable"
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
        TIMESTAMPTZ completed_at
    }

    campaign_updates {
        UUID id PK
        UUID campaign_id FK
        UUID author_id FK
        TEXT title
        TEXT body
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    campaign_status_events {
        UUID id PK
        UUID campaign_id FK
        TEXT previous_status
        TEXT new_status "funded | failed"
        TIMESTAMPTZ created_at
    }

    admin_actions {
        UUID id PK
        UUID admin_user_id FK
        TEXT action_type
        TEXT target_type "campaign | user"
        UUID target_id
        JSONB details
        TIMESTAMPTZ created_at
    }

    api_keys {
        UUID id PK
        UUID user_id FK
        TEXT key_prefix
        TEXT key_hash "UNIQUE"
        TEXT label
        TEXT[] scopes
        TIMESTAMPTZ last_used_at
        TIMESTAMPTZ revoked_at
        TIMESTAMPTZ created_at
    }

    webhooks {
        UUID id PK
        UUID user_id FK
        TEXT url
        TEXT[] events
        TEXT secret
        TIMESTAMPTZ revoked_at
        TIMESTAMPTZ created_at
    }

    webhook_deliveries {
        UUID id PK
        UUID webhook_id FK
        TEXT event_type
        JSONB payload
        TEXT status "pending|delivering|delivered|retrying|failed"
        INT response_status
        TEXT response_body_snippet
        INT attempt_count
        TEXT last_error
        TIMESTAMPTZ next_retry_at
        TIMESTAMPTZ delivered_at
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    password_reset_tokens {
        UUID id PK
        UUID user_id FK
        TEXT token_hash "UNIQUE"
        TIMESTAMPTZ expires_at
        TIMESTAMPTZ used_at
        TIMESTAMPTZ created_at
    }

    refresh_tokens {
        UUID id PK
        UUID user_id FK
        TEXT token_hash "UNIQUE"
        TIMESTAMPTZ expires_at
        TIMESTAMPTZ revoked_at
        TIMESTAMPTZ created_at
    }

    ledger_stream_cursors {
        UUID campaign_id PK_FK
        TEXT wallet_public_key
        TEXT last_cursor
        TIMESTAMPTZ updated_at
    }
```
