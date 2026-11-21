# Backup & Restore Runbook

This runbook covers backup, point-in-time recovery (PITR), encryption, retention, and restore drills for the **production Postgres** that stores custodial wallet ciphertexts and KYC references.

> **Data classification:** The database contains funds-adjacent data (custodial wallet ciphertexts) and PII (KYC references). Backups inherit this classification and **must be encrypted at rest** and access-controlled.

---

## 1. Overview

| Control | Mechanism | Frequency | Retention |
| --- | --- | --- | --- |
| Logical full backup | `pg_dump` (custom format) | Nightly | 30 days |
| Weekly full backup | `pg_dump` (custom format) | Weekly (Sun) | 90 days |
| Monthly full backup | `pg_dump` (custom format) | Monthly (1st) | 12 months |
| Continuous WAL archiving | `archive_command` → object storage | Continuous | 14 days |
| PITR window | Base backup + WAL | Continuous | 14 days |

**RPO:** ≤ 5 minutes (WAL archive interval).
**RTO target:** ≤ 2 hours (restore from latest base backup + WAL replay).

---

## 2. Prerequisites

- PostgreSQL 14+ with `wal_level = replica` (or `logical`).
- An encrypted object-storage bucket (e.g. S3 with SSE-KMS, or equivalent) dedicated to backups.
- A backup encryption key managed by the secrets manager / KMS. **Never** store the key alongside the backups.
- `pg_dump`, `pg_basebackup`, `psql`, `pg_restore`, and `age` (or `gpg`) available on the backup host.
- A dedicated backup role with `REPLICATION` and read access (see §3).

---

## 3. Database roles

Create a least-privilege backup role:

```sql
CREATE ROLE backup_user WITH LOGIN REPLICATION PASSWORD '<from-secrets-manager>';
GRANT CONNECT ON DATABASE appdb TO backup_user;
GRANT USAGE ON SCHEMA public TO backup_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO backup_user;
```

Store the password in the secrets manager; inject it at runtime via environment variable (`PGPASSWORD`), never in scripts or images.

---

## 4. Encryption at rest

All backups are encrypted **before** leaving the database host.

### 4.1 Encryption tooling

Use `age` (preferred) or `gpg`. The recipient/public key lives in the backup job; the private key lives only in the secrets manager and is required for restore.

```bash
# Encrypt a dump
pg_dump ... | age -r "$BACKUP_AGE_RECIPIENT" -o "$OUTFILE.age"

# Decrypt during restore
age -d -i "$BACKUP_AGE_IDENTITY" "$INFILE.age" | pg_restore ...
```

### 4.2 Object storage

- Enable server-side encryption (SSE-KMS) on the backup bucket as defense in depth.
- Enable bucket versioning and object lock (governance mode) to protect against deletion/ransomware.
- Restrict bucket access to the backup role only; enable access logging.

---

## 5. Nightly `pg_dump` backups

### 5.1 Backup script

Place at `/usr/local/bin/pg_backup.sh` on the backup host (or run as a scheduled job/sidecar):

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?}" "${PGDATABASE:?}" "${PGUSER:?}" "${PGPASSWORD:?}"
: "${BACKUP_AGE_RECIPIENT:?}" "${BACKUP_BUCKET:?}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DUMP="$TMP/${PGDATABASE}_${TS}.dump"

# Custom-format dump (supports parallel restore, selective restore)
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --file="$DUMP" \
  "$PGDATABASE"

# Encrypt at rest before upload
age -r "$BACKUP_AGE_RECIPIENT" -o "${DUMP}.age" "$DUMP"
rm -f "$DUMP"

# Upload to encrypted object storage
aws s3 cp "${DUMP}.age" "s3://${BACKUP_BUCKET}/nightly/$(basename "${DUMP}").age" \
  --sse aws:kms

# Verify upload integrity
aws s3api head-object \
  --bucket "$BACKUP_BUCKET" \
  --key "nightly/$(basename "${DUMP}").age" >/dev/null

