/**
 * Database Service
 * 
 * PostgreSQL with connection pooling for high traffic.
 * Optimized for read-heavy workloads (case display).
 */

const { Pool } = require('pg');
const { logger } = require('../utils/logger');

let pool = null;

/**
 * Setup database connection pool
 */
async function setupDatabase() {
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'clawtrial',
    user: process.env.DB_USER || 'clawtrial',
    password: process.env.DB_PASSWORD,

    // Connection pool settings for high traffic
    max: parseInt(process.env.DB_POOL_MAX || '50'),        // Max connections
    min: parseInt(process.env.DB_POOL_MIN || '10'),        // Min connections
    idleTimeoutMillis: 30000,                              // Close idle connections after 30s
    connectionTimeoutMillis: 5000,                         // Connection timeout

    // SSL for production
    ssl: process.env.DB_SSL === 'true' ? {
      rejectUnauthorized: true,
      ca: process.env.DB_SSL_CA
    } : false
  });

  // Handle pool errors
  pool.on('error', (err) => {
    logger.error('Unexpected database pool error:', err);
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query('SELECT NOW()');
    logger.info('Database connection established');
  } finally {
    client.release();
  }

  // Create tables if they don't exist
  await initializeSchema();

  return pool;
}

/**
 * Initialize database schema
 */
async function initializeSchema() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Cases table
    await client.query(`
      CREATE TABLE IF NOT EXISTS cases (
        id SERIAL PRIMARY KEY,
        case_id VARCHAR(64) UNIQUE NOT NULL,
        anonymized_agent_id VARCHAR(64) NOT NULL,
        offense_type VARCHAR(128) NOT NULL,
        offense_name VARCHAR(128) NOT NULL,
        severity VARCHAR(32) NOT NULL,
        verdict VARCHAR(16) NOT NULL CHECK (verdict IN ('GUILTY', 'NOT GUILTY')),
        vote VARCHAR(8) NOT NULL,
        primary_failure TEXT NOT NULL,
        agent_commentary TEXT,
        punishment_summary TEXT,
        proceedings JSONB NOT NULL,
        submitted_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        
        -- Indexes for performance
        CONSTRAINT valid_case_id CHECK (case_id ~ '^case_[0-9]+_[a-z0-9]+$')
      )
    `);

    // Indexes for common queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cases_submitted_at 
      ON cases(submitted_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cases_offense_type 
      ON cases(offense_type)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cases_verdict 
      ON cases(verdict)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cases_severity 
      ON cases(severity)
    `);

    // Registered agent keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_keys (
        id SERIAL PRIMARY KEY,
        public_key VARCHAR(64) UNIQUE NOT NULL,
        key_id VARCHAR(16) NOT NULL,
        agent_id VARCHAR(64),
        registered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        revoked_at TIMESTAMP WITH TIME ZONE,
        last_used_at TIMESTAMP WITH TIME ZONE,
        case_count INTEGER DEFAULT 0
      )
    `);

    // Statistics materialized view (for dashboard)
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS case_statistics AS
      SELECT 
        COUNT(*) as total_cases,
        COUNT(*) FILTER (WHERE verdict = 'GUILTY') as guilty_verdicts,
        COUNT(*) FILTER (WHERE verdict = 'NOT GUILTY') as not_guilty_verdicts,
        COUNT(DISTINCT offense_type) as unique_offenses,
        COUNT(DISTINCT anonymized_agent_id) as unique_agents,
        MAX(submitted_at) as latest_case
      FROM cases
    `);

    // Create index on materialized view
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_case_statistics 
      ON case_statistics (total_cases)
    `);

    await client.query('COMMIT');
    logger.info('Database schema initialized');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get database pool
 */
function getPool() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}

/**
 * Execute query with automatic retry
 */
async function query(text, params, retries = 3) {
  const pool = getPool();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const start = Date.now();
      const result = await pool.query(text, params);
      const duration = Date.now() - start;

      logger.debug({ query: text, duration, rows: result.rowCount });

      return result;
    } catch (error) {
      if (attempt === retries) {
        logger.error('Query failed after retries:', { error, query: text });
        throw error;
      }

      // Exponential backoff
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
    }
  }
}

/**
 * Refresh statistics view
 */
async function refreshStatistics() {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY case_statistics');
  logger.info('Statistics refreshed');
}

module.exports = {
  setupDatabase,
  getPool,
  query,
  refreshStatistics
};
