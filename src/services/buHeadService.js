'use strict';

const { sequelize } = require('../models');
const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const employeeRepository = require('../repositories/employeeRepository');
const companyRepository = require('../repositories/companyRepository');
const userAdditionalRoleRepository = require('../repositories/userAdditionalRoleRepository');
const buHeadCompanyMappingRepository = require('../repositories/buHeadCompanyMappingRepository');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { generateTemporaryPassword } = require('../utils/password');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * BU Head Service — "BU Head Master": create/list/view/edit/activate/
 * deactivate BU Head Users, and manage their BU (Company) mappings. Mirrors
 * companyService.createWithAdmin's "Employee + User + dual role, one
 * transaction" shape for creation, and entityBuAdminService.js's shape for
 * list/view/edit — but BU Head is scoped to a SET of Companies
 * (bu_head_company_mappings) rather than a single company_id, and never
 * creates a Company.
 *
 * Every method is scoped to entityIds (req.entityIds, populated by
 * requireEntityAdminOrAdmin.js) — a BU Head is only visible/manageable by
 * the Admin/Entity Admin whose own Entities its mapped Companies fall
 * under, exactly like BU Admin Master (entityBuAdminService.js).
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

async function resolveBuHeadRoleId() {
  const role = await roleRepository.findByName('BU Head');
  if (!role) {
    fail('The "BU Head" role is not seeded. Run database/migrations/20260861_add_bu_head_role.sql first.', 500);
  }
  return role.id;
}

/**
 * @param {number[]} entityIds
 * @returns {Promise<number[]>} Company ids under the caller's owned Entities
 */
async function resolveAllowedCompanyIds(entityIds) {
  return companyRepository.findIdsByEntityIds(entityIds);
}

/**
 * Every requested company id must fall inside the caller's own Entity
 * scope — the same "cannot touch another Entity Admin's Entities" guard
 * companyService.createWithAdmin applies to entity_id, applied here to
 * every entry of company_ids.
 *
 * @param {number[]} companyIds
 * @param {number[]} allowedCompanyIds
 */
function assertCompaniesInScope(companyIds, allowedCompanyIds) {
  const outOfScope = companyIds.find((id) => !allowedCompanyIds.includes(id));
  if (outOfScope !== undefined) {
    fail(`Company #${outOfScope} is not one of your own Entities' BUs.`, 403);
  }
}

/**
 * Create a BU Head — an Employee + linked User (role = BU Head) + that
 * User's additional Employee role, plus its initial BU (Company) mappings —
 * all in one transaction. Any failure rolls back everything; no orphaned
 * Employee/User row is ever left behind.
 *
 * @param {object} data - employeeValidation.createEmployeeSchema fields
 *   (minus manager assignment) + { company_ids: number[] }
 * @param {number} actorId - the Admin/Entity Admin creating this BU Head
 * @param {string} ipAddress
 * @param {number[]} entityIds - the calling actor's own owned Entities
 * @returns {Promise<{ employee: object, buHead: object, companyIds: number[], temporaryPassword?: string }>}
 */
