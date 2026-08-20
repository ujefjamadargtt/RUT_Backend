'use strict';

const { sequelize } = require('../models');
const authRepository = require('../repositories/authRepository');
const userRepository = require('../repositories/userRepository');
const rbacService = require('./rbacService');
const { generateTokens, verifyRefreshToken, REFRESH_TOKEN_EXPIRY } = require('../config/jwt');
const logger = require('../utils/logger');
const moment = require('moment-timezone');
const { extractIsOriginalDataVisible } = require('../utils/timesheetPublishPolicy');

/**
 * Auth Service — login/logout/refresh/profile/change-password.
 *
 * Login authenticates exclusively against User Master (`users`) — Employees
 * are pure business data now (see database/migrations/
 * 20260842_employees_drop_login_columns.sql); every Employee that needs to
 * log in has a linked User row (users.employee_id) created automatically at
 * Employee-creation time (see employeeService.js). There is no dual-lookup,
 * no loginType disambiguation, and no separate Employee token audience —
 * one identity table, one token shape, for every account tier.
 */

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

/**
 * Shape a user's roles for the login/refresh-token response — the PRIMARY
 * role plus every ADDITIONAL operational role they hold (see
 * database/migrations/20260850_add_user_additional_roles.sql). is_original_data_visible
 * is the user's COMPANY's own companies.is_original_data_visible (see
 * database/migrations/20260808_add_company_original_data_visibility.sql),
 * not a per-role column, so it's stamped identically onto every entry.
 *
 * @param {object} primaryRole
 * @param {object[]} additionalRoles
 * @param {boolean} isOriginalDataVisible - the user's COMPANY's is_original_data_visible
 * @returns {object[]}
 */
function serialiseRoles(primaryRole, additionalRoles, isOriginalDataVisible) {
  if (!primaryRole) return [];
  const roles = [primaryRole, ...(additionalRoles || [])];
  return roles.map((role) => ({
    id: role.id,
    name: role.role_name,
    permission: role.permission,
    hierarchyRank: role.hierarchy_rank,
    is_original_data_visible: isOriginalDataVisible,
  }));
}

/**
 * @returns {Error}
 */
function invalidCredentialsError() {
  const err = new Error('Invalid email or password.');
  err.statusCode = 401;
  err.code = 'INVALID_CREDENTIALS';
  err.isOperational = true;
  return err;
}

/**
 * @returns {Error}
 */
function emailNotRegisteredError() {
  const err = new Error('Email ID is not registered.');
  err.statusCode = 404;
  err.code = 'EMAIL_NOT_REGISTERED';
  err.isOperational = true;
  return err;
}

/**
 * The one generic 401 every refresh-token failure mode returns — invalid
 * signature, expired, unknown jti, already-consumed (replay), wrong user,
 * inactive account. Deliberately identical in every case so a caller can
 * never distinguish "this token doesn't exist" from "this token was
 * already used" from any other rejection reason.
 *
 * @returns {Error}
 */
function invalidRefreshTokenError() {
  const err = new Error('Invalid or expired refresh token.');
  err.statusCode = 401;
  err.code = 'INVALID_REFRESH_TOKEN';
  err.isOperational = true;
  return err;
}

// ─── Auth Service ─────────────────────────────────────────────────────────────

