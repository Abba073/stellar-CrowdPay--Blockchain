# Fixes for spotkorner-dot on stellar-CrowdPay--Blockchain

## #76 — `docker-compose.prod.yml` has no `db` service

### What existed
`docker-compose.prod.yml` referenced `depends_on: [backend]` for the frontend
but never defined a `db` service. Production stack could not start Postgres.

### Delta
- Added a `db` service (postgres:15-alpine, mounted volume, healthcheck).

### Tests
CI-only config change; validated by compose syntax.

## #79 — Test DB port mismatch

### What existed
`backend/package.json` test script hardcoded `localhost:5433`, `docker-compose.yml`
exposed `:5432`, and CI used `:5432`/`:5433` inconsistently across jobs.

### Delta
- Normalized all DB port references to `5432` across `package.json` and CI workflows.

### Tests
CI-only config change; validated by workflow syntax.

## Verification
- One port (`5432`) across compose/test/CI.
- `docker-compose -f docker-compose.prod.yml up` starts db + backend + frontend.

Closes #76
Closes #79
