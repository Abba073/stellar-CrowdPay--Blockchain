const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = './walletSecrets';
const VALID_SECRET = 'SD4P6WLGL222ADEXEIAPJAW37RLGXOB5OEESXLQLVJFOQQIJHSEMINS3';
const VALID_SECRET_2 = 'SCFNUJWAKVOHW2MT5Q3I3NQGU3GQVE3V5GDFCXH6MBPCBY3ADLPQ6C7D';

test('encryptWalletSecret stores an envelope and decrypts back with local provider', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.WALLET_SECRET_PROVIDER = 'local';
  process.env.WALLET_SECRET_LOCAL_KEK = Buffer.alloc(32, 7).toString('base64');

  delete require.cache[require.resolve(MODULE_PATH)];
  const walletSecrets = require(MODULE_PATH);

  const encrypted = await walletSecrets.encryptWalletSecret(VALID_SECRET, {
    userId: 'user-1',
    walletPublicKey: 'GABC123',
  });

  assert.match(encrypted, /^cpws:v1:/);
  assert.notEqual(encrypted, VALID_SECRET);
  assert.equal(walletSecrets.isEncryptedWalletSecret(encrypted), true);

  const decrypted = await walletSecrets.withDecryptedWalletSecret(
    encrypted,
    { userId: 'user-1', walletPublicKey: 'GABC123' },
    async (secret) => secret
  );

  assert.equal(decrypted, VALID_SECRET);

  t.after(() => {
    delete process.env.WALLET_SECRET_PROVIDER;
    delete process.env.WALLET_SECRET_LOCAL_KEK;
  });
});

// ---- rotation ------------------------------------------------------------------

