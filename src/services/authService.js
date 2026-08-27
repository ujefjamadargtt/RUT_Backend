'use strict';

const { sequelize } = require('../models');
const authRepository = require('../repositories/authRepository');
const employeeRepository = require('../repositories/employeeRepository');
const microsoftAuthService = require('./microsoftAuthService');
const rbacService = require('./rbacService');
const {
  generateTokens,
  verifyToken,
  verifyRefreshToken,
  signRoleSelectionTicket,
  ROLE_SELECTION_TICKET_TYPE,
  REFRESH_TOKEN_EXPIRY,
} = require('../config/jwt');
const logger = require('../utils/logger');
const moment = require('moment-timezone');
const { extractIsOriginalDataVisible } = require('../utils/timesheetPublishPolicy');

/**
 * Auth Service — login/logout/refresh/profile/change-password.
 *
 * Login authenticates exclusively against Employee Master (`employees`) —
 * the Employee-as-Identity redesign (database/migrations/
 * 20260864-20260880) moved login off `users` entirely. Every account tier
 * (Platform Admin through Employee/HR) is now a plain Employee row holding
 * zero or more roles (employee_roles) and zero or more Business Units
 * (employee_business_units) — no primary/additional role split, no single
 * home company_id for scoping.
 */

/**
 * Parse a JWT expiry string such as "7d", "15m", "1h" into a future Date.
 *
 * @param {string} expiry
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

/**
 * An employee's currently-active roles: both the role's own status
 * (roles.status) and this employee's grant of it (employee_roles.status)
 * must be 'active'. No primary/additional distinction — every consumer
 * treats the set uniformly.
 *
 * @param {object} employee - with `.roles` included (see authRepository.js)
 * @returns {object[]}
 */
function getActiveRoles(employee) {
  return (employee.roles || []).filter(
    (role) => role.status === 'active' && role.EmployeeRole && role.EmployeeRole.status === 'active'
  );
}

/**
 * An employee's currently-active Business Units (employee_business_units.status).
 *
 * @param {object} employee - with `.businessUnits` included
 * @returns {object[]}
 */
function getActiveBusinessUnits(employee) {
  return (employee.businessUnits || []).filter(
    (bu) => bu.EmployeeBusinessUnit && bu.EmployeeBusinessUnit.status === 'active'
  );
}

/**
 * Effective hierarchy rank = MIN(hierarchy_rank) across an employee's
 * active roles — NULL-rank roles (HR-style, not part of the numeric admin
 * chain) are excluded from the MIN, matching the pre-redesign isSeniorTier
 * semantics where a NULL-rank role never counted as senior.
 *
 * @param {object[]} activeRoles
 * @returns {number|null}
 */
