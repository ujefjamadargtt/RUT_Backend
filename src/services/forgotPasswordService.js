'use strict';

const bcrypt = require('bcrypt');
const { literal } = require('sequelize');
const userRepository = require('../repositories/userRepository');
const employeeRepository = require('../repositories/employeeRepository');
const passwordResetRepository = require('../repositories/passwordResetRepository');
const emailService = require('../utils/emailService');
const { OTP_EMAIL_SUBJECT, buildOtpEmailHtml } = require('../utils/emailTemplates');
const {
  resolveAccountCase,
  ACCOUNT_TYPES,
  emailNotRegisteredError,
  invalidLoginTypeError,
} = require('../utils/loginTypeResolver');
const logger = require('../utils/logger');

/**
 * Forgot Password Service (User + Employee)
 *
 * Resolves an email using the SAME shared case logic as the dynamic
 * /auth/login flow (src/utils/loginTypeResolver.js) — both lookups
 * (userRepository.findByEmail / employeeRepository.findByEmail) always run,
 * never a sequential "try User, fall back to Employee", so an email
 * registered in BOTH tables is properly disambiguated via `loginType`
 * instead of one silently winning.
 *
 * Unlike the previous design, this flow EXPLICITLY discloses whether an
 * email is registered ("Email ID is not registered.") — a deliberate,
 * repeated product requirement for both /login and /forgot-password,
 * overriding the more defensive generic-response posture used before.
 * Every outcome (found, not found, ambiguous, inactive) still writes a
 * password_reset_history row for audit purposes.
 *
 * All expiry/cooldown timing is delegated to passwordResetRepository.js's
 * SQL-side NOW() comparisons — never a JS `new Date()` comparison against a
 * value pulled from this table. See that file's module doc for why (a
 * pre-existing, confirmed timezone bug in how this project's two Sequelize
 * instances hydrate "timestamp without time zone" columns).
 */

const OTP_LENGTH = 6;
const OTP_VALIDITY_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const BCRYPT_ROUNDS = 12; // matches User.js / Employee.js's own password hashing
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
 * Normalise a resolved User/Employee record into the shape the rest of
 * this file works with.
 * @param {object} record - Sequelize User or Employee instance
 * @param {'user'|'employee'} loginType
 */
function toAccountShape(record, loginType) {
  return {
    loginType,
    accountId: record.id,
    companyId: record.company_id,
    isUsable: record.status === 'active' && !record.is_deleted,
  };
}

function accountIds(account) {
  return {
    user_id: account.loginType === 'user' ? account.accountId : null,
    employee_id: account.loginType === 'employee' ? account.accountId : null,
  };
}

/**
 * Resolve an email against BOTH Users and Employees (never a sequential
 * fallback) and apply the shared case logic.
 * @param {string} email - already lowercased/trimmed
 * @param {string} [loginType]
 * @returns {Promise<{ resolvedCase: object, userRecord: object|null, employeeRecord: object|null }>}
 */
async function resolveAccounts(email, loginType) {
  const [userRecord, employeeRecord] = await Promise.all([
    userRepository.findByEmail(email),
    employeeRepository.findByEmail(email),
  ]);
  const resolvedCase = resolveAccountCase(!!userRecord, !!employeeRecord, loginType);
  return { resolvedCase, userRecord, employeeRecord };
}

/**
 * Expire any prior pending OTP for this (email, loginType), generate+hash a
 * new one, persist it, and return the plaintext value for emailing (never
 * persisted in plaintext).
 */
