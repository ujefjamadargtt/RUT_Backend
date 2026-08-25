'use strict';

const { Op } = require('sequelize');
const { Employee, EmployeeLoginSession, Role, Company } = require('../models');
const logger = require('../utils/logger');
const dateHelper = require('../helpers/dateHelper');

/**
 * Auth Repository
 *
 * Responsible exclusively for data-access operations related to authentication.
 * No business logic lives here — all decisions belong in authService.js.
 *
 * Employee is the sole login identity now (Employee-as-Identity redesign,
 * database/migrations/20260864-20260880) — `users` stays in the DB
 * (never dropped) but is no longer read or written by this file.
 */

// through.attributes keeps employee_roles.status alongside each joined
// Role (surfaced as role.EmployeeRole.status) — a role can be globally
// active/inactive (roles.status) independently of whether THIS employee's
// grant of it is active (employee_roles.status); authService.js's login
// checks both.
const ROLES_INCLUDE = {
  model: Role,
  as: 'roles',
  attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
  through: { attributes: ['status'] },
};

const BUSINESS_UNITS_INCLUDE = {
  model: Company,
  as: 'businessUnits',
  attributes: ['id', 'company_code', 'company_name', 'status', 'is_original_data_visible'],
  through: { attributes: ['status'] },
};

/**
 * Find an employee by email address, with roles and business units
 * joined. Returns the employee with password included (defaultScope
 * excludes it — use Employee.scope('withPassword')).
 *
 * @param {string} email - Normalised, lowercase email address.
 * @returns {Promise<Employee|null>}
 */
async function findEmployeeByEmail(email) {
  return Employee.scope('withPassword').findOne({
    where: {
      email: email.toLowerCase().trim(),
    },
    include: [ROLES_INCLUDE, BUSINESS_UNITS_INCLUDE],
  });
}

/**
 * Find an employee by primary key, with roles and business units joined.
 * Password excluded (defaultScope).
 *
 * @param {number} id - Employee primary key.
 * @returns {Promise<Employee|null>}
 */
async function findEmployeeById(id) {
  return Employee.findOne({
    where: { id },
    include: [ROLES_INCLUDE, BUSINESS_UNITS_INCLUDE],
  });
}

/**
 * Stamp the last_login timestamp for an employee. Employee has no
 * last_login column of its own (never carried one) — logged only, not
 * persisted, to avoid a schema change purely for this. Kept as a no-op
 * hook point so callers don't need to change if a column is added later.
 *
 * @param {number} employeeId
 * @returns {Promise<void>}
 */
async function updateLastLogin(employeeId) {
  logger.info('Employee logged in', { employeeId });
}

/**
 * Persist a new employee login session record — one row per issued
 * refresh token. `jti`/`family_id` back the rotation/replay-detection
 * mechanism (mirrors user_sessions' shape).
 *
 * @param {object} sessionData
 * @param {number} sessionData.employee_id
 * @param {string} sessionData.refresh_token
 * @param {string} sessionData.jti
 * @param {string} sessionData.family_id
 * @param {Date}   sessionData.expires_at
 * @param {string} [sessionData.ip_address]
 * @param {string} [sessionData.user_agent]
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<EmployeeLoginSession>}
 */
async function createSession(sessionData, options = {}) {
  return EmployeeLoginSession.create({
    employee_id: sessionData.employee_id,
    refresh_token: sessionData.refresh_token,
    jti: sessionData.jti,
    family_id: sessionData.family_id,
    expires_at: sessionData.expires_at,
    ip_address: sessionData.ip_address || null,
    user_agent: sessionData.user_agent || null,
  }, options);
}

const SESSION_EMPLOYEE_INCLUDE = [
  {
    model: Employee,
    as: 'employee',
    attributes: ['id', 'email', 'status', 'is_deleted', 'company_id'],
    include: [ROLES_INCLUDE, BUSINESS_UNITS_INCLUDE],
  },
];

