'use strict';

const crypto = require('crypto');
const { sequelize, Role } = require('../models');
const employeeRepository = require('../repositories/employeeRepository');
const userRepository = require('../repositories/userRepository');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const roleHierarchyService = require('./roleHierarchyService');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Employee Service
 *
 * Employee is pure business data now (see database/migrations/
 * 20260842_employees_drop_login_columns.sql) — every Employee that needs
 * to log in gets a linked User row (users.employee_id) created
 * automatically here, never a separate Employee-direct-login path. Per
 * the RBAC redesign: "Whenever an Employee is created, automatically
 * create a User record. Role = Employee." HR may also assign a Primary
 * Manager (and optional Secondary) in the same transaction — both optional,
 * so an Employee can be left unmapped and assigned a manager later via update.
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

/**
 * Generate a random password satisfying the app's complexity policy
 * (upper+lower+digit+special, 16 chars) — used when HR omits `password` at
 * Employee creation. Returned in the create response exactly once; never
 * persisted in plaintext (the User model's beforeCreate hook hashes it).
 * @returns {string}
 */
function generateTemporaryPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;

  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const required = [pick(upper), pick(lower), pick(digits), pick(special)];
  const rest = Array.from({ length: 12 }, () => pick(all));

  return [...required, ...rest].sort(() => crypto.randomInt(3) - 1).join('');
}

/**
 * Confirm a candidate manager: exists, active, same company as the
 * Employee, and holds a role capable of managing Employees (Manager,
 * Service PO Admin, or Project Admin — anything with
 * 'manager.view_mapped_employees' in its effective capability set, direct
 * or inherited — see roleHierarchyService.js). The capability may come from
 * the candidate's PRIMARY role or an ADDITIONAL operational role (e.g. an
 * Employee-primary user who also holds an additional "Manager" role — see
 * database/migrations/20260850_add_user_additional_roles.sql). Reused by
 * both create() and update() rather than duplicating the check.
 *
 * @param {number} userId
 * @param {number} companyId
 * @param {string} label - 'Primary Manager' | 'Secondary Manager', for error messages
 * @returns {Promise<User>}
 */
async function assertValidManager(userId, companyId, label) {
  const user = await userRepository.findById(userId, companyId);
  if (!user) {
    throw notFoundError(`${label} not found in this company.`);
  }
  if (user.status !== 'active') {
    throw badRequestError(`${label} is not an active account.`);
  }
  if (!user.role) {
    throw badRequestError(`${label} has no role assigned.`);
  }

  const additionalRoleIds = (user.additionalRoles || []).map((role) => role.id);
  const capabilities = await roleHierarchyService.getEffectiveCapabilitiesForRoleIds([
    user.role.id,
    ...additionalRoleIds,
  ]);
  if (!roleHierarchyService.hasCapability(capabilities, CAPABILITY_CAN_MANAGE_EMPLOYEES)) {
    throw badRequestError(`${label} must hold a Manager (or higher) role.`);
  }

  return user;
}

/**
 * Upsert the PRIMARY (and optional SECONDARY) manager_employee_mappings row
 * for an Employee, inside the given transaction. Used by both create() and
 * update()'s manager-reassignment path.
 */
async function upsertManagerMapping(employeeId, mappingType, managerUserId, companyId, actorId, transaction) {
  const existing = await managerEmployeeMappingRepository.findByEmployeeAndType(employeeId, mappingType);

  if (existing && existing.manager_user_id === managerUserId) {
    return existing; // already correct, no-op
  }
  if (existing) {
    await existing.destroy({ transaction });
  }

  return managerEmployeeMappingRepository.create({
    company_id: companyId,
    manager_user_id: managerUserId,
    employee_id: employeeId,
    mapping_type: mappingType,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  }, { transaction });
}

/**
 * Employee itself carries no email (see database/migrations/
 * 20260842_employees_drop_login_columns.sql) — flatten it onto the
 * response from the linked User account, same convention as
 * getEligibleDeliveryHeads(). null if no User is linked yet. Expects an
 * Employee instance fetched with the `users` include (e.g. via
 * employeeRepository.findByIdWithEmail()).
 *
 * @param {Employee} employee
 * @returns {object} plain object with `email` set, `users` removed
 */
function attachEmail(employee) {
  const plain = employee.toJSON ? employee.toJSON() : { ...employee };
  plain.email = plain.users && plain.users[0] ? plain.users[0].email : null;
  delete plain.users;
  return plain;
}

/**
 * Attach each employee's Primary/Secondary Manager id AND display name
 * (full_name of the manager's own linked Employee, falling back to their
 * email if they have none) — batched: one query for every mapping row
 * across all given employees, one query for every distinct manager user,
 * rather than N+1 lookups per employee.
 *
 * @param {object[]} employees - plain objects (e.g. already through attachEmail()), each with an `id`
 * @param {number} companyId
 * @returns {Promise<object[]>}
 */
