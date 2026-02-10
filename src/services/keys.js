/**
 * Key Management Service
 * 
 * Manages registered agent public keys.
 * Keys must be registered before they can submit cases.
 */

const { query } = require('./database');
const { logger } = require('../utils/logger');

/**
 * Register a new agent key
 */
async function registerKey(publicKey, keyId, agentId = null) {
  // Validate key format
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) {
    throw new Error('Invalid public key format');
  }

  if (!/^[0-9a-f]{16}$/i.test(keyId)) {
    throw new Error('Invalid key ID format');
  }

  try {
    const sql = `
      INSERT INTO agent_keys (public_key, key_id, agent_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (public_key) DO UPDATE SET
        key_id = EXCLUDED.key_id,
        agent_id = COALESCE(EXCLUDED.agent_id, agent_keys.agent_id),
        last_used_at = NOW()
      RETURNING *
    `;

    const result = await query(sql, [publicKey.toLowerCase(), keyId.toLowerCase(), agentId]);
    
    logger.info('Key registered', { keyId, agentId });
    
    return result.rows[0];
  } catch (error) {
    logger.error('Key registration error:', error);
    throw error;
  }
}

/**
 * Get registered key by public key
 */
async function getRegisteredKey(publicKey) {
  const sql = `
    SELECT * FROM agent_keys
    WHERE public_key = $1
  `;

  const result = await query(sql, [publicKey.toLowerCase()]);
  return result.rows[0] || null;
}

/**
 * Get key by key ID
 */
async function getKeyById(keyId) {
  const sql = `
    SELECT * FROM agent_keys
    WHERE key_id = $1
  `;

  const result = await query(sql, [keyId.toLowerCase()]);
  return result.rows[0] || null;
}

/**
 * Revoke a key
 */
async function revokeKey(publicKey, reason = null) {
  const sql = `
    UPDATE agent_keys
    SET revoked_at = NOW()
    WHERE public_key = $1
    RETURNING *
  `;

  const result = await query(sql, [publicKey.toLowerCase()]);
  
  if (result.rows.length === 0) {
    throw new Error('Key not found');
  }

  logger.info('Key revoked', { publicKey: publicKey.substring(0, 16), reason });
  
  return result.rows[0];
}

/**
 * List all keys (admin only)
 */
async function listKeys({ includeRevoked = false, limit = 100, offset = 0 } = {}) {
  let sql = `
    SELECT 
      public_key,
      key_id,
      agent_id,
      registered_at,
      revoked_at,
      last_used_at,
      case_count
    FROM agent_keys
  `;

  if (!includeRevoked) {
    sql += ' WHERE revoked_at IS NULL';
  }

  sql += ' ORDER BY registered_at DESC LIMIT $1 OFFSET $2';

  const result = await query(sql, [limit, offset]);
  return result.rows;
}

/**
 * Get key statistics
 */
async function getKeyStats() {
  const sql = `
    SELECT 
      COUNT(*) as total_keys,
      COUNT(*) FILTER (WHERE revoked_at IS NULL) as active_keys,
      COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) as revoked_keys,
      SUM(case_count) as total_cases,
      MAX(last_used_at) as last_activity
    FROM agent_keys
  `;

  const result = await query(sql);
  return result.rows[0];
}

module.exports = {
  registerKey,
  getRegisteredKey,
  getKeyById,
  revokeKey,
  listKeys,
  getKeyStats
};
