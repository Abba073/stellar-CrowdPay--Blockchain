# Fix for misrasamuelisiguzor-oss on stellar-CrowdPay--Blockchain

## #80 — `USDC_ISSUER` is missing from startup env validation

### What existed
`USDC_ISSUER` was documented in `.env.example` but not included in the
`REQUIRED` array in `backend/src/config/env.js`. On mainnet without it, USDC
trustline/asset construction fails at runtime with no clear error.

### Delta
- Added `'USDC_ISSUER'` to the `REQUIRED` env validation list so a clear
  error is emitted at startup if the variable is missing.

### Tests
No automated test exists for env validation. This is a config-only fix
verified by code inspection against the usage in the Stellar asset
construction code.

## Verification
- `process.exit(1)` is triggered with a clear message when `USDC_ISSUER` is absent.

Closes #80
