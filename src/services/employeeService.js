'use strict';

const { Op } = require('sequelize');
const { sequelize, Role, Company } = require('../models');
const employeeRepository = require('../repositories/employeeRepository');
const employeeRoleRepository = require('../repositories/employeeRoleRepository');
const employeeBusinessUnitRepository = require('../repositories/employeeBusinessUnitRepository');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const roleHierarchyService = require('./roleHierarchyService');
const employeeAccessControlService = require('./employeeAccessControlService');
const companyAccessControlService = require('./companyAccessControlService');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { generateTemporaryPassword } = require('../utils/password');
const logger = require('../utils/logger');

/**
 * Employee Service
 *
 * Employee is the sole login identity now (Employee-as-Identity redesign,
 * database/migrations/20260864-20260880) — email/password live natively
 * on `employees`, roles are many-to-many (employee_roles, no primary/
 * additional split), and Business Unit membership is many-to-many
 * (employee_business_units) rather than a single company_id. HR may also
 * assign a Primary Manager (and optional Secondary) in the same
 * transaction — both optional, so an Employee can be left unmapped and
 * assigned a manager later via update().
 */

const CAPABILITY_CAN_MANAGE_EMPLOYEES = 'manager.view_mapped_employees';

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function forbiddenError(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

/**
 * Confirm a candidate manager: exists, active, same company as the
 * Employee, and holds a role capable of managing Employees (Manager,
 * Service PO Admin, or Project Admin — anything with
 * 'manager.view_mapped_employees' in its effective capability set, direct
 * or inherited — see roleHierarchyService.js). Reused by both create() and
 * update() rather than duplicating the check.
 *
 * @param {number} managerEmployeeId
 * @param {number} companyId
 * @param {string} label - 'Primary Manager' | 'Secondary Manager', for error messages
 * @returns {Promise<Employee>}
 */
async function assertValidManager(managerEmployeeId, companyId, label) {
  const manager = await employeeRepository.findById(managerEmployeeId, companyId);
  if (!manager) {
    throw notFoundError(`${label} not found in this company.`);
  }
  if (manager.status !== 'active') {
    throw badRequestError(`${label} is not an active account.`);
  }

  const roleIds = await employeeRoleRepository.findIdsByEmployeeId(managerEmployeeId);
  if (roleIds.length === 0) {
    throw badRequestError(`${label} has no role assigned.`);
  }

  const capabilities = await roleHierarchyService.getEffectiveCapabilitiesForRoleIds(roleIds);
  if (!roleHierarchyService.hasCapability(capabilities, CAPABILITY_CAN_MANAGE_EMPLOYEES)) {
    throw badRequestError(`${label} must hold a Manager (or higher) role.`);
  }

  return manager;
}

/**
 * Upsert the PRIMARY (and optional SECONDARY) manager_employee_mappings row
 * for an Employee, inside the given transaction. Used by both create() and
 * update()'s manager-reassignment path.
 */
async function upsertManagerMapping(employeeId, mappingType, managerEmployeeId, companyId, actorId, transaction) {
  const existing = await managerEmployeeMappingRepository.findByEmployeeAndType(employeeId, mappingType);

  if (existing && existing.manager_employee_id === managerEmployeeId) {
    return existing; // already correct, no-op
  }
  if (existing) {
    await existing.destroy({ transaction });
  }

  return managerEmployeeMappingRepository.create({
    company_id: companyId,
    manager_employee_id: managerEmployeeId,
    employee_id: employeeId,
    mapping_type: mappingType,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  }, { transaction });
}

/**
 * Attach each employee's Primary/Secondary Manager id AND display name —
 * batched: one query for every mapping row across all given employees, one
 * query for every distinct manager Employee, rather than N+1 lookups per
 * employee.
 *
 * @param {object[]} employees - plain objects, each with an `id`
 * @returns {Promise<object[]>}
 */
async function attachManagers(employees) {
  if (employees.length === 0) return employees;

  const employeeIds = employees.map((employee) => employee.id);
  const mappings = await managerEmployeeMappingRepository.findByEmployeeIds(employeeIds);

  const managerEmployeeIds = [...new Set(mappings.map((mapping) => mapping.manager_employee_id))];
  const managers = await employeeRepository.findByIds(managerEmployeeIds);
  const managerById = new Map(managers.map((manager) => [manager.id, { id: manager.id, name: manager.full_name }]));

  const mappingsByEmployee = new Map();
  mappings.forEach((mapping) => {
    if (!mappingsByEmployee.has(mapping.employee_id)) {
      mappingsByEmployee.set(mapping.employee_id, {});
    }
    mappingsByEmployee.get(mapping.employee_id)[mapping.mapping_type] = mapping.manager_employee_id;
  });

  return employees.map((employee) => {
    const slots = mappingsByEmployee.get(employee.id) || {};
    const primary = slots.PRIMARY ? managerById.get(slots.PRIMARY) : null;
    const secondary = slots.SECONDARY ? managerById.get(slots.SECONDARY) : null;
    return {
      ...employee,
      primary_manager_employee_id: primary ? primary.id : null,
      primary_manager_name: primary ? primary.name : null,
      secondary_manager_employee_id: secondary ? secondary.id : null,
      secondary_manager_name: secondary ? secondary.name : null,
    };
  });
}

/**
 * @param {object} employee - Sequelize Employee instance or plain object
 * @returns {object} plain object
 */
function toPlain(employee) {
  return employee.toJSON ? employee.toJSON() : { ...employee };
}

/**
 * Attach each employee's currently-held roles and Business Units — both
 * as plain id arrays (`role_ids`/`business_unit_ids`, for the Role & BU
 * Mapping form's multi-select value binding) and as `{id, name}` objects
 * (`roles`/`business_units`, for display) — batched: one query for roles
 * and one for BUs across every employee given, not N+1 per employee.
 *
 * Deliberately only used by the single-employee detail response
 * (getByIdWithEmail/update) and NOT the list endpoint (getAll) — the list
 * screen doesn't need this, and joining employee_roles/employee_business_units
 * for every row on a paginated list would be a needless cost there.
 *
 * @param {object[]} employees - plain objects, each with an `id`
 * @returns {Promise<object[]>}
 */
async function attachRoleAndBusinessUnitInfo(employees) {
  if (employees.length === 0) return employees;

  const employeeIds = employees.map((employee) => employee.id);
  const [roleGrants, buGrants] = await Promise.all([
    employeeRoleRepository.findRolesByEmployeeIds(employeeIds),
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds(employeeIds),
  ]);

  const rolesByEmployee = new Map();
  roleGrants.forEach((grant) => {
    if (!rolesByEmployee.has(grant.employee_id)) rolesByEmployee.set(grant.employee_id, []);
    rolesByEmployee.get(grant.employee_id).push({ id: grant.id, name: grant.name });
  });

  const businessUnitsByEmployee = new Map();
  buGrants.forEach((grant) => {
    if (!businessUnitsByEmployee.has(grant.employee_id)) businessUnitsByEmployee.set(grant.employee_id, []);
    businessUnitsByEmployee.get(grant.employee_id).push({ id: grant.id, name: grant.name });
  });

  return employees.map((employee) => {
    const roles = rolesByEmployee.get(employee.id) || [];
    const businessUnits = businessUnitsByEmployee.get(employee.id) || [];
    return {
      ...employee,
      role_ids: roles.map((role) => role.id),
      roles,
      business_unit_ids: businessUnits.map((bu) => bu.id),
      business_units: businessUnits,
    };
  });
}

/**
 * Return a paginated, filtered, sorted employee list — scoped to whatever
 * Employees `authContext`'s caller is authorized to see (see
 * employeeAccessControlService.resolveEmployeeAccessWhere): an Employee
 * gets only their own record, a Manager/Service PO Admin gets their own
 * record plus whoever is actually mapped to them, everyone else is bounded
 * by Company/Entity. Fixes the same object-level authorization gap as
 * getByIdWithEmail() below — this list endpoint previously returned every
 * Employee in the company to any authenticated caller regardless of role.
 *
 * @param {object} query - Express req.query (page, limit, search, status, designation, sort_by, sort_order)
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames } — see controller
 * @returns {Promise<{ data: Employee[], meta: object }>}
 */
const getAll = async (query = {}, authContext) => {
  const { page, limit, offset } = getPaginationParams(query);
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);

  const filters = {
    search: query.search || '',
    status: query.status || 'active',
    designation: query.designation || '',
    companyId: authContext.companyId,
    accessWhere,
  };

  const sort = {
    sortBy: query.sort_by || 'created_at',
    sortOrder: query.sort_order || 'DESC',
  };

  const { rows, count } = await employeeRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  const data = await attachManagers(rows.map(toPlain));

  return { data, meta };
};

