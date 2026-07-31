'use strict';

/**
 * Shared account-type resolution for the dynamic Login / Forgot Password
 * flows. Both /auth/login and /auth/forgot-password (and /resend-otp) must
 * resolve an email that may exist in Users, Employees, both, or neither —
 * and disambiguate identically when it exists in both — so this logic
 * lives in ONE place instead of being duplicated across authService.js and
 * forgotPasswordService.js.
 */

const ACCOUNT_TYPES = [
  { type: 'user', label: 'User' },
  { type: 'employee', label: 'Employee' },
];

/**
 * @param {boolean} hasUser
 * @param {boolean} hasEmployee
 * @param {string} [loginType] - 'user' | 'employee' | undefined, as submitted by the client
 * @returns {{ case: 'NOT_FOUND'|'AMBIGUOUS'|'INVALID_LOGIN_TYPE'|'USER'|'EMPLOYEE' }}
 */
function resolveAccountCase(hasUser, hasEmployee, loginType) {
  const normalizedType = loginType ? String(loginType).trim().toLowerCase() : null;

  if (normalizedType && normalizedType !== 'user' && normalizedType !== 'employee') {
    return { case: 'INVALID_LOGIN_TYPE' };
  }

  if (hasUser && hasEmployee) {
    if (!normalizedType) return { case: 'AMBIGUOUS' };
    return { case: normalizedType === 'user' ? 'USER' : 'EMPLOYEE' };
  }

  if (hasUser) {
    // An explicit loginType='employee' against a User-only email has
    // nothing to authenticate/reset — treat as not registered for that
    // type rather than silently falling back to the account it didn't ask for.
    return normalizedType === 'employee' ? { case: 'NOT_FOUND' } : { case: 'USER' };
  }

  if (hasEmployee) {
    return normalizedType === 'user' ? { case: 'NOT_FOUND' } : { case: 'EMPLOYEE' };
  }

  return { case: 'NOT_FOUND' };
}

/**
 * Generic "no account with this email (for the requested type)" error —
 * shared verbatim by authService.js's login() and
 * forgotPasswordService.js's forgotPassword()/resendOtp(). Deliberately
 * DISCLOSES non-existence (a departure from a generic-response design) per
 * an explicit, repeated product requirement covering both APIs.
 *
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
 * The submitted `loginType` was neither 'user' nor 'employee'.
 * @returns {Error}
 */
function invalidLoginTypeError() {
  const err = new Error("loginType must be 'user' or 'employee'.");
  err.statusCode = 422;
  err.code = 'INVALID_LOGIN_TYPE';
  err.isOperational = true;
  return err;
}

module.exports = {
  ACCOUNT_TYPES,
  resolveAccountCase,
  emailNotRegisteredError,
  invalidLoginTypeError,
};