const UID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function loadRotation() {
  process.env.NODE_ENV = 'test';
  process.env.WALLET_SECRET_PROVIDER = 'local';
  process.env.WALLET_SECRET_LOCAL_KEK = Buffer.alloc(32, 9).toString('base64');
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

/** Fake pool: keyset-pages `users`, applies guarded UPDATEs, records backups. */
function rotationRunner(users) {
  const log = [];
  const backups = [];
  const exec = (who) => async (text, params) => {
    log.push({ who, text, params });
    if (text.includes('FROM users')) {
      const limit = params[params.length - 1];
      const start = params.length === 3 ? users.findIndex((u) => u.id === params[1]) + 1 : 0;
      return { rows: users.slice(start, start + limit).map((u) => ({ ...u, cursor_created_at: `t-${u.id}` })) };
    }
    if (text.startsWith('UPDATE users SET wallet_secret_encrypted')) {
      const user = users.find((u) => u.id === params[1]);
      if (!user || user.wallet_secret_encrypted !== params[2]) return { rowCount: 0, rows: [] };
      user.wallet_secret_encrypted = params[0];
      return { rowCount: 1, rows: [] };
    }
    if (text.includes('INSERT INTO wallet_secret_backups')) {
      backups.push(params);
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  };
  return {
    log,
    backups,
    query: exec('pool'),
    connect: async () => ({ query: exec('client'), release() {} }),
  };
}

test('rotateLegacyUserWalletSecrets encrypts only plaintext rows, verifies, and backs up in the same transaction', async (t) => {
  const walletSecrets = loadRotation();
  t.after(() => {
    delete process.env.WALLET_SECRET_PROVIDER;
    delete process.env.WALLET_SECRET_LOCAL_KEK;
  });
  const existing = await walletSecrets.encryptWalletSecret(VALID_SECRET_2, { userId: UID(2), walletPublicKey: 'GDEF456' });
  const users = [
    { id: UID(1), wallet_public_key: 'GABC123', wallet_secret_encrypted: VALID_SECRET },
    { id: UID(2), wallet_public_key: 'GDEF456', wallet_secret_encrypted: existing },
  ];
  const runner = rotationRunner(users);

  const result = await walletSecrets.rotateLegacyUserWalletSecrets({ runner, runId: UID(99) });

  assert.deepEqual(
    { total: result.total, rotated: result.rotated, verified: result.verified, alreadyEncrypted: result.alreadyEncrypted, invalid: result.invalid },
    { total: 2, rotated: 1, verified: 1, alreadyEncrypted: 1, invalid: 0 }
  );
  assert.equal(result.run_id, UID(99));
  assert.match(users[0].wallet_secret_encrypted, /^cpws:v1:/);
  assert.equal(users[1].wallet_secret_encrypted, existing, 'already-encrypted row untouched');

  // The stored ciphertext really decrypts to the original secret.
  const roundTrip = await walletSecrets.withDecryptedWalletSecret(
    users[0].wallet_secret_encrypted,
    { userId: UID(1), walletPublicKey: 'GABC123' },
    async (s) => s
  );
  assert.equal(roundTrip, VALID_SECRET);

  // Backup of the previous value, written by the same client between BEGIN and COMMIT.
  assert.deepEqual(runner.backups, [[UID(99), UID(1), VALID_SECRET, users[0].wallet_secret_encrypted]]);
  const clientOps = runner.log.filter((l) => l.who === 'client').map((l) => l.text.split(/\s/)[0]);
  assert.deepEqual(clientOps, ['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
  // The UPDATE is guarded on the value that was read.
  const update = runner.log.find((l) => l.text.startsWith('UPDATE users'));
  assert.match(update.text, /AND wallet_secret_encrypted = \$3/);
});

test('rotation commits in keyset batches, one transaction each', async () => {
  const walletSecrets = loadRotation();
  const users = [1, 2, 3].map((n) => ({ id: UID(n), wallet_public_key: `G${n}`, wallet_secret_encrypted: VALID_SECRET }));
  const runner = rotationRunner(users);
  const result = await walletSecrets.rotateLegacyUserWalletSecrets({ runner, batchSize: 2 });
  assert.equal(result.rotated, 3);
  assert.equal(result.batches, 2);
  assert.equal(runner.log.filter((l) => l.text === 'COMMIT').length, 2);
  const pages = runner.log.filter((l) => l.text.includes('FROM users')).map((l) => l.params);
  assert.deepEqual(pages[0], [2]);
  assert.deepEqual(pages[1], [`t-${UID(2)}`, UID(2), 2]);
});

test('dry run encrypts and verifies but writes nothing', async () => {
  const walletSecrets = loadRotation();
  const users = [{ id: UID(1), wallet_public_key: 'G1', wallet_secret_encrypted: VALID_SECRET }];
  const runner = rotationRunner(users);
  let connected = false;
  runner.connect = async () => {
    connected = true;
    throw new Error('should not connect');
  };
  const result = await walletSecrets.rotateLegacyUserWalletSecrets({ runner, dryRun: true });
  assert.equal(result.rotated, 1);
  assert.equal(result.verified, 1);
  assert.equal(result.run_id, null);
  assert.equal(connected, false);
  assert.equal(users[0].wallet_secret_encrypted, VALID_SECRET);
});

test('a ciphertext that does not decrypt to the original aborts before any write', async () => {
  const walletSecrets = loadRotation();
  const users = [{ id: UID(1), wallet_public_key: 'G1', wallet_secret_encrypted: VALID_SECRET }];
  const runner = rotationRunner(users);
  const corrupt = {
    // Simulates a buggy provider: returns a ciphertext of a different secret.
    encrypt: (_secret, ctx) => walletSecrets.encryptWalletSecret(VALID_SECRET_2, ctx),
  };
  await assert.rejects(
    walletSecrets.rotateLegacyUserWalletSecrets({ runner, deps: corrupt }),
    /verification failed/
  );
  assert.equal(users[0].wallet_secret_encrypted, VALID_SECRET);
  assert.equal(runner.log.filter((l) => l.who === 'client').length, 0);
  assert.equal(runner.backups.length, 0);
});

test('a row changed since it was read is skipped, not overwritten', async () => {
  const walletSecrets = loadRotation();
  const users = [{ id: UID(1), wallet_public_key: 'G1', wallet_secret_encrypted: VALID_SECRET }];
  const runner = rotationRunner(users);
  const query = runner.query;
  runner.query = async (text, params) => {
    const res = await query(text, params);
    if (text.includes('FROM users')) users[0].wallet_secret_encrypted = 'cpws:v1:rotated-elsewhere';
    return res;
  };
  const result = await walletSecrets.rotateLegacyUserWalletSecrets({ runner });
  assert.equal(result.rotated, 0);
  assert.equal(result.skippedChanged, 1);
  assert.equal(users[0].wallet_secret_encrypted, 'cpws:v1:rotated-elsewhere');
  assert.equal(runner.backups.length, 0);
});

test('restore and purge only touch the given run', async () => {
  const walletSecrets = loadRotation();
  const seen = [];
  const runner = { query: async (text, params) => (seen.push({ text, params }), { rowCount: 3 }) };
  assert.deepEqual(await walletSecrets.restoreWalletSecretBackup(UID(5), { runner }), { restored: 3 });
  assert.match(seen[0].text, /b\.run_id = \$1[\s\S]*u\.wallet_secret_encrypted = b\.rotated_value/);
  assert.deepEqual(await walletSecrets.purgeWalletSecretBackup(UID(5), { runner }), { purged: 3 });
  assert.deepEqual(seen[1].params, [UID(5)]);
});

test('rotate-wallet-secrets CLI flags', () => {
  const { parseArgs } = require('../scripts/rotateWalletSecrets');
  assert.equal(parseArgs([], {}).dryRun, false);
  assert.equal(parseArgs([], { DRY_RUN: '1' }).dryRun, true);
  assert.equal(parseArgs(['--dry-run', '--batch-size=50'], {}).batchSize, 50);
  assert.equal(parseArgs([`--restore=${UID(1)}`], {}).restore, UID(1));
  assert.throws(() => parseArgs(['--restore=nope'], {}), /run_id/);
  assert.throws(() => parseArgs(['--force'], {}), /Unknown option/);
});