function getEffectiveHierarchyRank(activeRoles) {
  const ranks = activeRoles
    .map((role) => role.hierarchy_rank)
    .filter((rank) => Number.isInteger(rank));
  if (ranks.length === 0) return null;
  return Math.min(...ranks);
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
 * @returns {Error}
 */
function invalidLoginTicketError() {
  const err = new Error('Invalid or expired login ticket. Please log in again.');
  err.statusCode = 401;
  err.code = 'INVALID_LOGIN_TICKET';
  err.isOperational = true;
  return err;
}

/**
 * @returns {Error}
 */
function invalidRefreshTokenError() {
  const err = new Error('Invalid or expired refresh token.');
  err.statusCode = 401;
  err.code = 'INVALID_REFRESH_TOKEN';
  err.isOperational = true;
  return err;
}

/**
 * Plain `{id, name, permission, hierarchyRank}` shape for a role — used for
 * BOTH the pending-role-selection listing (login() with >1 active role)
 * and the final issued-session response (issueSession()).
 *
 * @param {object} role
 * @returns {object}
 */
function buildRoleSummary(role) {
  return {
    id: role.id,
    name: role.role_name,
    permission: role.permission,
    hierarchyRank: role.hierarchy_rank,
  };
}

/**
 * Issue a real session (access + refresh token pair, a persisted
 * employee_login_sessions row, last-login stamp, and the accessible-forms
 * set) for an Employee scoped to EXACTLY the given roles — Role-Based
 * Login's shared completion path, used by both login() (employee holds a
 * single active role, no selection needed) and selectRole() (employee
 * picked one of several). `rolesToGrant` is always a single-role array in
 * practice today, but this stays role-array-shaped (not role-singular)
 * because hierarchyRank/capabilities elsewhere are computed as a
 * MIN/union over an array — see getEffectiveHierarchyRank().
 *
 * Deliberately does NOT return `businessUnits` — mapped Business Units are
 * fetched on demand via GET /api/v1/employees/:id/business-units instead
 * (frontend already has the employee's own id from `employee.id` in this
 * same response), not carried in every login/refresh payload.
 *
 * @param {object} employee - with `.roles`/`.businessUnits` included (see authRepository.js)
 * @param {object[]} rolesToGrant - the role(s) this session is scoped to
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, roles, forms }>}
 */
async function issueSession(employee, rolesToGrant, ipAddress, userAgent) {
  const hierarchyRank = getEffectiveHierarchyRank(rolesToGrant);
  const roleIds = rolesToGrant.map((role) => role.id);
  const roleNames = rolesToGrant.map((role) => role.role_name);
  // Role-Based Login always scopes a session to exactly one role by the
  // time it reaches here (the caller already narrowed rolesToGrant down,
  // whether that's the employee's sole role or the one they picked) — see
  // config/jwt.js's generateTokens() doc comment for why this rides in the
  // token itself rather than only in this response.
  const activeRoleId = roleIds.length === 1 ? roleIds[0] : null;

  const { accessToken, refreshToken, expiresIn, refreshExpiresIn, jti, familyId } = generateTokens({
    id: employee.id,
    email: employee.email,
    roleIds,
    roleNames,
    hierarchyRank,
    activeRoleId,
  });

  await authRepository.createSession({
    employee_id: employee.id,
    refresh_token: refreshToken,
    jti,
    family_id: familyId,
    expires_at: expiryToDate(refreshExpiresIn || REFRESH_TOKEN_EXPIRY),
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
  });

  await authRepository.updateLastLogin(employee.id);

  const forms = await rbacService.getActiveFormsForRoles(roleIds, hierarchyRank);

  // is_original_data_visible is a policy flag derived FROM the employee's
  // Business Units, not the mapped-BU list itself — kept here (unlike the
  // BU list, see this function's doc comment) since existing consumers of
  // the login response already read it off `roles[].is_original_data_visible`.
  const activeBusinessUnits = getActiveBusinessUnits(employee);
  const isOriginalDataVisible = extractIsOriginalDataVisible(activeBusinessUnits[0] || null);

  return {
    accessToken,
    refreshToken,
    expiresIn,
    employee: sanitiseEmployee(employee),
    roles: rolesToGrant.map((role) => ({ ...buildRoleSummary(role), is_original_data_visible: isOriginalDataVisible })),
    forms,
  };
}

// ─── Auth Service ─────────────────────────────────────────────────────────────

/**
 * Account-state gate shared by EVERY login path (password, Microsoft SSO, or
 * any future identity provider) — must run identically regardless of how the
 * caller's identity was established, so it is checked once here rather than
 * duplicated per provider.
 *
 * @param {object} employee
 * @returns {object[]} the employee's currently-active roles (never empty —
 *   throws instead)
 * @throws {{ statusCode: 403, code: 'ACCOUNT_INACTIVE'|'ROLE_INACTIVE' }}
 */
function assertEmployeeLoginEligible(employee) {
  if (employee.status !== 'active' || employee.is_deleted) {
    logger.warn('Login attempt on inactive/deleted employee', { employeeId: employee.id });
    const err = new Error('Your account has been deactivated. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  const activeRoles = getActiveRoles(employee);
  if (activeRoles.length === 0) {
    logger.warn('Login attempt with no active role', { employeeId: employee.id });
    const err = new Error('No active role is assigned to your account. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ROLE_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  return activeRoles;
}

/**
 * Role-Based Login's shared completion step, once identity is established
 * AND assertEmployeeLoginEligible() has already passed — an employee holding
 * exactly one active role logs in directly; an employee holding MULTIPLE
 * active roles does NOT get real tokens yet, instead gets
 * `requiresRoleSelection: true` plus their role list and a short-lived
 * `loginTicket`, completed via selectRole()/POST /auth/select-role. Used by
 * BOTH login() (after a correct password) and loginWithMicrosoft() (after a
 * verified Microsoft ID token) so this behavior can never drift between
 * identity providers.
 *
 * @param {object} employee
 * @param {object[]} activeRoles - from assertEmployeeLoginEligible()
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, roles, forms }
 *   | { requiresRoleSelection: true, loginTicket: string, roles: object[] }>}
 */
async function completeAuthenticatedLogin(employee, activeRoles, ipAddress, userAgent) {
  if (activeRoles.length > 1) {
    logger.info('Login credentials verified; awaiting role selection', {
      employeeId: employee.id,
      roleCount: activeRoles.length,
    });
    return {
      requiresRoleSelection: true,
      loginTicket: signRoleSelectionTicket(employee.id),
      roles: activeRoles.map(buildRoleSummary),
    };
  }

  return issueSession(employee, activeRoles, ipAddress, userAgent);
}

/**
 * POST /auth/login
 *
 * Role-Based Login: an employee holding exactly one active role logs in
 * directly (unchanged from before). An employee holding MULTIPLE active
 * roles does NOT get real tokens yet — instead gets `requiresRoleSelection:
 * true` plus their role list and a short-lived `loginTicket` (credentials
 * already verified at this point); the frontend must prompt them to pick
 * one and complete login via selectRole()/POST /auth/select-role.
 *
 * @param {string} email
 * @param {string} password
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, roles, forms }
 *   | { requiresRoleSelection: true, loginTicket: string, roles: object[] }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function login(email, password, ipAddress, userAgent) {
  const employee = await authRepository.findEmployeeByEmail(email);

  if (!employee || !employee.password) {
    logger.warn('Login attempt with unregistered email', { email });
    throw emailNotRegisteredError();
  }

  const activeRoles = assertEmployeeLoginEligible(employee);

  const isPasswordValid = await employee.validatePassword(password);
  if (!isPasswordValid) {
    logger.warn('Login attempt with incorrect password', { employeeId: employee.id });
    throw invalidCredentialsError();
  }

  logger.info('Employee logged in successfully', { employeeId: employee.id, email: employee.email });
  return completeAuthenticatedLogin(employee, activeRoles, ipAddress, userAgent);
}

/**
 * POST /auth/microsoft
 *
 * Microsoft Entra ID SSO login. The frontend completes an Authorization
 * Code + PKCE sign-in via MSAL entirely client-side and hands this function
 * only the resulting Microsoft ID token — nothing else in the request is
 * ever trusted (see authController.loginWithMicrosoft(), authValidation.js's
 * microsoftLoginSchema).
 *
 * Once microsoftAuthService.verifyMicrosoftIdToken() has verified the
 * token's signature/issuer/audience/expiry/tenant and returned a trusted
 * email, this function falls into EXACTLY the same identity → account-state
 * → role-selection-or-session pipeline as login() — assertEmployeeLoginEligible()
 * and completeAuthenticatedLogin() are the same functions, not
 * reimplementations, so an Employee's authorization behavior (active-role
 * checks, multi-role selection, issued tokens, roles, forms, business
 * units) can never differ based on which identity provider was used.
 *
 * Employee lookup deliberately does NOT require `employee.password` to be
 * set (unlike login()) — an employee who signs in exclusively via Microsoft
 * SSO may have no password at all, and that must not block them.
 *
 * @param {string} idToken - raw Microsoft ID token from the frontend
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, roles, forms }
 *   | { requiresRoleSelection: true, loginTicket: string, roles: object[] }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function loginWithMicrosoft(idToken, ipAddress, userAgent) {
  const { email, oid } = await microsoftAuthService.verifyMicrosoftIdToken(idToken);

  const employee = await authRepository.findEmployeeByEmail(email);
  if (!employee) {
    logger.warn('Microsoft SSO login attempt with unregistered email', { email });
    throw emailNotRegisteredError();
  }

  const activeRoles = assertEmployeeLoginEligible(employee);

  logger.info('Employee logged in successfully via Microsoft SSO', { employeeId: employee.id, email: employee.email });

  // Best-effort: remember Microsoft's stable identifier for this employee
  // for future audit/hardening. Never blocks login on failure — email is,
  // and remains, the sole login-matching key.
  if (oid) {
    authRepository.updateMicrosoftObjectId(employee.id, oid).catch((err) => {
      logger.warn('Failed to persist microsoft_object_id', { employeeId: employee.id, error: err.message });
    });
  }

  return completeAuthenticatedLogin(employee, activeRoles, ipAddress, userAgent);
}

/**
 * POST /auth/select-role
 *
 * Completes Role-Based Login for an employee who holds multiple active
 * roles: exchanges the short-lived `loginTicket` login() issued (proof
 * that credentials were already verified) plus the chosen `roleId` for a
 * real session scoped to ONLY that role.
 *
 * @param {string} loginTicket - from login()'s `requiresRoleSelection` response
 * @param {number} roleId - must be one of the SAME employee's currently active roles
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, roles, forms }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function selectRole(loginTicket, roleId, ipAddress, userAgent) {
  let decoded;
  try {
    decoded = verifyToken(loginTicket);
  } catch (err) {
    throw invalidLoginTicketError();
  }

  if (decoded.type !== ROLE_SELECTION_TICKET_TYPE) {
    throw invalidLoginTicketError();
  }

  const employee = await authRepository.findEmployeeById(decoded.id);
  if (!employee || employee.status !== 'active' || employee.is_deleted) {
    logger.warn('Role selection for inactive/missing employee', { employeeId: decoded.id });
    const err = new Error('Your account has been deactivated. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  const activeRoles = getActiveRoles(employee);
  const selectedRole = activeRoles.find((role) => role.id === roleId);
  if (!selectedRole) {
    logger.warn('Role selection for a role no longer available', { employeeId: employee.id, roleId });
    const err = new Error('The selected role is not available for this account.');
    err.statusCode = 403;
    err.code = 'ROLE_NOT_AVAILABLE';
    err.isOperational = true;
    throw err;
  }

  logger.info('Employee logged in successfully (role selected)', { employeeId: employee.id, roleId });
  return issueSession(employee, [selectedRole], ipAddress, userAgent);
}

/**
 * POST /auth/switch-role
 *
 * Switches an ALREADY-AUTHENTICATED employee's active role to one of their
 * OTHER currently-active roles, without ending the current login — same
 * "issue a fresh session scoped to exactly one role" completion path as
 * selectRole(), just triggered from a live access token (`employeeId`
 * resolved from the verified JWT via middlewares/auth.js, see
 * authController.switchRole()) instead of a pre-auth `loginTicket`. The
 * requested `roleId` is NEVER trusted blindly — it must be one of this
 * SAME employee's own currently-active roles (getActiveRoles()), exactly
 * like selectRole(), or this throws ROLE_NOT_AVAILABLE.
 *
 * Does not revoke the prior session — same behavior as selectRole()/login()
 * issuing a new session without touching old ones; the old access/refresh
 * token pair simply ages out or is revoked separately via /auth/logout.
 *
 * @param {number} employeeId - resolved from the verified JWT, never the request body
 * @param {number} roleId - must be one of the SAME employee's currently active roles
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken, refreshToken, expiresIn, employee, roles, forms }>}
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function switchRole(employeeId, roleId, ipAddress, userAgent) {
  const employee = await authRepository.findEmployeeById(employeeId);
  if (!employee || employee.status !== 'active' || employee.is_deleted) {
    logger.warn('Role switch for inactive/missing employee', { employeeId });
    const err = new Error('Your account has been deactivated. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  const activeRoles = getActiveRoles(employee);
  const selectedRole = activeRoles.find((role) => role.id === roleId);
  if (!selectedRole) {
    logger.warn('Role switch to a role not assigned/active for this employee', { employeeId: employee.id, roleId });
    const err = new Error('The selected role is not available for this account.');
    err.statusCode = 403;
    err.code = 'ROLE_NOT_AVAILABLE';
    err.isOperational = true;
    throw err;
  }

  logger.info('Employee switched active role', { employeeId: employee.id, roleId });
  return issueSession(employee, [selectedRole], ipAddress, userAgent);
}

/**
 * Invalidate an employee session by revoking it (soft-revoke, same
 * mechanism as rotation) so a subsequent replay of this same refresh token
 * is recognized as reuse, not silently forgotten. Idempotent.
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

  logger.info('Session revoked on logout', { employeeId: decoded.id });
}

/**
 * Exchange a valid refresh token for a fresh access + refresh token pair,
 * with full ROTATION + REPLAY PREVENTION — same contract as before, now
 * keyed on Employee instead of User.
 *
 * @param {string} refreshToken
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: string, employee: object, roles: object[], forms: object }>}
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
    logger.warn('Refresh token missing jti claim — issued before rotation fix, rejecting', { employeeId: decoded.id });
    throw invalidRefreshTokenError();
  }

  const existingSession = await authRepository.findSessionByJti(decoded.jti);

  if (!existingSession) {
    logger.warn('Refresh token jti not found in any session', { employeeId: decoded.id });
    throw invalidRefreshTokenError();
  }

  if (existingSession.employee_id !== decoded.id) {
    logger.warn('Refresh token jti does not belong to the claimed employee — rejecting', {
      claimedEmployeeId: decoded.id, sessionEmployeeId: existingSession.employee_id,
    });
    throw invalidRefreshTokenError();
  }

  if (existingSession.revoked_at) {
    logger.warn('Refresh token reuse detected — revoking entire session family', {
      employeeId: decoded.id, familyId: existingSession.family_id, jti: decoded.jti,
    });
    if (existingSession.family_id) {
      await authRepository.revokeFamily(existingSession.family_id);
    }
    throw invalidRefreshTokenError();
  }

  if (existingSession.expires_at && new Date(existingSession.expires_at) <= new Date()) {
    throw invalidRefreshTokenError();
  }

  const { employee } = existingSession;

  if (!employee || employee.status !== 'active' || employee.is_deleted) {
    logger.warn('Token refresh for inactive/missing employee account', { employeeId: decoded.id });
    await authRepository.revokeSessionByJti(decoded.jti);
    const err = new Error('Account is inactive. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ACCOUNT_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  const activeRoles = getActiveRoles(employee);
  if (activeRoles.length === 0) {
    logger.warn('Token refresh for account with no active role', { employeeId: decoded.id });
    await authRepository.revokeSessionByJti(decoded.jti);
    const err = new Error('No active role is assigned to your account. Please contact the administrator.');
    err.statusCode = 403;
    err.code = 'ROLE_INACTIVE';
    err.isOperational = true;
    throw err;
  }

  // Role-Based Login: carry the ORIGINAL session's role scope forward
  // across rotation — same reasoning as middlewares/auth.js's identical
  // narrowing. `decoded.activeRoleId` rides in the refresh token itself
  // (config/jwt.js's generateTokens()), so this needs no session-table
  // schema change to remember which role a session was issued as. If that
  // role was since deactivated/removed, force re-login rather than
  // silently widening back out to every currently active role.
  let effectiveRoles = activeRoles;
  if (decoded.activeRoleId != null) {
    const stillActiveRole = activeRoles.find((role) => role.id === decoded.activeRoleId);
    if (!stillActiveRole) {
      logger.warn('Refresh token\'s selected role is no longer active — forcing re-login', {
        employeeId: decoded.id, activeRoleId: decoded.activeRoleId,
      });
      await authRepository.revokeSessionByJti(decoded.jti);
      const err = new Error('Your selected role is no longer active. Please log in again.');
      err.statusCode = 403;
      err.code = 'ROLE_INACTIVE';
      err.isOperational = true;
      throw err;
    }
    effectiveRoles = [stillActiveRole];
  }

  const hierarchyRank = getEffectiveHierarchyRank(effectiveRoles);
  const roleIds = effectiveRoles.map((role) => role.id);
  const roleNames = effectiveRoles.map((role) => role.role_name);
  const activeRoleId = decoded.activeRoleId ?? (roleIds.length === 1 ? roleIds[0] : null);

  // Reuse the existing family — rotation stays within one session lineage.
  const tokens = generateTokens(
    { id: employee.id, email: employee.email, roleIds, roleNames, hierarchyRank, activeRoleId },
    { familyId: existingSession.family_id }
  );

  let consumed = 0;
  await sequelize.transaction(async (transaction) => {
    consumed = await authRepository.consumeSessionByJti(decoded.jti, tokens.jti, { transaction });
    if (consumed === 1) {
      await authRepository.createSession({
        employee_id: employee.id,
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
    logger.warn('Refresh token was already consumed by a concurrent request', { employeeId: decoded.id, jti: decoded.jti });
    throw invalidRefreshTokenError();
  }

  logger.info('Token refreshed successfully (rotated)', { employeeId: employee.id, oldJti: decoded.jti, newJti: tokens.jti });

  const forms = await rbacService.getActiveFormsForRoles(roleIds, hierarchyRank);

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    employee: sanitiseEmployee(employee),
    roles: effectiveRoles.map(buildRoleSummary),
    forms,
  };
}

/**
 * PUT /auth/change-password
 *
 * Directly sets a new password for the already-authenticated Employee —
 * no current-password check.
 *
 * `employeeId` MUST be resolved from the verified JWT (req.employeeId, set
 * by middlewares/auth.js) — never from the request body.
 *
 * @param {number} employeeId - id resolved from the JWT
 * @param {string} newPassword - plaintext, already Joi-validated against the password policy
 * @returns {Promise<{ message: string }>}
 * @throws {Error} statusCode 404 'Employee not found.'
 */
async function changePassword(employeeId, newPassword) {
  const updated = await employeeRepository.updatePassword(employeeId, newPassword);
  if (!updated) {
    const err = new Error('Employee not found.');
    err.statusCode = 404;
    err.code = 'EMPLOYEE_NOT_FOUND';
    err.isOperational = true;
    throw err;
  }

  logger.info('Password changed successfully', { employeeId });

  return { message: 'Password updated successfully.' };
}

/**
 * Retrieve the full profile for the currently authenticated employee.
 *
 * @param {number} employeeId
 * @returns {Promise<object>} Sanitised employee object with roles/BUs.
 * @throws {{ statusCode: number, message: string, isOperational: boolean }}
 */
async function getProfile(employeeId) {
  const employee = await authRepository.findEmployeeById(employeeId);

  if (!employee) {
    const err = new Error('Employee not found.');
    err.statusCode = 404;
    err.code = 'EMPLOYEE_NOT_FOUND';
    err.isOperational = true;
    throw err;
  }

  return sanitiseEmployee(employee);
}

module.exports = {
  login,
  loginWithMicrosoft,
  selectRole,
  switchRole,
  logout,
  refreshToken,
  getProfile,
  changePassword,
};
