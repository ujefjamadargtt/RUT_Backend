'use strict';

const employeeRepository = require('../repositories/employeeRepository');
const employeeRoleRepository = require('../repositories/employeeRoleRepository');
const roleRepository = require('../repositories/roleRepository');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Entity Admin Service — Admin's "View Entity Admins" / "Manage Entity
 * Admins" module (create + list/view/edit/status). Entity Admin employees
 * have no Company/Entity to scope by (company_id is always NULL — see
 * resolveCompany.js), so scoping instead uses employees.created_by: an
 * Admin only ever sees the Entity Admins THEY created.
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

async function resolveEntityAdminRole() {
  const role = await roleRepository.findByName('Entity Admin');
  if (!role) {
    fail('The "Entity Admin" role is not seeded.', 500);
  }
  return role;
}

/**
 * @param {object} data - { email, password }
 * @param {number} actorId - the Admin creating this employee
 * @param {string} ipAddress
 * @returns {Promise<object>} the created Entity Admin's public summary
 */
const createEntityAdmin = async (data, actorId, ipAddress = null) => {
  const { email, password } = data;

  const existing = await employeeRepository.findByEmail(email);
  if (existing) {
    fail(`An employee with email "${email}" already exists.`, 409);
  }

  const entityAdminRole = await resolveEntityAdminRole();

  const employee = await employeeRepository.create({
    email,
    password,
    full_name: email.split('@')[0],
    employee_code: `ENA${Date.now().toString().slice(-6)}`,
    company_id: null,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  await employeeRoleRepository.replaceForEmployee(employee.id, [entityAdminRole.id], actorId, null);

  const summary = { id: employee.id, email: employee.email, role_id: entityAdminRole.id, company_id: employee.company_id };

  await createAuditLog(actorId, 'CREATE', 'employees', employee.id, null, summary, ipAddress);

  logger.info('Entity Admin created', { employeeId: employee.id, actorId });

  return summary;
};

/**
 * @param {object} query - { page, limit, search, status, sort_by, sort_order }
 * @param {number} actorId - the calling Admin (req.employeeId) — every
 *   result is scoped to Entity Admins THIS Admin created.
 * @returns {Promise<{ data, meta }>}
 */
const getAll = async (query = {}, actorId) => {
  const { page, limit, offset } = getPaginationParams(query);
  const entityAdminRole = await resolveEntityAdminRole();

  const { rows, count } = await employeeRepository.findByRoleAndCreator(
    entityAdminRole.id,
    { search: query.search, status: query.status, createdBy: actorId },
    { limit, offset },
    { sortBy: query.sort_by, sortOrder: query.sort_order }
  );

  const meta = getPaginationMeta(count, page, limit);
  return { data: rows, meta };
};

/**
 * @param {number} id
 * @param {number} actorId - the calling Admin — an Entity Admin created by
 *   a DIFFERENT Admin 404s here, the same branch as a genuinely missing id.
 * @returns {Promise<Employee>}
 */
const getById = async (id, actorId) => {
  const entityAdminRole = await resolveEntityAdminRole();
  const employee = await employeeRepository.findByIdWithRoleAndCreator(id, entityAdminRole.id, actorId);

  if (!employee) {
    fail('Entity Admin not found.', 404);
  }

  return employee;
};

/**
 * @param {number} id
 * @param {object} data
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<Employee>}
 */
const update = async (id, data, actorId, req) => {
  const existing = await getById(id, actorId);

  const oldValues = { email: existing.email, status: existing.status };
  const updated = await employeeRepository.update(id, { ...data, updated_by: actorId }, null);

  await createAuditLog(actorId, 'UPDATE', 'employees', id, oldValues, data, getIpAddress(req));

  logger.info('Entity Admin updated by Admin', { employeeId: id, actorId });

  return updated;
};

/**
 * @param {number} id
 * @param {'active'|'inactive'} status
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<Employee>}
 */
const setStatus = async (id, status, actorId, req) => {
  const existing = await getById(id, actorId);

  const updated = await employeeRepository.update(id, { status, updated_by: actorId }, null);

  await createAuditLog(
    actorId,
    'UPDATE',
    'employees',
    id,
    { status: existing.status },
    { status },
    getIpAddress(req)
  );

  logger.info('Entity Admin status changed by Admin', { employeeId: id, status, actorId });

  return updated;
};

module.exports = {
  createEntityAdmin,
  getAll,
  getById,
  update,
  setStatus,
};
