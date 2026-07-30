'use strict';

const { Op } = require('sequelize');
const { User, Employee, Role, sequelize } = require('../models');

/**
 * User Repository
 * Raw database access only — no business logic.
 */

/**
 * Standard include config for user queries: joins employee and role data.
 */
const DEFAULT_INCLUDE = [
  {
    model: Employee,
    as: 'employee',
    attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
    required: false,
  },
  {
    model: Role,
    as: 'role',
    attributes: ['id', 'role_name', 'permission', 'status', 'is_original_data_visible'],
    required: false,
  },
  {
    model: Role,
    as: 'roles',
    attributes: ['id', 'role_name', 'permission', 'status', 'is_original_data_visible'],
    through: { attributes: [] },
    required: false,
  },
];

/**
 * Fetch a paginated list of users.
 * Supports search on email, filter by status and role_id.
 *
 * @param {object} filters    - { search, status, role_id }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort       - { sortBy, sortOrder }
 * @returns {Promise<{ rows: User[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, role_id, companyId } = filters;
  const { limit = 20, offset = 0 } = pagination;
  const { sortBy: requestedSortBy = 'created_at', sortOrder = 'DESC' } = sort;
  // Defense-in-depth allowlist matching userValidation.js's sort_by enum
  // (email, created_at, last_login) — the route already validates this, but
  // the repository shouldn't trust an unvalidated caller to interpolate a
  // column name into the ORDER BY clause.
  const allowedSortColumns = ['email', 'created_at', 'last_login'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  const where = { is_deleted: false, company_id: companyId };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where.email = { [Op.iLike]: `%${search.trim()}%` };
  }

  const include = DEFAULT_INCLUDE.map((inc) => ({
    ...inc,
    through: inc.through ? { ...inc.through } : undefined,
  }));

  let subQuery;

  if (role_id) {
    include.forEach((inc) => {
      if (inc.as === 'roles') {
        inc.required = false;
        inc.where = { id: parseInt(role_id, 10) };
      }
    });

    where[Op.or] = [
      { role_id: parseInt(role_id, 10) },
      { '$roles.id$': parseInt(role_id, 10) },
    ];

    // Referencing the joined "roles" table in a top-level where is incompatible
    // with Sequelize's default subQuery pagination (the inner LIMIT/OFFSET
    // subquery has no join to "roles" yet), which raises a Postgres
    // "missing FROM-clause entry for table roles" error. Disable it here.
    subQuery = false;
  }

  return User.findAndCountAll({
    where,
    include,
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
    subQuery,
  });
};

/**
 * Find a single user by primary key, including employee and role.
 * @param {number} id
 * @returns {Promise<User|null>}
 */
const findById = async (id, companyId) => {
  const where = { id, is_deleted: false };
  // companyId is optional here (unlike other repositories) — rbacService.js
  // calls this without one for a cross-cutting existence check that isn't
  // company-scoped yet (a known follow-up, not this retrofit's scope);
  // callers that do pass one (userService.js) get properly scoped.
  if (companyId !== undefined) where.company_id = companyId;
  return User.findOne({ where, include: DEFAULT_INCLUDE });
};

/**
 * Find a user by email address (default scope excludes password).
 * @param {string} email
 * @returns {Promise<User|null>}
 */
const findByEmail = async (email) => {
  return User.findOne({ where: { email: email.toLowerCase(), is_deleted: false } });
};

/**
 * Find a user by email, including the password field.
 * Required for authentication and password verification flows.
 * @param {string} email
 * @returns {Promise<User|null>}
 */
const findByEmailWithPassword = async (email) => {
  return User.scope('withPassword').findOne({ where: { email: email.toLowerCase(), is_deleted: false } });
};

/**
 * Insert a new user record.
 * Password hashing is handled by the User model beforeCreate hook.
 * @param {object} data
 * @returns {Promise<User>}
 */
const create = async (data, options = {}) => {
  return User.create(data, options);
};

/**
 * Update an existing user by primary key.
 * @param {number} id
 * @param {object} data
 * @param {object} [options]
 * @returns {Promise<User|null>}
 */
const update = async (id, data, options = {}, companyId) => {
  const where = { id };
  if (companyId !== undefined) where.company_id = companyId;
  const user = await User.findOne({ where });
  if (!user) return null;
  return user.update(data, options);
};

/**
 * Soft-delete a user by setting status to 'inactive'.
 * @param {number} id
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<User|null>}
 */
const softDelete = async (id, updatedBy, companyId) => {
  const user = await User.findOne({ where: { id, is_deleted: false, company_id: companyId } });
  if (!user) return null;
  return user.update({ status: 'inactive', is_deleted: true, updated_by: updatedBy });
};

module.exports = {
  findAll,
  findById,
  findByEmail,
  findByEmailWithPassword,
  create,
  update,
  softDelete,
};