/**
 * Return a single employee by ID.
 * Throws a 404-carrying error if not found.
 *
 * @param {number} id
 * @returns {Promise<Employee>}
 */
const getById = async (id, companyId) => {
  const employee = await employeeRepository.findById(id, companyId);
  if (!employee) {
    throw notFoundError(`Employee with ID ${id} not found.`);
  }
  return employee;
};

/**
 * Same lookup as getById(), but with `email` flattened onto the response
 * (see attachEmail() above) — the public GET /employees/:id API's data
 * source. Kept separate from getById() itself, which internally returns a
 * raw Sequelize instance that update()/deleteEmployee() below still call
 * .toJSON()/read Sequelize-instance properties on.
 *
 * Object-level authorization (the GET /employees/:id IDOR/BOLA fix): the
 * caller's authorized-scope filter is merged into the SAME lookup query via
 * `accessWhere`, so an Employee outside `authContext`'s scope 404s exactly
 * like a nonexistent one — see employeeAccessControlService.js and
 * employeeRepository.findByIdWithEmail's doc comment.
 *
 * @param {number} id
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames } — see controller
 * @returns {Promise<object>}
 */
const getByIdWithEmail = async (id, authContext) => {
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  const employee = await employeeRepository.findByIdWithEmail(id, authContext.companyId, accessWhere);
  if (!employee) {
    throw notFoundError(`Employee with ID ${id} not found.`);
  }
  const [withManagers] = await attachManagers([toPlain(employee)]);
  const [withRolesAndBUs] = await attachRoleAndBusinessUnitInfo([withManagers]);
  return withRolesAndBUs;
};

