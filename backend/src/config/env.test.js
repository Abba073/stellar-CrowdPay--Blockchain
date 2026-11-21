const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { STELLAR_NETWORKS } = require('./env');

const BACKEND = path.join(__dirname, '..', '..');

// A minimal, valid testnet environment (values match the npm test script).
const BASE_ENV = {
  PATH: process.env.PATH,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/crowdpay',
  JWT_SECRET: 'testsecret',
  API_KEY_PEPPER: 'test-api-key-pepper',
  PLATFORM_SECRET_KEY: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
  STELLAR_NETWORK: 'testnet',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  WALLET_SECRET_LOCAL_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

// validateEnv() calls process.exit on failure, so run it in a child process.
function runValidateEnv(overrides = {}) {
  const script = "require('./src/config/env').validateEnv(); console.log('ENV_OK');";
  return spawnSync(process.execPath, ['-e', script], {
    cwd: BACKEND,
    env: { ...BASE_ENV, ...overrides },
    encoding: 'utf8',
  });
}

test('STELLAR_NETWORK accepts only testnet and mainnet', () => {
  assert.deepEqual(STELLAR_NETWORKS, ['testnet', 'mainnet']);
});

test('validateEnv accepts STELLAR_NETWORK=testnet', () => {
  const result = runValidateEnv({ STELLAR_NETWORK: 'testnet' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ENV_OK/);
});

test('validateEnv accepts STELLAR_NETWORK=mainnet with non-default secrets', () => {
  const result = runValidateEnv({
    STELLAR_NETWORK: 'mainnet',
    STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
    JWT_SECRET: 'a-real-jwt-secret',
    API_KEY_PEPPER: 'a-real-pepper',
    PLATFORM_SECRET_KEY: 'SBPQUZ6G4FZNWFHKUWC5BEYWF6R52E3SEP7R3GWYSM2XTKGF5LNTWW4R',
    WALLET_SECRET_LOCAL_KEK: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ENV_OK/);
});

for (const value of ['MAINNET', 'Mainnet', 'TESTNET', 'main', 'public', 'futurenet', ' mainnet', 'mainnet ']) {
  test(`validateEnv refuses to start with STELLAR_NETWORK=${JSON.stringify(value)}`, () => {
    const result = runValidateEnv({ STELLAR_NETWORK: value });
    assert.equal(result.status, 1, `expected startup failure for ${JSON.stringify(value)}`);
    assert.match(result.stderr, /Cannot start: invalid STELLAR_NETWORK/);
    assert.doesNotMatch(result.stdout, /ENV_OK/);
  });
}
