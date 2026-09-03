'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate Limiters
 * Centralized so every limiter shares the same response shape and IP
 * resolution (app.js already sets `trust proxy`). Windows/maxes are
 * env-overridable so they can be tuned per deployment without a code change.
 */

const jsonMessage = (message) => ({ success: false, message });

/**
 * General API limiter
 * Applied globally as a backstop against abuse/DoS.
 */
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage('Too many requests from this IP. Please try again later.'),
  skip: (req) => req.path === '/health',
});

/**
 * Authentication limiter
 * Protects login endpoint from brute-force attacks.
 * Keyed by IP + email to avoid blocking an entire office NAT.
 */
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage('Too many login attempts. Please try again after 15 minutes.'),
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`,
});

/**
 * Bulk Import limiter
 * Protects expensive Excel/CSV import endpoints.
 */
const importLimiter = rateLimit({
  windowMs: parseInt(process.env.IMPORT_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.IMPORT_RATE_LIMIT_MAX, 10) || 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage('Too many import requests. Please try again later.'),
});

/**
 * AI Insights limiter
 * Prevents excessive usage of external LLM providers.
 */
const aiLimiter = rateLimit({
  windowMs: parseInt(process.env.AI_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX, 10) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage('Too many AI insight requests. Please try again later.'),
});

/**
 * Heavy Reports / Dashboard limiter
 * Protects expensive analytics and reporting endpoints.
 */
const heavyReportLimiter = rateLimit({
  windowMs: parseInt(process.env.REPORT_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.REPORT_RATE_LIMIT_MAX, 10) || 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage('Too many report requests. Please slow down and try again shortly.'),
});

/**
 * Approval Reminder limiter
 * The Employee-initiated "Remind" action (POST /employee-timesheets/
 * remind-approval) — throttled per Employee (never per IP, so one office
 * NAT can't rate-limit a whole team), so repeated/accidental clicks can
 * never spam the same Manager with duplicate reminder emails. A UX/abuse
 * safeguard, not a security control — the endpoint itself is idempotent
 * (notification-only) regardless.
 */
const reminderLimiter = rateLimit({
  windowMs: parseInt(process.env.REMINDER_RATE_LIMIT_WINDOW_MS, 10) || 5 * 60 * 1000,
  max: parseInt(process.env.REMINDER_RATE_LIMIT_MAX, 10) || 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.employeeId || req.ip}`,
  message: jsonMessage('A reminder was already sent recently. Please wait before sending another.'),
});

module.exports = {
  apiLimiter,
  authLimiter,
  importLimiter,
  aiLimiter,
  heavyReportLimiter,
  reminderLimiter,
};