/**
 * Return one employee's current Role & Business Unit mappings only — the
 * data source for the Action → Role & BU Mapping screen (moved out of the
 * Employee Drawer; the Employee List's GET /employees intentionally does
 * NOT carry this, see attachRoleAndBusinessUnitInfo()'s doc comment).
 * Reuses the exact same access check (an out-of-scope employee 404s here
 * too, never disclosing existence) and the exact same
 * employee_roles/employee_business_units read path GET /employees/:id
 * already uses — no separate/duplicate mapping-fetch logic.
 *
 * @param {number} id
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames }
 * @returns {Promise<{ employee_id: number, role_ids: number[], roles: object[], business_unit_ids: number[], business_units: object[] }>}
 */
const getMappings = async (id, authContext) => {
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  const employee = await employeeRepository.findByIdWithEmail(id, authContext.companyId, accessWhere);
  if (!employee) {
    throw notFoundError(`Employee with ID ${id} not found.`);
  }

  const [withRolesAndBUs] = await attachRoleAndBusinessUnitInfo([{ id: employee.id }]);

  return {
    employee_id: employee.id,
    role_ids: withRolesAndBUs.role_ids,
    roles: withRolesAndBUs.roles,
    business_unit_ids: withRolesAndBUs.business_unit_ids,
    business_units: withRolesAndBUs.business_units,
  };
};

/**
 * Return one employee's Business Units — the dedicated, lightweight data
 * source for the frontend to load "Mapped BUs" by empId (e.g. right after
 * login, using the `employee.id` from the login/select-role response)
 * instead of the login response itself carrying this. Deliberately
 * separate from getMappings() above: that endpoint is the Role & BU
 * Mapping admin screen's heavier payload (roles + BUs, lean `{id, name}`
 * shape); this one is just BUs, in the fuller `{id, name,
 * is_original_data_visible}` shape authService.js's login used to embed
 * directly in its response.
 *
 * Two DIFFERENT sources, unioned, because "which BUs does this employee
 * have" means something different depending on tier:
 *   - explicit `employee_business_units` grants — every ordinary Employee/
 *     Manager/BU Admin/etc's actual mapped BUs.
 *   - for an Admin/Entity Admin TARGET (rank 2/3) — these are platform-
 *     wide/Entity-scoped by design and are almost never given an explicit
 *     employee_business_units row (see adminService.createAdmin —
 *     company_id is always NULL, no BU mapping step). Their real "BUs" are
 *     whatever Companies fall under an Entity they own, transitively (the
 *     SAME companyAccessControlService.resolveOwnedCompanyIds resolution
 *     Company/Entity Master and employeeAccessControlService already use)
 *     — i.e. the Companies under Entities/Entity Admins THEY created.
 *     Without this, an Admin would get `businessUnits: []` here even
 *     though they meaningfully "own" a whole sub-hierarchy of Companies.
 * Each returned entry carries `source: 'mapped' | 'owned'` so the frontend
 * can distinguish an explicit grant from an Admin's owned-hierarchy
 * Company if it needs to (e.g. different label/badge) — a Company present
 * in BOTH sets is returned once, tagged `mapped` (explicit grant wins).
 *
 * Reuses the same object-level access check as every other Employee read
 * (an out-of-scope employee 404s here too, never disclosing existence) —
 * an employee's own record is always within their own access scope, so
 * this always succeeds for "my own mapped BUs".
 *
 * @param {number} id
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames }
 * @returns {Promise<{ employee_id: number, businessUnits: {id: number, name: string, is_original_data_visible: boolean, source: string}[] }>}
 */
