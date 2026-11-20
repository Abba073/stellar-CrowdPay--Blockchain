const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REQUIRED, DEV_ONLY_VALUES } = require('./env');

const BACKEND = path.join(__dirname, '..', '..');
const REPO = path.join(BACKEND, '..');
const BACKEND_EXAMPLE = path.join(BACKEND, '.env.example');
const ROOT_EXAMPLE = path.join(REPO, '.env.example');

// Read by code but intentionally not in .env.example.
const UNDOCUMENTED_ALLOWED = {
  DRY_RUN: 'one-off flag for src/scripts/*, passed on the command line',
  WALLET_ENCRYPTION_KEY: 'legacy walletService used only by the unmounted routes/wallets.js',
};
// Present in backend/.env.example but consumed by containers, not the Node process.
const NON_BACKEND_KEYS = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'];

function parseExample(file) {
  const set = new Map();
  const commented = [];
  const duplicates = [];
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const active = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (active) {
      if (set.has(active[1])) duplicates.push(active[1]);
      set.set(active[1], active[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }
    const optional = line.match(/^#\s*([A-Z][A-Z0-9_]*)=/);
    if (optional) commented.push(optional[1]);
  }
  for (const key of commented) {
    if (set.has(key) || commented.indexOf(key) !== commented.lastIndexOf(key)) duplicates.push(key);
  }
  return { set, commented: new Set(commented), duplicates: [...new Set(duplicates)] };
}

function envVarsReadByBackend() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        for (const [, key] of fs.readFileSync(full, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
          found.add(key);
        }
      }
    }
  };
  walk(path.join(BACKEND, 'src'));
  walk(path.join(BACKEND, 'db'));
  return found;
}

// Boots the real env validation (plus the startup parsing it does not cover)
// in a clean process whose environment is exactly the example file.
function bootWithExample(overrides = {}) {
  const { set } = parseExample(BACKEND_EXAMPLE);
  const env = { PATH: process.env.PATH, ...Object.fromEntries(set), ...overrides };
  const script = `
    require('./src/config/env').validateEnv();
    const { Keypair, StrKey } = require('@stellar/stellar-sdk');
    Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
    if (!StrKey.isValidEd25519PublicKey(process.env.USDC_ISSUER)) throw new Error('bad USDC_ISSUER');
    require('./src/utils/amounts').getPlatformFeeBps();
    new URL(process.env.DATABASE_URL);
    console.log('BOOT_OK');
  `;
  return spawnSync(process.execPath, ['-e', script], { cwd: BACKEND, env, encoding: 'utf8' });
}

test('backend/.env.example has no duplicate keys', () => {
  assert.deepEqual(parseExample(BACKEND_EXAMPLE).duplicates, []);
});

test('backend/.env.example sets every hard-required variable', () => {
  const { set } = parseExample(BACKEND_EXAMPLE);
  const missing = REQUIRED.filter((key) => !set.get(key));
  assert.deepEqual(missing, []);
});

test('REQUIRED and backend/.env.example are in bidirectional parity', () => {
  const { set } = parseExample(BACKEND_EXAMPLE);
  const read = envVarsReadByBackend();

  // Every REQUIRED key must be present and uncommented in the example.
  const missingRequired = REQUIRED.filter((key) => !set.has(key)).sort();
  assert.deepEqual(missingRequired, [], 'REQUIRED keys missing from backend/.env.example');

  // Every active key in the example must be REQUIRED, a documented optional
  // (read by the backend or consumed by containers), never an unknown key.
  const unexpected = [...set.keys()]
    .filter((key) => !REQUIRED.includes(key) && !read.has(key) && !NON_BACKEND_KEYS.includes(key))
    .sort();
  assert.deepEqual(unexpected, [], 'backend/.env.example documents keys the backend neither requires nor reads');
});

test('backend/.env.example round-trips through startup validation', () => {
  const result = bootWithExample();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BOOT_OK/);
});

test('published dev-only values are refused in production and on mainnet', () => {
  const { set } = parseExample(BACKEND_EXAMPLE);
  for (const [key, value] of Object.entries(DEV_ONLY_VALUES)) {
    assert.equal(set.get(key), value, `${key} in .env.example must match DEV_ONLY_VALUES in env.js`);
  }

  for (const overrides of [{ NODE_ENV: 'production' }, { STELLAR_NETWORK: 'mainnet' }]) {
    const result = bootWithExample(overrides);
    assert.equal(result.status, 1, `expected refusal with ${JSON.stringify(overrides)}`);
    for (const key of Object.keys(DEV_ONLY_VALUES)) {
      assert.match(result.stderr, new RegExp(`- ${key}`));
    }
  }
});

test('every variable the backend reads is documented in backend/.env.example', () => {
  const { set, commented } = parseExample(BACKEND_EXAMPLE);
  const undocumented = [...envVarsReadByBackend()]
    .filter((key) => !set.has(key) && !commented.has(key) && !UNDOCUMENTED_ALLOWED[key])
    .sort();
  assert.deepEqual(undocumented, []);
});

test('backend/.env.example documents no variables the backend ignores', () => {
  const { set, commented } = parseExample(BACKEND_EXAMPLE);
  const read = envVarsReadByBackend();
  const stale = [...set.keys(), ...commented]
    .filter((key) => !read.has(key) && !NON_BACKEND_KEYS.includes(key))
    .sort();
  assert.deepEqual(stale, []);
});

test('STELLAR_NETWORK example value is one the code recognises', () => {
  const { set } = parseExample(BACKEND_EXAMPLE);
  assert.ok(['testnet', 'mainnet'].includes(set.get('STELLAR_NETWORK')));
});

test('root .env.example only carries docker compose DB credentials and defers to the backend file', () => {
  const root = parseExample(ROOT_EXAMPLE);
  assert.deepEqual(root.duplicates, []);
  assert.deepEqual([...root.set.keys()].sort(), [...NON_BACKEND_KEYS].sort());
  assert.deepEqual([...root.commented], []);
  assert.match(fs.readFileSync(ROOT_EXAMPLE, 'utf8'), /backend\/\.env\.example/);

  // The root file must not duplicate any REQUIRED backend variable; those live
  // in backend/.env.example only.
  const leaked = REQUIRED.filter((key) => root.set.has(key) || root.commented.has(key)).sort();
  assert.deepEqual(leaked, [], 'REQUIRED backend vars must not appear in the root .env.example');
});

test('root and backend examples agree on database credentials', () => {
  const root = parseExample(ROOT_EXAMPLE).set;
  const backend = parseExample(BACKEND_EXAMPLE).set;
  for (const key of NON_BACKEND_KEYS) {
    assert.equal(backend.get(key), root.get(key), `${key} differs between the two examples`);
  }
  const url = new URL(backend.get('DATABASE_URL'));
  assert.equal(decodeURIComponent(url.username), root.get('POSTGRES_USER'));
  assert.equal(decodeURIComponent(url.password), root.get('POSTGRES_PASSWORD'));
  assert.equal(url.pathname.slice(1), root.get('POSTGRES_DB'));
});

test('docker-compose.yml only interpolates variables defined in the root .env.example', () => {
  const root = parseExample(ROOT_EXAMPLE).set;
  const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');
  const used = [...compose.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)].map(([, key]) => key);
  assert.ok(used.length > 0);
  assert.deepEqual([...new Set(used)].filter((key) => !root.has(key)), []);
});
