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
 * Persist a new user session record.
 *
 * @param {object} sessionData
 * @param {number} sessionData.user_id
 * @param {string} sessionData.refresh_token
 * @param {Date}   sessionData.expires_at
 * @param {string} [sessionData.ip_address]
 * @param {string} [sessionData.user_agent]
 * @returns {Promise<UserSession>}
 */
async function createSession(sessionData) {
  return UserSession.create({
    user_id: sessionData.user_id,
    refresh_token: sessionData.refresh_token,
    expires_at: sessionData.expires_at,
    ip_address: sessionData.ip_address || null,
    user_agent: sessionData.user_agent || null,
  });
}

/**
 * Look up a session by refresh token that has not yet expired.
 *
 * @param {string} refreshToken
 * @returns {Promise<UserSession|null>}
 */
async function findSession(refreshToken) {
  return UserSession.findOne({
    where: {
      refresh_token: refreshToken,
      expires_at: {
        [Op.gt]: dateHelper.nowDate(),
      },
    },
    include: [
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
        ],
      },
    ],
  });
}

/**
 * Remove a specific session by its refresh token.
 * Returns the number of rows deleted.
 *
 * @param {string} refreshToken
 * @returns {Promise<number>}
 */
async function deleteSession(refreshToken) {
  return UserSession.destroy({
    where: { refresh_token: refreshToken },
  });
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
  findSession,
  deleteSession,
  deleteUserSessions,
};
