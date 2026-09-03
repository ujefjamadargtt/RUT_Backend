'use strict';

const { Op } = require('sequelize');
const { Employee, ServicePOResource, ServicePO, EmployeeBusinessUnit } = require('../models');

/**
 * Employee Repository
 * Raw database access — no business logic.
 */

/**
 * Builds a `company_id` WHERE fragment that's safe to spread even when the
 * caller has no single company (Admin/Entity Admin/Platform Admin — their
 * own `employees.company_id` is NULL by design, and they legitimately
 * manage Employees across many companies, not one). Passing
 * `company_id: undefined` straight into a Sequelize `where` throws
 * ("WHERE parameter \"company_id\" has invalid \"undefined\" value") —
 * this omits the key entirely instead, so those actors' requests reach the
 * intended row rather than crashing. Deliberately permissive rather than
 * scoped-by-entity here: callers senior enough to have no companyId have
 * already cleared `isSeniorTier`/route-level `authorize()` checks upstream.
 *
 * Array-aware (same shape as clientRepository.js/projectRepository.js/
 * servicePORepository.js's companyScope) so a caller that HAS resolved a
 * company-less Admin/Entity Admin's owned-Company-id array via
 * companyAccessControlService.resolveActorCompanyScope can pass it straight
 * through as a proper `IN (...)` filter instead of falling back to `{}`.
 *
 * @param {number|number[]|null|undefined} companyId
 * @returns {object} `{ company_id: companyId }`, `{ company_id: { [Op.in]: companyId } }`, or `{}`
 */
function companyScope(companyId) {
  if (Array.isArray(companyId)) {
    return { company_id: { [Op.in]: companyId } };
  }
  return companyId != null ? { company_id: companyId } : {};
}

/**
 * Same intent as companyScope(), but for queries whose base row IS the
 * Employee (so a bare `id` key unambiguously means Employee.id) — an
 * Employee created after the Employee-Business-Unit redesign
 * (database/migrations/20260866_create_employee_business_units.sql) never
 * gets its own `company_id` populated; its Company/BU membership lives
 * exclusively in `employee_business_units` now (see that model's doc
 * comment: "replacing the old single users.company_id column"). Matching
 * on `company_id` alone therefore 404s every such Employee for any
 * company-scoped lookup (e.g. mapping them to a Service PO). This ORs the
 * legacy column with an active employee_business_units membership so both
 * old and new Employees resolve. NOT safe to reuse for a query on a
 * different model (e.g. findActiveAllocations() below queries
 * ServicePOResource/ServicePO, where `id` means something else) — those
 * keep using the plain companyScope() above.
 *
 * @param {number|number[]|null|undefined} companyId
 * @returns {Promise<object>}
 */
async function employeeScope(companyId) {
  if (companyId == null) return {};

  const companyIdCondition = Array.isArray(companyId) ? { [Op.in]: companyId } : companyId;
  const buRows = await EmployeeBusinessUnit.findAll({
    where: {
      business_unit_id: Array.isArray(companyId) ? { [Op.in]: companyId } : companyId,
      status: 'active',
    },
    attributes: ['employee_id'],
    raw: true,
  });

  if (buRows.length === 0) {
    return { company_id: companyIdCondition };
  }

  return {
    [Op.or]: [
      { company_id: companyIdCondition },
      { id: { [Op.in]: buRows.map((row) => row.employee_id) } },
    ],
  };
}

