'use strict';

const authService = require('../services/authService');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Resolve the client's real IP address, accounting for reverse-proxy headers.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown'
  );
}

// ─── Auth Controller ──────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 *
 * Authenticate a user with email + password.
 * Returns access token, refresh token, and safe user object.
 *
 * Request body (validated upstream by Joi middleware):
 *   { email: string, password: string }
 *
 * Response 200:
 *   { success: true, message: string, data: { accessToken, refreshToken, expiresIn, user } }
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await authService.login(email, password, ipAddress, userAgent);

    return sendSuccess(res, result, 'Login successful.');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/logout
 *
 * Invalidate the current session using the provided refresh token.
 * The authenticate middleware must have already verified the access token.
 *
 * Request body:
 *   { refresh_token: string }
 *
 * Response 200:
 *   { success: true, message: string, data: null }
 */
const logout = async (req, res, next) => {
  try {
    const { refresh_token } = req.body;

    // refresh_token may be absent if the client only holds an access token —
    // we still treat this as a successful logout from the client's perspective.
    if (refresh_token) {
      await authService.logout(refresh_token);
    }

    logger.info('User logged out', { userId: req.userId });

    return sendSuccess(res, null, 'Logged out successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/refresh-token
 *
 * Exchange a valid refresh token for a new access + refresh token pair.
 * The old refresh token is revoked on success (token rotation).
 *
 * Request body:
 *   { refresh_token: string }
 *
 * Response 200:
 *   { success: true, message: string, data: { accessToken, refreshToken, expiresIn, user } }
 */
const refreshToken = async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await authService.refreshToken(refresh_token, ipAddress, userAgent);

    return sendSuccess(res, result, 'Token refreshed successfully.');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/auth/profile
 *
 * Return the authenticated user's profile including role and employee details.
 * Requires a valid Bearer access token (enforce via authenticate middleware in routes).
 *
 * Response 200:
 *   { success: true, message: string, data: { id, email, role, employee, ... } }
 */
const getProfile = async (req, res, next) => {
  try {
    const profile = await authService.getProfile(req.userId);

    return sendSuccess(res, profile, 'Profile fetched successfully.');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  login,
  logout,
  refreshToken,
  getProfile,
};