const createBuHead = async (data, actorId, ipAddress = null, entityIds = []) => {
  const {
    email,
    password,
    company_ids: requestedCompanyIds,
    ...employeeFields
  } = data;

  const companyIds = [...new Set(requestedCompanyIds)];

  const allowedCompanyIds = await resolveAllowedCompanyIds(entityIds);
  assertCompaniesInScope(companyIds, allowedCompanyIds);

  const homeCompanyId = companyIds[0];

  if (employeeFields.employee_code) {
    const existingCode = await employeeRepository.findByCode(employeeFields.employee_code, homeCompanyId);
    if (existingCode) {
      fail(`Employee code "${employeeFields.employee_code}" is already in use.`, 409);
    }
  }

  const existingUser = await userRepository.findByEmail(email);
  if (existingUser) {
    fail(`A user with email "${email}" already exists.`, 409);
  }

  const [buHeadRole, employeeRole] = await Promise.all([
    resolveBuHeadRoleId().then((id) => ({ id })),
    roleRepository.findByName('Employee'),
  ]);
  if (!employeeRole) {
    fail('The "Employee" role is not seeded.', 500);
  }

  const temporaryPassword = password || generateTemporaryPassword();

  let employee, buHead;
  await sequelize.transaction(async (transaction) => {
    // BU Head's own Employee record, like a BU Admin's — auto-published
    // timesheets, never held for approval (same override
    // companyService.createWithAdmin applies to BU Admin's own Employee row).
    employee = await employeeRepository.create(
      {
        ...employeeFields,
        is_timesheet_approval_required: false,
        company_id: homeCompanyId,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction }
    );

    // company_id: null — a BU Head is not scoped to a single Company like a
    // BU Admin; its actual scope is resolved per-request against
    // bu_head_company_mappings (see resolveCompany.js), never a stored
    // default. Same NULL convention as Entity Admin/Admin.
    buHead = await userRepository.create(
      {
        email,
        password: temporaryPassword,
        role_id: buHeadRole.id,
        employee_id: employee.id,
        company_id: null,
        status: 'active',
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction }
    );

    // The BU Head's second role — Employee — granted additively so the same
    // User resolves as both, exactly like companyService.createWithAdmin
    // does for BU Admin.
    await userAdditionalRoleRepository.replaceForUser(buHead.id, [employeeRole.id], actorId, transaction);

    await buHeadCompanyMappingRepository.bulkCreate(companyIds, buHead.id, actorId, { transaction });
  });

  await createAuditLog(
    actorId,
    'CREATE',
    'employees',
    employee.id,
    null,
    { id: employee.id, employee_code: employee.employee_code, company_id: employee.company_id, linked_user_id: buHead.id },
    ipAddress
  );

  const buHeadSummary = {
    id: buHead.id,
    email: buHead.email,
    employee_id: employee.id,
    role_id: buHead.role_id,
    roles: ['BU Head', 'Employee'],
    company_ids: companyIds,
  };
  await createAuditLog(actorId, 'CREATE', 'users', buHead.id, null, buHeadSummary, ipAddress);
  await createAuditLog(actorId, 'CREATE', 'bu_head_company_mappings', buHead.id, null, { company_ids: companyIds }, ipAddress);

  logger.info('BU Head created with linked Employee record, dual role assignment, and BU mappings', {
    employeeId: employee.id,
    userId: buHead.id,
    companyIds,
    createdBy: actorId,
  });

  const employeeSummary = { id: employee.id, employee_code: employee.employee_code, full_name: employee.full_name, email };

  const response = { employee: employeeSummary, buHead: buHeadSummary, companyIds };
  if (!password) {
    response.temporaryPassword = temporaryPassword;
  }

  return response;
};

/**
 * @param {number[]} entityIds
 * @param {object} query - { page, limit, search, status, sort_by, sort_order }
 * @returns {Promise<{ data, meta }>}
 */
const getAll = async (entityIds, query = {}) => {
  const { page, limit, offset } = getPaginationParams(query);
  const [buHeadRoleId, allowedCompanyIds] = await Promise.all([
    resolveBuHeadRoleId(),
    resolveAllowedCompanyIds(entityIds),
  ]);
  const buHeadUserIds = await buHeadCompanyMappingRepository.findBuHeadUserIdsForCompanyIds(allowedCompanyIds);

  const { rows, count } = await userRepository.findByIdsInAndRole(
    buHeadUserIds,
    buHeadRoleId,
    { search: query.search, status: query.status },
    { limit, offset },
    { sortBy: query.sort_by, sortOrder: query.sort_order }
  );

  const meta = getPaginationMeta(count, page, limit);
  return { data: rows, meta };
};

/**
 * @param {number} id
 * @param {number[]} entityIds
 * @returns {Promise<User>}
 */