/**
 * Fetch a paginated, filtered, sorted list of employees.
 *
 * `businessUnitId`, when given, narrows the result down to employees
 * mapped to (or, for a legacy row, carrying the company_id of) that ONE
 * Business Unit — combined via a separate `Op.and` key so it stacks on top
 * of whatever `accessWhere`/`companyId` already restricted the query to,
 * rather than replacing it; it can only further narrow the caller's own
 * access scope, never widen it. Uses employeeScope() (not a bare
 * `company_id` match) for the same reason accessWhere already does — an
 * Employee created after the Employee-Business-Unit redesign never gets
 * its own `company_id` populated.
 *
 * @param {object} filters    - { search, status, designation, businessUnitId }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort       - { sortBy, sortOrder }
 * @returns {Promise<{ rows: Employee[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, designation, companyId, accessWhere, businessUnitId } = filters;
  const { limit = 20, offset = 0 } = pagination;
  const { sortBy: requestedSortBy = 'created_at', sortOrder = 'DESC' } = sort;
  // Defense-in-depth allowlist matching employeeValidation.js's sort_by enum
  // — the route already validates this, but the repository shouldn't trust
  // an unvalidated caller to interpolate a column name into ORDER BY.
  const allowedSortColumns = ['full_name', 'employee_code', 'date_of_joining', 'created_at', 'designation'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  // accessWhere (employeeAccessControlService.resolveEmployeeAccessWhere) is
  // the authoritative object-level scope when supplied — it already decides
  // company_id (or an explicit id-in-scope list) per the caller's role, so
  // it takes precedence over the raw companyId fallback other, non-scoped
  // callers of this same filters shape still rely on.
  const where = accessWhere
    ? { is_deleted: false, ...accessWhere }
    : { is_deleted: false, ...(await employeeScope(companyId)) };

  // Status filter — omit clause entirely when 'all' is requested
  if (status && status !== 'all') {
    where.status = status;
  }

  // Designation filter
  if (designation) {
    where.designation = { [Op.iLike]: `%${designation}%` };
  }

  // Full-text search across full_name, employee_code, designation
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    where[Op.or] = [
      { full_name: { [Op.iLike]: term } },
      { employee_code: { [Op.iLike]: term } },
      { designation: { [Op.iLike]: term } },
    ];
  }

  // Business Unit filter — see this function's doc comment. `Op.and` is not
  // used anywhere else in this function, so this never collides with the
  // `Op.or` key search may have just set above.
  if (businessUnitId) {
    // The explicit list filter must follow the mapping table, not the
    // legacy employees.company_id column. This is the exact table updated by
    // the Role & BU Mapping feature.
    const buRows = await EmployeeBusinessUnit.findAll({
      where: { business_unit_id: businessUnitId, status: 'active' },
      attributes: ['employee_id'],
      raw: true,
    });
    where[Op.and] = [{ id: { [Op.in]: buRows.map((row) => row.employee_id) } }];
  }

  return Employee.findAndCountAll({
    where,
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
  });
};

/**
 * Find a single employee by primary key.
 * @param {number} id
 * @returns {Promise<Employee|null>}
 */
const findById = async (id, companyId) => {
  return Employee.findOne({ where: { id, is_deleted: false, ...(await employeeScope(companyId)) } });
};

/**
 * Find a single employee by primary key, including their linked User's
 * email — a separate function from findById() (which has 9 other call
 * sites across validation/service code that don't need this extra join)
 * so that GET/PUT /employees/:id can flatten `email` onto the response the
 * same way GET /employees already does, without adding an unnecessary
 * include everywhere else findById() is used.
 *
 * `accessWhere` (employeeAccessControlService.resolveEmployeeAccessWhere)
 * is merged directly into the WHERE clause of THIS SAME query, not checked
 * afterward — an Employee outside the caller's authorized scope and an
 * Employee that plain doesn't exist both simply fail to match a row here,
 * so GET /employees/:id returns the identical 404 either way and never
 * discloses which case it was. When omitted, falls back to a bare
 * companyId filter for callers that don't need per-object scoping.
 *
 * @param {number} id
 * @param {number} companyId
 * @param {object} [accessWhere] - caller's authorized-scope WHERE fragment
 * @returns {Promise<Employee|null>}
 */
const findByIdWithEmail = async (id, companyId, accessWhere = null) => {
  // Op.and, not object spread: accessWhere may itself carry an `id` key
  // (the Manager/Service PO Admin/Employee scope is an id-in-list filter) —
  // spreading it after `{ id }` would silently overwrite the requested id
  // with the scope's list instead of ANDing the two together.
  return Employee.findOne({
    where: accessWhere
      ? { [Op.and]: [{ id, is_deleted: false }, accessWhere] }
      : { id, is_deleted: false, ...(await employeeScope(companyId)) },
  });
};

