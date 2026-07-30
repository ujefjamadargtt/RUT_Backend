'use strict';

const authRepository = require('../repositories/authRepository');
const rbacService = require('./rbacService');
const {
  generateTokens,
  verifyRefreshToken,
  REFRESH_TOKEN_EXPIRY,
} = require('../config/jwt');
const logger = require('../utils/logger');
const moment = require('moment-timezone');

/**
 * Parse a JWT expiry string such as "7d", "15m", "1h" into a future Date.
 *
 * @param {string} expiry - e.g. "7d", "15m", "2h", "3600" (seconds as string)
 * @returns {Date}
 */
function expiryToDate(expiry) {
  const units = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const match = String(expiry).match(/^(\d+)([smhdw]?)$/i);

  if (!match) {
    const seconds = parseInt(expiry, 10);
    return moment.tz('Asia/Kolkata').add(seconds, 'seconds').format('YYYY-MM-DDTHH:mm:ssZ');
  }

  const value = parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  const seconds = value * (units[unit] || 1);
  return moment.tz('Asia/Kolkata').add(seconds, 'seconds').format('YYYY-MM-DDTHH:mm:ssZ');
}

/**
 * Strip sensitive fields and return a safe user object for API responses.
 *
 * @param {object} user - Sequelize User instance or plain object.
 * @returns {object}
 */
function sanitiseUser(user) {
  const plain = user.toJSON ? user.toJSON() : { ...user };
  delete plain.password;
  return plain;
}

function serialiseRoles(roles) {
  return roles.map((role) => ({
    id: role.id,
    name: role.role_name,
    permission: role.permission,
    is_original_data_visible: role.is_original_data_visible,
  }));
}

// ─── Auth Service ─────────────────────────────────────────────────────────────

/**
 * Authenticate a user with email + password credentials.
 *
 * Steps:
 *  1. Locate user record including role.
 *  2. Verify account and role are active.
 *  3. Compare submitted password against bcrypt hash.
 *  4. Issue access + refresh tokens.
 *  5. Persist session to user_sessions.
 *  6. Stamp last_login timestamp.
 *
 * @param {string} email
 * @param {string} password     - Plain-text password submitted by the client.
 * @param {string} [ipAddress]  - Client IP for session audit.
 * @param {string} [userAgent]  - User-Agent header value for session audit.
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: string, user: object }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function login(email, password, ipAddress, userAgent) {
  // 1. Find user with password hash included (scope bypasses defaultScope exclusion)
  const user = await authRepository.findUserByEmail(email);

  if (!user) {
    logger.warn('Login attempt with unknown email', { email });
    const err = new Error('Invalid email or password.');
    err.statusCode = 401;
    err.code = 'INVALID_CREDENTIALS';
    err.isOperational = true;
    throw err;
  }

  // 2. Check account status
  if (user.status !== 'active') {
    logger.warn('Login attempt on inactive account', { userId: user.id, email });
    const err = new Error('Your account has been deactivated. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  const activeRolesMap = new Map();

  if (user.role && user.role.status === 'active') {
    activeRolesMap.set(user.role.id, user.role);
  }

  if (Array.isArray(user.roles)) {
    user.roles.forEach((role) => {
      if (role && role.status === 'active') {
        activeRolesMap.set(role.id, role);
      }
    });
  }

  const activeRoles = Array.from(activeRolesMap.values());

  if (activeRoles.length === 0) {
    logger.warn('Login attempt with no active roles', {
      userId: user.id,
      primaryRoleId: user.role_id,
      activeRoleIds: [],
    });
    const err = new Error('No active role is assigned to your account. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ROLE_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  // 4. Validate password using the instance method defined on the User model
  const isPasswordValid = await user.validatePassword(password);

  if (!isPasswordValid) {
    logger.warn('Login attempt with incorrect password', { userId: user.id });
    const err = new Error('Invalid email or password.');
    err.statusCode = 401;
    err.code = 'INVALID_CREDENTIALS';
    err.isOperational = true;
    throw err;
  }

  // 5. Generate JWT pair
  const { accessToken, refreshToken, expiresIn, refreshExpiresIn } = generateTokens(user);

  // 6. Persist session
  await authRepository.createSession({
    user_id: user.id,
    refresh_token: refreshToken,
    expires_at: expiryToDate(refreshExpiresIn || REFRESH_TOKEN_EXPIRY),
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  // 7. Update last_login (fire-and-forget; non-critical)
  authRepository.updateLastLogin(user.id).catch((updateErr) => {
    logger.error('Failed to update last_login', { userId: user.id, error: updateErr.message });
  });

  logger.info('User logged in successfully', { userId: user.id, email: user.email });

  // Only actively-mapped forms (role_form_mapping.status = true), grouped by
  // module — inactive/unmapped forms are excluded entirely, not just
  // flagged. See rbacService.getActiveFormsForRoles().
  const forms = await rbacService.getActiveFormsForRoles(activeRoles.map((role) => role.id));

  return {
    accessToken,
    refreshToken,
    expiresIn,
    user: sanitiseUser(user),
    roles: serialiseRoles(activeRoles),
    forms,
  };
}

/**
 * Invalidate a user session by removing the refresh token from the store.
 *
 * @param {string} refreshToken
 * @returns {Promise<void>}
 */