async function attachManagers(employees) {
  if (employees.length === 0) return employees;

  const employeeIds = employees.map((employee) => employee.id);
  const mappings = await managerEmployeeMappingRepository.findByEmployeeIds(employeeIds);

  const managerUserIds = [...new Set(mappings.map((mapping) => mapping.manager_user_id))];
  const managers = await userRepository.findByIds(managerUserIds);
  const managerById = new Map(
    managers.map((manager) => [
      manager.id,
      { id: manager.id, name: manager.employee ? manager.employee.full_name : manager.email },
    ])
  );

  const mappingsByEmployee = new Map();
  mappings.forEach((mapping) => {
    if (!mappingsByEmployee.has(mapping.employee_id)) {
      mappingsByEmployee.set(mapping.employee_id, {});
    }
    mappingsByEmployee.get(mapping.employee_id)[mapping.mapping_type] = mapping.manager_user_id;
  });

  return employees.map((employee) => {
    const slots = mappingsByEmployee.get(employee.id) || {};
    const primary = slots.PRIMARY ? managerById.get(slots.PRIMARY) : null;
    const secondary = slots.SECONDARY ? managerById.get(slots.SECONDARY) : null;
    return {
      ...employee,
      primary_manager_user_id: primary ? primary.id : null,
      primary_manager_name: primary ? primary.name : null,
      secondary_manager_user_id: secondary ? secondary.id : null,
      secondary_manager_name: secondary ? secondary.name : null,
    };
  });
}

/**
 * Return a paginated, filtered, sorted employee list.
 *
 * @param {object} query - Express req.query (page, limit, search, status, designation, sort_by, sort_order)
 * @returns {Promise<{ data: Employee[], meta: object }>}
 */
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || '',
    status: query.status || 'active',
    designation: query.designation || '',
    companyId,
  };

  const sort = {
    sortBy: query.sort_by || 'created_at',
    sortOrder: query.sort_order || 'DESC',
  };

  const { rows, count } = await employeeRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  const withEmail = rows.map(attachEmail);
  const data = await attachManagers(withEmail);

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
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<object>}
 */
const getByIdWithEmail = async (id, companyId) => {
  const employee = await employeeRepository.findByIdWithEmail(id, companyId);
  if (!employee) {
    throw notFoundError(`Employee with ID ${id} not found.`);
  }
  const [withManagers] = await attachManagers([attachEmail(employee)]);
  return withManagers;
};

/**
 * Create a new Employee — and, in the same transaction:
 *   1. A linked User account (role = Employee) so they can log in.
 *   2. An optional PRIMARY manager_employee_mappings row.
 *   3. An optional SECONDARY manager_employee_mappings row.
 *
 * @param {object} data - Validated fields: employee business fields + email,
 *   password?, primary_manager_user_id?, secondary_manager_user_id?
 * @param {number} userId - ID of the creating (HR) user, for audit
 * @param {string} ipAddress
 * @param {number} companyId
 * @returns {Promise<{ employee: object, user: object, temporaryPassword?: string }>}
 */
const create = async (data, userId, ipAddress = null, companyId) => {
  const {
    email,
    password,
    primary_manager_user_id: primaryManagerUserId,
    secondary_manager_user_id: secondaryManagerUserId,
    ...employeeFields
  } = data;

  if (secondaryManagerUserId && secondaryManagerUserId === primaryManagerUserId) {
    throw badRequestError('Secondary Manager must be different from the Primary Manager.');
  }

  if (employeeFields.employee_code) {
    const existingCode = await employeeRepository.findByCode(employeeFields.employee_code, companyId);
    if (existingCode) {
      throw conflictError(`Employee code "${employeeFields.employee_code}" is already in use.`);
    }
  }

  const existingUser = await userRepository.findByEmail(email);
  if (existingUser) {
    throw conflictError(`Email "${email}" is already registered.`);
  }

  // Both managers are optional; when supplied, must belong to the same
  // Company as the Employee being created — assertValidManager's findById()
  // is itself company-scoped, so a manager from another company 404s here.
  if (primaryManagerUserId) {
    await assertValidManager(primaryManagerUserId, companyId, 'Primary Manager');
  }
  if (secondaryManagerUserId) {
    await assertValidManager(secondaryManagerUserId, companyId, 'Secondary Manager');
  }

  const employeeRole = await Role.findOne({ where: { role_name: 'Employee' } });
  if (!employeeRole) {
    const err = new Error('The "Employee" role is not seeded.');
    err.statusCode = 500;
    throw err;
  }

  const temporaryPassword = password || generateTemporaryPassword();

  let employee;
  let user;

  await sequelize.transaction(async (transaction) => {
    employee = await employeeRepository.create({
      ...employeeFields,
      company_id: companyId,
      created_by: userId,
      updated_by: userId,
    }, { transaction });

    user = await userRepository.create({
      email,
      password: temporaryPassword,
      role_id: employeeRole.id,
      employee_id: employee.id,
      company_id: companyId,
      status: 'active',
      created_by: userId,
      updated_by: userId,
    }, { transaction });

    if (primaryManagerUserId) {
      await upsertManagerMapping(employee.id, 'PRIMARY', primaryManagerUserId, companyId, userId, transaction);
    }
    if (secondaryManagerUserId) {
      await upsertManagerMapping(employee.id, 'SECONDARY', secondaryManagerUserId, companyId, userId, transaction);
    }
  });

  await createAuditLog(
    userId,
    'CREATE',
    'employees',
    employee.id,
    null,
    { id: employee.id, employee_code: employee.employee_code, linked_user_id: user.id, email },
    ipAddress
  );

  logger.info('Employee created with linked User account', {
    employeeId: employee.id,
    userId: user.id,
    primaryManagerUserId,
    secondaryManagerUserId: secondaryManagerUserId || null,
    createdBy: userId,
  });

  const responseUser = user.toJSON();
  delete responseUser.password;

  const response = { employee, user: responseUser };
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
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Employee>}
 */
