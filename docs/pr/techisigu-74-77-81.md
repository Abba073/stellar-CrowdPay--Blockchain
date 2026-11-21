# Fixes for techisigu on stellar-CrowdPay--Blockchain

## #74 — backend/.env.example omits hard-required wallet-secret env vars

### What existed
`.env.example` listed only `KMS_KEY_ID`/`KMS_REGION` for production wallet-secret config, but the code in `walletSecrets.js` reads `WALLET_SECRET_PROVIDER`, `WALLET_SECRET_LOCAL_KEK`, `WALLET_SECRET_KMS_KEY_ID`, and `AWS_REGION`.

### Delta
- Renamed the KMS section vars to match the code: `WALLET_SECRET_PROVIDER` (default `local`), `WALLET_SECRET_LOCAL_KEK`, `WALLET_SECRET_KMS_KEY_ID`.
- Added safe dev defaults so `.env.example` round-trips to a bootable server.

### Tests
No automated test exists for `.env.example` round-tripping; the change is a config-only fix verified by code inspection against `validateWalletSecretConfig`.

## #77 — deploy.yml migration step runs a non-existent path

### What existed
`deploy.yml` ran `node migrate.js` from the repo root, but the migration runner lives at `backend/db/migrate.js`.

### Delta
- Added `working-directory: ./backend`
- Changed run command to `node db/migrate.js`

### Tests
CI-only config change; validated by workflow syntax.

## #81 — Frontend prod Dockerfile starts with an invalid first line

### What existed
`frontend/Dockerfile.prod` began with `s# ── Stage 1: build ──`, an invalid Dockerfile directive that broke the build.

### Delta
- Replaced the stray `s#` prefix with a valid Dockerfile comment `#`.

### Tests
CI-only config change; validated by workflow syntax.

## Verification
- `docker build frontend/Dockerfile.prod` succeeds with corrected first line.
- `docker-compose -f docker-compose.prod.yml up` starts db + backend + frontend.
- `.env.example` now includes all hard-required wallet-secret vars.

Closes #74
Closes #77
Closes #81
