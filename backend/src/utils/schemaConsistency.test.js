const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dbDir = path.join(__dirname, '..', '..', 'db');

function definedTables() {
  const files = [
    path.join(dbDir, 'schema.sql'),
    ...fs.readdirSync(path.join(dbDir, 'migrations')).map((f) => path.join(dbDir, 'migrations', f)),
  ];
  const tables = new Set();
  for (const f of files) {
    const sql = fs.readFileSync(f, 'utf8');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)) {
      tables.add(m[1].toLowerCase());
    }
  }
  return tables;
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [p] : [];
  });
}

test('every migration-managed table used by application SQL has DDL in a migration or schema.sql', () => {
  const tables = definedTables();
  // Tables the app depends on for membership/multisig features (issue: missing DDL).
  for (const t of ['campaign_members', 'campaigns', 'users', 'milestones', 'withdrawal_requests']) {
    assert.ok(tables.has(t), `no CREATE TABLE found for ${t}`);
  }

  const missing = new Map();
  for (const file of jsFiles(path.join(__dirname, '..'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+(\w+)/g)) {
      const t = m[1].toLowerCase();
      if (!tables.has(t)) missing.set(t, path.relative(path.join(__dirname, '..'), file));
    }
  }
  assert.deepEqual([...missing.entries()], [], 'tables written by app SQL but never created');
});

test('campaign_members migration defines every column the routes use', () => {
  const sql = fs.readFileSync(path.join(dbDir, 'migrations', '20260625_campaign_members.sql'), 'utf8');
  for (const col of ['campaign_id', 'user_id', 'email', 'role', 'invited_by', 'invite_token', 'accepted_at', 'created_at']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `missing column ${col}`);
  }
});
