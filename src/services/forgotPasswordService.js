'use strict';

const bcrypt = require('bcrypt');
const { literal } = require('sequelize');
const userRepository = require('../repositories/userRepository');
const passwordResetRepository = require('../repositories/passwordResetRepository');
const emailService = require('../utils/emailService');
const { OTP_EMAIL_SUBJECT, buildOtpEmailHtml } = require('../utils/emailTemplates');
const logger = require('../utils/logger');

/**
 * Forgot Password Service
 *
 * Resolves an email against User Master only — Employees authenticate
 * exclusively through their linked User row now (see
 * database/migrations/20260842_employees_drop_login_columns.sql), so there
 * is no longer a dual User/Employee lookup or loginType disambiguation.
 * `password_reset_otps`/`password_reset_history` still carry a `login_type`
 * column from when both account types existed — every row this service
 * writes simply passes the literal `'user'`, keeping that schema untouched
 * (it's an OTP-stream partition key, not a business concept this service
 * needs to reintroduce).
 *
 * This flow EXPLICITLY discloses whether an email is registered ("Email ID
 * is not registered.") — a deliberate, repeated product requirement.
 * Every outcome (found, not found, inactive) still writes a
 * password_reset_history row for audit purposes.
 *
 * All expiry/cooldown timing is delegated to passwordResetRepository.js's
 * SQL-side NOW() comparisons — see that file's module doc.
 */

const LOGIN_TYPE = 'user';
const OTP_LENGTH = 6;
const OTP_VALIDITY_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const BCRYPT_ROUNDS = 12; // matches User.js's own password hashing
const PURPOSE = 'password_reset';

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function cooldownError() {
  const err = new Error('An OTP was already sent recently. Please wait before requesting another.');
  err.statusCode = 429;
  err.code = 'OTP_COOLDOWN_ACTIVE';
  err.isOperational = true;
  return err;
}

function emailNotRegisteredError() {
  const err = new Error('Email ID is not registered.');
  err.statusCode = 404;
  err.code = 'EMAIL_NOT_REGISTERED';
  err.isOperational = true;
  return err;
}

/**
 * Wrap the existing callback-based emailService.sendEmail() in a Promise
 * for exactly this one call site — the utility itself is never touched or
 * converted; every other part of this file stays async/await as normal.
 */
function sendEmailAsync(to, subject, html) {
  return new Promise((resolve, reject) => {
    emailService.sendEmail(to, subject, html, (err, ...rest) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(rest);
    });
  });
}

/** 6-digit numeric OTP, e.g. "582194" — always exactly 6 digits. */
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Expire any prior pending OTP for this email, generate+hash a new one, and
 * persist it, returning the plaintext value for emailing (never persisted
 * in plaintext).
 */
async function issueOtp(user, email, ipAddress) {
  await passwordResetRepository.expirePendingByEmail(email, PURPOSE, LOGIN_TYPE);

  const plainOtp = generateOtp();
  const hashedOtp = await bcrypt.hash(plainOtp, BCRYPT_ROUNDS);

  await passwordResetRepository.createOtp({
    company_id: user.company_id,
    login_type: LOGIN_TYPE,
    user_id: user.id,
    employee_id: null,
    email,
    otp: hashedOtp,
    purpose: PURPOSE,
    status: 'pending',
    attempt_count: 0,
    created_ip: ipAddress || null,
    created_by: null,
  }, OTP_VALIDITY_MINUTES);

  return plainOtp;
}

/**
 * Send the OTP email. A transport failure is logged but never surfaced to
 * the caller as a distinct error — the OTP has already been persisted and
 * the caller still gets a normal success response regardless of whether
 * the Company Email API is reachable.
 */
async function sendOtpEmail(email, plainOtp) {
  const html = buildOtpEmailHtml(plainOtp, OTP_VALIDITY_MINUTES);
  try {
    await sendEmailAsync(email, OTP_EMAIL_SUBJECT, html);
  } catch (err) {
    logger.error('Failed to send password reset OTP email', { email, error: err.message });
  }
}

/**
 * Shared body of forgotPassword()/resendOtp() — they differ only in the
 * history action recorded ('OTP_SENT' vs 'OTP_RESENT') and log message.
 */
