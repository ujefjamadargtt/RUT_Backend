'use strict';

const employeeRepository = require('../repositories/employeeRepository');
const employeeRoleRepository = require('../repositories/employeeRoleRepository');
const roleRepository = require('../repositories/roleRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Admin Service — Platform Admin's Employee(role=Admin)-creation and "View
 * Admins" module (per the RBAC spec: "Platform Admin should NOT directly
 * create Entity Admin or BU Admin"). Creates a bare Employee holding the
 * "Admin" role — no Company/Entity/Business Unit (Admin is platform-wide,
 * like Platform Admin — see resolveCompany.js). The new Admin then creates
 * Entity Admins/BU Admins itself via entityAdmin.routes.js / ordinary
 * Employee Master create/update (Employee-as-Identity redesign — see
 * database/migrations/20260864-20260880).
 *
 * getAll/getById are scoped to the Admins THIS Platform Admin created
 * (employees.created_by) — same isolation principle as
 * entityAdminService.js's "View Entity Admins" module, so one Platform
 * Admin account can never see Admins created by a different Platform
 * Admin account.
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

async function resolveAdminRole() {
  const role = await roleRepository.findByName('Admin');
  if (!role) {
    fail('The "Admin" role is not seeded.', 500);
  }
  return role;
}

/**
 * @param {object} data - { email, password }
 * @param {number} actorId - the Platform Admin creating this employee
 * @param {string} ipAddress
 * @returns {Promise<object>} the created Admin's public summary
 */
const createAdmin = async (data, actorId, ipAddress = null) => {
  const { email, password } = data;

  const existing = await employeeRepository.findByEmail(email);
  if (existing) {
    fail(`An employee with email "${email}" already exists.`, 409);
  }

  const adminRole = await resolveAdminRole();

  const employee = await employeeRepository.create({
    email,
    password,
    full_name: email.split('@')[0],
    employee_code: `ADM${Date.now().toString().slice(-6)}`,
    company_id: null,
    status: 'active',
    // Admin is a platform-wide role with no timesheet of its own to
    // approve — never held-back awaiting approval like a regular Employee.
    is_timesheet_approval_required: false,
    created_by: actorId,
    updated_by: actorId,
  });

  await employeeRoleRepository.replaceForEmployee(employee.id, [adminRole.id], actorId, null);

  const summary = { id: employee.id, email: employee.email, role_id: adminRole.id, company_id: employee.company_id };

  await createAuditLog(actorId, 'CREATE', 'employees', employee.id, null, summary, ipAddress);

  logger.info('Admin created', { employeeId: employee.id, actorId });

  return summary;
};

/**
 * @param {object} query - { page, limit, search, status, sort_by, sort_order }
 * @param {number} actorId - the calling Platform Admin (req.employeeId) —
 *   every result is scoped to Admins THIS Platform Admin created.
 * @returns {Promise<{ data, meta }>}
 */
const getAll = async (query = {}, actorId) => {
  const { page, limit, offset } = getPaginationParams(query);
  const adminRole = await resolveAdminRole();

  const { rows, count } = await employeeRepository.findByRoleAndCreator(
    adminRole.id,
    { search: query.search, status: query.status, createdBy: actorId },
    { limit, offset },
    { sortBy: query.sort_by, sortOrder: query.sort_order }
  );

  const meta = getPaginationMeta(count, page, limit);
  return { data: rows, meta };
};

/**
 * @param {number} id
 * @param {number} actorId - the calling Platform Admin — an Admin created
 *   by a DIFFERENT Platform Admin 404s here, the same branch as a
 *   genuinely missing id (never leak cross-Platform-Admin existence).
 * @returns {Promise<Employee>}
 */
const getById = async (id, actorId) => {
  const adminRole = await resolveAdminRole();
  const employee = await employeeRepository.findByIdWithRoleAndCreator(id, adminRole.id, actorId);

  if (!employee) {
    fail('Admin not found.', 404);
  }

  return employee;
};

module.exports = {
  createAdmin,
  getAll,
  getById,
};