const getBusinessUnits = async (id, authContext) => {
  // Self-lookup ("my own mapped BUs") is unconditionally allowed — no
  // company/BU context is required to see your own record, which matters
  // because a multi-BU actor calls this specifically to discover their own
  // BU list BEFORE they have anything to put in X-Company-Id (see
  // employee.routes.js's route, which skips resolveCompany for exactly this
  // case, leaving authContext.companyId unresolved here on purpose).
  const accessWhere = id === authContext.employeeId
    ? {}
    : await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  const employee = await employeeRepository.findByIdWithEmail(id, authContext.companyId, accessWhere);
  if (!employee) {
    throw notFoundError(`Employee with ID ${id} not found.`);
  }

  const [explicitBUs, targetRoles] = await Promise.all([
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId(employee.id),
    employeeRoleRepository.findRolesByEmployeeId(employee.id),
  ]);

  const businessUnitsById = new Map(
    explicitBUs.map((bu) => [bu.id, {
      id: bu.id,
      name: bu.company_name,
      is_original_data_visible: !!bu.is_original_data_visible,
      source: 'mapped',
    }])
  );

  // Effective hierarchy rank of the TARGET employee (not the caller) —
  // same MIN-across-active-roles rule as authService.getEffectiveHierarchyRank.
  const ranks = targetRoles.map((role) => role.hierarchy_rank).filter((rank) => Number.isInteger(rank));
  const targetHierarchyRank = ranks.length > 0 ? Math.min(...ranks) : null;

  if (targetHierarchyRank === 2 || targetHierarchyRank === 3) {
    const ownedCompanyIds = await companyAccessControlService.resolveOwnedCompanyIds(targetHierarchyRank, employee.id);
    if (ownedCompanyIds.length > 0) {
      const ownedCompanies = await Company.findAll({
        where: { id: { [Op.in]: ownedCompanyIds }, is_deleted: false },
        attributes: ['id', 'company_name', 'is_original_data_visible'],
      });
      ownedCompanies.forEach((company) => {
        if (!businessUnitsById.has(company.id)) {
          businessUnitsById.set(company.id, {
            id: company.id,
            name: company.company_name,
            is_original_data_visible: !!company.is_original_data_visible,
            source: 'owned',
          });
        }
      });
    }
  }

  return {
    employee_id: employee.id,
    businessUnits: [...businessUnitsById.values()],
  };
};

/**
 * Validate every requested role: must exist and be active. At most one may
 * be senior-tier (hierarchy_rank <= 4) — preserves the pre-redesign
 * single-primary-senior-role invariant even though roles are otherwise
 * flat multi-value (see the Employee-as-Identity plan's decision #3).
 *
 * @param {number[]} roleIds
 * @returns {Promise<Role[]>} the resolved Role rows, same order as roleIds
 */
async function assertValidRoles(roleIds) {
  const roles = await Promise.all(
    roleIds.map(async (roleId) => {
      const role = await Role.findOne({ where: { id: roleId, is_deleted: false } });
      if (!role) {
        throw notFoundError(`Role with ID ${roleId} not found.`);
      }
      if (role.status !== 'active') {
        throw conflictError(`Role "${role.role_name}" is inactive and cannot be assigned.`);
      }
      return role;
    })
  );

  const seniorRoles = roles.filter((role) => roleHierarchyService.isSeniorTier(role.hierarchy_rank));
  if (seniorRoles.length > 1) {
    throw badRequestError(
      `An Employee may hold at most one senior-tier role; got: ${seniorRoles.map((r) => r.role_name).join(', ')}.`
    );
  }

  return roles;
}

/**
 * Validate every requested Business Unit: must exist, be an active,
 * non-deleted Company. `companyId` (the actor's own home BU) is
 * auto-injected if the caller supplied one and it isn't already in the
 * list. Business Unit assignment is OPTIONAL at Employee create/update
 * time — BU mapping is done separately (a dedicated mapping flow, not the
 * Employee form) — so an empty/omitted `businessUnitIds` with no
 * `companyId` to fall back to simply resolves to no BUs at all, rather
 * than failing the request.
 *
 * Ownership check: every id, after the exists-and-active check, must also
 * fall within the caller's own permitted scope (`ownedScope` — either a
 * single companyId, or an array: the resolved owned-Company ids for a
 * company-less Admin/Entity Admin, OR — for a multi-BU BU-scoped actor —
 * every one of THEIR OWN actively mapped BUs, not just whichever one is
 * currently active via X-Company-Id; see create()/update()'s callers for
 * which one gets built) — otherwise any caller could attach an Employee to
 * a completely unrelated tenant's (or unmapped) Business Unit just by
 * knowing/guessing its id.
 *
 * @param {number[]} businessUnitIds
 * @param {number} companyId
 * @param {number|number[]} ownedScope
 * @returns {Promise<number[]>}
 */