async function sendOrResendOtp(email, ipAddress, userAgent, historyAction) {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await userRepository.findByEmail(normalizedEmail);

  const failNotFound = async (remarks) => {
    await passwordResetRepository.logHistory({
      email: normalizedEmail,
      action: 'OTP_FAILED',
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
      remarks,
    });
    throw emailNotRegisteredError();
  };

  if (!user) {
    return failNotFound('No account found for this email.');
  }

  if (user.status !== 'active') {
    // Deliberately treated the same as NOT_FOUND for this specific flow:
    // an unauthenticated forgot-password request revealing "this account
    // exists but is deactivated" is its own disclosure risk.
    return failNotFound('Account is inactive.');
  }

  const hasRecent = await passwordResetRepository.hasRecentOtp(normalizedEmail, PURPOSE, LOGIN_TYPE, RESEND_COOLDOWN_SECONDS);
  if (hasRecent) {
    throw cooldownError();
  }

  const plainOtp = await issueOtp(user, normalizedEmail, ipAddress);
  await sendOtpEmail(normalizedEmail, plainOtp);

  await passwordResetRepository.logHistory({
    company_id: user.company_id,
    email: normalizedEmail,
    login_type: LOGIN_TYPE,
    user_id: user.id,
    employee_id: null,
    action: historyAction,
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  const isResend = historyAction === 'OTP_RESENT';
  logger.info(`Password reset OTP ${isResend ? 'resent' : 'issued'}`, { email: normalizedEmail });

  return { message: isResend ? 'OTP resent successfully.' : 'OTP sent successfully.' };
}

/**
 * POST /auth/forgot-password
 * @param {string} email
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 404 EMAIL_NOT_REGISTERED / 429 OTP_COOLDOWN_ACTIVE
 */
const forgotPassword = async (email, ipAddress, userAgent) => {
  return sendOrResendOtp(email, ipAddress, userAgent, 'OTP_SENT');
};

/**
 * POST /auth/resend-otp
 * @param {string} email
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ message: string }>}
 */
const resendOtp = async (email, ipAddress, userAgent) => {
  return sendOrResendOtp(email, ipAddress, userAgent, 'OTP_RESENT');
};

/**
 * POST /auth/verify-otp
 * @param {string} email
 * @param {string} otp - plaintext, as submitted by the user
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 400 — invalid/expired OTP or attempts exceeded
 */
const verifyOtp = async (email, otp, ipAddress, userAgent) => {
  const normalizedEmail = email.toLowerCase().trim();

  await passwordResetRepository.expireElapsedPending(normalizedEmail, PURPOSE, LOGIN_TYPE);
  const candidates = await passwordResetRepository.findLivePendingByEmail(normalizedEmail, PURPOSE, LOGIN_TYPE);

  const fail = async (remarks, message) => {
    await passwordResetRepository.logHistory({
      email: normalizedEmail,
      login_type: LOGIN_TYPE,
      action: 'OTP_FAILED',
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
      remarks,
    });
    throw badRequest(message);
  };

  let matched = null;
  for (const candidate of candidates) {
    if (await bcrypt.compare(otp, candidate.otp)) {
      matched = candidate;
      break;
    }
  }

  if (!matched) {
    const mostRecentLive = candidates[0];
    if (mostRecentLive) {
      const newCount = mostRecentLive.attempt_count + 1;
      const exceeded = newCount >= MAX_ATTEMPTS;
      await passwordResetRepository.updateOtpById(mostRecentLive.id, {
        attempt_count: newCount,
        status: exceeded ? 'expired' : 'pending',
      });
      if (exceeded) {
        return fail(
          'Maximum verification attempts exceeded.',
          'Maximum attempts exceeded. Please request a new OTP.'
        );
      }
    }
    return fail('OTP did not match any pending request.', 'Invalid or expired OTP.');
  }

  await passwordResetRepository.updateOtpById(matched.id, {
    status: 'verified',
    verified_at: literal('NOW()'),
  });

  await passwordResetRepository.logHistory({
    company_id: matched.company_id,
    email: normalizedEmail,
    login_type: LOGIN_TYPE,
    user_id: matched.user_id,
    action: 'OTP_VERIFIED',
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  return { message: 'OTP verified successfully.' };
};

/**
 * POST /auth/reset-password
 * @param {string} email
 * @param {string} otp - plaintext, must match the already-'verified' row
 * @param {string} password - plaintext new password (already Joi-validated for policy)
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 400 — no verified/unexpired OTP for this email
 */
const resetPassword = async (email, otp, password, ipAddress, userAgent) => {
  const normalizedEmail = email.toLowerCase().trim();

  const fail = async (remarks) => {
    await passwordResetRepository.logHistory({
      email: normalizedEmail,
      login_type: LOGIN_TYPE,
      action: 'PASSWORD_RESET_FAILED',
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
      remarks,
    });
    throw badRequest('OTP is not verified or has expired. Please verify your OTP again.');
  };

  const verified = await passwordResetRepository.findVerifiedLiveByEmail(normalizedEmail, PURPOSE, LOGIN_TYPE);
  if (!verified) {
    return fail('No verified, unexpired OTP found for this email.');
  }
  if (!(await bcrypt.compare(otp, verified.otp))) {
    return fail('Submitted OTP does not match the verified OTP.');
  }

  await userRepository.update(verified.user_id, { password }, {}, verified.company_id);

  await passwordResetRepository.updateOtpById(verified.id, {
    status: 'used',
    used_at: literal('NOW()'),
  });

  await passwordResetRepository.logHistory({
    company_id: verified.company_id,
    email: normalizedEmail,
    login_type: LOGIN_TYPE,
    user_id: verified.user_id,
    action: 'PASSWORD_RESET',
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  logger.info('Password reset completed', { email: normalizedEmail });

  return { message: 'Password reset successfully. You can now log in with your new password.' };
};

module.exports = {
  forgotPassword,
  resendOtp,
  verifyOtp,
  resetPassword,
  OTP_LENGTH,
  OTP_VALIDITY_MINUTES,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
};
