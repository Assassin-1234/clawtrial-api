/**
 * Case Routes
 * 
 * POST /api/v1/cases - Submit new case (requires signature)
 * GET /api/v1/public/cases - List cases (public, cached)
 * GET /api/v1/public/cases/:id - Get single case (public, cached)
 * GET /api/v1/public/statistics - Get statistics (public, cached)
 */

const express = require('express');
const { z } = require('zod');
const { logger } = require('../utils/logger');
const { cache } = require('../services/redis');
const { 
  createCase, 
  getCases, 
  getCaseById, 
  getStatistics,
  isDuplicate 
} = require('../services/cases');

const router = express.Router();

// Jury deliberation schema
const juryDeliberationSchema = z.object({
  role: z.enum(['Pragmatist', 'Pattern Matcher', 'Agent Advocate']),
  vote: z.enum(['GUILTY', 'NOT GUILTY']),
  reasoning: z.string().min(1).max(500)
});

// Proceedings schema
const proceedingsSchema = z.object({
  judge_statement: z.string().min(1).max(1000),
  jury_deliberations: z.array(juryDeliberationSchema).length(3),
  evidence_summary: z.string().min(1).max(1000),
  punishment_detail: z.string().min(1).max(500)
});

// Validation schema
const caseSchema = z.object({
  case_id: z.string().regex(/^case_\d+_[a-z0-9]+$/),
  anonymized_agent_id: z.string().length(32),
  offense_type: z.enum([
    'circular_reference',
    'validation_vampire', 
    'overthinker',
    'goalpost_mover',
    'avoidance_artist',
    'promise_breaker',
    'context_collapser',
    'emergency_fabricator',
    'monopolizer',
    'contrarian',
    'vague_requester',
    'scope_creeper',
    'unreader',
    'interjector',
    'ghost',
    'perfectionist',
    'jargon_juggler',
    'deadline_denier'
  ]),
  offense_name: z.string().min(1).max(64),
  severity: z.enum(['minor', 'moderate', 'severe']),
  verdict: z.enum(['GUILTY', 'NOT GUILTY']),
  vote: z.string().regex(/^\d+-\d+$/),
  primary_failure: z.string().min(1).max(280),
  agent_commentary: z.string().min(1).max(560).optional(),
  punishment_summary: z.string().min(1).max(280).optional(),
  proceedings: proceedingsSchema,
  timestamp: z.string().datetime(),
  schema_version: z.literal('1.0.0')
});

/**
 * POST /api/v1/cases
 * Submit a new case (requires signature verification)
 */
router.post('/', async (req, res) => {
  try {
    // Validate request body
    const validation = caseSchema.safeParse(req.body);
    
    if (!validation.success) {
      logger.warn('Invalid case submission', { 
        errors: validation.error.errors,
        agent: req.verifiedAgent?.keyId 
      });
      
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const caseData = validation.data;

    // Check for duplicate (double-check after signature middleware)
    const duplicate = await isDuplicate(caseData.case_id);
    if (duplicate) {
      return res.status(409).json({
        error: 'Duplicate case',
        message: 'Case ID already exists'
      });
    }

    // Create case
    const newCase = await createCase(caseData, req.verifiedAgent);

    // Invalidate caches
    await cache.del('cases:list:recent');
    await cache.del('cases:stats');

    logger.info('Case created', { 
      caseId: caseData.case_id,
      agentId: req.verifiedAgent.agentId,
      verdict: caseData.verdict
    });

    res.status(201).json({
      success: true,
      case: newCase
    });

  } catch (error) {
    logger.error('Case creation error:', error);
    res.status(500).json({
      error: 'Internal error',
      message: 'Failed to create case'
    });
  }
});

/**
 * GET /api/v1/public/cases
 * List cases with pagination (public, cached)
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const verdict = req.query.verdict;
    const offense = req.query.offense;
    const severity = req.query.severity;

    // Build cache key
    const cacheKey = `cases:list:${page}:${limit}:${verdict || 'all'}:${offense || 'all'}:${severity || 'all'}`;
    
    // Try cache
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Fetch from database
    const result = await getCases({ page, limit, verdict, offense, severity });

    const response = {
      success: true,
      data: result.cases,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit)
      }
    };

    // Cache for 5 minutes
    await cache.set(cacheKey, response, 300);

    res.json(response);

  } catch (error) {
    logger.error('List cases error:', error);
    res.status(500).json({
      error: 'Internal error',
      message: 'Failed to fetch cases'
    });
  }
});

/**
 * GET /api/v1/public/cases/:id
 * Get single case (public, cached)
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `case:${id}`;

    // Try cache
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Fetch from database
    const caseData = await getCaseById(id);

    if (!caseData) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Case not found'
      });
    }

    const response = {
      success: true,
      data: caseData
    };

    // Cache for 1 hour (cases are immutable)
    await cache.set(cacheKey, response, 3600);

    res.json(response);

  } catch (error) {
    logger.error('Get case error:', error);
    res.status(500).json({
      error: 'Internal error',
      message: 'Failed to fetch case'
    });
  }
});

/**
 * GET /api/v1/public/statistics
 * Get global statistics (public, cached)
 */
router.get('/stats/global', async (req, res) => {
  try {
    const cacheKey = 'cases:stats';

    // Try cache
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Fetch from database
    const stats = await getStatistics();

    const response = {
      success: true,
      data: stats
    };

    // Cache for 10 minutes
    await cache.set(cacheKey, response, 600);

    res.json(response);

  } catch (error) {
    logger.error('Get statistics error:', error);
    res.status(500).json({
      error: 'Internal error',
      message: 'Failed to fetch statistics'
    });
  }
});

module.exports = { caseRoutes: router };
