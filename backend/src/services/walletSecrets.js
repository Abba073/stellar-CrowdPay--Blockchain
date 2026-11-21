const crypto = require('crypto');
const https = require('https');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');

const ENVELOPE_PREFIX = 'cpws:v1:';
const LOCAL_PROVIDER = 'local';
const AWS_KMS_PROVIDER = 'aws-kms';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getConfiguredProvider() {
  if (process.env.WALLET_SECRET_PROVIDER) return process.env.WALLET_SECRET_PROVIDER;
  return isProduction() ? AWS_KMS_PROVIDER : LOCAL_PROVIDER;
}

function decodeKeyMaterial(value) {
  const input = String(value || '').trim();
  if (!input) {
    throw new Error('WALLET_SECRET_LOCAL_KEK must be set for local wallet-secret encryption');
  }

  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return Buffer.from(input, 'hex');
  }

  try {
    return Buffer.from(input, 'base64');
  } catch (_err) {
    throw new Error('WALLET_SECRET_LOCAL_KEK must be base64 or hex encoded');
  }
}

function getLocalKek() {
  const key = decodeKeyMaterial(process.env.WALLET_SECRET_LOCAL_KEK);
  if (key.length !== 32) {
    throw new Error('WALLET_SECRET_LOCAL_KEK must decode to exactly 32 bytes');
  }
  return key;
}

function buildEncryptionContext({ userId, walletPublicKey }) {
  const context = {
    app: 'crowdpay',
    entity: 'user-wallet-secret',
  };

  if (userId) context.user_id = String(userId);
  if (walletPublicKey) context.wallet_public_key = String(walletPublicKey);
  return context;
}

function bufferToB64(value) {
  return Buffer.from(value).toString('base64');
}

function b64ToBuffer(value) {
  return Buffer.from(String(value), 'base64');
}