/**
 * The scope to check business_unit_ids against — widened for a multi-BU
 * BU-scoped actor to their FULL set of actively mapped BUs, not just the
 * single one currently active via X-Company-Id. `ownedScope` (from
 * companyAccessControlService.resolveActorCompanyScope) already correctly
 * returns an array for a company-less Admin/Entity Admin, so this only
 * changes the BU-scoped-actor case: a BU Admin mapped to BU 1 + BU 2 must
 * be able to assign either (or both) to an Employee regardless of which one
 * is momentarily active, but still never an unmapped BU 3.
 *
 * @param {{ companyId: number|null, employeeBusinessUnits?: number[] }} authContext
 * @param {number|number[]} ownedScope
 * @returns {number|number[]}
 */
function resolveBUAssignmentScope(authContext, ownedScope) {
  if (authContext.companyId != null) {
    const mappedIds = authContext.employeeBusinessUnits || [];
    if (mappedIds.length > 0) {
      return mappedIds;
    }
  }
  return ownedScope;
}

async function resolveBusinessUnitIds(businessUnitIds, companyId, ownedScope) {
  const ids = [...new Set(businessUnitIds && businessUnitIds.length > 0 ? businessUnitIds : [])];
  if (companyId && !ids.includes(companyId)) {
    ids.push(companyId);
  }
  if (ids.length === 0) {
    return ids;
  }

  const companies = await Company.findAll({ where: { id: { [Op.in]: ids }, is_deleted: false } });
  if (companies.length !== ids.length) {
    const found = new Set(companies.map((c) => c.id));
    const missing = ids.filter((id) => !found.has(id));
    throw notFoundError(`Business Unit(s) not found: ${missing.join(', ')}.`);
  }

  const allowedIds = Array.isArray(ownedScope) ? new Set(ownedScope) : null;
  const disallowed = ids.filter((id) => (allowedIds ? !allowedIds.has(id) : id !== ownedScope));
  if (disallowed.length > 0) {
    throw forbiddenError(`Business Unit(s) not one of your own: ${disallowed.join(', ')}.`);
  }

  return ids;
}

/**
 * Resolve the roles an Employee will hold: whatever the caller supplied,
 * or — if none — the single "Employee" role, so an Employee can always be
 * created without the caller having to explicitly pick a role every time.
 *
 * @param {number[]} roleIds
 * @returns {Promise<number[]>}
 * @throws {Error} 404 if role_ids is empty AND the "Employee" role master
 *   row itself can't be found (a genuine data-setup problem, not a caller error)
 */
async function resolveDefaultRoleIds(roleIds) {
  if (roleIds && roleIds.length > 0) {
    return roleIds;
  }

  const employeeRole = await Role.findOne({ where: { role_name: 'Employee', is_deleted: false } });
  if (!employeeRole) {
    throw notFoundError('Default "Employee" role not found — contact an administrator.');
  }

  return [employeeRole.id];
}

/**
 * Create a new Employee — email/password are now native fields, and role/
 * Business Unit assignment is inside the same transaction via
 * employee_roles/employee_business_units (Employee-as-Identity redesign).
 *
 * @param {object} data - Validated fields: employee business fields + email,
 *   password?, role_ids[], business_unit_ids[]?, primary_manager_employee_id?,
 *   secondary_manager_employee_id?
 * @param {number} userId - ID of the creating (HR) actor, for audit
 * @param {string} ipAddress
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames } — see controller
 * @returns {Promise<{ employee: object, temporaryPassword?: string }>}
 */