/**
 * Find a single employee by their native login email (case-insensitive,
 * trimmed) — the uniqueness check at Employee creation/update time.
 *
 * @param {string} email
 * @returns {Promise<Employee|null>}
 */
const findByEmail = async (email) => {
  return Employee.findOne({ where: { email: email.toLowerCase().trim() } });
};

/**
 * Set (and hash, via the model's beforeUpdate hook) a new password for one
 * Employee — the self-service PUT /auth/change-password flow.
 *
 * @param {number} id
 * @param {string} newPassword - plaintext, already Joi-validated for policy
 * @returns {Promise<boolean>} true if a row was updated
 */
const updatePassword = async (id, newPassword) => {
  const employee = await Employee.findOne({ where: { id } });
  if (!employee) return false;
  employee.password = newPassword;
  await employee.save();
  return true;
};

/**
 * Find a single employee by employee_code, scoped to one company
 * (uniqueness is per-company — see uq_employees_company_code), regardless
 * of status or soft-delete state, so a code held by an inactive or deleted
 * employee in this company can never be reassigned.
 * @param {string} code
 * @param {number} companyId
 * @returns {Promise<Employee|null>}
 */
const findByCode = async (code, companyId) => {
  return Employee.findOne({ where: { employee_code: code, ...(await employeeScope(companyId)) } });
};

/**
 * Insert a new employee record.
 * @param {object} data
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<Employee>}
 */
const create = async (data, options = {}) => {
  return Employee.create(data, options);
};

/**
 * Update an existing employee by primary key.
 * @param {number} id
 * @param {object} data
 * @param {number} companyId
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<Employee>}
 */
const update = async (id, data, companyId, options = {}) => {
  const employee = await Employee.findOne({ where: { id, ...(await employeeScope(companyId)) }, transaction: options.transaction });
  if (!employee) return null;
  return employee.update(data, options);
};

/**
 * Soft-delete an employee by setting status to 'inactive'.
 * @param {number} id
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<Employee|null>}
 */
const softDelete = async (id, updatedBy, companyId) => {
  const employee = await Employee.findOne({ where: { id, is_deleted: false, ...(await employeeScope(companyId)) } });
  if (!employee) return null;
  return employee.update({ status: 'inactive', is_deleted: true, updated_by: updatedBy });
};

/**
 * Return all employees with status = 'active', ordered by full_name.
 *
 * `accessWhere` (employeeAccessControlService.resolveEmployeeAccessWhere),
 * when supplied, takes precedence over the raw `companyScope(companyId)`
 * fallback — same precedence rule as findAll()/findByIdWithEmail() — so a
 * company-less Admin/Entity Admin gets their own resolved scope instead of
 * companyScope's permissive `{}` (every record, cross-tenant).
 *
 * @param {number} companyId
 * @param {object} [accessWhere]
 * @returns {Promise<Employee[]>}
 */
const getActiveEmployees = async (companyId, accessWhere = null, businessUnitId = null) => {
  const where = accessWhere
    ? { [Op.and]: [{ status: 'active', is_deleted: false }, accessWhere] }
    : { status: 'active', is_deleted: false, ...(await employeeScope(companyId)) };

  if (businessUnitId) {
    const buRows = await EmployeeBusinessUnit.findAll({
      where: { business_unit_id: businessUnitId, status: 'active' },
      attributes: ['employee_id'],
      raw: true,
    });
    where[Op.and] = [...(where[Op.and] || []), { id: { [Op.in]: buRows.map((row) => row.employee_id) } }];
  }

  return Employee.findAll({
    where,
    order: [['full_name', 'ASC']],
    attributes: [
      'id',
      'employee_code',
      'full_name',
      'designation',
      'total_experience',
      'company_experience',
      'status',
    ],
  });
};

/**
 * Return every active, non-deleted Employee in one Company — the eligible
 * candidate list for Service PO Delivery Head selection. Employee no
 * longer carries its own email (see database/migrations/
 * 20260842_employees_drop_login_columns.sql) — it's sourced here from the
 * Employee's linked User account (at most one, per the one-User-per-
 * Employee unique index) instead.
 *
 * @param {number} companyId
 * @param {object} [accessWhere] - see getActiveEmployees()'s doc comment
 * @returns {Promise<Employee[]>}
 */