echo "Backup complete: nightly/$(basename "${DUMP}").age"
```

### 5.2 Scheduling

Run nightly via cron or a container sidecar:

```cron
# Nightly full logical backup at 02:00 UTC
0 2 * * * /usr/local/bin/pg_backup.sh >> /var/log/pg_backup.log 2>&1
```

In `docker-compose.prod.yml`, run the backup as a dedicated sidecar service with its own volume and secrets, not inside the primary DB container.

### 5.3 Verification

After each run, the job must:
1. Confirm the object exists and is non-zero size.
2. Record the dump's `pg_restore --list` output (decrypted) to confirm it is a valid archive.
3. Emit a success/failure metric; alert if no successful backup in 26 hours.

---

## 6. WAL archiving & PITR

### 6.1 `postgresql.conf`

```conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'
archive_timeout = 300          # force a WAL switch every 5 min → bounds RPO
wal_keep_size = 1GB
```

> For object storage, replace `archive_command` with a wrapper that uploads to the encrypted bucket (e.g. `wal-g wal-push %p` or a custom `aws s3 cp` wrapper). Ensure the archive command is idempotent and returns non-zero on failure so Postgres retries.

### 6.2 Base backups

Take a weekly physical base backup for PITR:

```bash
pg_basebackup \
  --pgdata=/backups/base/$(date -u +%Y%m%d) \
  --format=tar \
  --wal-method=stream \
  --checkpoint=fast \
  --compress=9
```

Encrypt and upload the base backup the same way as logical dumps (§4).

### 6.3 PITR window

- Retain WAL segments for **14 days**.
- PITR = latest base backup + replay WAL up to a target timestamp.
- Monitor `pg_stat_archiver`: alert on `failed_count` increasing or `last_archived_time` older than 10 minutes.

---

## 7. Retention policy

| Tier | Kept | Location |
| --- | --- | --- |
| Nightly dumps | 30 days | `s3://<bucket>/nightly/` |
| Weekly dumps | 90 days | `s3://<bucket>/weekly/` |
| Monthly dumps | 12 months | `s3://<bucket>/monthly/` |
| WAL archive | 14 days | `s3://<bucket>/wal/` |
| Base backups | 14 days | `s3://<bucket>/base/` |

Apply lifecycle rules on the bucket to expire objects per the table. Object lock prevents early deletion within the retention window. **Never** shorten retention below the PITR window without a documented change.

---

## 8. Quarterly restore drill

Run at least once per quarter (and after any major schema/migration change). Record results in the ops log.

### 8.1 Procedure

1. **Provision an isolated restore target** (separate host/container, no production network access, no production secrets).
2. **Fetch the latest base backup + required WAL** (or a nightly dump for logical restore).
3. **Decrypt** using the identity from the secrets manager:
   ```bash
   age -d -i "$BACKUP_AGE_IDENTITY" backup.dump.age > backup.dump
   ```
4. **Restore**:
   - Logical: `pg_restore --clean --if-exists --no-owner -d restoredb backup.dump`
   - PITR: restore base backup into `PGDATA`, set `restore_command`, `recovery_target_time`, start Postgres, wait for recovery to complete.
5. **Validate**:
   - Row counts on critical tables (wallets, KYC references) match expectations.
   - Spot-check a sample of wallet ciphertexts decrypt correctly with the application key.
   - Run application smoke tests against the restored instance.
   - Confirm `pg_controldata` / recovery log shows the expected target time.
6. **Measure RTO** (time from start to validated restore) and compare to the 2-hour target.
7. **Tear down** the restore target and securely wipe restored data.
8. **Document** date, backup used, RTO achieved, issues found, and follow-up actions.

### 8.2 Drill checklist

- [ ] Backup decrypted successfully with the current key.
- [ ] Restore completed without errors.
- [ ] Critical table row counts verified.
- [ ] Sample wallet ciphertext decryption verified.
- [ ] Application smoke tests passed.
- [ ] RTO measured and recorded.
- [ ] Restore target destroyed and wiped.
- [ ] Findings filed as follow-up issues.

---

## 9. Key management

- Rotate the backup encryption key annually and on any suspected compromise.
- Keep the previous key available until all backups encrypted with it have expired.
- Store keys in the secrets manager / KMS; never in git, images, or the backup bucket.
- Document key rotation in the ops log.

---

## 10. Monitoring & alerts

Alert on:
- No successful nightly backup in 26 hours.
- `pg_stat_archiver.failed_count` increasing.
- WAL archive lag > 10 minutes.
- Backup object size deviating > 50% from the 7-day average.
- Restore drill overdue (> 100 days since last drill).

---

## 11. Incident: restore during an outage

1. Declare incident and freeze writes to the primary.
2. Identify the last known-good timestamp (before the destructive event).
3. Provision a fresh instance and perform PITR to that timestamp (§8).
4. Validate data integrity (§8.1 step 5).
5. Repoint the application to the restored instance and resume traffic.
6. Preserve the failed instance for post-mortem analysis.
7. File a post-incident review within 5 business days.