const getById = async (id, entityIds) => {
  const [buHeadRoleId, allowedCompanyIds] = await Promise.all([
    resolveBuHeadRoleId(),
    resolveAllowedCompanyIds(entityIds),
  ]);

  const user = await userRepository.findById(id);
  if (!user || user.role_id !== buHeadRoleId) {
    fail('BU Head not found.', 404);
  }

  const mappedCompanyIds = await buHeadCompanyMappingRepository.findCompanyIdsForBuHead(id);
  const inScope = mappedCompanyIds.some((companyId) => allowedCompanyIds.includes(companyId));
  if (!inScope) {
    fail('BU Head not found.', 404);
  }

  return user;
};

/**
 * @param {number} id
 * @param {object} data - { status? }
 * @param {number[]} entityIds
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<User>}
 */
const update = async (id, data, entityIds, actorId, req) => {
  const existing = await getById(id, entityIds);

  const oldValues = { status: existing.status };
  const updated = await userRepository.update(id, { ...data, updated_by: actorId });

  await createAuditLog(actorId, 'UPDATE', 'users', id, oldValues, data, getIpAddress(req));

  logger.info('BU Head updated', { userId: id, actorId });

  return updated;
};

/**
 * @param {number} id
 * @param {'active'|'inactive'} status
 * @param {number[]} entityIds
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<User>}
 */
const setStatus = async (id, status, entityIds, actorId, req) => {
  const existing = await getById(id, entityIds);

  const updated = await userRepository.update(id, { status, updated_by: actorId });

  await createAuditLog(actorId, 'UPDATE', 'users', id, { status: existing.status }, { status }, getIpAddress(req));

  logger.info('BU Head status changed', { userId: id, status, actorId });

  return updated;
};

/**
 * @param {number} id
 * @param {number[]} entityIds
 * @returns {Promise<object[]>}
 */
const getMappedCompanies = async (id, entityIds) => {
  await getById(id, entityIds); // ownership + role check
  return buHeadCompanyMappingRepository.findMappingsForBuHead(id);
};

/**
 * Map one or more additional Companies to an existing BU Head.
 *
 * @param {number} id
 * @param {number[]} companyIds
 * @param {number[]} entityIds
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<object[]>} the BU Head's full mapped-company list after the change
 */
const mapCompanies = async (id, companyIds, entityIds, actorId, req) => {
  await getById(id, entityIds); // ownership + role check

  const allowedCompanyIds = await resolveAllowedCompanyIds(entityIds);
  const uniqueCompanyIds = [...new Set(companyIds)];
  assertCompaniesInScope(uniqueCompanyIds, allowedCompanyIds);

  for (const companyId of uniqueCompanyIds) {
    const alreadyMapped = await buHeadCompanyMappingRepository.exists(id, companyId);
    if (alreadyMapped) {
      fail(`Company #${companyId} is already mapped to this BU Head.`, 409);
    }
  }

  await buHeadCompanyMappingRepository.bulkCreate(uniqueCompanyIds, id, actorId);

  await createAuditLog(actorId, 'CREATE', 'bu_head_company_mappings', id, null, { company_ids: uniqueCompanyIds }, getIpAddress(req));

  logger.info('Companies mapped to BU Head', { userId: id, companyIds: uniqueCompanyIds, actorId });

  return buHeadCompanyMappingRepository.findMappingsForBuHead(id);
};

/**
 * Remove a single BU (Company) mapping — deletes only the mapping row;
 * never the Company/User/Employee it points at.
 *
 * @param {number} id
 * @param {number} companyId
 * @param {number[]} entityIds
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<void>}
 */
const unmapCompany = async (id, companyId, entityIds, actorId, req) => {
  await getById(id, entityIds); // ownership + role check

  const deleted = await buHeadCompanyMappingRepository.deleteMapping(id, companyId);
  if (deleted === 0) {
    fail(`Company #${companyId} is not mapped to this BU Head.`, 404);
  }

  await createAuditLog(actorId, 'DELETE', 'bu_head_company_mappings', id, { company_id: companyId }, null, getIpAddress(req));

  logger.info('Company unmapped from BU Head', { userId: id, companyId, actorId });
};

module.exports = {
  createBuHead,
  getAll,
  getById,
  update,
  setStatus,
  getMappedCompanies,
  mapCompanies,
  unmapCompany,
};