const getEligibleDeliveryHeads = async (companyId, accessWhere = null) => {
  return Employee.findAll({
    where: accessWhere
      ? { [Op.and]: [{ status: 'active', is_deleted: false }, accessWhere] }
      : { status: 'active', is_deleted: false, ...(await employeeScope(companyId)) },
    attributes: ['id', 'employee_code', 'full_name', 'email', 'status', 'company_id'],
    order: [['full_name', 'ASC']],
  });
};

/**
 * Active, non-deleted Employees holding ANY of the given role ids — the
 * eligible candidate list for Primary/Secondary Manager selection (must
 * hold a role with the manager.view_mapped_employees capability, see
 * employeeService.js's assertValidManager()/getEligibleManagers()). One
 * query via the Employee<->Role join, not N+1 per candidate.
 *
 * @param {number|number[]} companyId
 * @param {number[]} roleIds
 * @param {object} [accessWhere] - see getActiveEmployees()'s doc comment
 * @returns {Promise<Employee[]>}
 */
const findEligibleManagers = async (companyId, roleIds, accessWhere = null) => {
  if (!roleIds || roleIds.length === 0) return [];
  const { Role } = require('../models');
  return Employee.findAll({
    where: accessWhere
      ? { [Op.and]: [{ status: 'active', is_deleted: false }, accessWhere] }
      : { status: 'active', is_deleted: false, ...(await employeeScope(companyId)) },
    include: [{
      model: Role,
      as: 'roles',
      attributes: [],
      where: { id: { [Op.in]: roleIds } },
      through: { attributes: [] },
      required: true,
    }],
    attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
    order: [['full_name', 'ASC']],
    distinct: true,
  });
};

/**
 * Return employees whose IDs are in the provided array.
 * Used for resource allocation checks.
 * @param {number[]} ids
 * @returns {Promise<Employee[]>}
 */
const findByIds = async (ids, companyId) => {
  if (!ids || ids.length === 0) return [];
  return Employee.findAll({
    where: { id: { [Op.in]: ids }, is_deleted: false, ...(await employeeScope(companyId)) },
    order: [['full_name', 'ASC']],
  });
};

/**
 * Check if an employee is allocated to any active Service PO.
 * Returns an array of active PO records that reference this employee.
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<ServicePOResource[]>}
 */
const findActiveAllocations = async (employeeId, companyId) => {
  return ServicePOResource.findAll({
    where: { employee_id: employeeId, ...companyScope(companyId) },
    include: [
      {
        model: ServicePO,
        as: 'servicePO',
        where: { status: 'active', ...companyScope(companyId) },
        attributes: ['id', 'service_po_code', 'service_po_name', 'status'],
        required: true,
      },
    ],
  });
};

/**
 * Lightweight fetch of employees in one company (including inactive/
 * soft-deleted) for bulk import code-uniqueness validation, so a code held
 * by a deleted employee in this company is still flagged as taken rather
 * than silently reused.
 *
 * `companyId === null` (an Admin/Entity Admin import with no Business Unit
 * assigned yet — see employeeImportService.js's resolveOptionalCreateCompanyId
 * call) means "match the other company_id IS NULL employees", NOT
 * companyScope()'s usual "unrestricted" meaning for that same value —
 * otherwise this would flag every employee_code on the whole platform as
 * taken instead of just the ones actually sharing this row's (lack of a)
 * company.
 * @param {number|null} companyId
 * @returns {Promise<{ employee_code: string }[]>}
 */
const findAllForImport = async (companyId) => {
  return Employee.findAll({
    where: companyId === null ? { company_id: null } : { ...(await employeeScope(companyId)) },
    attributes: ['employee_code'],
    raw: true,
  });
};

/**
 * Every currently-registered native login email across ALL Employees
 * (Employee is the sole login identity now — email uniqueness is GLOBAL,
 * per the `employees_email_key` constraint, not scoped to one company) —
 * the bulk-import duplicate-email pre-check's data source
 * (employeeImportService.js). Excludes soft-deleted rows, same as
 * findByEmail()'s uniqueness check would in spirit, though findByEmail()
 * itself doesn't filter is_deleted (kept consistent with THIS query's own
 * purpose: rows a fresh import could actually collide with).
 *
 * @returns {Promise<string[]>} lowercased emails, nulls excluded
 */
