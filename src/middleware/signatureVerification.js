/**
 * Ed25519 Signature Verification Middleware
 * 
 * Auto-registers agents on first valid submission.
 * All submissions must be cryptographically signed.
 */

const nacl = require('tweetnacl');
const { logger } = require('../utils/logger');
const { getRegisteredKey, registerKey } = require('../services/keys');

/**
 * Verify Ed25519 signature on case submissions
 */
async function signatureVerification(req, res, next) {
  // Only verify POST requests (submissions)
  if (req.method !== 'POST') {
    return next();
  }

  try {
    const signature = req.headers['x-case-signature'];
    const publicKey = req.headers['x-agent-key'];
    const keyId = req.headers['x-key-id'];

    // Check required headers
    if (!signature || !publicKey || !keyId) {
      logger.warn('Missing signature headers', {
        ip: req.ip,
        headers: req.headers
      });
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Missing signature headers. Required: X-Case-Signature, X-Agent-Key, X-Key-ID'
      });
    }

    // Validate header formats
    if (!/^[0-9a-f]{128}$/i.test(signature)) {
      return res.status(400).json({
        error: 'Invalid signature format',
        message: 'Signature must be 128 hex characters (64 bytes)'
      });
    }

    if (!/^[0-9a-f]{64}$/i.test(publicKey)) {
      return res.status(400).json({
        error: 'Invalid public key format',
        message: 'Public key must be 64 hex characters (32 bytes)'
      });
    }

    // Check if key is registered (auto-register on first valid submission)
    let keyRecord = await getRegisteredKey(publicKey);
    
    if (!keyRecord) {
      // Auto-register new agent on first valid submission
      logger.info('Auto-registering new agent', { 
        publicKey: publicKey.substring(0, 16),
        keyId 
      });
      
      const agentId = `agent_${publicKey.substring(0, 16)}`;
      keyRecord = await registerKey(publicKey, keyId, agentId);
    }

    // Check if key is revoked
    if (keyRecord.revokedAt) {
      logger.warn('Attempt to use revoked key', { 
        publicKey: publicKey.substring(0, 16),
        revokedAt: keyRecord.revokedAt 
      });
      return res.status(403).json({
        error: 'Key revoked',
        message: 'This agent key has been revoked'
      });
    }

    // Build canonical payload
    const payload = req.body;
    const canonicalPayload = canonicalizePayload(payload);

    // Verify signature
    const messageBytes = Buffer.from(canonicalPayload, 'utf8');
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(publicKey, 'hex');

    const isValid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes
    );

    if (!isValid) {
      logger.warn('Invalid signature', {
        publicKey: publicKey.substring(0, 16),
        keyId
      });
      return res.status(403).json({
        error: 'Invalid signature',
        message: 'Case signature verification failed'
      });
    }

    // Check timestamp (prevent replay attacks)
    const caseTimestamp = new Date(payload.timestamp);
    const now = new Date();
    const age = (now - caseTimestamp) / 1000; // seconds

    if (age > 86400) { // 24 hours
      return res.status(400).json({
        error: 'Case expired',
        message: 'Case timestamp is older than 24 hours'
      });
    }

    if (age < -300) { // 5 minutes in future
      return res.status(400).json({
        error: 'Invalid timestamp',
        message: 'Case timestamp is in the future'
      });
    }

    // Check for duplicate case_id (replay protection)
    const { isDuplicate } = require('../services/cases');
    const duplicate = await isDuplicate(payload.case_id);
    if (duplicate) {
      return res.status(409).json({
        error: 'Duplicate case',
        message: 'Case ID already exists'
      });
    }

    // Attach verified agent info to request
    req.verifiedAgent = {
      publicKey,
      keyId,
      agentId: keyRecord.agentId,
      registeredAt: keyRecord.registeredAt
    };

    logger.info('Signature verified', {
      keyId,
      caseId: payload.case_id,
      agentId: keyRecord.agentId
    });

    next();

  } catch (error) {
    logger.error('Signature verification error:', error);
    return res.status(500).json({
      error: 'Verification failed',
      message: 'Internal error during signature verification'
    });
  }
}

/**
 * Create canonical payload string (must match agent-side implementation)
 */
function canonicalizePayload(payload) {
  const signable = {
    case_id: payload.case_id,
    anonymized_agent_id: payload.anonymized_agent_id,
    offense_type: payload.offense_type,
    verdict: payload.verdict,
    vote: payload.vote,
    timestamp: payload.timestamp
  };

  // Deterministic JSON with sorted keys
  return JSON.stringify(signable, Object.keys(signable).sort());
}

module.exports = { signatureVerification, canonicalizePayload };
