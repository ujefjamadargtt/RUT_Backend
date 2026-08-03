'use strict';

const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const moment = require('moment-timezone');
const dateHelper = require('../helpers/dateHelper');

const LOG_DIR = process.env.LOG_DIR || 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'warn' : 'debug');

// ─── Custom format ────────────────────────────────────────────────────────────
const { combine, timestamp, printf, colorize, errors, splat, json } = format;

const logFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level.toUpperCase()}]: ${stack || message}${metaStr}`;
});

// ─── Daily rotate transport factory ──────────────────────────────────────────
function makeRotateTransport(level, filename) {
  return new DailyRotateFile({
    level,
    dirname: LOG_DIR,
    filename: `${filename}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    format: combine(
      timestamp({ format: () => moment.tz(dateHelper.DEFAULT_TZ).format('YYYY-MM-DD HH:mm:ss') }),
      errors({ stack: true }),
      splat(),
      json(),
    ),
  });
}

// ─── Logger instance ──────────────────────────────────────────────────────────
const logger = createLogger({
  level: LOG_LEVEL,
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6,
  },
  format: combine(
      timestamp({ format: () => moment.tz(dateHelper.DEFAULT_TZ).format('YYYY-MM-DD HH:mm:ss') }),
    errors({ stack: true }),
    splat(),
  ),
  transports: [
    // All logs (info and above)
    makeRotateTransport('info', path.join('application')),
    // Error-only log
    makeRotateTransport('error', path.join('error')),
  ],
  exitOnError: false,
});

// ─── Console transport ────────────────────────────────────────────────────────
// Always attached, in every environment. In production this is the ONLY way
// to see application errors: hosts like Railway capture stdout/stderr as
// their log stream, but have no access to the DailyRotateFile transports
// above, which write to the container's local (often ephemeral) disk. Without
// this, a production 500 logs only to a file nobody can read, and the
// operator is stuck with the generic "An internal server error occurred."
// response and no way to find the real cause.
if (process.env.NODE_ENV === 'production') {
  logger.add(new transports.Console({
    level: LOG_LEVEL,
    format: combine(
      timestamp({ format: () => moment.tz(dateHelper.DEFAULT_TZ).format('YYYY-MM-DD HH:mm:ss') }),
      errors({ stack: true }),
      splat(),
      json(),
    ),
  }));
} else {
  logger.add(new transports.Console({
    level: 'debug',
    format: combine(
      colorize({ all: true }),
      timestamp({ format: 'HH:mm:ss' }),
      errors({ stack: true }),
      splat(),
      logFormat,
    ),
  }));
}

// ─── Stream for Morgan / HTTP logging ────────────────────────────────────────
logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  },
};

module.exports = logger;