const findAllEmails = async () => {
  const employees = await Employee.findAll({
    where: { is_deleted: false, email: { [Op.ne]: null } },
    attributes: ['email'],
    raw: true,
  });
  return employees.map((e) => e.email.toLowerCase());
};

/**
 * Every active, non-deleted Employee with no legacy `company_id` at all,
 * created by one specific actor — candidate list for the "genuinely
 * unassigned Employee" branch of employeeServicePOMappingService.
 * autoMapExistingEmployeesToCentralisedServicePO() (the mirror, in the
 * other direction, of assign()'s own unassigned-Employee fallback). Callers
 * must still confirm each candidate has NO employee_business_units row
 * either (via employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds)
 * — `company_id: null` alone doesn't guarantee that, same distinction
 * assign() itself already draws.
 *
 * @param {number} createdBy
 * @returns {Promise<{id: number}[]>}
 */
const findActiveUnassignedByCreator = async (createdBy) => {
  return Employee.findAll({
    where: { company_id: null, created_by: createdBy, status: 'active', is_deleted: false },
    attributes: ['id'],
    raw: true,
  });
};

/**
 * Fetch a paginated, filtered, sorted list of Employees holding one role,
 * scoped to whoever created them — Admin's "View Entity Admins"/Platform
 * Admin's "View Admins" module's data source. Admin/Entity Admin/Platform
 * Admin employees always have company_id NULL by design (see
 * resolveCompany.js), so there is no company to scope by; created_by (the
 * actor who created this Admin/Entity Admin) is the scoping axis instead.
 *
 * @param {number} roleId
 * @param {object} filters - { search, status, createdBy }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort - { sortBy, sortOrder }
 * @returns {Promise<{ rows: Employee[], count: number }>}
 */
const findByRoleAndCreator = async (roleId, filters = {}, pagination = {}, sort = {}) => {
  const { Role } = require('../models');
  const { search, status, createdBy } = filters;
  const { limit = 20, offset = 0 } = pagination;
  const { sortBy: requestedSortBy = 'created_at', sortOrder = 'DESC' } = sort;
  const allowedSortColumns = ['email', 'created_at', 'full_name'];
  const sortBy = allowedSortColumns.includes(requestedSortBy) ? requestedSortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes((sortOrder || '').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  const where = { is_deleted: false, created_by: createdBy };
  if (status && status !== 'all') {
    where.status = status;
  }
  if (search && search.trim()) {
    where.email = { [Op.iLike]: `%${search.trim()}%` };
  }

  return Employee.findAndCountAll({
    where,
    include: [{
      model: Role,
      as: 'roles',
      attributes: [],
      where: { id: roleId },
      through: { attributes: [] },
      required: true,
    }],
    limit,
    offset,
    order: [[sortBy, safeSortOrder]],
    distinct: true,
  });
};

/**
 * Single Employee, scoped to holding the given role AND having been
 * created by `createdBy` — see findByRoleAndCreator's doc comment.
 *
 * @param {number} id
 * @param {number} roleId
 * @param {number} createdBy
 * @returns {Promise<Employee|null>}
 */
const findByIdWithRoleAndCreator = async (id, roleId, createdBy) => {
  const { Role } = require('../models');
  return Employee.findOne({
    where: { id, is_deleted: false, created_by: createdBy },
    include: [{
      model: Role,
      as: 'roles',
      attributes: [],
      where: { id: roleId },
      through: { attributes: [] },
      required: true,
    }],
  });
};

module.exports = {
  employeeScope,
  findAll,
  findById,
  findByIdWithEmail,
  findByCode,
  findByEmail,
  updatePassword,
  findByRoleAndCreator,
  findByIdWithRoleAndCreator,
  create,
  update,
  softDelete,
  getActiveEmployees,
  getEligibleDeliveryHeads,
  findEligibleManagers,
  findByIds,
  findActiveAllocations,
  findAllForImport,
  findAllEmails,
  findActiveUnassignedByCreator,
};