const create = async (data, userId, ipAddress = null, authContext) => {
  const companyId = authContext.companyId;
  const ownedScope = await companyAccessControlService.resolveActorCompanyScope(authContext);
  const {
    email,
    password,
    role_ids: roleIds = [],
    business_unit_ids: businessUnitIds = [],
    primary_manager_employee_id: primaryManagerEmployeeId,
    secondary_manager_employee_id: secondaryManagerEmployeeId,
    ...employeeFields
  } = data;

  if (secondaryManagerEmployeeId && secondaryManagerEmployeeId === primaryManagerEmployeeId) {
    throw badRequestError('Secondary Manager must be different from the Primary Manager.');
  }

  if (employeeFields.employee_code) {
    const existingCode = await employeeRepository.findByCode(employeeFields.employee_code, companyId);
    if (existingCode) {
      throw conflictError(`Employee code "${employeeFields.employee_code}" is already in use.`);
    }
  }

  const existingEmployee = await employeeRepository.findByEmail(email);
  if (existingEmployee) {
    throw conflictError(`Email "${email}" is already registered.`);
  }

  // role_ids defaults to the "Employee" role when omitted — the caller no
  // longer has to explicitly pick a role every time. business_unit_ids is
  // fully optional: BU mapping is done separately (a dedicated mapping
  // flow, not this form), so an Employee can be created with zero BUs.
  const resolvedRoleIds = await resolveDefaultRoleIds(roleIds);
  const resolvedRoles = await assertValidRoles(resolvedRoleIds);
  const resolvedBusinessUnitIds = await resolveBusinessUnitIds(
    businessUnitIds, companyId, resolveBUAssignmentScope(authContext, ownedScope)
  );

  // Admin holds no timesheet of its own to approve — never held-back
  // awaiting approval like a regular Employee, regardless of what the
  // caller passed for this field.
  const isAdminRole = resolvedRoles.some((role) => role.role_name === 'Admin');
  if (isAdminRole) {
    employeeFields.is_timesheet_approval_required = false;
  }

  // Both managers are optional; when supplied, must belong to the caller's
  // own permitted scope — assertValidManager's findById() is passed
  // `ownedScope` (not the raw, possibly-undefined `companyId`) so a
  // company-less Admin/Entity Admin can't reference a manager belonging to
  // an unrelated tenant's Company.
  if (primaryManagerEmployeeId) {
    await assertValidManager(primaryManagerEmployeeId, ownedScope, 'Primary Manager');
  }
  if (secondaryManagerEmployeeId) {
    await assertValidManager(secondaryManagerEmployeeId, ownedScope, 'Secondary Manager');
  }

  const temporaryPassword = password || generateTemporaryPassword();

  let employee;

  await sequelize.transaction(async (transaction) => {
    employee = await employeeRepository.create({
      ...employeeFields,
      email,
      password: temporaryPassword,
      company_id: companyId,
      created_by: userId,
      updated_by: userId,
    }, { transaction });

    await employeeRoleRepository.replaceForEmployee(employee.id, resolvedRoleIds, userId, transaction);
    await employeeBusinessUnitRepository.replaceForEmployee(employee.id, resolvedBusinessUnitIds, userId, transaction);

    if (primaryManagerEmployeeId) {
      await upsertManagerMapping(employee.id, 'PRIMARY', primaryManagerEmployeeId, companyId, userId, transaction);
    }
    if (secondaryManagerEmployeeId) {
      await upsertManagerMapping(employee.id, 'SECONDARY', secondaryManagerEmployeeId, companyId, userId, transaction);
    }

    // Auto-map against every Business Unit this NEW employee is actually
    // being assigned to (resolvedBusinessUnitIds — already includes the
    // BU-scoped actor's own companyId when no explicit business_unit_ids
    // were supplied, see resolveBusinessUnitIds() above), NOT the raw
    // `companyId` (the CREATING actor's own BU, which is undefined for a
    // company-less Admin/Entity Admin even when they explicitly assign the
    // new employee one or more Business Units via business_unit_ids — using
    // it here meant auto-mapping silently never ran for exactly that,
    // increasingly common, creation path). Calling this once per BU is safe
    // even when a BU-less global Centralised PO shows up for more than one
    // BU — bulkCreate's ignoreDuplicates + the unique (employee_id,
    // service_po_id) constraint make the repeat a no-op.
    //
    // An employee with NO Business Unit at all (resolvedBusinessUnitIds
    // empty) still gets one call with companyId: null — a Centralised PO
    // is deliberately not tied to any BU, so it must reach every employee
    // regardless of whether THEY have a BU (see
    // autoMapCentralisedServicePOs()'s doc comment).
    if (resolvedBusinessUnitIds.length > 0) {
      for (const businessUnitId of resolvedBusinessUnitIds) {
        await employeeServicePOMappingService.autoMapCentralisedServicePOs(employee.id, businessUnitId, userId, transaction);
      }
    } else {
      await employeeServicePOMappingService.autoMapCentralisedServicePOs(employee.id, null, userId, transaction);
    }
  });

  await createAuditLog(
    userId,
    'CREATE',
    'employees',
    employee.id,
    null,
    { id: employee.id, employee_code: employee.employee_code, email, role_ids: resolvedRoleIds },
    ipAddress
  );

  logger.info('Employee created', {
    employeeId: employee.id,
    roleIds: resolvedRoleIds,
    primaryManagerEmployeeId,
    secondaryManagerEmployeeId: secondaryManagerEmployeeId || null,
    createdBy: userId,
  });

  const responseEmployee = employee.toJSON();
  delete responseEmployee.password;

  const response = { employee: responseEmployee };
  // Only surface the plaintext password when we generated it — if HR
  // supplied their own, they already know it.
  if (!password) {
    response.temporaryPassword = temporaryPassword;
  }

  return response;
};

