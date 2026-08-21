'use strict';

const { Op } = require('sequelize');
const { User, Employee, Role, sequelize } = require('../models');

/**
 * User Repository
 * Raw database access only — no business logic.
 */

/**
 * Standard include config for user queries: joins employee, PRIMARY role,
 * and ADDITIONAL role data. users.role_id (the `role` include) remains the
 * sole source of truth for hierarchy/scoping — the `additionalRoles`
 * include is a purely additive capability grant, never read for those
 * decisions. See database/migrations/20260850_add_user_additional_roles.sql
 * and roleHierarchyService.getEffectiveCapabilitiesForRoleIds().
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
    attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
    required: false,
  },
  {
    model: Role,
    as: 'additionalRoles',
    attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
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
  const { search, status, role_id, companyId, accessWhere } = filters;
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

  // accessWhere (userAccessControlService.resolveUserAccessWhere) is the
  // authoritative object-level scope when supplied, applied BEFORE
  // pagination/search/role filters — a caller can never widen it via
  // company_id/role_id/search/page/limit, since none of those keys can
  // collide with or override it.
  const where = accessWhere
    ? { is_deleted: false, ...accessWhere }
    : { is_deleted: false, company_id: companyId };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where.email = { [Op.iLike]: `%${search.trim()}%` };
  }

  if (role_id) {
    where.role_id = parseInt(role_id, 10);
  }

  return User.findAndCountAll({
    where,
    include: DEFAULT_INCLUDE,
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
  });
};

/**
 * Find a single user by primary key, including employee and role.
 *
 * `accessWhere` (userAccessControlService.resolveUserAccessWhere), when
 * supplied, is the authoritative object-level scope and takes precedence
 * over the plain companyId filter — merged into this SAME query so an
 * out-of-scope User and a nonexistent one both simply fail to match a row,
 * never distinguishable from the response (see userController.getById).
 *
 * @param {number} id
 * @param {number} [companyId]
 * @param {object} [accessWhere]
 * @returns {Promise<User|null>}
 */
const findById = async (id, companyId, accessWhere = null) => {
  if (accessWhere) {
    return User.findOne({ where: { id, is_deleted: false, ...accessWhere }, include: DEFAULT_INCLUDE });
  }
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
 * Find the single User linked to one Employee (users.employee_id — a
 * partial unique index enforces at most one). Used by employeeService.js
 * to update an Employee's login email, since Employee itself carries no
 * email column.
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<User|null>}
 */
const findByEmployeeId = async (employeeId, companyId) => {
  return User.findOne({ where: { employee_id: employeeId, company_id: companyId, is_deleted: false } });
};

/**
 * Fetch multiple users by id in one query, including their linked
 * Employee's full_name — used to resolve a display name for a set of
 * Manager user ids at once (e.g. employeeService.js's Primary/Secondary
 * Manager id+name attachment) without N+1 queries.
 * @param {number[]} ids
 * @returns {Promise<User[]>}
 */
const findByIds = async (ids) => {
  if (!ids || ids.length === 0) return [];
  return User.findAll({
    where: { id: { [Op.in]: ids }, is_deleted: false },
    attributes: ['id', 'email'],
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['full_name'],
        required: false,
      },
    ],
  });
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

/**
 * Fetch a paginated list of Users scoped to MULTIPLE companies at once,
 * filtered to a specific role — the "BU Admin Master" module's data source
 * (Entity Admin manages BU Admins across every Company under their owned
 * Entities, unlike every other caller of this repository which is scoped
 * to a single companyId). Additive export — findAll above is untouched.
 *
 * @param {number[]} companyIds
 * @param {number} roleId - resolved by the caller via roleRepository.findByName
 * @param {object} filters - { search, status }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort - { sortBy, sortOrder }
 * @returns {Promise<{ rows: User[], count: number }>}
 */