/**
 * Look up a LIVE (unrevoked, unexpired) session by its refresh token's own
 * `jti` claim. Read-only; does not consume the session.
 *
 * @param {string} jti
 * @returns {Promise<EmployeeLoginSession|null>}
 */
async function findActiveSessionByJti(jti) {
  return EmployeeLoginSession.findOne({
    where: {
      jti,
      revoked_at: null,
      expires_at: { [Op.gt]: dateHelper.nowDate() },
    },
    include: SESSION_EMPLOYEE_INCLUDE,
  });
}

/**
 * Look up a session by `jti` REGARDLESS of revoked/expired state, with the
 * owning Employee/roles/businessUnits joined — authService.refreshToken()
 * uses this single lookup both to distinguish "unknown jti" from "already
 * consumed" (replay) AND, when the session is still live, as the source of
 * the Employee record the rotation itself needs.
 *
 * @param {string} jti
 * @returns {Promise<EmployeeLoginSession|null>}
 */
async function findSessionByJti(jti) {
  return EmployeeLoginSession.findOne({ where: { jti }, include: SESSION_EMPLOYEE_INCLUDE });
}

/**
 * Atomically consume (soft-revoke) a session by `jti` — the single-use
 * guarantee refresh-token rotation depends on. See the equivalent
 * user_sessions logic this replaces: the `revoked_at IS NULL` guard makes
 * this safe under concurrent requests presenting the SAME refresh token.
 *
 * @param {string} jti
 * @param {string} replacedByJti
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<number>} 1 if this call consumed the session, 0 if already revoked/gone
 */
async function consumeSessionByJti(jti, replacedByJti, options = {}) {
  const [affectedCount] = await EmployeeLoginSession.update(
    { revoked_at: dateHelper.nowDate(), replaced_by_jti: replacedByJti },
    { where: { jti, revoked_at: null }, ...options }
  );
  return affectedCount;
}

/**
 * Revoke every currently-active session in a family in one statement — the
 * replay-detection response.
 *
 * @param {string} familyId
 * @returns {Promise<number>} number of sessions revoked
 */
async function revokeFamily(familyId) {
  const [affectedCount] = await EmployeeLoginSession.update(
    { revoked_at: dateHelper.nowDate() },
    { where: { family_id: familyId, revoked_at: null } }
  );
  return affectedCount;
}

/**
 * Soft-revoke one session by `jti` — logout. Idempotent.
 *
 * @param {string} jti
 * @returns {Promise<number>}
 */
async function revokeSessionByJti(jti) {
  const [affectedCount] = await EmployeeLoginSession.update(
    { revoked_at: dateHelper.nowDate() },
    { where: { jti, revoked_at: null } }
  );
  return affectedCount;
}

/**
 * Remove all sessions belonging to an employee.
 * Use this on password change, account suspension, or admin-forced logout.
 *
 * @param {number} employeeId
 * @returns {Promise<number>} Number of rows deleted.
 */
async function deleteEmployeeSessions(employeeId) {
  return EmployeeLoginSession.destroy({
    where: { employee_id: employeeId },
  });
}

/**
 * Persist Microsoft's stable object id (the `oid` claim) against an employee
 * on a successful Microsoft SSO login — see authService.loginWithMicrosoft().
 * Best-effort by design: the caller treats a failure here as non-fatal to
 * the login itself, since email remains the sole login-matching key and this
 * value is stored for audit/future hardening only.
 *
 * @param {number} employeeId
 * @param {string} microsoftObjectId
 * @returns {Promise<void>}
 */
async function updateMicrosoftObjectId(employeeId, microsoftObjectId) {
  await Employee.update(
    { microsoft_object_id: microsoftObjectId },
    { where: { id: employeeId } }
  );
}

module.exports = {
  findEmployeeByEmail,
  findEmployeeById,
  updateLastLogin,
  createSession,
  findActiveSessionByJti,
  findSessionByJti,
  consumeSessionByJti,
  revokeFamily,
  revokeSessionByJti,
  deleteEmployeeSessions,
  updateMicrosoftObjectId,
};
