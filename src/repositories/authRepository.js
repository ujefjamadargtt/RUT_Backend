'use strict';

const { Op } = require('sequelize');
const { User, UserSession, Role, Employee, Company } = require('../models');

// PRIMARY role stays the sole source of truth for hierarchy/scoping; this
// is a purely additive capability grant, unioned into effective
// capabilities only — see database/migrations/20260850_add_user_additional_roles.sql
// and authService.js's serialiseRoles().
const ADDITIONAL_ROLES_INCLUDE = {
  model: Role,
  as: 'additionalRoles',
  attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
  through: { attributes: [] },
  required: false,
};
const logger = require('../utils/logger');
const dateHelper = require('../helpers/dateHelper');

/**
 * Auth Repository
 *
 * Responsible exclusively for data-access operations related to authentication.
 * No business logic lives here — all decisions belong in authService.js.
 *
 * Single identity table (`users`) for every account tier, including
 * Employees — see database/migrations/20260842_employees_drop_login_columns.sql.
 * There is no longer a parallel Employee lookup/session store.
 */

/**
 * Find a user by email address.
 * Returns the user with their role and linked employee joined (password
 * excluded via defaultScope). Use User.scope('withPassword') before calling
 * if the password hash is needed.
 *
 * @param {string} email - Normalised, lowercase email address.
 * @returns {Promise<User|null>}
 */
async function findUserByEmail(email) {
  return User.scope('withPassword').findOne({
    where: {
      email: email.toLowerCase().trim(),
    },
    // The Role include deliberately does NOT list is_original_data_visible,
    // and the Company include DOES: the login response's
    // roles[].is_original_data_visible is sourced from the user's COMPANY
    // (see authService.js's serialiseRoles()), not from Role, and not from
    // a users-table column — see database/migrations/
    // 20260808_add_company_original_data_visibility.sql.
    include: [
      {
        model: Role,
        as: 'role',
        attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
      },
      ADDITIONAL_ROLES_INCLUDE,
      {
        model: Employee,
        as: 'employee',
        required: false,
      },
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'company_code', 'company_name', 'status', 'is_original_data_visible'],
        required: false,
      },
    ],
  });
}

/**
 * Find a user by primary key.
 * Returns the user with their role and linked employee record.
 * Password is excluded (defaultScope).
 *
 * @param {number} id - User primary key.
 * @returns {Promise<User|null>}
 */
async function findUserById(id) {
  return User.findOne({
    where: { id },
    include: [
      {
        model: Role,
        as: 'role',
        attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
      },
      ADDITIONAL_ROLES_INCLUDE,
      {
        model: Employee,
        as: 'employee',
        required: false,
      },
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'company_code', 'company_name', 'status'],
        required: false,
      },
    ],
    attributes: { exclude: ['password'] },
  });
}

/**
 * Stamp the last_login timestamp for a user.
 *
 * @param {number} userId
 * @returns {Promise<[number]>} Sequelize update result tuple.
 */
async function updateLastLogin(userId) {
  return User.update(
    { last_login: dateHelper.nowDate() },
    { where: { id: userId } }
  );
}

/**
 * Persist a new user session record — one row per issued refresh token.
 * `jti`/`family_id` back the rotation/replay-detection mechanism (see
 * database/migrations/20260857_add_refresh_token_rotation.sql); `jti` is
 * unique per issuance, `family_id` is shared across every token descended
 * from one login.
 *
 * @param {object} sessionData
 * @param {number} sessionData.user_id
 * @param {string} sessionData.refresh_token
 * @param {string} sessionData.jti
 * @param {string} sessionData.family_id
 * @param {Date}   sessionData.expires_at
 * @param {string} [sessionData.ip_address]
 * @param {string} [sessionData.user_agent]
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<UserSession>}
 */
async function createSession(sessionData, options = {}) {
  return UserSession.create({
    user_id: sessionData.user_id,
    refresh_token: sessionData.refresh_token,
    jti: sessionData.jti,
    family_id: sessionData.family_id,
    expires_at: sessionData.expires_at,
    ip_address: sessionData.ip_address || null,
    user_agent: sessionData.user_agent || null,
  }, options);
}

