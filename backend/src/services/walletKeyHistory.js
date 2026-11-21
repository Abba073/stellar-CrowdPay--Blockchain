const db = require('../config/database');

/**
 * Rotate a user's wallet key while keeping every past key mapped to the user, so contribution
 * history and refund lookups keep working. `client` must be inside a transaction if provided.
 */
async function rotateUserWalletKey({ userId, newPublicKey, newSecretEncrypted }, client = db) {
  const { rows } = await client.query(
    'SELECT wallet_public_key FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  if (!rows.length) return null;
  const oldPublicKey = rows[0].wallet_public_key;
  if (oldPublicKey === newPublicKey) return { oldPublicKey, newPublicKey };

  await client.query(
    `INSERT INTO user_wallet_keys (public_key, user_id, retired_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (public_key) DO UPDATE SET retired_at = NOW()`,
    [oldPublicKey, userId]
  );
  await client.query(
    `UPDATE users SET wallet_public_key = $1, wallet_secret_encrypted = COALESCE($2, wallet_secret_encrypted)
     WHERE id = $3`,
    [newPublicKey, newSecretEncrypted || null, userId]
  );
  await client.query(
    `INSERT INTO user_wallet_keys (public_key, user_id) VALUES ($1, $2)
     ON CONFLICT (public_key) DO UPDATE SET retired_at = NULL`,
    [newPublicKey, userId]
  );
  return { oldPublicKey, newPublicKey };
}

module.exports = { rotateUserWalletKey };
