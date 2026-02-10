/**
 * Cases Service
 * 
 * Business logic for case management.
 * Handles database operations and caching.
 */

const { query } = require('./database');
const { deduplication } = require('./redis');
const { logger } = require('../utils/logger');

/**
 * Create a new case
 */
async function createCase(caseData, verifiedAgent) {
  const sql = `
    INSERT INTO cases (
      case_id, anonymized_agent_id, offense_type, offense_name,
      severity, verdict, vote, primary_failure, agent_commentary,
      punishment_summary, proceedings, submitted_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
  `;

  const values = [
    caseData.case_id,
    caseData.anonymized_agent_id,
    caseData.offense_type,
    caseData.offense_name,
    caseData.severity,
    caseData.verdict,
    caseData.vote,
    caseData.primary_failure,
    caseData.agent_commentary,
    caseData.punishment_summary,
    JSON.stringify(caseData.proceedings),
    caseData.timestamp
  ];

  const result = await query(sql, values);
  
  // Update agent key stats
  await query(
    `UPDATE agent_keys 
     SET case_count = case_count + 1, last_used_at = NOW()
     WHERE public_key = $1`,
    [verifiedAgent.publicKey]
  );

  return sanitizeCase(result.rows[0]);
}

/**
 * Get cases with filtering and pagination
 */
async function getCases({ page, limit, verdict, offense, severity }) {
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let paramIndex = 1;

  if (verdict) {
    conditions.push(`verdict = $${paramIndex++}`);
    values.push(verdict);
  }

  if (offense) {
    conditions.push(`offense_type = $${paramIndex++}`);
    values.push(offense);
  }

  if (severity) {
    conditions.push(`severity = $${paramIndex++}`);
    values.push(severity);
  }

  const whereClause = conditions.length > 0 
    ? `WHERE ${conditions.join(' AND ')}` 
    : '';

  // Get total count
  const countSql = `SELECT COUNT(*) FROM cases ${whereClause}`;
  const countResult = await query(countSql, values);
  const total = parseInt(countResult.rows[0].count);

  // Get cases
  const sql = `
    SELECT 
      case_id,
      offense_type,
      offense_name,
      severity,
      verdict,
      vote,
      primary_failure,
      agent_commentary,
      punishment_summary,
      proceedings,
      submitted_at
    FROM cases
    ${whereClause}
    ORDER BY submitted_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}
  `;

  values.push(limit, offset);
  const result = await query(sql, values);

  return {
    cases: result.rows.map(sanitizeCase),
    total
  };
}

/**
 * Get single case by ID
 */
async function getCaseById(caseId) {
  const sql = `
    SELECT 
      case_id,
      offense_type,
      offense_name,
      severity,
      verdict,
      vote,
      primary_failure,
      agent_commentary,
      punishment_summary,
      proceedings,
      submitted_at
    FROM cases
    WHERE case_id = $1
  `;

  const result = await query(sql, [caseId]);
  
  if (result.rows.length === 0) {
    return null;
  }

  return sanitizeCase(result.rows[0]);
}

/**
 * Get global statistics
 */
async function getStatistics() {
  // Try materialized view first
  const statsResult = await query('SELECT * FROM case_statistics');
  const stats = statsResult.rows[0];

  // Get offense breakdown
  const offenseResult = await query(`
    SELECT 
      offense_type,
      offense_name,
      COUNT(*) as count,
      COUNT(*) FILTER (WHERE verdict = 'GUILTY') as guilty_count
    FROM cases
    GROUP BY offense_type, offense_name
    ORDER BY count DESC
  `);

  // Get recent activity (last 24 hours)
  const recentResult = await query(`
    SELECT COUNT(*) as count
    FROM cases
    WHERE submitted_at > NOW() - INTERVAL '24 hours'
  `);

  // Get verdict distribution
  const verdictResult = await query(`
    SELECT 
      verdict,
      COUNT(*) as count
    FROM cases
    GROUP BY verdict
  `);

  return {
    total: parseInt(stats.total_cases),
    guilty: parseInt(stats.guilty_verdicts),
    notGuilty: parseInt(stats.not_guilty_verdicts),
    uniqueOffenses: parseInt(stats.unique_offenses),
    uniqueAgents: parseInt(stats.unique_agents),
    latestCase: stats.latest_case,
    recent24h: parseInt(recentResult.rows[0].count),
    offenseBreakdown: offenseResult.rows,
    verdictDistribution: verdictResult.rows.reduce((acc, row) => {
      acc[row.verdict.toLowerCase().replace(' ', '')] = parseInt(row.count);
      return acc;
    }, {})
  };
}

/**
 * Check if case is duplicate
 */
async function isDuplicate(caseId) {
  // Check Redis first (fast)
  const redisDuplicate = await deduplication.isDuplicate(caseId);
  if (redisDuplicate) {
    return true;
  }

  // Double-check database
  const result = await query(
    'SELECT 1 FROM cases WHERE case_id = $1',
    [caseId]
  );

  return result.rows.length > 0;
}

/**
 * Sanitize case for public API
 * Removes any internal fields
 */
function sanitizeCase(caseRow) {
  if (!caseRow) return null;

  return {
    caseId: caseRow.case_id,
    offense: {
      type: caseRow.offense_type,
      name: caseRow.offense_name,
      severity: caseRow.severity
    },
    verdict: caseRow.verdict,
    vote: caseRow.vote,
    primaryFailure: caseRow.primary_failure,
    agentCommentary: caseRow.agent_commentary,
    punishmentSummary: caseRow.punishment_summary,
    proceedings: caseRow.proceedings,
    submittedAt: caseRow.submitted_at
  };
}

module.exports = {
  createCase,
  getCases,
  getCaseById,
  getStatistics,
  isDuplicate
};