/**
 * Update an existing employee.
 * Guards against duplicate employee_code changes; optionally reassigns
 * Primary/Secondary Manager (same validation as create()).
 *
 * Object-level authorization (the PUT /employees/:id IDOR fix — mirrors
 * getByIdWithEmail()): `authContext`'s resolved `accessWhere` is merged
 * into the SAME lookup query that 404s when the row doesn't exist, so an
 * Employee outside the caller's scope 404s exactly like a nonexistent one,
 * and can never be updated by a company-less Admin/Entity Admin guessing an
 * id. `existing.company_id` (now verified-owned) is then used for every
 * single-company operation below instead of the raw, possibly-undefined
 * `authContext.companyId` — this also closes the same "manager/BU from an
 * unrelated tenant" gap create() has, for the update path.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {string} ipAddress
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames } — see controller
 * @returns {Promise<Employee>}
 */
const update = async (id, data, userId, ipAddress = null, authContext) => {
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  const existing = await employeeRepository.findByIdWithEmail(id, authContext.companyId, accessWhere);
  if (!existing) {
    throw notFoundError(`Employee with ID ${id} not found.`);
  }
  const companyId = existing.company_id;
  const ownedScope = await companyAccessControlService.resolveActorCompanyScope(authContext);

  const {
    primary_manager_employee_id: primaryManagerEmployeeId,
    secondary_manager_employee_id: secondaryManagerEmployeeId,
    role_ids: roleIds,
    business_unit_ids: businessUnitIds,
    email,
    ...employeeFields
  } = data;

  if (employeeFields.employee_code && employeeFields.employee_code !== existing.employee_code) {
    const taken = await employeeRepository.findByCode(employeeFields.employee_code, companyId);
    if (taken && taken.id !== id) {
      throw conflictError(`Employee code "${employeeFields.employee_code}" is already in use.`);
    }
  }

  if (email && email !== existing.email) {
    const taken = await employeeRepository.findByEmail(email);
    if (taken && taken.id !== id) {
      throw conflictError(`Email "${email}" is already registered to another employee.`);
    }
  }

  // Same default-to-"Employee" behavior as create() — an explicitly empty
  // role_ids array falls back to the Employee role rather than erroring.
  const resolvedRoleIds = roleIds !== undefined
    ? await resolveDefaultRoleIds(roleIds)
    : undefined;
  if (resolvedRoleIds !== undefined) {
    await assertValidRoles(resolvedRoleIds);
  }

  // ownedScope (not the single companyId) — an Admin/Entity Admin may
  // legitimately attach any of their OWN Business Units, not just the one
  // this Employee already belongs to. Widened further for a multi-BU
  // BU-scoped actor via resolveBUAssignmentScope() — see its doc comment.
  const resolvedBusinessUnitIds = businessUnitIds !== undefined
    ? await resolveBusinessUnitIds(businessUnitIds, companyId, resolveBUAssignmentScope(authContext, ownedScope))
    : null;

  if (primaryManagerEmployeeId) {
    await assertValidManager(primaryManagerEmployeeId, companyId, 'Primary Manager');
  }
  if (secondaryManagerEmployeeId) {
    await assertValidManager(secondaryManagerEmployeeId, companyId, 'Secondary Manager');
  }

  const oldValues = existing.toJSON();
  let updated;

  await sequelize.transaction(async (transaction) => {
    const updatePayload = { ...employeeFields, updated_by: userId };
    if (email) updatePayload.email = email;

    updated = await employeeRepository.update(id, updatePayload, companyId, { transaction });

    if (resolvedRoleIds !== undefined) {
      await employeeRoleRepository.replaceForEmployee(id, resolvedRoleIds, userId, transaction);
    }
    if (resolvedBusinessUnitIds !== null) {
      await employeeBusinessUnitRepository.replaceForEmployee(id, resolvedBusinessUnitIds, userId, transaction);
    }

    if (primaryManagerEmployeeId) {
      await upsertManagerMapping(id, 'PRIMARY', primaryManagerEmployeeId, companyId, userId, transaction);
    }
    if (secondaryManagerEmployeeId !== undefined) {
      if (secondaryManagerEmployeeId === null) {
        const existingSecondary = await managerEmployeeMappingRepository.findByEmployeeAndType(id, 'SECONDARY');
        if (existingSecondary) await existingSecondary.destroy({ transaction });
      } else {
        await upsertManagerMapping(id, 'SECONDARY', secondaryManagerEmployeeId, companyId, userId, transaction);
      }
    }
  });

  const updatedPlain = updated.toJSON();
  delete updatedPlain.password;

  await createAuditLog(
    userId,
    'UPDATE',
    'employees',
    id,
    oldValues,
    updatedPlain,
    ipAddress
  );

  logger.info('Employee updated', { employeeId: id, userId });

  const refreshed = await employeeRepository.findByIdWithEmail(id, companyId);
  const [withManagers] = await attachManagers([toPlain(refreshed)]);
  const [withRolesAndBUs] = await attachRoleAndBusinessUnitInfo([withManagers]);
  return withRolesAndBUs;
};

