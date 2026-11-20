const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal stub so validateEnv can be loaded without real service dependencies.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../services/walletSecrets') {
    return { validateWalletSecretConfig: () => {} };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const { validateEnv } = require('./env');

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'PLATFORM_SECRET_KEY',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of REQUIRED_KEYS) {
    saved[key] = process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of REQUIRED_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

const VALID_ENV = {
  DATABASE_URL: 'postgres://localhost/test',
  JWT_SECRET: 'supersecret',
  PLATFORM_SECRET_KEY: 'platformkey',
  STELLAR_NETWORK: 'testnet',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
};

test('validateEnv passes when all required vars are set', () => {
  withEnv(VALID_ENV, () => {
    assert.doesNotThrow(() => validateEnv());
  });
});

test('whitespace-only JWT_SECRET is treated as missing', () => {
  const originalExit = process.exit;
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('process.exit'); };

  try {
    withEnv({ ...VALID_ENV, JWT_SECRET: '   ' }, () => {
      assert.throws(() => validateEnv(), /process\.exit/);
    });
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});

test('whitespace-only PLATFORM_SECRET_KEY is treated as missing', () => {
  const originalExit = process.exit;
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('process.exit'); };

  try {
    withEnv({ ...VALID_ENV, PLATFORM_SECRET_KEY: '\t' }, () => {
      assert.throws(() => validateEnv(), /process\.exit/);
    });
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});

test('whitespace-only DATABASE_URL is treated as missing', () => {
  const originalExit = process.exit;
  let exitCode;
  process.exit = (code) => { exitCode = code; throw new Error('process.exit'); };

  try {
    withEnv({ ...VALID_ENV, DATABASE_URL: '  \n  ' }, () => {
      assert.throws(() => validateEnv(), /process\.exit/);
    });
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});
