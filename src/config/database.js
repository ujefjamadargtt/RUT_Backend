'use strict';

const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');

const {
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  NODE_ENV,
} = process.env;

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST || 'localhost',
  port: parseInt(DB_PORT, 10) || 5432,
  dialect: 'postgres',
  logging: NODE_ENV === 'development'
    ? (sql, timing) => logger.debug(`[SQL] ${sql}${timing ? ` (${timing}ms)` : ''}`)
    : false,
  benchmark: NODE_ENV === 'development',

  pool: {
    max: 10,          // Maximum number of connections in pool
    min: 2,           // Minimum number of connections in pool
    acquire: 30000,   // Maximum time (ms) to acquire a connection before throwing error
    idle: 10000,      // Time (ms) a connection can be idle before being released
    evict: 1000,      // Time interval (ms) to run eviction checks
  },

  dialectOptions: {
    ssl: NODE_ENV === 'production'
      ? { require: true, rejectUnauthorized: false }
      : false,
    statement_timeout: 30000,       // 30s query timeout
    idle_in_transaction_session_timeout: 60000,
  },

  define: {
    underscored: true,          // Use snake_case column names
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    freezeTableName: true,      // Do not pluralize table names
  },

  // Store timestamps using configured DB timezone (default to India IST)
  timezone: process.env.DB_TIMEZONE || '+05:30',
});

/**
 * Test the database connection.
 * Called at server startup; rejects on failure so the process exits cleanly.
 */
async function connectDatabase() {
  try {
    await sequelize.authenticate();
    logger.info(`Database connected: ${DB_NAME}@${DB_HOST}:${DB_PORT || 5432}`);

    // Ensure the DB session timezone matches the configured timezone so
    // server-side default timestamps (NOW()) use the expected offset.
    const tz = process.env.DB_TIMEZONE || '+05:30';
    try {
      await sequelize.query(`SET TIME ZONE '${tz}';`);
      logger.info(`Database session timezone set to ${tz}`);
    } catch (tzErr) {
      logger.warn('Failed to set DB session timezone:', tzErr.message || tzErr);
    }
    return sequelize;
  } catch (err) {
    logger.error('Unable to connect to the database:', err);
    throw err;
  }
}

/**
 * Detect SERIAL/IDENTITY primary-key sequences that have fallen behind
 * MAX(id) in their table — the condition that causes Postgres to raise
 * "duplicate key value violates unique constraint ..._pkey" on a DEFAULT
 * insert. Read-only; logs a warning per affected table so it's caught at
 * deploy time instead of surfacing as a live 500 on the next INSERT.
 */
async function checkSequenceHealth() {
  const [rows] = await sequelize.query(`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_default LIKE 'nextval(%'
  `);

  for (const { table_name, column_name } of rows) {
    const [[{ seq }]] = await sequelize.query(
      `SELECT pg_get_serial_sequence(:table, :column) AS seq`,
      { replacements: { table: table_name, column: column_name } }
    );
    if (!seq) continue;

    const [[{ max_id }]] = await sequelize.query(
      `SELECT COALESCE(MAX(${column_name}), 0) AS max_id FROM "${table_name}"`
    );
    const [[{ last_value, is_called }]] = await sequelize.query(`SELECT last_value, is_called FROM ${seq}`);
    const nextId = is_called ? Number(last_value) + 1 : Number(last_value);

    if (Number(max_id) >= nextId) {
      logger.error(
        `Sequence desync detected: "${table_name}.${column_name}" has MAX(id)=${max_id} but ${seq} would next return ${nextId}. ` +
        `Run database/migrations/20260729_resync_serial_sequences.sql before this table receives another INSERT.`
      );
    }
  }
}

/**
 * Sync all models with the database.
 * Use { alter: true } in development only — never { force: true } in production.
 *
 * @param {object} [options={}]
 */
async function syncDatabase(options = {}) {
  try {
    await sequelize.sync(options);
    logger.info('Database models synchronized successfully.');
  } catch (err) {
    logger.error('Database sync failed:', err);
    throw err;
  }
}

module.exports = {
  sequelize,
  Sequelize,
  connectDatabase,
  syncDatabase,
  checkSequenceHealth,
};
