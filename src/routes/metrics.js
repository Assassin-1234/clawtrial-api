/**
 * Metrics Route
 * 
 * Prometheus-compatible metrics endpoint.
 */

const express = require('express');
const { register, collectDefaultMetrics } = require('prom-client');

const router = express.Router();

// Enable default metrics (memory, CPU, etc.)
collectDefaultMetrics();

/**
 * GET /metrics
 * Prometheus metrics
 */
router.get('/', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

module.exports = { metricsRoutes: router };
