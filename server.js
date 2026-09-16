'use strict';

// Force the Node process itself onto UTC, before anything else runs (in
// particular before any Date object is constructed or the pg driver loads).
// `employee_work_logs`/`user_sessions`/`password_reset_otps` etc. store
// `TIMESTAMP` (no time zone) columns; when the process timezone is anything
// other than UTC (e.g. a host defaulting to Asia/Kolkata), node-postgres's
// naive-timestamp parser (postgres-date) falls back to interpreting the
// stored value as PROCESS-LOCAL time instead of UTC, silently shifting every
// created_at/updated_at/expires_at read by that offset. The DB session
// itself already writes in UTC (see src/config/database.js's `timezone`
// option); this line makes the read side agree. IST display conversions are
// unaffected — they already go through moment-timezone with an explicit
// 'Asia/Kolkata' zone (src/helpers/dateHelper.js), which doesn't depend on
// the process's local timezone.
process.env.TZ = 'UTC';

require('dotenv').config();

require('./src/config/validateEnv')();

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = require('./src/app');
const logger = require('./src/utils/logger');
const { sequelize } = require('./src/config/database');
const { runMigrations } = require('./src/database/migrationRunner');
const aiInsightScheduler = require('./src/scheduler/aiInsight.scheduler');

const NODE_ENV = process.env.NODE_ENV || 'development';

// SSL is optional: set SSL_ENABLED=true (with SSL_KEY_PATH/SSL_CERT_PATH) to
// have Node terminate HTTPS directly. Otherwise Node listens on plain HTTP,
// which is the right setup when a reverse proxy/IIS terminates SSL instead.
const SSL_ENABLED = String(process.env.SSL_ENABLED).toLowerCase() === 'true';
const PORT = process.env.PORT || 5000;
const HTTPS_PORT = process.env.HTTPS_PORT || 5443;

console.log(`[startup] NODE_ENV=${NODE_ENV}  SSL_ENABLED=${SSL_ENABLED}`);

function loadSslOptions() {
  const keyPath = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;

  if (!keyPath || !certPath) {
    throw new Error('SSL_ENABLED is true but SSL_KEY_PATH/SSL_CERT_PATH are not set.');
  }

  const options = {
    key: fs.readFileSync(path.resolve(keyPath)),
    cert: fs.readFileSync(path.resolve(certPath)),
  };

  if (process.env.SSL_CA_PATH) {
    options.ca = fs.readFileSync(path.resolve(process.env.SSL_CA_PATH));
  }

  return options;
}

let server;

async function startServer() {
  try {
    await sequelize.authenticate();
    logger.info('Database connection established successfully.');
    console.log('[startup] Database connection OK');

    // Runs once, before anything else touches the database: applies every
    // pending migration in database/migrations/ in chronological order, or
    // exits the process if any migration fails — the app must never start
    // serving requests against a partially migrated schema. See
    // src/database/migrationRunner.js for the full behavior contract.
    // Set SKIP_MIGRATIONS=true to opt out (e.g. a read replica, or a
    // deploy stage that runs migrations as a separate, explicit step).
    if (String(process.env.SKIP_MIGRATIONS).toLowerCase() === 'true') {
      logger.warn('SKIP_MIGRATIONS=true — skipping automatic migrations on startup.');
      console.log('[startup] SKIP_MIGRATIONS=true — skipping automatic migrations.');
    } else {
    await runMigrations(sequelize);
    }

    if (NODE_ENV === 'development') {
      await sequelize.sync({ alter: false });
      logger.info('Database models synchronized.');
    }

    try {
      // await aiInsightScheduler.start();
    } catch (schedulerErr) {
      // Scheduler failures (e.g. a bad cron expression) must never take
      // down the whole API — log and keep starting.
      logger.error('AI Insight scheduler failed to start:', schedulerErr);
      console.error('[startup] WARNING: AI Insight scheduler failed to start:', schedulerErr.message);
    }

    const listenPort = SSL_ENABLED ? HTTPS_PORT : PORT;
    server = SSL_ENABLED
      ? https.createServer(loadSslOptions(), app)
      : http.createServer(app);

    server.listen(listenPort, () => {
      const protocol = SSL_ENABLED ? 'HTTPS' : 'HTTP';
      const msg = `RUT Portal API running on port ${listenPort} [${NODE_ENV}] (${protocol})`;
      logger.info(msg);
      console.log(`[startup] ${msg}`);
    });

    server.on('error', (err) => {
      const msg = err.code === 'EADDRINUSE'
        ? `Port ${listenPort} is already in use.`
        : `Server error: ${err.message}`;
      logger.error(msg);
      console.error(`[startup] ERROR: ${msg}`);
      process.exit(1);
    });

  } catch (err) {
    logger.error('Failed to start server:', err);
    console.error('[startup] FATAL:', err.message);
    process.exit(1);
  }
}

function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed.');
      try {
        await sequelize.close();
        logger.info('Database connection closed.');
      } catch (err) {
        logger.error('Error closing database connection:', err);
      }
      logger.info('Shutdown complete.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  console.error('[runtime] Uncaught Exception:', err.message);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  console.error('[runtime] Unhandled Rejection:', reason);
  gracefulShutdown('unhandledRejection');
});

startServer();
