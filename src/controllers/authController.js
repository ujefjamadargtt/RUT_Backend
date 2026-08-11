'use strict';

const authService = require('../services/authService');
const forgotPasswordService = require('../services/forgotPasswordService');
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
 * Authenticate against User Master. Login response always includes both
 * `user` and `employee` — `employee` is null for an account with no linked
 * Employee record (see authService.login).
 *
 * Request body (validated upstream by Joi middleware):
 *   { email: string, password: string }
 *
 * Response 200:
 *   { success: true, message: string, data: { accessToken, refreshToken, expiresIn, user, employee, roles, forms } }
 * Response 404: { success: false, message: 'Email ID is not registered.' }
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
 * PUBLIC route (no authenticate middleware) — authService.logout() already
 * checks both user_sessions and employee_sessions for a match, so a valid
 * User access token is neither required nor meaningful here; the refresh
 * token itself is the only credential this operation needs. req.userId is
 * therefore never set on this route — do not reference it here.
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

    logger.info('Logout request processed');

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

/**
 * POST /api/auth/forgot-password
 *
 * Request body: { email: string }
 * Response 200: { success: true, message: 'OTP sent successfully.' }
 * Response 404: { success: false, message: 'Email ID is not registered.' }
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.forgotPassword(email, ipAddress, userAgent);

    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/resend-otp
 *
 * Request body: { email: string }
 * Response 200: { success: true, message: 'OTP resent successfully.' }
 * Response 404: { success: false, message: 'Email ID is not registered.' }
 * Response 429: { success: false, message: '...wait before requesting another.' }
 */
const resendOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.resendOtp(email, ipAddress, userAgent);

    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/verify-otp
 *
 * Request body: { email: string, otp: string }
 * Response 200: { success: true, message: 'OTP verified successfully.', data: null }
 * Response 400: invalid/expired OTP or attempts exceeded
 */
const verifyOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.verifyOtp(email, otp, ipAddress, userAgent);

    return sendSuccess(res, null, result.message);
  } catch (err) {
    if (err.statusCode === 400) {
      return sendError(res, err.message, 400);
    }
    next(err);
  }
};

/**
 * POST /api/auth/reset-password
 *
 * Request body: { email: string, otp: string, password: string, confirmPassword: string }
 * Response 200: { success: true, message: string, data: null }
 * Response 400: OTP not verified / expired
 */
const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, password } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.resetPassword(email, otp, password, ipAddress, userAgent);

    return sendSuccess(res, null, result.message);
  } catch (err) {
    if (err.statusCode === 400) {
      return sendError(res, err.message, 400);
    }
    next(err);
  }
};

/**
 * PUT /api/v1/auth/change-password
 *
 * Directly sets a new password for the already-authenticated User. The
 * request body only ever needs `newPassword` — the account to update is
 * resolved entirely from the Bearer access token (req.userId, set by
 * `authenticate`), never from the request body.
 *
 * Request body: { newPassword: string }
 * Response 200: { success: true, message: 'Password updated successfully.' }
 * Response 404: { success: false, message: 'User not found.' }
 */
const changePassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;

    const result = await authService.changePassword(req.userId, newPassword, req.companyId);

    return sendSuccess(res, null, result.message);
  } catch (err) {
    if (err.statusCode === 404) {
      return sendError(res, err.message, err.statusCode);
    }
    next(err);
  }
};

module.exports = {
  login,
  logout,
  refreshToken,
  getProfile,
  forgotPassword,
  resendOtp,
  verifyOtp,
  resetPassword,
  changePassword,
};
