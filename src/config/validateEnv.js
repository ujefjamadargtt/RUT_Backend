'use strict';

/**
 * Startup Environment Validation
 * Fails fast with a clear, non-sensitive message if a required env var is
 * missing, rather than letting the app boot into a broken/insecure state
 * (e.g. jwt.verify() silently signing/verifying against `undefined`, or a
 * DB connection attempt failing deep inside Sequelize with a raw driver
 * error). JWT_SECRET/JWT_REFRESH_SECRET are already validated independently
 * by src/config/jwt.js — repeated here so this one call covers everything
 * needed to boot, regardless of which modules happen to be required first.
 *
 * @throws {Error} if any required variable is missing, listing all of them
 *   at once (not just the first) so a misconfigured environment can be
 *   fixed in one pass instead of one failed restart at a time.
 */
function validateEnv() {
  const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. Check your .env file against .env.example.`
    );
  }

  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long.');
  }
  if (process.env.JWT_REFRESH_SECRET.length < 32) {
    throw new Error('JWT_REFRESH_SECRET must be at least 32 characters long.');
  }
}

module.exports = validateEnv;