const findByCompanyIdsAndRole = async (companyIds, roleId, filters = {}, pagination = {}, sort = {}) => {
  const { search, status } = filters;
  const { limit = 20, offset = 0 } = pagination;
  const { sortBy: requestedSortBy = 'created_at', sortOrder = 'DESC' } = sort;
  const allowedSortColumns = ['email', 'created_at', 'last_login'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  if (!companyIds || companyIds.length === 0) {
    return { rows: [], count: 0 };
  }

  const where = {
    is_deleted: false,
    company_id: { [Op.in]: companyIds },
    role_id: roleId,
  };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where.email = { [Op.iLike]: `%${search.trim()}%` };
  }

  return User.findAndCountAll({
    where,
    include: DEFAULT_INCLUDE,
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
  });
};

/**
 * Fetch a paginated list of Users holding one role, scoped to whoever
 * created them — Admin's "View Entity Admins" module's data source. Entity
 * Admin (and Admin) users always have company_id NULL by design (see
 * resolveCompany.js), so there is no company to scope by; created_by (the
 * Admin who created this Entity Admin) is the scoping axis instead — see
 * entityAdminService.js's doc comment.
 *
 * @param {number} roleId - resolved by the caller via roleRepository.findByName
 * @param {object} filters - { search, status, createdBy }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort - { sortBy, sortOrder }
 * @returns {Promise<{ rows: User[], count: number }>}
 */
const findByRole = async (roleId, filters = {}, pagination = {}, sort = {}) => {
  const { search, status, createdBy } = filters;
  const { limit = 20, offset = 0 } = pagination;
  const { sortBy: requestedSortBy = 'created_at', sortOrder = 'DESC' } = sort;
  const allowedSortColumns = ['email', 'created_at', 'last_login'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  const where = { is_deleted: false, role_id: roleId, created_by: createdBy };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where.email = { [Op.iLike]: `%${search.trim()}%` };
  }

  return User.findAndCountAll({
    where,
    include: DEFAULT_INCLUDE,
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
  });
};

/**
 * Fetch a paginated list of Users whose id is in a given set, filtered to a
 * specific role — the "BU Head Master" module's data source. A BU Head has
 * no single company_id (NULL, like Entity Admin/Admin — see
 * resolveCompany.js), so unlike findByCompanyIdsAndRole (BU Admin Master),
 * scoping is driven by an explicit id set the caller has already resolved
 * (buHeadService.js: every BU Head mapped to a Company under the calling
 * Entity Admin/Admin's owned Entities — see
 * buHeadCompanyMappingRepository.findBuHeadUserIdsForCompanyIds). Additive
 * export — every existing function above is untouched.
 *
 * @param {number[]} userIds
 * @param {number} roleId - resolved by the caller via roleRepository.findByName
 * @param {object} filters - { search, status }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort - { sortBy, sortOrder }
 * @returns {Promise<{ rows: User[], count: number }>}
 */
const findByIdsInAndRole = async (userIds, roleId, filters = {}, pagination = {}, sort = {}) => {
  const { search, status } = filters;
  const { limit = 20, offset = 0 } = pagination;
  const { sortBy: requestedSortBy = 'created_at', sortOrder = 'DESC' } = sort;
  const allowedSortColumns = ['email', 'created_at', 'last_login'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  if (!userIds || userIds.length === 0) {
    return { rows: [], count: 0 };
  }

  const where = {
    is_deleted: false,
    id: { [Op.in]: userIds },
    role_id: roleId,
  };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where.email = { [Op.iLike]: `%${search.trim()}%` };
  }

  return User.findAndCountAll({
    where,
    include: DEFAULT_INCLUDE,
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
  });
};

/**
 * Lightweight fetch of every non-deleted user's email (lowercased), for
 * bulk-import uniqueness validation — email is unique across the whole
 * `users` table (not per-company, see users_email_key), so this
 * intentionally isn't companyId-scoped.
 * @returns {Promise<string[]>}
 */
const findAllEmails = async () => {
  const users = await User.findAll({ where: { is_deleted: false }, attributes: ['email'], raw: true });
  return users.map((u) => u.email.toLowerCase());
};

module.exports = {
  findAll,
  findById,
  findByEmail,
  findByEmailWithPassword,
  findByEmployeeId,
  findByIds,
  findAllEmails,
  create,
  update,
  softDelete,
  findByCompanyIdsAndRole,
  findByRole,
  findByIdsInAndRole,
};
