/**
 * Redis Service
 * 
 * Caching layer for high-traffic reads.
 * Also used for rate limiting and session management.
 */

const Redis = require('ioredis');
const { logger } = require('../utils/logger');

let redis = null;

/**
 * Setup Redis connection
 */
async function setupRedis() {
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    
    // Connection settings
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    
    // Retry strategy
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    }
  });

  redis.on('connect', () => {
    logger.info('Redis connected');
  });

  redis.on('error', (err) => {
    logger.error('Redis error:', err);
  });

  // Test connection
  await redis.ping();

  return redis;
}

/**
 * Get Redis client
 */
function getRedis() {
  if (!redis) {
    throw new Error('Redis not initialized');
  }
  return redis;
}

/**
 * Cache operations
 */
const cache = {
  /**
   * Get cached value
   */
  async get(key) {
    try {
      const value = await redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error('Cache get error:', error);
      return null;
    }
  },

  /**
   * Set cached value
   */
  async set(key, value, ttlSeconds = 300) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error('Cache set error:', error);
      return false;
    }
  },

  /**
   * Delete cached value
   */
  async del(key) {
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      logger.error('Cache delete error:', error);
      return false;
    }
  },

  /**
   * Check if key exists
   */
  async exists(key) {
    try {
      return await redis.exists(key) === 1;
    } catch (error) {
      logger.error('Cache exists error:', error);
      return false;
    }
  }
};

/**
 * Rate limiting with Redis
 */
const rateLimit = {
  /**
   * Check if request is allowed
   */
  async isAllowed(key, limit, windowSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;
    
    try {
      // Remove old entries
      await redis.zremrangebyscore(key, 0, windowStart);
      
      // Count current entries
      const current = await redis.zcard(key);
      
      if (current >= limit) {
        return { allowed: false, remaining: 0 };
      }
      
      // Add current request
      await redis.zadd(key, now, `${now}-${Math.random()}`);
      await redis.expire(key, windowSeconds);
      
      return { allowed: true, remaining: limit - current - 1 };
    } catch (error) {
      logger.error('Rate limit error:', error);
      // Fail open in case of Redis error
      return { allowed: true, remaining: 1 };
    }
  }
};

/**
 * Case deduplication
 */
const deduplication = {
  /**
   * Check if case ID already exists
   */
  async isDuplicate(caseId) {
    const key = `case:${caseId}`;
    const exists = await cache.exists(key);
    
    if (!exists) {
      // Mark as seen (24 hour TTL)
      await cache.set(key, { seen: true }, 86400);
    }
    
    return exists;
  }
};

module.exports = {
  setupRedis,
  getRedis,
  cache,
  rateLimit,
  deduplication
};