/**
 * Soft-delete an employee.
 * Blocks deletion if the employee is allocated to any active Service PO.
 *
 * Object-level authorization — same fix and rationale as update() above:
 * an out-of-scope Employee 404s exactly like a nonexistent one, closing the
 * DELETE /employees/:id IDOR.
 *
 * @param {number} id
 * @param {number} userId
 * @param {string} ipAddress
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames } — see controller
 * @returns {Promise<Employee>}
 */
const deleteEmployee = async (id, userId, ipAddress = null, authContext) => {
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  const employee = await employeeRepository.findByIdWithEmail(id, authContext.companyId, accessWhere);
  if (!employee) {
    throw notFoundError(`Employee with ID ${id} not found.`);
  }
  const companyId = employee.company_id;

  // Guard: do not deactivate an employee tied to an active PO
  const activeAllocations = await employeeRepository.findActiveAllocations(id, companyId);
  if (activeAllocations.length > 0) {
    const poNames = activeAllocations
      .map((r) => r.servicePO?.service_po_code || `PO#${r.service_po_id}`)
      .join(', ');
    throw conflictError(
      `Cannot deactivate employee. They are currently allocated to active Service PO(s): ${poNames}.`
    );
  }

  const oldValues = employee.toJSON();
  const deleted = await employeeRepository.softDelete(id, userId, companyId);

  await createAuditLog(
    userId,
    'DELETE',
    'employees',
    id,
    oldValues,
    deleted.toJSON(),
    ipAddress
  );

  logger.info('Employee soft-deleted', { employeeId: id, userId });

  return deleted;
};

/**
 * Return all active employees (lightweight list for dropdowns, allocation
 * pickers) — scoped via the same resolveEmployeeAccessWhere() every other
 * Employee read uses, so a company-less Admin/Entity Admin gets their own
 * owned-Company employees instead of every employee on the platform (the
 * GET /employees/active/list leak fix).
 *
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames }
 * @returns {Promise<Employee[]>}
 */
const getActiveEmployees = async (authContext) => {
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  return employeeRepository.getActiveEmployees(authContext.companyId, accessWhere);
};

/**
 * Return eligible candidates for Primary/Secondary Manager selection — the
 * Employee Create/Edit form's manager dropdowns. Same eligibility rule
 * assertValidManager() enforces at create()/update() time (any role whose
 * effective capability set includes manager.view_mapped_employees, direct
 * or inherited), resolved once here via a single Employee<->Role join
 * rather than per-candidate — so a value offered in the dropdown is always
 * one create()/update() will actually accept, and the frontend never needs
 * to N+1 a per-row mappings fetch to figure out who's eligible.
 *
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames }
 * @returns {Promise<{ id: number, employee_code: string, full_name: string, designation: string|null, status: string }[]>}
 */
const getEligibleManagers = async (authContext) => {
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  const eligibleRoleIds = await roleHierarchyService.getRoleIdsWithCapability(CAPABILITY_CAN_MANAGE_EMPLOYEES);
  const employees = await employeeRepository.findEligibleManagers(authContext.companyId, eligibleRoleIds, accessWhere);
  return employees.map((employee) => ({
    id: employee.id,
    employee_code: employee.employee_code,
    full_name: employee.full_name,
    designation: employee.designation,
    status: employee.status,
  }));
};

/**
 * Return eligible candidates for Service PO Delivery Head selection —
 * every active, non-deleted Employee in the caller's own Company. Shapes
 * each row to the field set the Delivery Head picker needs: `email` is
 * sourced from the Employee's linked User account (Employee itself
 * carries no email — see database/migrations/
 * 20260842_employees_drop_login_columns.sql), `null` if that Employee has
 * no linked User yet.
 *
 * Scoped via resolveEmployeeAccessWhere() — same leak fix as
 * getActiveEmployees() above (GET /employees/eligible-delivery-heads).
 *
 * @param {object} authContext - { userId, employeeId, companyId, hierarchyRank, roleNames }
 * @returns {Promise<{ id: number, employee_code: string, employee_name: string, email: string|null, status: string, company_id: number }[]>}
 */
const getEligibleDeliveryHeads = async (authContext) => {
  const accessWhere = await employeeAccessControlService.resolveEmployeeAccessWhere(authContext);
  const employees = await employeeRepository.getEligibleDeliveryHeads(authContext.companyId, accessWhere);

  return employees.map((employee) => ({
    id: employee.id,
    employee_code: employee.employee_code,
    employee_name: employee.full_name,
    email: employee.email || null,
    status: employee.status,
    company_id: employee.company_id,
  }));
};

module.exports = {
  getAll,
  getById,
  getByIdWithEmail,
  getMappings,
  getBusinessUnits,
  create,
  update,
  delete: deleteEmployee,
  getActiveEmployees,
  getEligibleDeliveryHeads,
  getEligibleManagers,
};
