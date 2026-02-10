/**
 * ClawTrial API Server
 * 
 * High-performance, secure API for receiving and displaying AI Courtroom cases.
 * Handles immense traffic through clustering, caching, and database optimization.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const cluster = require('cluster');
const os = require('os');
const { register } = require('prom-client');

const { logger } = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { signatureVerification } = require('./middleware/signatureVerification');
const { caseRoutes } = require('./routes/cases');
const { healthRoutes } = require('./routes/health');
const { metricsRoutes } = require('./routes/metrics');
const { setupDatabase } = require('./services/database');
const { setupRedis } = require('./services/redis');

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === 'true';

// Security configuration
const securityConfig = {
  // Rate limiting
  apiLimiter: rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute per IP
    message: {
      error: 'Too many requests',
      retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: 60
      });
    }
  }),

  // Stricter rate limit for case submissions
  submissionLimiter: rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10, // 10 submissions per minute per IP
    message: {
      error: 'Submission rate limit exceeded',
      retryAfter: 60
    }
  }),

  // CORS configuration
  corsOptions: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [
      'https://clawtrial.com',
      'https://www.clawtrial.com'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Case-Signature', 'X-Agent-Key', 'X-Key-ID'],
    credentials: false,
    maxAge: 86400
  }
};

// Create Express app
function createApp() {
  const app = express();

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"]
      }
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  }));

  app.use(cors(securityConfig.corsOptions));
  app.use(compression());
  app.use(express.json({ limit: '10kb' })); // Small limit - cases are compact
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));
  
  // Prevent parameter pollution
  app.use(hpp());
  
  // Data sanitization
  app.use(mongoSanitize());
  app.use(xss());

  // Request logging
  app.use((req, res, next) => {
    req.requestId = require('uuid').v4();
    req.startTime = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - req.startTime;
      logger.info({
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
    });
    
    next();
  });

  // Health check (no rate limit)
  app.use('/health', healthRoutes);
  
  // Metrics endpoint (Prometheus)
  app.use('/metrics', metricsRoutes);

  // API routes with rate limiting
  app.use('/api/v1/cases', securityConfig.submissionLimiter, signatureVerification, caseRoutes);
  
  // Public read routes (separate rate limit)
  app.use('/api/v1/public', securityConfig.apiLimiter, caseRoutes);

  // Root redirect to website
  app.get('/', (req, res) => {
    res.redirect('https://clawtrial.com');
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      path: req.path
    });
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}

// Start server
async function startServer() {
  try {
    // Initialize database
    await setupDatabase();
    logger.info('Database connected');

    // Initialize Redis
    await setupRedis();
    logger.info('Redis connected');

    const app = createApp();

    app.listen(PORT, () => {
      logger.info(`ClawTrial API server running on port ${PORT} in ${NODE_ENV} mode`);
      logger.info(`Worker ${process.pid} started`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Clustering for high traffic
if (ENABLE_CLUSTERING && cluster.isMaster) {
  const numCPUs = os.cpus().length;
  logger.info(`Master ${process.pid} is running`);
  logger.info(`Starting ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died`);
    logger.info('Starting a new worker...');
    cluster.fork();
  });
} else {
  startServer();
}

module.exports = { createApp };
