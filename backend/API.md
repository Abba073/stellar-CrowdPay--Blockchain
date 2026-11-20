# CrowdPay Backend API

> **Generated file — do not edit by hand.**
> The swagger-jsdoc annotations in `src/routes/*.js` are the single source of
> truth for the HTTP API. This file is generated from that spec by
> `npm run docs:api` (`scripts/generate-api-docs.js`). CI runs
> `npm run docs:api:check`, which regenerates the file and fails when the
> committed copy differs, so any route change must be accompanied by the
> regenerated `API.md`.

The [route table](#route-table) is derived from the same spec and must match the
routers mounted in `src/index.js` exactly: `src/routes/apiDocs.test.js` fails
when a route is added, removed or renamed without updating the annotations (and
when a `###` heading below names a route that does not exist).

## Interactive Swagger UI

Browse the interactive API docs at `GET /api/docs` (served from the same spec).

## Conventions

- **Base path**: every JSON route lives under `/api`, except `GET /health` and `GET /health/ledger`.
- **Authentication**: `POST /api/auth/login` and `POST /api/auth/register` set an httpOnly `cp_token`
  cookie (plus a refresh cookie used by `POST /api/auth/refresh`, named `__Host-cp_refresh` in production
  and `cp_refresh_token` elsewhere). Browser clients send the
  cookie with `credentials: "include"`. Server-to-server clients may instead send
  `Authorization: Bearer <token>`, where the token is either the access token or a `cp_live_…` API key
  from `POST /api/api-keys`.
- **Errors**: every non-2xx response has the same envelope:

  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Human-readable message", "fields": { "amount": "Invalid amount" } } }
  ```

  `code` is always present: by default it is derived from the status (`BAD_REQUEST`, `UNAUTHORIZED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_ERROR` (422), `TOO_MANY_REQUESTS`,
  `INTERNAL_ERROR`, `BAD_GATEWAY`, `SERVICE_UNAVAILABLE`), and some endpoints use a more specific one
  (e.g. `KYC_REQUIRED`). `fields` is present for field-level validation errors. A few endpoints add
  top-level hints next to `error` (e.g. `retryable`, `retry_after_ms`, `retry_after_seconds`).
  Request-validation failures (`400 VALIDATION_ERROR`) also keep the raw `errors` array.
- **Idempotency**: `POST /api/campaigns`, `POST /api/contributions/submit-signed`,
  `POST /api/withdrawals/request` and `POST /api/milestones/:id/release` (and its `/approve` alias)
  accept an optional `Idempotency-Key` header (max 255 chars). A repeated key with the same body
  returns the original 2xx response with `Idempotent-Replayed: true`; a different body returns `422`,
  and a request still in progress returns `409`.

Auth column in the table:

| Value | Meaning |
|---|---|
| Public | No credentials required |
| Optional | Works anonymously; more fields for the owner/admin |
| User | Any authenticated user (additional ownership checks noted per route) |
| Owner | Authenticated campaign owner (or member role noted) |
| Admin | `role=admin` |
| Super admin | `is_super_admin=true` |
| Platform | The configured `PLATFORM_APPROVER_USER_ID` (any user in dev when unset) |
| Signed | Provider HMAC signature, no user session |

## Contribution conversion model

- Campaigns define a default settlement asset via `campaigns.asset_type` (`USDC` or `XLM`).
- Contributors can pay using `send_asset`.
- If `send_asset !== campaign.asset_type`, the backend uses Stellar `pathPaymentStrictReceive` so the campaign receives the exact requested `amount` in its settlement asset.
- Conversion path discovery uses Stellar Horizon `strictReceivePaths` and applies a `5%` slippage buffer when computing `sendMax`.
- Additional credit assets can be enabled through `STELLAR_EXTRA_ASSETS` in `.env` as a JSON object (`{"CODE":"ISSUER"}`).


## Route table

Deprecated aliases still respond but will be removed; new integrations must use the canonical route.

### Auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/register` | Public | Rate-limited. Creates user + custodial wallet, sets session cookies |
| `POST` | `/api/auth/login` | Public | Rate-limited. Sets session cookies |
| `POST` | `/api/auth/refresh` | Public | Rotates the refresh cookie and issues a new access token |
| `POST` | `/api/auth/logout` | Public | Revokes the refresh token and clears cookies |
| `POST` | `/api/auth/verify-email` | Public | Body `{ token }` |
| `POST` | `/api/auth/resend-verification` | User | Rate-limited (3/hour) |
| `POST` | `/api/auth/forgot-password` | Public | Always `200` to avoid account enumeration |
| `POST` | `/api/auth/reset-password` | Public | Body `{ token, password }` |

### Users

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/users/me` | User | Current profile |
| `PATCH` | `/api/users/me` | User | Update display `name` only |
| `POST` | `/api/users/me/kyc/start` | User | Start hosted KYC session |
| `GET` | `/api/users/me/campaigns` | User | **Deprecated** alias of `GET /api/campaigns/mine` |
| `GET` | `/api/users/me/stats` | User | Dashboard totals |
| `GET` | `/api/users/me/balance` | User | Custodial wallet balances |
| `GET` | `/api/users/me/contributions` | User | **Deprecated** alias of `GET /api/contributions/mine` |

### Campaigns

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/campaigns` | Public | List/search with filters. Paginate with `limit` + `cursor` (`next_cursor` from the previous page) for `sort=newest` / `most_funded`; `offset` still works but is slower on deep pages |
| `POST` | `/api/campaigns` | User | Creator/admin; requires verified email (and KYC when enforced) |
| `GET` | `/api/campaigns/mine` | User | Campaigns the user created |
| `GET` | `/api/campaigns/categories` | Public | |
| `GET` | `/api/campaigns/featured` | Public | |
| `GET` | `/api/campaigns/:id` | Public | |
| `PATCH` | `/api/campaigns/:id` | User | Campaign creator only; title, description, deadline |
| `POST` | `/api/campaigns/:id/cover-image` | Owner | Multipart upload; requires `STORAGE_*` config |
| `GET` | `/api/campaigns/:id/embed` | Public | CORS-enabled widget payload |
| `GET` | `/api/campaigns/:id/backers` | Optional | |
| `GET` | `/api/campaigns/:id/stream` | Public | Server-sent events for live funding updates |
| `GET` | `/api/campaigns/:id/balance` | Public | On-chain campaign wallet balances |
| `GET` | `/api/campaigns/:id/analytics` | User | Owner or admin only |
| `POST` | `/api/campaigns/:id/refresh-status` | User | Re-evaluate funded/failed status |
| `POST` | `/api/campaigns/:id/trigger-refunds` | Admin | |
| `POST` | `/api/campaigns/cron/fail-expired` | Admin | Manual trigger for the expiry job |
| `POST` | `/api/campaigns/cron/reminders` | Admin | Manual trigger for deadline reminders |
| `GET` | `/api/campaigns/:id/milestones` | Public | |
| `POST` | `/api/campaigns/:id/milestones` | Owner | Replace the milestone plan |
| `GET` | `/api/campaigns/:id/updates` | Public | `limit`, `offset` query params |
| `POST` | `/api/campaigns/:id/updates` | Owner | Campaign creator only |
| `PATCH` | `/api/campaigns/:id/updates/:updateId` | Owner | Campaign creator only |
| `DELETE` | `/api/campaigns/:id/updates/:updateId` | Owner | Campaign creator only |
| `GET` | `/api/campaigns/:id/members` | Owner | |
| `POST` | `/api/campaigns/:id/members` | Owner | Invite by email |
| `PATCH` | `/api/campaigns/:id/members/:userId` | Owner | Change a member's role |
| `DELETE` | `/api/campaigns/:id/members/:userId` | User | Owner removes a member, or a member leaves |
| `POST` | `/api/campaigns/:id/members/accept` | User | Accept an invitation |
| `POST` | `/api/campaigns/:id/disputes` | User | Contributors raise a dispute |
| `GET` | `/api/campaigns/:id/disputes` | User | |

### Contributions

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/contributions` | User | Custodial contribution (direct or path payment) |
| `GET` | `/api/contributions/quote` | User | DEX quote for cross-asset contributions |
| `POST` | `/api/contributions/prepare` | User | Unsigned XDR for Freighter signing |
| `POST` | `/api/contributions/submit-signed` | User | Submit Freighter-signed XDR |
| `GET` | `/api/contributions/finalization/:txHash` | User | Submitted vs. ledger-indexed status |
| `GET` | `/api/contributions/campaign/:campaignId` | Optional | Sensitive fields redacted for anonymous callers |
| `GET` | `/api/contributions/mine` | User | The caller's contributions |
| `GET` | `/api/contributions` | User | **Deprecated** alias of `GET /api/contributions/mine` |

### Anchor (SEP-24 fiat on-ramp)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/anchor/info` | Public | Configured anchors and enabled asset codes |
| `GET` | `/api/anchor/sep24/assets` | Public | Anchors available for wallet top-ups |
| `POST` | `/api/anchor/deposits/start` | User | Deposit that ends in a campaign contribution |
| `POST` | `/api/anchor/sep24/deposit` | User | Deposit into the user's own custodial wallet |
| `GET` | `/api/anchor/deposits/:id` | User | Poll a deposit session |

### Withdrawals (manual fund release)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/withdrawals/capabilities` | User | |
| `POST` | `/api/withdrawals/request` | User | Campaign creator only |
| `GET` | `/api/withdrawals/campaign/:campaignId` | User | Creator or platform approver |
| `GET` | `/api/withdrawals/:id` | User | Creator or platform approver; includes `unsigned_xdr` |
| `POST` | `/api/withdrawals/:id/approve/creator` | User | Campaign creator only |
| `POST` | `/api/withdrawals/:id/approve/platform` | Platform | |
| `POST` | `/api/withdrawals/:id/approve` | Platform | **Deprecated** alias of `POST /api/withdrawals/:id/approve/platform` |
| `POST` | `/api/withdrawals/:id/cancel` | User | Campaign creator only, before signing |
| `POST` | `/api/withdrawals/:id/reject` | Platform | |
| `GET` | `/api/withdrawals/:id/events` | User | Creator or platform approver |
| `GET` | `/api/withdrawals/:id/audit` | User | **Deprecated** alias of `GET /api/withdrawals/:id/events` |

### Milestones

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/milestones/campaign/:campaignId` | Public | |
| `POST` | `/api/milestones` | User | Campaign creator only |
| `POST` | `/api/milestones/:id/submit` | User | Campaign creator only |
| `POST` | `/api/milestones/:id/release` | User | Platform approver only |
| `POST` | `/api/milestones/:id/approve` | User | **Deprecated** alias of `POST /api/milestones/:id/release` |
| `POST` | `/api/milestones/:id/reject` | User | Platform approver only |

### Disputes

| Method | Path | Auth | Notes |
|---|---|---|---|
| `PATCH` | `/api/disputes/:id` | Admin | Change status / add resolution note |
| `GET` | `/api/disputes/:id/events` | User | |

### Stellar transactions

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/stellar/transactions` | User | |
| `GET` | `/api/stellar/transactions/:id` | User | |

### Admin

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/admin/stats` | Admin | |
| `GET` | `/api/admin/metrics/db-pool` | Admin | Database pool total/idle/waiting counts |
| `GET` | `/api/admin/campaigns` | Admin | |
| `GET` | `/api/admin/campaigns/deleted` | Admin | |
| `PATCH` | `/api/admin/campaigns/:id/suspend` | Admin | |
| `PATCH` | `/api/admin/campaigns/:id/restore` | Admin | |
| `PATCH` | `/api/admin/campaigns/:id/feature` | Admin | |
| `PATCH` | `/api/admin/campaigns/:id/unfeature` | Admin | |
| `DELETE` | `/api/admin/campaigns/:id` | Admin | Soft delete |
| `POST` | `/api/admin/campaigns/:id/reconcile` | Admin | Reconcile raised amount against the ledger |
| `GET` | `/api/admin/users` | Admin | |
| `PATCH` | `/api/admin/users/:id/ban` | Admin | |
| `PATCH` | `/api/admin/users/:id/unban` | Admin | |
| `PATCH` | `/api/admin/users/:id/promote` | Super admin | |
| `PATCH` | `/api/admin/users/:id/demote` | Super admin | |
| `GET` | `/api/admin/audit-log` | Admin | `limit` max 100; pass `pagination.next_before_id` as `before_id` for the next page |
| `GET` | `/api/admin/milestones` | Admin | |

### Developer: API keys and webhooks

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/api-keys` | User | |
| `POST` | `/api/api-keys` | User | Raw key is returned once |
| `DELETE` | `/api/api-keys/:id` | User | |
| `GET` | `/api/webhooks` | User | |
| `POST` | `/api/webhooks` | User | |
| `DELETE` | `/api/webhooks/:id` | User | |
| `GET` | `/api/webhooks/deliveries` | User | |
| `POST` | `/api/webhooks/kyc` | Signed | KYC provider callback |
| `POST` | `/api/webhooks/email-events` | Token | Email provider bounce/complaint events; suppresses the address |

### Notifications

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/notifications` | User | |
| `PATCH` | `/api/notifications/read-all` | User | |
| `PATCH` | `/api/notifications/:id/read` | User | |

### Platform

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/config` | Public | `{ platform_fee_bps }` |
| `GET` | `/api/stats` | Public | Landing-page totals (cached 60 s) |
| `GET` | `/api/seo/head` | Public | HTML head fragment for campaign pages, injected by nginx SSI so crawlers see per-campaign `og:*`/`twitter:*` tags (cached 60 s) |
| `GET` | `/health` | Public | Liveness + database connectivity; returns `{ "status": "ok" }` |
| `GET` | `/health/ledger` | Public | Horizon stream health |

### Removed

- `POST /api/users/register` and `POST /api/users/login` (and every other `/api/users/*` copy of the auth
  router) were undocumented duplicates of `/api/auth/*`. No client used them, so they have been removed. Use `/api/auth/*`.

## Endpoint details

### `GET /api/users/me`

Authenticated. Returns the current profile: `id`, `email`, `name`, `wallet_public_key`, `wallet_type`, `role`,
`kyc_status` (`unverified`, `pending`, `verified`, `rejected`), `kyc_completed_at`, `created_at`, and
`kyc_required_for_campaigns` (boolean, from `KYC_REQUIRED_FOR_CAMPAIGNS`).

### `POST /api/auth/verify-email`

Public. Validates a verification token and marks the associated user's email as verified.

Body:
- `token` (required): the token from the verification email link.

Returns `200` on success (including when the email was already verified), or `400` if the token is missing, invalid or expired (> 24 hours).

### `POST /api/auth/resend-verification`

Authenticated. Generates a new verification token and sends a new email.
Rate-limited to 3 requests per hour per user.

### `POST /api/users/me/kyc/start`

Authenticated. Creates a hosted KYC session with the configured provider and marks the user `pending`.

Response includes `redirect_url` or `session_token`, plus the updated user. Persona is used when `KYC_PROVIDER=persona`, `PERSONA_API_KEY`, and `PERSONA_TEMPLATE_ID` are configured; otherwise local development returns a dev redirect URL.

### `POST /api/webhooks/kyc`

KYC provider callback. Updates the matched user to `verified` or `rejected` from provider status. The campaign creation gate is controlled by `KYC_REQUIRED_FOR_CAMPAIGNS` and defaults to enabled; set it to `false` for testnet/dev.

### `POST /api/campaigns`

Authenticated creator/admin endpoint. The user must have `email_verified=true`. Additionally, when `KYC_REQUIRED_FOR_CAMPAIGNS` is not `false`, the user must have `kyc_status=verified`; otherwise the API returns `403` with `code=KYC_REQUIRED` or `code=EMAIL_NOT_VERIFIED`.

### `GET /api/contributions/quote`

Get a DEX quote before submitting a conversion contribution.

Query params:

- `send_asset` (required): `XLM` or `USDC`
- `dest_asset` (required): `XLM` or `USDC`
- `dest_amount` (required): amount the campaign should receive

Success response (`200`):

```json
{
  "send_asset": "XLM",
  "dest_asset": "USDC",
  "dest_amount": "9",
  "quoted_source_amount": "10.0000000",
  "max_send_amount": "10.5000000",
  "estimated_rate": "0.900000000000000",
  "path": ["AQUA"],
  "path_count": 3
}
```

Errors:

- `400` missing/invalid params
- `404` no path found on Stellar DEX

### `POST /api/contributions`

Submit a contribution through the existing custodial wallet flow (direct payment or path payment).

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign must receive in campaign asset
- `send_asset` (required): `XLM` or `USDC`

Success response (`202`):

```json
{
  "tx_hash": "c8d6...",
  "message": "Transaction submitted",
  "conversion_quote": {
    "send_asset": "XLM",
    "campaign_asset": "USDC",
    "campaign_amount": "4.5000000",
    "quoted_source_amount": "5.0000000",
    "max_send_amount": "5.2500000",
    "path": []
  }
}
```

`conversion_quote` is `null` for direct same-asset contributions.

Errors:

- `400` missing fields / unsupported assets
- `404` campaign not found or not active
- `422` no conversion path found for requested asset pair

### `POST /api/contributions/prepare`

Prepare an unsigned Stellar transaction for a Freighter contribution without submitting it.

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign must receive in campaign asset
- `send_asset` (required): `XLM` or `USDC`
- `sender_public_key` (required): contributor wallet public key from Freighter

Success response (`200`):

```json
{
  "unsigned_xdr": "AAAAAgAAA...",
  "prepare_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "conversion_quote": null,
  "sender_public_key": "G...",
  "network_passphrase": "Test SDF Network ; September 2015",
  "network_name": "TESTNET"
}
```

`prepare_token` is short-lived and must be returned with the signed XDR to `/api/contributions/submit-signed`.

Errors:

- `400` missing fields / invalid Stellar public key / unsupported asset
- `404` campaign not found or not active
- `422` no conversion path found for requested asset pair

### `POST /api/contributions/submit-signed`

Submit a Freighter-signed contribution transaction after backend validation.

Body:

- `prepare_token` (required): opaque token returned by `/prepare`
- `signed_xdr` (required): transaction signed in Freighter

Success response (`202`):

```json
{
  "tx_hash": "c8d6...",
  "stellar_transaction_id": "0f3f...",
  "message": "Transaction submitted",
  "conversion_quote": null
}
```

Validation performed before submission:

- signed transaction source account must match `sender_public_key`
- signed transaction body hash must match the prepared unsigned XDR exactly
- signed transaction must contain a valid signature for the contributor public key

Errors:

- `400` missing fields / invalid prepare token
- `403` prepare token belongs to a different authenticated user
- `422` signed XDR does not match the prepared transaction
- `502` Stellar rejected the signed transaction

### `GET /api/anchor/info`

Returns the configured fiat on-ramp anchors and the CrowdPay asset codes currently enabled on Stellar.

### `POST /api/anchor/deposits/start`

Authenticated. Starts a SEP-24 hosted deposit session for the chosen anchor after backend SEP-10 authentication.

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign should ultimately receive
- `anchor_id` (required): anchor identifier from `/api/anchor/info`

Success response includes:

- anchor session `id`
- `interactive_url`
- `anchor_transaction_id`
- `anchor_asset` / `anchor_amount`
- `conversion_quote` when the eventual contribution needs a path payment

### `GET /api/anchor/deposits/:id`

Authenticated. Polls the anchor transaction, updates the local anchor session, and once the deposit completes automatically submits the normal Stellar contribution from the user’s custodial wallet.

### Anchor environment configuration

Anchor deposit support requires a configured backend anchor signing wallet and an enabled anchor.
Set `ANCHOR_WALLET_HOME_DOMAIN` and `ANCHOR_WALLET_SIGNING_SECRET` in the backend environment.
MoneyGram anchor support is enabled by default unless `ANCHOR_MONEYGRAM_ENABLED=false`.
Use `ANCHOR_MONEYGRAM_ENV=sandbox|preview|production` to select the MoneyGram deployment.

For a custom anchor, configure `ANCHOR_CUSTOM_ID`, `ANCHOR_CUSTOM_NAME`, `ANCHOR_CUSTOM_HOME_DOMAIN`, `ANCHOR_CUSTOM_WEB_AUTH_ENDPOINT`, `ANCHOR_CUSTOM_SEP24_ENDPOINT`, `ANCHOR_CUSTOM_SIGNING_KEY`, `ANCHOR_CUSTOM_ASSET_CODE`, and `ANCHOR_CUSTOM_ASSET_ISSUER`.

### `GET /api/contributions/campaign/:campaignId`

Fetch indexed contributions with conversion audit fields, newest first.

Query params: `limit` (default 20, max 100) and `cursor` (the `next_cursor` of the previous
page). Cursor pages are index range scans, so deep pages stay fast. `offset` is still accepted
for older clients (the response then echoes `offset` and `next_cursor` is `null`). `total` is
only returned on the first page.

Success response (`200`):

```json
{
  "total": 128,
  "limit": 20,
  "next_cursor": "eyJzIjoiY29udHJpYnV0aW9uc19uZXdlc3QiLCJ2Ijoi...",
  "contributions": [
  {
    "id": "0f3f...",
    "sender_public_key": "G...",
    "amount": "4.5000000",
    "asset": "USDC",
    "payment_type": "path_payment_strict_receive",
    "source_amount": "4.9973210",
    "source_asset": "XLM",
    "conversion_rate": "0.900482150000000",
    "path": ["AQUA"],
    "tx_hash": "c8d6...",
    "created_at": "2026-04-23T08:13:34.392Z"
  }
  ]
}
```

`sender_public_key` and refund fields are only included for admins and campaign members.

### `GET /api/withdrawals/capabilities`

Returns whether the authenticated user may perform **platform** signing/rejection (`can_approve_platform`). If `PLATFORM_APPROVER_USER_ID` is set in the backend environment, only that user’s JWT subject matches; otherwise (dev only) any authenticated user may act as platform for API calls.

### `POST /api/withdrawals/request`

Create a pending withdrawal request (creator only). Verifies multisig on the campaign wallet, ensures the campaign is `active` or `funded`, and rejects if another `pending` withdrawal already exists for the same campaign.

Body:

- `campaign_id` (required)
- `destination_key` (required)
- `amount` (required)

Returns `201` with withdrawal request (`creator_signed=false`, `platform_signed=false`, `status=pending`).

Appends an audit row to `withdrawal_approval_events` with action `requested`.

Errors:

- `403` not the campaign creator
- `409` campaign status not eligible, or duplicate pending withdrawal
- `422` multisig configuration invalid

### `POST /api/withdrawals/:id/approve/creator`

Creator approval step. Signs withdrawal XDR using creator custodial key and marks `creator_signed=true`.

Errors:

- `403` caller is not campaign creator
- `409` request no longer pending, campaign status not `active`/`funded`, or already creator-approved

Logs `creator_signed` in `withdrawal_approval_events`.

### `POST /api/withdrawals/:id/approve/platform`

Platform approval/finalization step. `POST /api/withdrawals/:id/approve` is a deprecated alias. Signs with platform key, validates dual-signature presence, and submits to Stellar.

Errors:

- `403` caller cannot perform platform signature (see `PLATFORM_APPROVER_USER_ID`)
- `409` creator approval missing, campaign status not eligible, or request not pending
- `422` insufficient signatures in XDR
- `502` Stellar rejected the transaction — request is marked `failed` and `submit_failed` is logged

Success:

- marks request as `status=submitted`
- stores Stellar `tx_hash`
- logs `platform_signed` in `withdrawal_approval_events`

### `POST /api/withdrawals/:id/cancel`

Creator-only. Cancels a **pending** request **before** creator signature (`creator_signed=false`). Sets `status=denied` and stores optional `reason` in `denial_reason`. Logs `creator_cancelled`.

### `POST /api/withdrawals/:id/reject`

Platform-only (same rules as platform approve). Rejects a **pending** request **after** creator has signed and **before** platform signature. Sets `status=denied`. Body optional: `{ "reason": "..." }`. Logs `platform_rejected`.

### `GET /api/withdrawals/campaign/:campaignId`

List withdrawal requests for a campaign (`denial_reason` included when denied). **Authorized for campaign creator or configured platform approver only** (others receive `403`).

### `GET /api/withdrawals/:id/events`

`GET /api/withdrawals/:id/audit` is a deprecated alias. Immutable audit timeline for one withdrawal: `action`, `actor_user_id`, `note`, `metadata`, `created_at`. Same authorization as the campaign list endpoint.

### `GET /api/campaigns/:id/embed`

Public, CORS-enabled campaign payload for iframe embeds. The campaign ID is a UUID and must be passed unchanged. Returns campaign title, description, amounts, asset, status, progress percentage, contributor count, and a contribution URL.

The embeddable widget polls this endpoint every 30 seconds. Use `GET /api/campaigns/:id/stream` for live SSE updates.

### `GET /api/campaigns/:id/analytics`

Contribution analytics for the last 30 days, **restricted to the campaign owner or an admin** (others receive `403`). Returns `dailyTotals`, `assetBreakdown`, and `topContributors`. Deleted or unknown campaigns return `404`.

### `GET /api/milestones/campaign/:campaignId`

List milestones for a campaign in display order.

Success response (`200`):

```json
[
  {
    "id": "0f3f...",
    "campaign_id": "4db6...",
    "title": "Prototype delivery",
    "description": "Ship the first production-ready prototype to pilot users.",
    "release_percentage": "25.0000",
    "sort_order": 0,
    "status": "pending",
    "evidence_url": null,
    "destination_key": null,
    "review_note": null,
    "created_at": "2026-04-26T08:13:34.392Z",
    "completed_at": null,
    "approved_at": null,
    "released_at": null
  }
]
```

### `POST /api/milestones/:id/submit`

Creator-only. Submit milestone completion evidence and the payout destination for that release.

Body:

- `evidence_url` (required)
- `destination_key` (required): Stellar public key that will receive the approved release

Errors:

- `403` caller is not the campaign creator
- `409` campaign is not yet in a releaseable state, or milestone is already released
- `400` destination key is invalid

### `POST /api/milestones/:id/release`

Platform-only. `POST /api/milestones/:id/approve` is a deprecated alias. Reviews the submitted milestone, signs the escrow withdrawal using the existing dual-signature flow, submits it to Stellar, records the withdrawal, and advances campaign status to `in_progress` or `completed`.

Body:

- `reason` (optional): review note stored with the milestone and audit trail

Errors:

- `403` caller cannot perform platform approval
- `409` evidence or payout destination is missing, campaign status is not `funded`/`in_progress`, or release already exists
- `422` dual signature requirements were not met
- `502` Stellar rejected the release transaction

### `POST /api/milestones/:id/reject`

Platform-only. Rejects a submitted milestone and stores a required review note.

Body:

- `reason` (required)

## Auditability and traceability

- Every indexed contribution stores:
  - `payment_type` (`payment` vs `path_payment_strict_receive`)
  - destination settlement `amount` and `asset`
  - conversion source `source_amount` and `source_asset` (when applicable)
  - `conversion_rate` (`destination_amount / source_amount`)
  - conversion `path` as JSON
  - immutable Stellar `tx_hash`
- This enables independent reconciliation against Horizon payment records by `tx_hash`.

- Manual fund releases append rows to `withdrawal_approval_events` (`requested`, `creator_signed`, `platform_signed`, `creator_cancelled`, `platform_rejected`, `submit_failed`) with optional `note` and `metadata` JSON for audit and manual review.

- Milestone-based releases reuse the same multisig withdrawal machinery, but the release is triggered from platform approval after the creator has submitted evidence and a payout destination.

- Anchor-assisted contributions persist `anchor_id` and `anchor_transaction_id` on the final `contributions` row for support and reconciliation.

## Ledger monitor health

### `GET /health/ledger`

Public JSON snapshot for operations: Horizon **cursor** row per active campaign wallet (from `ledger_stream_cursors`), in-process **SSE stream state** (`connected`, `reconnecting`, `error`, `not_connected`), last message time, reconnect attempt count, and `stale_stream_no_messages_15m` when a supposedly connected stream has had no SSE traffic for 15 minutes.

The backend also logs a **warning** every 5 minutes if any wallet is in that stale state.

## Test coverage

Route behaviour is covered by the `src/routes/*.test.js` suites (`npm test`). `src/routes/apiDocs.test.js`
checks that the route table above matches the mounted routers.