/**
 * POST /auth/login
 *
 * @param {string} email
 * @param {string} password
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, user, employee, roles, forms }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function login(email, password, ipAddress, userAgent) {
  const user = await authRepository.findUserByEmail(email);

  if (!user) {
    logger.warn('Login attempt with unregistered email', { email });
    throw emailNotRegisteredError();
  }

  if (user.status !== 'active') {
    logger.warn('Login attempt on inactive account', { userId: user.id });
    const err = new Error('Your account has been deactivated. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  if (!user.role || user.role.status !== 'active') {
    logger.warn('Login attempt with no active role', { userId: user.id, roleId: user.role_id });
    const err = new Error('No active role is assigned to your account. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ROLE_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  if (user.employee && (user.employee.status !== 'active' || user.employee.is_deleted)) {
    logger.warn('Login attempt on inactive employee record', { userId: user.id, employeeId: user.employee.id });
    const err = new Error('Your employee record is inactive. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'EMPLOYEE_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  const isPasswordValid = await user.validatePassword(password);

  if (!isPasswordValid) {
    logger.warn('Login attempt with incorrect password', { userId: user.id });
    throw invalidCredentialsError();
  }

  // No familyId passed — login always starts a brand NEW session lineage,
  // never reuses one (that only happens on rotation — see refreshToken()).
  const { accessToken, refreshToken, expiresIn, refreshExpiresIn, jti, familyId } = generateTokens(user);

  await authRepository.createSession({
    user_id: user.id,
    refresh_token: refreshToken,
    jti,
    family_id: familyId,
    expires_at: expiryToDate(refreshExpiresIn || REFRESH_TOKEN_EXPIRY),
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  authRepository.updateLastLogin(user.id).catch((updateErr) => {
    logger.error('Failed to update last_login', { userId: user.id, error: updateErr.message });
  });

  logger.info('User logged in successfully', { userId: user.id, email: user.email });

  // Only actively-mapped forms (role_form_mapping.status = true), grouped by
  // module — inactive/unmapped forms are excluded entirely. Every role the
  // user holds (primary + additional — see database/migrations/
  // 20260850_add_user_additional_roles.sql) contributes its own mapped
  // forms; getActiveFormsForRoles() unions and dedupes across all of them,
  // exactly like it already does for req.capabilities — a role never gets
  // treated as more or less entitled to its own forms because it's
  // "additional" rather than primary. Platform Admin (hierarchy_rank === 1)
  // implicitly sees every active form rather than relying on stored mapping
  // rows — see rbacService.getActiveFormsForRoles().
  const additionalRoleIds = (user.additionalRoles || []).map((role) => role.id);
  const forms = await rbacService.getActiveFormsForRoles(
    [user.role.id, ...additionalRoleIds],
    user.role.hierarchy_rank
  );

  return {
    accessToken,
    refreshToken,
    expiresIn,
    user: sanitiseUser(user),
    // Per the RBAC redesign: login always returns both `user` and
    // `employee` — `employee` is null for an account with no linked
    // Employee record (every Admin/Manager tier that isn't also staff).
    employee: user.employee ? user.employee.toJSON() : null,
    roles: serialiseRoles(user.role, user.additionalRoles, extractIsOriginalDataVisible(user.company)),
    forms,
  };
}

/**
 * Invalidate a user session by revoking it (same soft-revoke mechanism as
 * rotation — see authRepository.revokeSessionByJti) so a subsequent replay
 * of this same refresh token is recognized as reuse, not silently
 * forgotten. Idempotent: an unparseable, unknown, or already-revoked token
 * still returns success from the client's perspective.
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

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (jwtErr) {
    logger.info('Logout with an already-invalid/expired refresh token — no-op');
    return;
  }

  if (decoded.jti) {
    await authRepository.revokeSessionByJti(decoded.jti);
  }

  logger.info('Session revoked on logout', { userId: decoded.id });
}

/**
 * Exchange a valid refresh token for a fresh access + refresh token pair,
 * with full ROTATION + REPLAY PREVENTION:
 *
 *  1. Cryptographically verify the refresh token (signature, expiry,
 *     audience — verifyRefreshToken() already rejects an access token
 *     presented here, since access/refresh tokens are signed with
 *     different secrets under different audiences).
 *  2. Require a `jti` claim — a refresh token issued before this fix has
 *     none and can never be safely tracked/rotated; reject it (forces a
 *     one-time re-login for any session started before this change shipped).
 *  3. Look up the session by jti REGARDLESS of revoked state, to tell
 *     apart three cases: unknown jti (invalid), an ALREADY-REVOKED jti
 *     (replay — the same token being reused after it was already rotated
 *     or logged out) vs. still-live. A replay revokes the ENTIRE token
 *     family (every descendant of the same login), not just this one
 *     token, since reuse of an old token is a signal it may have been
 *     stolen and both the legitimate and illegitimate holder may now have
 *     valid-looking tokens.
 *  4. Confirm the owning user is still active.
 *  5. Generate a new token pair, reusing the SAME family_id (rotation
 *     stays within one session lineage; only login starts a new one).
 *  6. ATOMICALLY consume (soft-revoke) the presented token by jti — see
 *     authRepository.consumeSessionByJti()'s doc comment for exactly how
 *     this makes concurrent replay of the SAME token safe: only one of two
 *     simultaneous requests presenting the same refresh token can ever
 *     affect a row, so only one can ever receive a new token pair. If this
 *     call reports 0 rows affected, another request already won the race
 *     between our step-3 read and here — the freshly generated tokens
 *     below are discarded, never persisted or returned.
 *  7. Persist the new session and return the new pair.
 *
 * Steps 6-7 run inside one transaction: a crash between consuming the old
 * session and persisting the new one leaves the old token dead but issues
 * no orphaned "new" token that was never actually stored — the caller
 * simply has to log in again, which is a safe failure mode, never a
 * security one.
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

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (jwtErr) {
    throw invalidRefreshTokenError();
  }

  if (!decoded.jti) {
    logger.warn('Refresh token missing jti claim — issued before rotation fix, rejecting', { userId: decoded.id });
    throw invalidRefreshTokenError();
  }

  const existingSession = await authRepository.findSessionByJti(decoded.jti);

  if (!existingSession) {
    logger.warn('Refresh token jti not found in any session', { userId: decoded.id });
    throw invalidRefreshTokenError();
  }

  if (existingSession.user_id !== decoded.id) {
    logger.warn('Refresh token jti does not belong to the claimed user — rejecting', {
      claimedUserId: decoded.id, sessionUserId: existingSession.user_id,
    });
    throw invalidRefreshTokenError();
  }

  if (existingSession.revoked_at) {
    // REPLAY: this exact token was already consumed (rotated or logged
    // out) at some point in the past. Kill the whole family — if it was
    // stolen, this stops both the legitimate and illegitimate holder.
    logger.warn('Refresh token reuse detected — revoking entire session family', {
      userId: decoded.id, familyId: existingSession.family_id, jti: decoded.jti,
    });
    if (existingSession.family_id) {
      await authRepository.revokeFamily(existingSession.family_id);
    }
    throw invalidRefreshTokenError();
  }

  if (existingSession.expires_at && new Date(existingSession.expires_at) <= new Date()) {
    throw invalidRefreshTokenError();
  }

  const { user } = existingSession;

  if (!user || user.status !== 'active') {
    logger.warn('Token refresh for inactive/missing user account', { userId: decoded.id });
    await authRepository.revokeSessionByJti(decoded.jti);
    const err = new Error('Account is inactive. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  if (!user.role || user.role.status !== 'active') {
    logger.warn('Token refresh for account with no active role', { userId: decoded.id });
    await authRepository.revokeSessionByJti(decoded.jti);
    const err = new Error('No active role is assigned to your account. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ROLE_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  if (user.employee && (user.employee.status !== 'active' || user.employee.is_deleted)) {
    logger.warn('Token refresh for inactive employee record', { userId: decoded.id, employeeId: user.employee.id });
    await authRepository.revokeSessionByJti(decoded.jti);
    const err = new Error('Your employee record is inactive. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'EMPLOYEE_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  // Reuse the existing family — rotation stays within one session lineage.
  const tokens = generateTokens(user, { familyId: existingSession.family_id });

  let consumed = 0;
  await sequelize.transaction(async (transaction) => {
    consumed = await authRepository.consumeSessionByJti(decoded.jti, tokens.jti, { transaction });
    if (consumed === 1) {
      await authRepository.createSession({
        user_id: user.id,
        refresh_token: tokens.refreshToken,
        jti: tokens.jti,
        family_id: tokens.familyId,
        expires_at: expiryToDate(tokens.refreshExpiresIn || REFRESH_TOKEN_EXPIRY),
        ip_address: ipAddress || null,
        user_agent: userAgent || null,
      }, { transaction });
    }
  });

  if (consumed === 0) {
    // Lost a concurrent race against another request presenting the SAME
    // token — the freshly generated tokens above were never persisted and
    // are discarded here; only the winner's tokens are ever valid.
    logger.warn('Refresh token was already consumed by a concurrent request', { userId: decoded.id, jti: decoded.jti });
    throw invalidRefreshTokenError();
  }

  logger.info('Token refreshed successfully (rotated)', { userId: user.id, oldJti: decoded.jti, newJti: tokens.jti });

  const forms = user.role
    ? await rbacService.getActiveFormsForRoles(
        [user.role.id, ...(user.additionalRoles || []).map((role) => role.id)],
        user.role.hierarchy_rank
      )
    : {};

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    user: sanitiseUser(user),
    roles: serialiseRoles(user.role, user.additionalRoles, extractIsOriginalDataVisible(user.company)),
    forms,
  };
}

/**
 * PUT /auth/change-password
 *
 * Directly sets a new password for the already-authenticated User — no
 * current-password check. Distinct from userService.changePassword() (the
 * /users/:id/change-password self-service flow, which verifies the OLD
 * password).
 *
 * `userId` MUST be resolved from the verified JWT (req.userId, set by
 * middlewares/auth.js) — never from the request body — so an account can
 * only ever change its own password.
 *
 * @param {number} userId - id resolved from the JWT
 * @param {string} newPassword - plaintext, already Joi-validated against the password policy
 * @param {number} [companyId] - resolved from the JWT/DB re-fetch, scopes the update
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 404 'User not found.'
 */
async function changePassword(userId, newPassword, companyId) {
  const updated = await userRepository.update(userId, { password: newPassword }, {}, companyId);
  if (!updated) {
    const err = new Error('User not found.');
    err.statusCode = 404;
    err.code = 'USER_NOT_FOUND';
    err.isOperational = true;
    throw err;
  }

  logger.info('Password changed successfully', { userId });

  return { message: 'Password updated successfully.' };
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
  changePassword,
};
