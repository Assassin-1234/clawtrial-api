/**
 * Global Error Handler
 * 
 * Catches all errors and returns safe responses.
 * Logs detailed errors internally.
 */

const { logger } = require('../utils/logger');

function errorHandler(err, req, res, next) {
  // Log error details
  logger.error('Request error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.requestId,
    ip: req.ip
  });

  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation error',
      message: isDevelopment ? err.message : 'Invalid request data'
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required'
    });
  }

  if (err.code === '23505') { // PostgreSQL unique violation
    return res.status(409).json({
      error: 'Conflict',
      message: 'Resource already exists'
    });
  }

  // Default error
  res.status(err.status || 500).json({
    error: 'Internal error',
    message: isDevelopment ? err.message : 'Something went wrong'
  });
}

module.exports = { errorHandler };