async function issueOtp(account, email, ipAddress) {
  await passwordResetRepository.expirePendingByEmail(email, PURPOSE, account.loginType);

  const plainOtp = generateOtp();
  const hashedOtp = await bcrypt.hash(plainOtp, BCRYPT_ROUNDS);

  await passwordResetRepository.createOtp({
    company_id: account.companyId,
    login_type: account.loginType,
    ...accountIds(account),
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
 * the Company Email API is reachable (matches how upstream modules already
 * treat sendEmail() failures as non-fatal/logged-only).
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
async function sendOrResendOtp(email, loginType, ipAddress, userAgent, historyAction) {
  const normalizedEmail = email.toLowerCase().trim();
  const { resolvedCase, userRecord, employeeRecord } = await resolveAccounts(normalizedEmail, loginType);

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

  let account;
  switch (resolvedCase.case) {
    case 'NOT_FOUND':
      return failNotFound('No account found for this email/login type.');
    case 'INVALID_LOGIN_TYPE':
      throw invalidLoginTypeError();
    case 'AMBIGUOUS':
      return {
        requiresUserTypeSelection: true,
        message: 'This email is associated with multiple account types. Please choose an account type.',
        accountTypes: ACCOUNT_TYPES,
      };
    case 'USER':
      account = toAccountShape(userRecord, 'user');
      break;
    case 'EMPLOYEE':
      account = toAccountShape(employeeRecord, 'employee');
      break;
    default:
      return failNotFound('Unresolved account case.');
  }

  if (!account.isUsable) {
    // Deliberately treated the same as NOT_FOUND for this specific flow:
    // unlike login (where the caller already proved they hold valid
    // credentials), an unauthenticated forgot-password request revealing
    // "this account exists but is deactivated" is its own disclosure risk
    // the spec never asked to take on. Login's own inactive-account
    // messaging (ACCOUNT_INACTIVE) is untouched.
    return failNotFound('Account is inactive.');
  }

  const hasRecent = await passwordResetRepository.hasRecentOtp(
    normalizedEmail, PURPOSE, account.loginType, RESEND_COOLDOWN_SECONDS
  );
  if (hasRecent) {
    throw cooldownError();
  }

  const plainOtp = await issueOtp(account, normalizedEmail, ipAddress);
  await sendOtpEmail(normalizedEmail, plainOtp);

  await passwordResetRepository.logHistory({
    company_id: account.companyId,
    email: normalizedEmail,
    login_type: account.loginType,
    ...accountIds(account),
    action: historyAction,
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  const isResend = historyAction === 'OTP_RESENT';
  logger.info(`Password reset OTP ${isResend ? 'resent' : 'issued'}`, {
    email: normalizedEmail,
    loginType: account.loginType,
  });

  // Return the RESOLVED loginType alongside the success message — once
  // this endpoint has determined which account the OTP was issued for
  // (either because the email was unambiguous, or because the caller
  // explicitly chose one), the frontend has no other way to know it and
  // must carry it forward into /verify-otp and /reset-password verbatim.
  // Those two endpoints deliberately do NOT re-resolve or infer the
  // account type — they trust and validate against exactly this value,
  // avoiding a second dual-table lookup for the same decision.
  return {
    message: isResend ? 'OTP resent successfully.' : 'OTP sent successfully.',
    loginType: account.loginType,
  };
}

/**
 * POST /auth/forgot-password
 * @param {string} email
 * @param {string} [loginType] - 'user' | 'employee', required only when the email resolves to both
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ message: string, loginType: 'user'|'employee' }|{ requiresUserTypeSelection: true, message: string, accountTypes: object[] }>}
 * @throws {Error} statusCode 404 EMAIL_NOT_REGISTERED / 422 INVALID_LOGIN_TYPE / 429 OTP_COOLDOWN_ACTIVE
 */
const forgotPassword = async (email, loginType, ipAddress, userAgent) => {
  return sendOrResendOtp(email, loginType, ipAddress, userAgent, 'OTP_SENT');
};

/**
 * POST /auth/resend-otp
 * @param {string} email
 * @param {string} [loginType]
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<object>} same shape as forgotPassword()
 */
const resendOtp = async (email, loginType, ipAddress, userAgent) => {
  return sendOrResendOtp(email, loginType, ipAddress, userAgent, 'OTP_RESENT');
};

/**
 * POST /auth/verify-otp
 * @param {string} email
 * @param {string} otp - plaintext, as submitted by the user
 * @param {string} loginType - 'user' | 'employee', REQUIRED (disambiguates which OTP stream this is)
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 400 — invalid/expired OTP or attempts exceeded
 */
const verifyOtp = async (email, otp, loginType, ipAddress, userAgent) => {
  const normalizedEmail = email.toLowerCase().trim();
  const normalizedType = String(loginType).toLowerCase();

  await passwordResetRepository.expireElapsedPending(normalizedEmail, PURPOSE, normalizedType);
  const candidates = await passwordResetRepository.findLivePendingByEmail(normalizedEmail, PURPOSE, normalizedType);

  const fail = async (remarks, message) => {
    await passwordResetRepository.logHistory({
      email: normalizedEmail,
      login_type: normalizedType,
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
    // candidates is already ordered newest-first, pre-filtered to live
    // (unexpired) rows, AND scoped to this exact login_type by
    // findLivePendingByEmail — the first entry is the one a wrong guess
    // should count against. This is also the enforcement point that a
    // User OTP can never be consumed against an Employee verify request:
    // a User-issued OTP simply never appears in an 'employee'-scoped query.
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
    login_type: matched.login_type,
    user_id: matched.user_id,
    employee_id: matched.employee_id,
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
 * @param {string} loginType - 'user' | 'employee', REQUIRED
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 400 — no verified/unexpired OTP for this email+loginType
 */
const resetPassword = async (email, otp, password, loginType, ipAddress, userAgent) => {
  const normalizedEmail = email.toLowerCase().trim();
  const normalizedType = String(loginType).toLowerCase();

  const fail = async (remarks) => {
    await passwordResetRepository.logHistory({
      email: normalizedEmail,
      login_type: normalizedType,
      action: 'PASSWORD_RESET_FAILED',
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
      remarks,
    });
    throw badRequest('OTP is not verified or has expired. Please verify your OTP again.');
  };

  // findVerifiedLiveByEmail's own WHERE clause already excludes expired
  // rows (expires_at > NOW(), evaluated in SQL) AND scopes to this exact
  // login_type — the enforcement point for "never allow a User OTP to
  // reset an Employee password, or vice versa."
  const verified = await passwordResetRepository.findVerifiedLiveByEmail(normalizedEmail, PURPOSE, normalizedType);
  if (!verified) {
    return fail('No verified, unexpired OTP found for this email/login type.');
  }
  if (!(await bcrypt.compare(otp, verified.otp))) {
    return fail('Submitted OTP does not match the verified OTP.');
  }

  // Update ONLY the account type the OTP was actually issued for.
  if (verified.login_type === 'user') {
    await userRepository.update(verified.user_id, { password }, {}, verified.company_id);
  } else {
    await employeeRepository.update(verified.employee_id, { password }, verified.company_id);
  }

  await passwordResetRepository.updateOtpById(verified.id, {
    status: 'used',
    used_at: literal('NOW()'),
  });

  await passwordResetRepository.logHistory({
    company_id: verified.company_id,
    email: normalizedEmail,
    login_type: verified.login_type,
    user_id: verified.user_id,
    employee_id: verified.employee_id,
    action: 'PASSWORD_RESET',
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  logger.info('Password reset completed', { email: normalizedEmail, loginType: verified.login_type });

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
