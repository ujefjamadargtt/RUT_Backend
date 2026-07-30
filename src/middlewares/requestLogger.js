'use strict';

const logger = require('../utils/logger');

/**
 * Morgan-style HTTP request logger built on Winston.
 * Logs: method, URL, status code, response time, content-length, user-id (if authenticated).
 *
 * Skips health-check / favicon requests to avoid noise.
 */
const SKIP_PATHS = new Set(['/health', '/favicon.ico', '/ping']);

const requestLogger = (req, res, next) => {
  // Skip noisy utility paths
  if (SKIP_PATHS.has(req.path)) {
    return next();
  }

  const startTime = process.hrtime.bigint();

  // Capture response finish event
  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startTime;
    const durationMs = Number(durationNs) / 1_000_000;

    const statusCode = res.statusCode;
    const contentLength = res.get('content-length') || '-';

    const logData = {
      method: req.method,
      url: req.originalUrl || req.url,
      status: statusCode,
      responseTime: `${durationMs.toFixed(2)}ms`,
      contentLength,
      ip: req.ip || req.connection?.remoteAddress || '-',
      userAgent: req.get('User-Agent') || '-',
      userId: req.userId || null,
      userRole: req.userRole || null,
      referrer: req.get('Referrer') || req.get('Referer') || '-',
    };

    const message = `${req.method} ${req.originalUrl} ${statusCode} ${durationMs.toFixed(2)}ms`;

    if (statusCode >= 500) {
      logger.error(message, logData);
    } else if (statusCode >= 400) {
      logger.warn(message, logData);
    } else {
      logger.http(message, logData);
    }
  });

  // Also handle aborted requests
  res.on('close', () => {
    if (!res.writableFinished) {
      const durationNs = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNs) / 1_000_000;
      logger.warn(`REQUEST ABORTED ${req.method} ${req.originalUrl} ${durationMs.toFixed(2)}ms`, {
        method: req.method,
        url: req.originalUrl,
        status: 'ABORTED',
        responseTime: `${durationMs.toFixed(2)}ms`,
        userId: req.userId || null,
        ip: req.ip,
      });
    }
  });

  next();
};

module.exports = requestLogger;
