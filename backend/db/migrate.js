require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Historical migrations in explicit dependency order (001_ needs the campaigns
// table, so it runs after 20260401_). Never rename, reorder or append to this list.
const LEGACY_MIGRATIONS = [
  '20260401_users_campaigns_contributions.sql',
  '001_add_campaign_wallet_secrets.sql',
  '20260423_add_contribution_conversion_audit_fields.sql',
  '20260423_withdrawal_approval_audit.sql',
  '20260424_campaign_failure_and_refund_support.sql',
  '20260425_add_password_reset_tokens.sql',
  '20260425_refresh_tokens.sql',
  '20260425_roles_dashboards_and_campaign_updates.sql',
  '20260426_milestone_release_workflow.sql',
  '20260426_platform_fee.sql',
  '20260427_anchor_sep24_deposits.sql',
  '20260428_campaign_cover_search_indexes.sql',
  '20260428_contribution_limits.sql',
  '20260428_creator_kyc.sql',
  '20260428_dispute_resolution.sql',
  '20260428_social_proof_updates.sql',
  '20260429_add_soroban_contract_ids.sql',
  '20260430_admin_moderation.sql',
  '20260529_add_wallet_type.sql',
  '20260601_notifications.sql',
  '20260602_add_campaign_soft_delete.sql',
  '20260602_add_featured_campaigns_198.sql',
  '20260602_campaign_categories.sql',
  '20260602_campaign_refund_mechanism.sql',
  '20260602_campaign_search_vector.sql',
  '20260602_campaign_webhooks.sql',
  '20260610_add_email_verification.sql',
  '20260615_campaign_status_events.sql',
  '20260616_wallet_only_anchor_deposits.sql',
  '20260624_soroban_contract_verification.sql',
  '20260625_campaign_members.sql',
  '20260625_user_wallet_key_history.sql',
  '20260626_anchor_deposit_submission_claim.sql',
  '20260627_milestone_release_claim.sql',
  '20260924_contribution_backfill_audit.sql',
  '20260925_add_token_version.sql',
  '20260925_campaign_status_suspended_check_fix.sql',
  '20260925_invite_email_binding.sql',
  '20260925_super_admin_tier.sql',
  '20260926_refresh_token_family_reuse_detection.sql',
];

// New migrations must be named with the current UTC time: YYYYMMDDHHMMSS_description.sql
const NEW_MIGRATION_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

function orderMigrations(files) {
  const legacySet = new Set(LEGACY_MIGRATIONS);
  const invalid = files.filter((f) => !legacySet.has(f) && !NEW_MIGRATION_PATTERN.test(f));
  if (invalid.length) {
    throw new Error(
      `Invalid migration filename(s): ${invalid.join(', ')}. ` +
        'New migrations must be named YYYYMMDDHHMMSS_description.sql (UTC).'
    );
  }
  const present = new Set(files);
  return [
    ...LEGACY_MIGRATIONS.filter((f) => present.has(f)),
    ...files.filter((f) => !legacySet.has(f)).sort(),
  ];
}

async function migrate() {
  const client = await pool.connect();
  try {
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows: applied } = await client.query(
      'SELECT filename FROM schema_migrations'
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = orderMigrations(
      fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
    );

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[migrate] Already applied: ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // 42P07 = duplicate_table, 42701 = duplicate_column, 42P06 = duplicate_schema
        if (['42P07', '42701', '42P06', '42710'].includes(err.code) || err.message.includes('already exists')) {
          console.log(`[migrate] Schema objects for ${file} already exist; recording as applied.`);
          await client.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
            [file]
          );
        } else {
          throw err;
        }
      }
    }

    console.log(`[migrate] Done. ${count} migration(s) applied.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate] Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
