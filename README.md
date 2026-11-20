# CrowdPay....

[![CI](https://github.com/Savitura/crowdpay/actions/workflows/ci.yml/badge.svg)](https://github.com/Savitura/crowdpay/actions/workflows/ci.yml)

**Blockchain-powered crowdfunding for the internet.**

CrowdPay lets creators, startups, and communities raise funds globally. Each campaign gets its own Stellar multisig wallet. Contributions are tracked on-chain, milestone payouts are governed by Soroban smart contracts, and contributors can deposit fiat via MoneyGram's Stellar anchor.

> **Status**: Active development — testnet only.

---

## How it works

1. Creator launches a campaign with a funding goal, deadline, and optional milestones
2. Contributors send USDC (or any Stellar asset — path payments handle conversion)
3. Funds sit in a campaign escrow wallet; the Soroban contract tracks milestone completion
4. Creator requests withdrawal → platform co-signs → funds released to creator
5. If the campaign fails to hit its goal, contributors can claim refunds

---

## Architecture

```
Browser  ──────────────────────────────────────────────────────────────
  React 18 + Vite │ React Router │ Freighter wallet │ i18next (en, fr)
────────────────────────────────────────────────────────────────────────
                            │ HTTPS
                            ▼
Backend  ──────────────────────────────────────────────────────────────
  Express │ JWT auth │ Winston │ Sentry │ rate-limit │ Swagger docs
  ┌────────────────────────────────────────────────────────────────┐
  │ routes: campaigns · contributions · withdrawals · milestones   │
  │         disputes · users · wallets · notifications · webhooks  │
  │         anchor · admin · api-keys                              │
  └────────────────────────────────────────────────────────────────┘
  ┌────────────────────────────────────────────────────────────────┐
  │ services: stellarService · sorobanService · anchorService      │
  │           ledgerMonitor · reconciliation · contributionService │
  │           emailService · kycProvider · webhookDispatcher       │
  │           walletSecrets · campaignStatusService                │
  └────────────────────────────────────────────────────────────────┘
          │                    │                      │
          ▼                    ▼                      ▼
    PostgreSQL          Stellar Horizon         AWS S3 / R2
    (pgv8/pg)          + Soroban RPC        (campaign images)
                             │
                   MoneyGram SEP-24 Anchor
                   (fiat ↔ USDC rails)
```

---

## Project Structure

```
crowdpay/
├── backend/
│   ├── src/
│   │   ├── config/          # env, database, stellar client, logger, constants
│   │   ├── routes/          # one file per resource (campaigns, contributions, ...)
│   │   ├── services/        # all business logic and third-party integrations
│   │   ├── middleware/      # auth, validation, error handler, request ID
│   │   └── index.js         # Express app entry point
│   └── db/
│       ├── schema.sql       # base schema
│       ├── migrate.js       # migration runner
│       └── migrations/      # date-prefixed SQL files
├── frontend/
│   └── src/
│       ├── pages/           # 18 route-level page components
│       ├── components/      # reusable UI (CampaignCard, ContributeModal, ...)
│       ├── context/         # AuthContext, ThemeContext, ToastContext
│       ├── services/        # typed API client functions
│       ├── locales/         # i18n JSON (en, fr)
│       └── config/          # Stellar/Freighter config
└── contracts/
    └── soroban/             # Rust Soroban contracts (escrow, milestone release)
```

---

## Quick Start

### With Docker (recommended)

```bash
git clone https://github.com/Savitura/crowdpay
cd crowdpay
cp .env.example .env                  # docker compose DB credentials
cp backend/.env.example backend/.env  # backend config (single source of truth)
docker compose up
```

| Service  | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend  | http://localhost:3001 |
| API docs | http://localhost:3001/api/docs |

The database schema is applied automatically. Hot-reload is active for both processes.

### Without Docker

```bash
# Prerequisites: Node.js 20+, PostgreSQL 15+

cd backend && npm install && cp .env.example .env
# Fill in .env (see Environment Variables below)
npm run migrate:fresh

cd ../frontend && npm install

# Two terminals:
cd backend  && npm run dev   # http://localhost:3001
cd frontend && npm run dev   # http://localhost:5173
```

### Environment Variables

[`backend/.env.example`](backend/.env.example) is the single source of truth. It lists every variable the
backend reads, with comments. Its uncommented values are either hard-required (the server refuses to start without
`DATABASE_URL`, `JWT_SECRET`, `API_KEY_PEPPER`, `PLATFORM_SECRET_KEY`, `STELLAR_NETWORK`, `STELLAR_HORIZON_URL`,
`USDC_ISSUER`, and a valid `WALLET_SECRET_LOCAL_KEK` or AWS KMS config) or safe local-development defaults. The
values marked DEV-ONLY are rejected when `NODE_ENV=production` or `STELLAR_NETWORK=mainnet`.

The root [`.env.example`](.env.example) only holds the `POSTGRES_*` credentials used by `docker compose`.

Generate a platform keypair:
```bash
node -e "const {Keypair} = require('@stellar/stellar-sdk'); const kp = Keypair.random(); console.log('Public:', kp.publicKey()); console.log('Secret:', kp.secret());"
```

Fund it on testnet:
```bash
curl "https://friendbot.stellar.org?addr=<PLATFORM_PUBLIC_KEY>"
```

---

## Testing

```bash
cd backend  && npm test       # Node test runner + Supertest
cd frontend && npm test       # Vitest
```

---

## Key Concepts

**Campaign wallet**: Each campaign has a dedicated Stellar account with a 2-of-2 multisig threshold — contributions go directly to it. The platform co-signer key is required for withdrawals.

**Soroban escrow**: The Rust contract at `contracts/soroban/` holds contribution records on-chain. Milestone release calls invoke the contract before the backend builds the withdrawal transaction.

**Anchor deposits**: `anchorService.js` implements SEP-10 (web auth) + SEP-24 (interactive deposit) with MoneyGram. Users can deposit cash or USD and receive USDC in their CrowdPay wallet.

**Reconciliation**: `reconciliation.js` runs periodically to compare `raised_amount` in PostgreSQL against the live Stellar account balance. Discrepancies are logged and resolved.

**Campaign status cron**: `campaignStatusService.js` runs hourly (via `node-cron` in `backend/src/index.js`) to transition active campaigns to `funded` or `failed` when goals or deadlines are met. Set `ENABLE_CAMPAIGN_STATUS_CRON=false` to disable the in-process scheduler (e.g. when using an external cron that calls `POST /api/campaigns/cron/fail-expired` instead). On each transition, `campaignStatusActions.js` sends emails, fires webhooks, creates in-app notifications, logs the change in `campaign_status_events`, and queues contributor refunds for failed campaigns.

---

## Operations

### Database backups & restore

The production PostgreSQL database holds custodial wallet ciphertexts and KYC references, so it is backed up
nightly and protected with point-in-time recovery (PITR). Backups are encrypted at rest (age/GPG) before leaving
the host, retained per the schedule below, and restores are rehearsed every quarter.

| Layer | What | Retention |
|---|---|---|
| Nightly `pg_dump` (custom format, encrypted) | Full logical backup, uploaded to off-host object storage | 30 daily, 12 weekly, 12 monthly |
| WAL archiving (PITR) | Continuous `archive_command` shipping to object storage | 14 days |
| Quarterly restore drill | Restore latest dump + PITR replay into a scratch instance and verify | Evidence recorded in the runbook |

The nightly job runs as the `backup` sidecar in `docker-compose.prod.yml` (see `BACKUP_*` env vars). To take or
restore a backup manually:

```bash
# Nightly dump (encrypted, uploaded)
./scripts/backup.sh

# Restore into a scratch database (never against production)
./scripts/restore.sh --target crowdpay_restore --from latest
```

Full procedures — PITR configuration, encryption key handling, retention policy, and the quarterly restore drill
checklist — live in [`backend/docs/backup_restore.md`](backend/docs/backup_restore.md). **Do not run destructive
migrations without a verified backup taken in the last 24 hours.**

---

## Part of Savitura

- **[Fluxa](https://github.com/Savitura/Fluxa)** — the payment infrastructure layer
- **[SaviTools](https://github.com/Savitura/Savitools)** — developer tools for Stellar builders

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