const update = async (id, data, userId, ipAddress = null, companyId) => {
  const existing = await getById(id, companyId); // throws 404 if not found

  const {
    primary_manager_user_id: primaryManagerUserId,
    secondary_manager_user_id: secondaryManagerUserId,
    email,
    ...employeeFields
  } = data;

  if (employeeFields.employee_code && employeeFields.employee_code !== existing.employee_code) {
    const taken = await employeeRepository.findByCode(employeeFields.employee_code, companyId);
    if (taken && taken.id !== id) {
      throw conflictError(`Employee code "${employeeFields.employee_code}" is already in use.`);
    }
  }

  if (primaryManagerUserId) {
    await assertValidManager(primaryManagerUserId, companyId, 'Primary Manager');
  }
  if (secondaryManagerUserId) {
    await assertValidManager(secondaryManagerUserId, companyId, 'Secondary Manager');
  }

  // Employee itself carries no email column — updating it means updating
  // the linked User's own email instead (see userEmailField's doc comment
  // in employeeValidation.js). Validated up front, same uniqueness rule as
  // User Master's own email-change flow.
  let linkedUser = null;
  if (email) {
    linkedUser = await userRepository.findByEmployeeId(id, companyId);
    if (!linkedUser) {
      throw badRequestError('This Employee has no linked User account to update the email for.');
    }
    if (email !== linkedUser.email) {
      const taken = await userRepository.findByEmail(email);
      if (taken && taken.id !== linkedUser.id) {
        throw conflictError(`Email "${email}" is already registered to another user.`);
      }
    }
  }

  const oldValues = existing.toJSON();
  let updated;

  await sequelize.transaction(async (transaction) => {
    updated = await employeeRepository.update(id, { ...employeeFields, updated_by: userId }, companyId, { transaction });

    if (linkedUser && email !== linkedUser.email) {
      await userRepository.update(linkedUser.id, { email, updated_by: userId }, { transaction }, companyId);
    }

    if (primaryManagerUserId) {
      await upsertManagerMapping(id, 'PRIMARY', primaryManagerUserId, companyId, userId, transaction);
    }
    if (secondaryManagerUserId !== undefined) {
      if (secondaryManagerUserId === null) {
        const existingSecondary = await managerEmployeeMappingRepository.findByEmployeeAndType(id, 'SECONDARY');
        if (existingSecondary) await existingSecondary.destroy({ transaction });
      } else {
        await upsertManagerMapping(id, 'SECONDARY', secondaryManagerUserId, companyId, userId, transaction);
      }
    }
  });

  await createAuditLog(
    userId,
    'UPDATE',
    'employees',
    id,
    oldValues,
    updated.toJSON(),
    ipAddress
  );

  logger.info('Employee updated', { employeeId: id, userId });

  const refreshed = await employeeRepository.findByIdWithEmail(id, companyId);
  const [withManagers] = await attachManagers([attachEmail(refreshed)]);
  return withManagers;
};

/**
 * Soft-delete an employee.
 * Blocks deletion if the employee is allocated to any active Service PO.
 *
 * @param {number} id
 * @param {number} userId
 * @param {string} ipAddress
 * @returns {Promise<Employee>}
 */
const deleteEmployee = async (id, userId, ipAddress = null, companyId) => {
  const employee = await getById(id, companyId); // throws 404 if not found

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
 * Return all active employees (lightweight list for dropdowns, allocation pickers).
 * @returns {Promise<Employee[]>}
 */
const getActiveEmployees = async (companyId) => {
  return employeeRepository.getActiveEmployees(companyId);
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
 * @param {number} companyId
 * @returns {Promise<{ id: number, employee_code: string, employee_name: string, email: string|null, status: string, company_id: number }[]>}
 */
const getEligibleDeliveryHeads = async (companyId) => {
  const employees = await employeeRepository.getEligibleDeliveryHeads(companyId);

  return employees.map((employee) => ({
    id: employee.id,
    employee_code: employee.employee_code,
    employee_name: employee.full_name,
    email: employee.users && employee.users[0] ? employee.users[0].email : null,
    status: employee.status,
    company_id: employee.company_id,
  }));
};

module.exports = {
  getAll,
  getById,
  getByIdWithEmail,
  create,
  update,
  delete: deleteEmployee,
  getActiveEmployees,
  getEligibleDeliveryHeads,
};