async function logout(refreshToken) {
  if (!refreshToken) {
    const err = new Error('Refresh token is required to log out.');
    err.statusCode = 400;
    err.code = 'MISSING_TOKEN';
    err.isOperational = true;
    throw err;
  }

  const deleted = await authRepository.deleteSession(refreshToken);

  if (deleted === 0) {
    // Session already gone or token was never valid — treat as success (idempotent)
    logger.debug('Logout called but no active session found for token');
  } else {
    logger.info('Session deleted on logout');
  }
}

/**
 * Exchange a valid refresh token for a fresh access + refresh token pair.
 *
 * Steps:
 *  1. Cryptographically verify the refresh token signature and expiry.
 *  2. Confirm the session record still exists in the database (not revoked).
 *  3. Confirm the owning user is still active.
 *  4. Delete the old session (token rotation — prevents replay).
 *  5. Issue new token pair and persist new session.
 *
 * @param {string} refreshToken
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: string, user: object }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function refreshToken(refreshToken, ipAddress, userAgent) {
  if (!refreshToken) {
    const err = new Error('Refresh token is required.');
    err.statusCode = 400;
    err.code = 'MISSING_TOKEN';
    err.isOperational = true;
    throw err;
  }

  // 1. Verify JWT signature and expiry
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (jwtErr) {
    const err = new Error('Refresh token is invalid or has expired. Please log in again.');
    err.statusCode = 401;
    err.code = 'INVALID_REFRESH_TOKEN';
    err.isOperational = true;
    throw err;
  }

  // 2. Confirm the session exists and has not been revoked
  const session = await authRepository.findSession(refreshToken);

  if (!session) {
    logger.warn('Refresh token not found in active sessions', { userId: decoded.id });
    const err = new Error('Session not found or has expired. Please log in again.');
    err.statusCode = 401;
    err.code = 'SESSION_NOT_FOUND';
    err.isOperational = true;
    throw err;
  }

  const { user } = session;

  // 3. Verify the user account is still active
  if (!user || user.status !== 'active') {
    logger.warn('Token refresh for inactive user account', { userId: decoded.id });
    await authRepository.deleteSession(refreshToken);
    const err = new Error('Account is inactive. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  // 4. Revoke old session (token rotation)
  await authRepository.deleteSession(refreshToken);

  // 5. Issue new token pair and persist new session
  const tokens = generateTokens(user);

  await authRepository.createSession({
    user_id: user.id,
    refresh_token: tokens.refreshToken,
    expires_at: expiryToDate(tokens.refreshExpiresIn || REFRESH_TOKEN_EXPIRY),
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  logger.info('Token refreshed successfully', { userId: user.id });

  const activeRoles = (user.roles || []).filter((role) => role.status === 'active');
  const forms = await rbacService.getActiveFormsForRoles(activeRoles.map((role) => role.id));

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    user: sanitiseUser(user),
    roles: serialiseRoles(activeRoles),
    forms,
  };
}

/**
 * Retrieve the full profile for the currently authenticated user.
 *
 * @param {number} userId
 * @returns {Promise<object>} Sanitised user object with role and employee data.
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function getProfile(userId) {
  const user = await authRepository.findUserById(userId);

  if (!user) {
    const err = new Error('User not found.');
    err.statusCode = 404;
    err.code = 'USER_NOT_FOUND';
    err.isOperational = true;
    throw err;
  }

  return sanitiseUser(user);
}

module.exports = {
  login,
  logout,
  refreshToken,
  getProfile,
};
