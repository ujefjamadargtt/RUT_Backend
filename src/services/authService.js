'use strict';

const authRepository = require('../repositories/authRepository');
const userRepository = require('../repositories/userRepository');
const employeeRepository = require('../repositories/employeeRepository');
const rbacService = require('./rbacService');
const {
  generateTokens,
  verifyRefreshToken,
  REFRESH_TOKEN_EXPIRY,
  generateEmployeeTokens,
  verifyEmployeeRefreshToken,
} = require('../config/jwt');
const {
  resolveAccountCase,
  ACCOUNT_TYPES,
  emailNotRegisteredError,
  invalidLoginTypeError,
} = require('../utils/loginTypeResolver');
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

/**
 * Strip sensitive fields and return a safe employee object for API responses.
 *
 * @param {object} employee - Sequelize Employee instance or plain object.
 * @returns {object}
 */
function sanitiseEmployee(employee) {
  const plain = employee.toJSON ? employee.toJSON() : { ...employee };
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

/**
 * Same generic "wrong password" error shared by the User path, the
 * Employee path, and the both-accounts-exist password-disambiguation
 * branch in login() below — one place so all three stay identical instead
 * of drifting.
 *
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
 * Not-found error for changePassword() below — message text is the only
 * thing that differs between the two account types.
 * @param {'user'|'employee'} userType
 * @returns {Error}
 */
function accountNotFoundError(userType) {
  const err = new Error(userType === 'user' ? 'User not found.' : 'Employee not found.');
  err.statusCode = 404;
  err.code = userType === 'user' ? 'USER_NOT_FOUND' : 'EMPLOYEE_NOT_FOUND';
  err.isOperational = true;
  return err;
}

/**
 * @returns {Error}
 */
function invalidUserTypeError() {
  const err = new Error('Invalid user type.');
  err.statusCode = 422;
  err.code = 'INVALID_USER_TYPE';
  err.isOperational = true;
  return err;
}

// ─── Auth Service ─────────────────────────────────────────────────────────────

/**
 * Employee half of the dynamic login flow. Mirrors the User login steps
 * (status check, password check, token issue, session persist) but against
 * an already-resolved Employee record — the caller (login()) is
 * responsible for finding it and deciding this is the right path; this
 * function never re-queries or second-guesses that decision. Returns a
 * distinct response shape ({ employee, loginType: 'employee' } instead of
 * { user, roles, forms }) so the frontend can tell the two apart.
 *
 * @param {import('../models').Employee} employee - already resolved, guaranteed non-null
 * @param {string} password
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, loginType }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function authenticateEmployee(employee, password, ipAddress, userAgent) {
  if (employee.status !== 'active' || employee.is_deleted) {
    logger.warn('Login attempt on inactive employee account', { employeeId: employee.id });
    const err = new Error('Your account has been deactivated. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  const isPasswordValid = await employee.validatePassword(password);

  if (!isPasswordValid) {
    logger.warn('Login attempt with incorrect password', { employeeId: employee.id });
    throw invalidCredentialsError();
  }

  const { accessToken, refreshToken, expiresIn, refreshExpiresIn } = generateEmployeeTokens(employee);

  await authRepository.createEmployeeSession({
    employee_id: employee.id,
    refresh_token: refreshToken,
    expires_at: expiryToDate(refreshExpiresIn || REFRESH_TOKEN_EXPIRY),
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  logger.info('Employee logged in successfully', { employeeId: employee.id, email: employee.email_id });

  return {
    accessToken,
    refreshToken,
    expiresIn,
    employee: sanitiseEmployee(employee),
    loginType: 'employee',
  };
}

/**
 * User half of the dynamic login flow, against an already-resolved User
 * record — login() is responsible for finding it and deciding this is the
 * right path. Steps: check account/role status, validate password, issue
 * tokens, persist session, stamp last_login. Identical body to the
 * previous single-purpose login() function, just no longer doing its own
 * lookup.
 *
 * @param {import('../models').User} user - already resolved, guaranteed non-null
 * @param {string} password
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, user, roles, forms }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function authenticateUser(user, password, ipAddress, userAgent) {
  // 2. Check account status
  if (user.status !== 'active') {
    logger.warn('Login attempt on inactive account', { userId: user.id });
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
    throw invalidCredentialsError();
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
 * Dynamic login entry point — resolves whether the submitted email belongs
 * to a User, an Employee, both, or neither, then dispatches to
 * authenticateUser()/authenticateEmployee() accordingly. Both lookups run
 * unconditionally (not a sequential "try User, fall back to Employee")
 * specifically so an email that exists in BOTH tables is detected and
 * disambiguated, rather than one silently winning by query order.
 *
 * `loginType` is optional. Omitting it is fully backward compatible for
 * every account that exists as only a User or only an Employee (the
 * overwhelming majority) — behavior for those is unchanged from before
 * this dual-lookup existed. It only matters for the edge case of an email
 * registered as both:
 *
 *   - `loginType` given → authenticate ONLY against that account (existing
 *     behavior, unchanged): right password → normal login response, wrong
 *     password → INVALID_CREDENTIALS. This is what the frontend calls a
 *     second time once the user has picked an account type.
 *   - `loginType` omitted → rather than immediately asking the frontend to
 *     disambiguate, the submitted password is first checked against BOTH
 *     accounts via each model's own validatePassword() (bcrypt, the same
 *     mechanism every other password check in this codebase uses — never a
 *     raw hash/plaintext comparison):
 *       - matches only User      → log in as User immediately
 *       - matches only Employee  → log in as Employee immediately
 *       - matches both           → genuinely ambiguous (can't be resolved
 *         from the password alone); return requiresUserTypeSelection so the
 *         frontend can ask and resubmit with an explicit loginType
 *       - matches neither        → INVALID_CREDENTIALS, same as any other
 *         wrong-password attempt
 *
 * @param {string} email
 * @param {string} password
 * @param {string} [loginType] - 'user' | 'employee', optional; only forces which account is checked
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<object>} authenticateUser()/authenticateEmployee()'s result, OR
 *   { requiresUserTypeSelection: true, message, accountTypes } when genuinely ambiguous
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function login(email, password, loginType, ipAddress, userAgent) {
  const [user, employee] = await Promise.all([
    authRepository.findUserByEmail(email),
    authRepository.findEmployeeByEmail(email),
  ]);

  const resolved = resolveAccountCase(!!user, !!employee, loginType);

  switch (resolved.case) {
    case 'NOT_FOUND':
      logger.warn('Login attempt with unregistered email', { email, loginType: loginType || null });
      throw emailNotRegisteredError();

    case 'INVALID_LOGIN_TYPE':
      throw invalidLoginTypeError();

    case 'AMBIGUOUS': {
      // loginType was omitted and this email is registered as both a User
      // and an Employee — try the submitted password against both before
      // asking the frontend to disambiguate (see the doc comment above).
      const [userPasswordMatches, employeePasswordMatches] = await Promise.all([
        user.validatePassword(password),
        employee.validatePassword(password),
      ]);

      if (userPasswordMatches && !employeePasswordMatches) {
        return authenticateUser(user, password, ipAddress, userAgent);
      }

      if (employeePasswordMatches && !userPasswordMatches) {
        return authenticateEmployee(employee, password, ipAddress, userAgent);
      }

      if (userPasswordMatches && employeePasswordMatches) {
        logger.info('Login requires account type selection — password matched both accounts', { email });
        return {
          requiresUserTypeSelection: true,
          message: 'This email is associated with multiple accounts using the same password. Please choose the account you want to log in to.',
          accountTypes: ACCOUNT_TYPES,
        };
      }

      logger.warn('Login attempt with incorrect password (email registered as both User and Employee)', { email });
      throw invalidCredentialsError();
    }

    case 'USER':
      return authenticateUser(user, password, ipAddress, userAgent);

    case 'EMPLOYEE':
      return authenticateEmployee(employee, password, ipAddress, userAgent);

    default:
      // Unreachable — resolveAccountCase() always returns one of the above.
      throw emailNotRegisteredError();
  }
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

  if (deleted > 0) {
    logger.info('Session deleted on logout');
    return;
  }

  // No matching User session — this may be an Employee's refresh token
  // (dynamic login issues Employee tokens from the same /auth/login and
  // /auth/logout endpoints). Check employee_sessions before giving up.
  const deletedEmployeeSession = await authRepository.deleteEmployeeSession(refreshToken);

  if (deletedEmployeeSession === 0) {
    // Session already gone or token was never valid — treat as success (idempotent)
    logger.debug('Logout called but no active session found for token');
  } else {
    logger.info('Employee session deleted on logout');
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
/**
 * Employee half of the dynamic refresh flow — only reached from
 * refreshToken() when the submitted token fails User refresh-token
 * verification but succeeds Employee refresh-token verification.
 *
 * @param {string} refreshTokenValue
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, loginType }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function refreshEmployeeToken(refreshTokenValue, ipAddress, userAgent) {
  const session = await authRepository.findEmployeeSession(refreshTokenValue);

  if (!session) {
    logger.warn('Employee refresh token not found in active sessions');
    const err = new Error('Session not found or has expired. Please log in again.');
    err.statusCode = 401;
    err.code = 'SESSION_NOT_FOUND';
    err.isOperational = true;
    throw err;
  }

  const { employee } = session;

  if (!employee || employee.status !== 'active' || employee.is_deleted) {
    logger.warn('Token refresh for inactive employee account', { employeeId: employee?.id });
    await authRepository.deleteEmployeeSession(refreshTokenValue);
    const err = new Error('Account is inactive. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  // Revoke old session (token rotation)
  await authRepository.deleteEmployeeSession(refreshTokenValue);

  const tokens = generateEmployeeTokens(employee);

  await authRepository.createEmployeeSession({
    employee_id: employee.id,
    refresh_token: tokens.refreshToken,
    expires_at: expiryToDate(tokens.refreshExpiresIn || REFRESH_TOKEN_EXPIRY),
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  logger.info('Employee token refreshed successfully', { employeeId: employee.id });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    employee: sanitiseEmployee(employee),
    loginType: 'employee',
  };
}

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
    // Not a valid User refresh token (wrong audience/signature/expiry) —
    // it may be an Employee refresh token instead (dynamic login issues
    // both types from the same /auth/refresh-token endpoint). Every User
    // branch below this block is unchanged from before this fallback existed.
    try {
      verifyEmployeeRefreshToken(refreshToken);
    } catch (employeeJwtErr) {
      const err = new Error('Refresh token is invalid or has expired. Please log in again.');
      err.statusCode = 401;
      err.code = 'INVALID_REFRESH_TOKEN';
      err.isOperational = true;
      throw err;
    }
    return refreshEmployeeToken(refreshToken, ipAddress, userAgent);
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
 * PUT /auth/change-password
 *
 * Directly sets a new password for the already-authenticated User or
 * Employee — no current-password check. This is deliberately distinct from
 * userService.changePassword() (the /users/:id/change-password self-service
 * flow, which verifies the OLD password) — that endpoint is untouched by
 * this feature. This one exists specifically to serve BOTH account types
 * through one endpoint, trusting the caller's already-verified JWT instead.
 *
 * `authId`/`userType` MUST be resolved from the verified JWT
 * (req.authId/req.userType, set by middlewares/dualAuth.js) — never from
 * the request body — so an account can only ever change its own password.
 *
 * Reuses userRepository.update()/employeeRepository.update(): both already
 * hash via the model's own beforeUpdate hook (identical bcrypt/BCRYPT_ROUNDS
 * mechanism Login/Forgot Password already use), so no hashing happens here.
 *
 * @param {number} authId - id resolved from the JWT (User.id or Employee.id)
 * @param {'user'|'employee'} userType
 * @param {string} newPassword - plaintext, already Joi-validated against the password policy
 * @param {number} [companyId] - resolved from the JWT/DB re-fetch, scopes the update
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 404 ('User not found.'/'Employee not found.') / 422 ('Invalid user type.')
 */
async function changePassword(authId, userType, newPassword, companyId) {
  if (userType === 'user') {
    const updated = await userRepository.update(authId, { password: newPassword }, {}, companyId);
    if (!updated) {
      throw accountNotFoundError('user');
    }
    logger.info('Password changed successfully', { userId: authId, userType: 'user' });
  } else if (userType === 'employee') {
    const updated = await employeeRepository.update(authId, { password: newPassword }, companyId);
    if (!updated) {
      throw accountNotFoundError('employee');
    }
    logger.info('Password changed successfully', { employeeId: authId, userType: 'employee' });
  } else {
    throw invalidUserTypeError();
  }

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