function encodeEnvelope(payload) {
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function parseEnvelope(value) {
  if (typeof value !== 'string' || !value.startsWith(ENVELOPE_PREFIX)) return null;
  const encoded = value.slice(ENVELOPE_PREFIX.length);
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const payload = JSON.parse(decoded);
  if (!payload || payload.kind !== 'wallet-secret-envelope' || payload.v !== 1) {
    throw new Error('Unsupported wallet secret envelope');
  }
  return payload;
}

function isEncryptedWalletSecret(value) {
  try {
    return Boolean(parseEnvelope(value));
  } catch (_err) {
    return false;
  }
}

function isLegacyPlaintextWalletSecret(value) {
  if (typeof value !== 'string' || !value || isEncryptedWalletSecret(value)) return false;
  try {
    Keypair.fromSecret(value);
    return true;
  } catch (_err) {
    return false;
  }
}

function createAesGcmCipher(key, iv, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  return cipher;
}

function createAesGcmDecipher(key, iv, aad, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return decipher;
}

function encryptAesGcm({ plaintext, key, aad }) {
  const iv = crypto.randomBytes(12);
  const cipher = createAesGcmCipher(key, iv, aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertext, tag };
}

function decryptAesGcm({ ciphertext, key, iv, aad, tag }) {
  const decipher = createAesGcmDecipher(key, iv, aad, tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function localEnvelopeEncrypt(secretBuffer, context) {
  const aad = Buffer.from(JSON.stringify(context), 'utf8');
  const dataKey = crypto.randomBytes(32);
  const wrapped = encryptAesGcm({
    plaintext: dataKey,
    key: getLocalKek(),
    aad,
  });
  const sealed = encryptAesGcm({
    plaintext: secretBuffer,
    key: dataKey,
    aad,
  });
  dataKey.fill(0);

  return {
    v: 1,
    kind: 'wallet-secret-envelope',
    provider: LOCAL_PROVIDER,
    algorithm: 'aes-256-gcm',
    context,
    wrapped_key: bufferToB64(wrapped.ciphertext),
    wrapped_key_iv: bufferToB64(wrapped.iv),
    wrapped_key_tag: bufferToB64(wrapped.tag),
    ciphertext: bufferToB64(sealed.ciphertext),
    iv: bufferToB64(sealed.iv),
    tag: bufferToB64(sealed.tag),
  };
}

function localEnvelopeDecrypt(envelope) {
  const aad = Buffer.from(JSON.stringify(envelope.context || {}), 'utf8');
  const dataKey = decryptAesGcm({
    ciphertext: b64ToBuffer(envelope.wrapped_key),
    key: getLocalKek(),
    iv: b64ToBuffer(envelope.wrapped_key_iv),
    aad,
    tag: b64ToBuffer(envelope.wrapped_key_tag),
  });

  try {
    return decryptAesGcm({
      ciphertext: b64ToBuffer(envelope.ciphertext),
      key: dataKey,
      iv: b64ToBuffer(envelope.iv),
      aad,
      tag: b64ToBuffer(envelope.tag),
    });
  } finally {
    dataKey.fill(0);
  }
}

function getAwsCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for WALLET_SECRET_PROVIDER=aws-kms');
  }

  return { accessKeyId, secretAccessKey, sessionToken };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function deriveAwsSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function toAmzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function getAwsKmsHost() {
  return process.env.WALLET_SECRET_KMS_ENDPOINT_HOST || `kms.${process.env.AWS_REGION}.amazonaws.com`;
}

function getAwsKmsPath() {
  return process.env.WALLET_SECRET_KMS_ENDPOINT_PATH || '/';
}

function buildAwsHeaders(target, body) {
  const region = process.env.AWS_REGION;
  const keyId = process.env.WALLET_SECRET_KMS_KEY_ID;
  if (!region || !keyId) {
    throw new Error('AWS_REGION and WALLET_SECRET_KMS_KEY_ID are required for WALLET_SECRET_PROVIDER=aws-kms');
  }

  const host = getAwsKmsHost();
  const path = getAwsKmsPath();
  const { accessKeyId, secretAccessKey, sessionToken } = getAwsCredentials();
  const amzDate = toAmzDate();
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
  };
  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }

  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join('');
  const signedHeaders = sortedHeaderNames.join(';');
  const payloadHash = sha256Hex(body);
  const canonicalRequest = [
    'POST',
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/kms/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveAwsSigningKey(secretAccessKey, dateStamp, region, 'kms');
  const signature = hmac(signingKey, stringToSign, 'hex');
  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return { headers, host, path };
}

function kmsRequest(target, payload) {
  const body = JSON.stringify(payload);
  const { headers, host, path } = buildAwsHeaders(target, body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: 'POST',
        headers: {
          ...headers,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = responseBody ? JSON.parse(responseBody) : {};
          } catch (_err) {
            return reject(new Error(`KMS returned non-JSON response (${res.statusCode})`));
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(parsed);
          }

          const errorMessage = parsed.message || parsed.Message || parsed.__type || `status ${res.statusCode}`;
          return reject(new Error(`KMS request failed: ${errorMessage}`));
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function awsKmsEnvelopeEncrypt(secretBuffer, context) {
  const dataKeyResponse = await kmsRequest('TrentService.GenerateDataKey', {
    KeyId: process.env.WALLET_SECRET_KMS_KEY_ID,
    KeySpec: 'AES_256',
    EncryptionContext: context,
  });

  const dataKey = b64ToBuffer(dataKeyResponse.Plaintext);
  try {
    const aad = Buffer.from(JSON.stringify(context), 'utf8');
    const sealed = encryptAesGcm({
      plaintext: secretBuffer,
      key: dataKey,
      aad,
    });

    return {
      v: 1,
      kind: 'wallet-secret-envelope',
      provider: AWS_KMS_PROVIDER,
      algorithm: 'aes-256-gcm',
      kms_key_id: dataKeyResponse.KeyId || process.env.WALLET_SECRET_KMS_KEY_ID,
      encrypted_data_key: dataKeyResponse.CiphertextBlob,
      context,
      ciphertext: bufferToB64(sealed.ciphertext),
      iv: bufferToB64(sealed.iv),
      tag: bufferToB64(sealed.tag),
    };
  } finally {
    dataKey.fill(0);
  }
}

async function awsKmsEnvelopeDecrypt(envelope) {
  const response = await kmsRequest('TrentService.Decrypt', {
    CiphertextBlob: envelope.encrypted_data_key,
    EncryptionContext: envelope.context,
    KeyId: envelope.kms_key_id,
  });

  const dataKey = b64ToBuffer(response.Plaintext);
  try {
    const aad = Buffer.from(JSON.stringify(envelope.context || {}), 'utf8');
    return decryptAesGcm({
      ciphertext: b64ToBuffer(envelope.ciphertext),
      key: dataKey,
      iv: b64ToBuffer(envelope.iv),
      aad,
      tag: b64ToBuffer(envelope.tag),
    });
  } finally {
    dataKey.fill(0);
  }
}

function validateWalletSecretConfig() {
  const provider = getConfiguredProvider();

  if (isProduction() && provider !== AWS_KMS_PROVIDER) {
    throw new Error('Production requires WALLET_SECRET_PROVIDER=aws-kms');
  }

  if (provider === LOCAL_PROVIDER) {
    getLocalKek();
    return;
  }

  if (provider === AWS_KMS_PROVIDER) {
    if (!process.env.AWS_REGION || !process.env.WALLET_SECRET_KMS_KEY_ID) {
      throw new Error('AWS_REGION and WALLET_SECRET_KMS_KEY_ID are required for WALLET_SECRET_PROVIDER=aws-kms');
    }
    getAwsCredentials();
    return;
  }

  throw new Error(`Unsupported WALLET_SECRET_PROVIDER: ${provider}`);
}

async function encryptWithProvider(secretBuffer, context) {
  const provider = getConfiguredProvider();
  if (provider === LOCAL_PROVIDER) return localEnvelopeEncrypt(secretBuffer, context);
  if (provider === AWS_KMS_PROVIDER) return awsKmsEnvelopeEncrypt(secretBuffer, context);
  throw new Error(`Unsupported WALLET_SECRET_PROVIDER: ${provider}`);
}

async function decryptWithProvider(envelope) {
  if (envelope.provider === LOCAL_PROVIDER) return localEnvelopeDecrypt(envelope);
  if (envelope.provider === AWS_KMS_PROVIDER) return awsKmsEnvelopeDecrypt(envelope);
  throw new Error(`Unsupported wallet secret provider in envelope: ${envelope.provider}`);
}

async function encryptWalletSecret(secret, contextInput = {}) {
  validateWalletSecretConfig();
  if (isEncryptedWalletSecret(secret)) return secret;

  const secretBuffer = Buffer.from(String(secret), 'utf8');
  try {
    const context = buildEncryptionContext(contextInput);
    const envelope = await encryptWithProvider(secretBuffer, context);
    return encodeEnvelope(envelope);
  } finally {
    secretBuffer.fill(0);
  }
}

async function decryptWalletSecretToBuffer(secret, contextInput = {}) {
  if (typeof secret !== 'string' || !secret) {
    throw new Error('Wallet secret is missing');
  }

  const envelope = parseEnvelope(secret);
  if (envelope) {
    const expectedContext = buildEncryptionContext(contextInput);
    const envelopeContext = envelope.context || {};

    if (
      expectedContext.wallet_public_key &&
      envelopeContext.wallet_public_key !== expectedContext.wallet_public_key
    ) {
      throw new Error('Wallet secret context mismatch');
    }

    if (expectedContext.user_id && envelopeContext.user_id && envelopeContext.user_id !== expectedContext.user_id) {
      throw new Error('Wallet secret owner mismatch');
    }

    return decryptWithProvider(envelope);
  }

  if (!isLegacyPlaintextWalletSecret(secret)) {
    throw new Error('Wallet secret has invalid format');
  }

  if (isProduction()) {
    throw new Error('Legacy plaintext wallet secret detected; run npm run rotate-wallet-secrets before production startup');
  }

  return Buffer.from(secret, 'utf8');
}

async function withDecryptedWalletSecret(secret, contextInput, fn) {
  const secretBuffer = await decryptWalletSecretToBuffer(secret, contextInput);
  let plaintextSecret = secretBuffer.toString('utf8');
  try {
    return await fn(plaintextSecret);
  } finally {
    secretBuffer.fill(0);
    plaintextSecret = null;
  }
}

const DEFAULT_ROTATION_BATCH_SIZE = 100;

/**
 * Encrypts `plaintext` for the row and proves the result decrypts back to
 * exactly the same bytes (constant-time compare) before anything is written.
 * Throws if it does not; nothing is returned that has not round-tripped.
 */
async function encryptAndVerify(
  plaintext,
  context,
  { encrypt = encryptWalletSecret, decrypt = decryptWalletSecretToBuffer } = {}
) {
  const ciphertext = await encrypt(plaintext, context);
  const decrypted = await decrypt(ciphertext, context);
  const original = Buffer.from(String(plaintext), 'utf8');
  try {
    if (decrypted.length !== original.length || !crypto.timingSafeEqual(decrypted, original)) {
      throw new Error(`Rotation verification failed for user ${context.userId}: ciphertext does not decrypt to the original secret`);
    }
  } finally {
    decrypted.fill(0);
    original.fill(0);
  }
  return ciphertext;
}

/**
 * Re-encrypts legacy plaintext wallet secrets with the configured provider.
 *
 * Safety properties (a bad rotation would permanently lose custodial keys):
 * - every new ciphertext is decrypted and compared with the original
 *   before it is written; any mismatch aborts the run;
 * - rows are processed in keyset batches of `batchSize`, one transaction
 *   per batch, so a failure rolls back only the current batch;
 * - each rotated row's previous value is copied to wallet_secret_backups
 *   (keyed by `runId`) in the same transaction as its update; this backup
 *   is mandatory and cannot be skipped outside a dry run;
 * - the UPDATE only applies if the row still holds the value that was read.
 *
 * In a dry run the same encrypt + verify happens but nothing is written.
 */
async function rotateLegacyUserWalletSecrets({
  runner = db,
  dryRun = false,
  batchSize = DEFAULT_ROTATION_BATCH_SIZE,
  runId = crypto.randomUUID(),
  onBatch = () => {},
  deps = undefined, // test seam for encryptAndVerify
} = {}) {
  validateWalletSecretConfig();
  const limit = Math.max(1, Math.min(parseInt(batchSize, 10) || DEFAULT_ROTATION_BATCH_SIZE, 1000));
  const result = {
    run_id: dryRun ? null : runId,
    total: 0,
    rotated: 0,
    verified: 0,
    alreadyEncrypted: 0,
    invalid: 0,
    skippedChanged: 0,
    batches: 0,
  };

  let cursor = null;
  for (;;) {
    const params = [];
    let after = '';
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      after = 'WHERE (created_at, id) > ($1::timestamptz, $2::uuid)';
    }
    params.push(limit);
    const { rows } = await runner.query(
      `SELECT id, wallet_public_key, wallet_secret_encrypted, created_at::text AS cursor_created_at
       FROM users
       ${after}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
      params
    );
    if (!rows.length) break;
    result.total += rows.length;
    result.batches += 1;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.cursor_created_at, id: last.id };

    // Encrypt + verify the whole batch before opening a transaction.
    const planned = [];
    for (const row of rows) {
      if (isEncryptedWalletSecret(row.wallet_secret_encrypted)) {
        result.alreadyEncrypted += 1;
        continue;
      }
      if (!isLegacyPlaintextWalletSecret(row.wallet_secret_encrypted)) {
        result.invalid += 1;
        continue;
      }
      const ciphertext = await encryptAndVerify(
        row.wallet_secret_encrypted,
        { userId: row.id, walletPublicKey: row.wallet_public_key },
        deps
      );
      result.verified += 1;
      planned.push({ row, ciphertext });
    }

    if (dryRun || !planned.length) {
      if (dryRun) result.rotated += planned.length;
      onBatch({ batch: result.batches, rows: rows.length, rotated: dryRun ? planned.length : 0 });
      if (rows.length < limit) break;
      continue;
    }

    const client = await runner.connect();
    let rotatedInBatch = 0;
    try {
      await client.query('BEGIN');
      for (const { row, ciphertext } of planned) {
        const { rowCount } = await client.query(
          `UPDATE users SET wallet_secret_encrypted = $1
           WHERE id = $2 AND wallet_secret_encrypted = $3`,
          [ciphertext, row.id, row.wallet_secret_encrypted]
        );
        if (!rowCount) {
          // Changed since it was read (e.g. rotated concurrently); leave it.
          result.skippedChanged += 1;
          continue;
        }
        await client.query(
          `INSERT INTO wallet_secret_backups (run_id, user_id, previous_value, rotated_value)
           VALUES ($1, $2, $3, $4)`,
          [runId, row.id, row.wallet_secret_encrypted, ciphertext]
        );
        rotatedInBatch += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    result.rotated += rotatedInBatch;
    onBatch({ batch: result.batches, rows: rows.length, rotated: rotatedInBatch });
    if (rows.length < limit) break;
  }

  return result;
}

/**
 * Puts back the pre-rotation values recorded for `runId`, but only for rows
 * that still hold the ciphertext that run wrote.
 */
async function restoreWalletSecretBackup(runId, { runner = db } = {}) {
  const { rowCount } = await runner.query(
    `UPDATE users u
        SET wallet_secret_encrypted = b.previous_value
       FROM wallet_secret_backups b
      WHERE b.run_id = $1
        AND b.user_id = u.id
        AND u.wallet_secret_encrypted = b.rotated_value`,
    [runId]
  );
  return { restored: rowCount };
}

/** Deletes a verified run's backup rows (they may contain plaintext secrets). */
async function purgeWalletSecretBackup(runId, { runner = db } = {}) {
  const { rowCount } = await runner.query('DELETE FROM wallet_secret_backups WHERE run_id = $1', [runId]);
  return { purged: rowCount };
}

async function countLegacyPlaintextUserWalletSecrets({ runner = db } = {}) {
  const { rows } = await runner.query('SELECT wallet_secret_encrypted FROM users');
  return rows.reduce(
    (count, row) => count + (isLegacyPlaintextWalletSecret(row.wallet_secret_encrypted) ? 1 : 0),
    0
  );
}

async function assertNoLegacyPlaintextUserWalletSecrets({ runner = db } = {}) {
  const count = await countLegacyPlaintextUserWalletSecrets({ runner });
  if (count > 0) {
    throw new Error(
      `Detected ${count} legacy plaintext wallet secret(s); run npm run rotate-wallet-secrets before production startup`
    );
  }
}

module.exports = {
  assertNoLegacyPlaintextUserWalletSecrets,
  countLegacyPlaintextUserWalletSecrets,
  decryptWalletSecretToBuffer,
  encryptWalletSecret,
  getConfiguredProvider,
  isEncryptedWalletSecret,
  isLegacyPlaintextWalletSecret,
  rotateLegacyUserWalletSecrets,
  restoreWalletSecretBackup,
  purgeWalletSecretBackup,
  validateWalletSecretConfig,
  withDecryptedWalletSecret,
};
