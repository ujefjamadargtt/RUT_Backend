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

/**
 * Send the "email exists as both a User and an Employee" disambiguation
 * response — a flat, non-standard shape (no `data` envelope) shared
 * verbatim by /login and /forgot-password (and /resend-otp), since both
 * resolve accounts via the same shared case logic
 * (src/utils/loginTypeResolver.js) and can hit this same outcome.
 *
 * @param {import('express').Response} res
 * @param {{ message: string, accountTypes: object[] }} result
 */
function sendRequiresUserTypeSelection(res, result) {
  return res.status(200).json({
    success: false,
    requiresUserTypeSelection: true,
    message: result.message,
    accountTypes: result.accountTypes,
  });
}

/**
 * Send the /forgot-password and /resend-otp success response — a flat
 * shape (no `data` envelope) that includes the RESOLVED `loginType`
 * alongside the message. This is the only way the frontend learns which
 * account type an ambiguous email resolved to (or confirms the type for
 * an unambiguous one) — it must carry this value forward verbatim into
 * /verify-otp and /reset-password, which no longer re-resolve it.
 *
 * @param {import('express').Response} res
 * @param {{ message: string, loginType: string }} result
 */
function sendOtpIssued(res, result) {
  return res.status(200).json({
    success: true,
    message: result.message,
    loginType: result.loginType,
  });
}

// ─── Auth Controller ──────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 *
 * Authenticate a User or Employee with email + password. The backend
 * resolves which account type the email belongs to; `loginType` is only
 * required when the email is registered as BOTH (see authService.login).
 *
 * Request body (validated upstream by Joi middleware):
 *   { email: string, password: string, loginType?: 'user'|'employee' }
 *
 * Response 200 (normal):
 *   { success: true, message: string, data: { accessToken, refreshToken, expiresIn, user|employee, ... } }
 * Response 200 (ambiguous — email is both a User and an Employee, no loginType given):
 *   { success: false, requiresUserTypeSelection: true, message: string, accountTypes: [...] }
 * Response 404: { success: false, message: 'Email ID is not registered.' }
 */
const login = async (req, res, next) => {
  try {
    const { email, password, loginType } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await authService.login(email, password, loginType, ipAddress, userAgent);

    if (result.requiresUserTypeSelection) {
      return sendRequiresUserTypeSelection(res, result);
    }

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
 * Supports both User and Employee — the backend resolves which one the
 * submitted email belongs to, exactly like the dynamic /auth/login flow.
 * `loginType` is only required when the email is registered as BOTH.
 *
 * Request body: { email: string, loginType?: 'user'|'employee' }
 * Response 200 (normal): { success: true, message: 'OTP sent successfully.', loginType: 'user'|'employee' }
 *   — no `data` envelope; the frontend MUST carry this `loginType` forward
 *   into /verify-otp and /reset-password verbatim, since those endpoints
 *   no longer re-resolve it.
 * Response 200 (ambiguous): { success: false, requiresUserTypeSelection: true, message, accountTypes }
 * Response 404: { success: false, message: 'Email ID is not registered.' }
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email, loginType } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.forgotPassword(email, loginType, ipAddress, userAgent);

    if (result.requiresUserTypeSelection) {
      return sendRequiresUserTypeSelection(res, result);
    }

    return sendOtpIssued(res, result);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/resend-otp
 *
 * Request body: { email: string, loginType?: 'user'|'employee' }
 * Response 200 (normal): { success: true, message: 'OTP resent successfully.', loginType: 'user'|'employee' }
 * Response 200 (ambiguous): { success: false, requiresUserTypeSelection: true, message, accountTypes }
 * Response 404: { success: false, message: 'Email ID is not registered.' }
 * Response 429: { success: false, message: '...wait before requesting another.' }
 */
const resendOtp = async (req, res, next) => {
  try {
    const { email, loginType } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.resendOtp(email, loginType, ipAddress, userAgent);

    if (result.requiresUserTypeSelection) {
      return sendRequiresUserTypeSelection(res, result);
    }

    return sendOtpIssued(res, result);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/verify-otp
 *
 * Request body: { email: string, otp: string, loginType: 'user'|'employee' }
 * Response 200: { success: true, message: 'OTP verified successfully.', data: null }
 * Response 400: invalid/expired OTP or attempts exceeded
 */
const verifyOtp = async (req, res, next) => {
  try {
    const { email, otp, loginType } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.verifyOtp(email, otp, loginType, ipAddress, userAgent);

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
 * Request body: { email: string, otp: string, password: string, confirmPassword: string, loginType: 'user'|'employee' }
 * Response 200: { success: true, message: string, data: null }
 * Response 400: OTP not verified / expired
 */
const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, password, loginType } = req.body;
    const ipAddress = resolveIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const result = await forgotPasswordService.resetPassword(email, otp, password, loginType, ipAddress, userAgent);

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
 * Directly sets a new password for the already-authenticated User or
 * Employee — supports both account types through one endpoint. `req.authId`
 * and `req.userType` are set by the `dualAuth` middleware from the verified
 * JWT; the request body only ever needs `newPassword` (any `id`/`userType`
 * a client sends is ignored — only the token's own resolved identity is used).
 *
 * Request body: { newPassword: string }
 * Response 200: { success: true, message: 'Password updated successfully.' }
 * Response 404: { success: false, message: 'User not found.' | 'Employee not found.' }
 * Response 422: { success: false, message: 'Invalid user type.' }
 */
const changePassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;

    const result = await authService.changePassword(req.authId, req.userType, newPassword, req.companyId);

    return sendSuccess(res, null, result.message);
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 422) {
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
