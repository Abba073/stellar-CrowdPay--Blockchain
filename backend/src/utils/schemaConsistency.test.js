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

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// Extract every table referenced by application SQL: FROM/JOIN (SELECT), UPDATE,
// INSERT INTO and DELETE FROM. Returns lowercased table names.
function referencedTables(src) {
  const sql = stripSqlComments(src);
  const re = /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?"?(\w+)"?/gi;
  const tables = new Set();
  for (const m of sql.matchAll(re)) tables.add(m[1].toLowerCase());
  return tables;
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
    for (const t of referencedTables(src)) {
      if (!tables.has(t)) missing.set(t, path.relative(path.join(__dirname, '..'), file));
    }
  }
  assert.deepEqual([...missing.entries()], [], 'tables referenced by app SQL but never created');
});

test('regression: tables referenced only in SELECT/UPDATE/JOIN are detected', () => {
  const tables = definedTables();
  const fixture = [
    'SELECT * FROM made_up_select_table WHERE id = $1;',
    'UPDATE made_up_update_table SET x = 1;',
    'SELECT a.* FROM users a JOIN made_up_join_table b ON b.user_id = a.id;',
    '-- SELECT * FROM made_up_commented_table;',
    '/* UPDATE made_up_block_commented_table SET x = 1; */',
  ].join('\n');
  const found = referencedTables(fixture);
  for (const t of ['made_up_select_table', 'made_up_update_table', 'made_up_join_table']) {
    assert.ok(found.has(t), `expected ${t} to be extracted`);
    assert.ok(!tables.has(t), `fixture table ${t} must not exist in DDL`);
  }
  assert.ok(!found.has('made_up_commented_table'), 'line comments must be stripped');
  assert.ok(!found.has('made_up_block_commented_table'), 'block comments must be stripped');
});

test('campaign_members migration defines every column the routes use', () => {
  const sql = fs.readFileSync(path.join(dbDir, 'migrations', '20260625_campaign_members.sql'), 'utf8');
  for (const col of ['campaign_id', 'user_id', 'email', 'role', 'invited_by', 'invite_token', 'accepted_at', 'created_at']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `missing column ${col}`);
  }
});