const SESSION_USER_INCLUDE = [
  {
    model: User,
    as: 'user',
    attributes: ['id', 'email', 'role_id', 'employee_id', 'company_id', 'status'],
    include: [
      {
        model: Role,
        as: 'role',
        attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
      },
      ADDITIONAL_ROLES_INCLUDE,
      // is_original_data_visible sourced from the user's COMPANY, not
      // from Role or a users-table column — see authService.js's
      // serialiseRoles() and database/migrations/
      // 20260808_add_company_original_data_visibility.sql. Without this
      // include, refreshToken()'s serialiseRoles() call would always
      // see it as undefined.
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'is_original_data_visible'],
        required: false,
      },
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'status', 'is_deleted'],
        required: false,
      },
    ],
  },
];

/**
 * Look up a LIVE (unrevoked, unexpired) session by its refresh token's own
 * `jti` claim — the sole lookup key for the refresh flow now, replacing a
 * match on the raw token string. Read-only; does not consume the session
 * (see consumeSessionByJti() below for the atomic, one-time-use step).
 *
 * @param {string} jti
 * @returns {Promise<UserSession|null>}
 */
async function findActiveSessionByJti(jti) {
  return UserSession.findOne({
    where: {
      jti,
      revoked_at: null,
      expires_at: { [Op.gt]: dateHelper.nowDate() },
    },
    include: SESSION_USER_INCLUDE,
  });
}

/**
 * Look up a session by `jti` REGARDLESS of revoked/expired state, with the
 * owning User/Role/Company joined the same way findActiveSessionByJti()
 * does — authService.refreshToken() uses this single lookup both to
 * distinguish "unknown jti" from "already consumed" (replay) AND, when the
 * session turns out to still be live, as the source of the User record the
 * rotation itself needs (role/company for the response payload).
 *
 * @param {string} jti
 * @returns {Promise<UserSession|null>}
 */
async function findSessionByJti(jti) {
  return UserSession.findOne({ where: { jti }, include: SESSION_USER_INCLUDE });
}

/**
 * Atomically consume (soft-revoke) a session by `jti` — the single-use
 * guarantee refresh-token rotation depends on. The `revoked_at IS NULL`
 * guard in the WHERE clause is what makes this safe under concurrent
 * requests presenting the SAME refresh token: Postgres serializes
 * concurrent UPDATEs touching the same row, so at most one of them can
 * ever affect a row here — the loser sees 0 rows affected and must treat
 * the token as already consumed, never issuing a second child token pair.
 * Soft-revoke (not delete) so a later replay of this same jti is still
 * recognizable as reuse rather than "unknown token" — see
 * findSessionByJti() above.
 *
 * @param {string} jti
 * @param {string} replacedByJti - the newly issued token's jti, for lineage tracing
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<number>} 1 if this call consumed the session, 0 if it was already revoked/gone
 */
async function consumeSessionByJti(jti, replacedByJti, options = {}) {
  const [affectedCount] = await UserSession.update(
    { revoked_at: dateHelper.nowDate(), replaced_by_jti: replacedByJti },
    { where: { jti, revoked_at: null }, ...options }
  );
  return affectedCount;
}

/**
 * Revoke every currently-active session in a family in one statement — the
 * replay-detection response: presenting an already-consumed refresh token
 * is treated as a signal the token may have been stolen, so the entire
 * lineage descended from the same login is killed, forcing a fresh login.
 *
 * @param {string} familyId
 * @returns {Promise<number>} number of sessions revoked
 */
async function revokeFamily(familyId) {
  const [affectedCount] = await UserSession.update(
    { revoked_at: dateHelper.nowDate() },
    { where: { family_id: familyId, revoked_at: null } }
  );
  return affectedCount;
}

/**
 * Soft-revoke one session by `jti` — logout. Idempotent (an already-
 * revoked or unknown jti simply affects 0 rows; the caller treats this as
 * success either way, matching the existing "logout is always a success
 * from the client's perspective" behavior).
 *
 * @param {string} jti
 * @returns {Promise<number>}
 */
async function revokeSessionByJti(jti) {
  const [affectedCount] = await UserSession.update(
    { revoked_at: dateHelper.nowDate() },
    { where: { jti, revoked_at: null } }
  );
  return affectedCount;
}

/**
 * Remove all sessions belonging to a user.
 * Use this on password change, account suspension, or admin-forced logout.
 *
 * @param {number} userId
 * @returns {Promise<number>} Number of rows deleted.
 */
async function deleteUserSessions(userId) {
  return UserSession.destroy({
    where: { user_id: userId },
  });
}

module.exports = {
  findUserByEmail,
  findUserById,
  updateLastLogin,
  createSession,
  findActiveSessionByJti,
  findSessionByJti,
  consumeSessionByJti,
  revokeFamily,
  revokeSessionByJti,
  deleteUserSessions,
};
