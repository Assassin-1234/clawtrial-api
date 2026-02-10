/**
 * Health Check Routes
 * 
 * For load balancers and monitoring systems.
 */

const express = require('express');
const { getPool } = require('../services/database');
const { getRedis } = require('../services/redis');

const router = express.Router();

/**
 * GET /health
 * Basic health check
 */
router.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

/**
 * GET /health/ready
 * Readiness probe (checks dependencies)
 */
router.get('/ready', async (req, res) => {
  try {
    // Check database
    const pool = getPool();
    await pool.query('SELECT 1');

    // Check Redis
    const redis = getRedis();
    await redis.ping();

    res.json({
      status: 'ready',
      checks: {
        database: 'connected',
        cache: 'connected'
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      error: error.message
    });
  }
});

/**
 * GET /health/live
 * Liveness probe
 */
router.get('/live', (req, res) => {
  res.json({
    status: 'alive',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

module.exports = { healthRoutes: router };
