'use strict';

const servicePORepository = require('../repositories/servicePORepository');
const clientRepository = require('../repositories/clientRepository');
const projectRepository = require('../repositories/projectRepository');
const employeeRepository = require('../repositories/employeeRepository');
const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const timesheetRepository = require('../repositories/timesheetRepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const { Employee } = require('../models');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');
const aiInsightService = require('./aiInsight.service');

/**
 * ServicePO Service
 * All business logic for Service POs and resource allocation.
 */

// Valid status transitions when closing or updating
const ALLOWED_CLOSE_FROM = ['active'];

/**
 * Confirm a Project belongs to the given Client — the cross-check the
 * Client -> Project -> Service PO flow needs on top of each FK's own
 * existence/active/same-company validation (both of which are already
 * enforced by clientRepository.findById()/projectRepository.findById()
 * being company-scoped). Shared by create() and update() so the rule is
 * never duplicated.
 *
 * @param {Project} project - already resolved via projectRepository.findById()
 * @param {number} clientId
 */
function assertProjectBelongsToClient(project, clientId) {
  if (project.client_id !== clientId) {
    const err = new Error('The selected Project does not belong to the selected Client.');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Confirm a candidate Delivery Head: exists, belongs to the same Company
 * as the Service PO, is active, and is not soft-deleted. Always an
 * Employee Master id — never a User Master id (see ServicePO.js's model
 * doc comment on the `deliveryHead` association).
 *
 * employeeRepository.findById() already scopes by company_id AND
 * is_deleted = false, so an employee from another company or a deleted
 * employee both simply resolve as "not found" here — the same branch as a
 * genuinely missing id, which is deliberate (never leak cross-company
 * existence).
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<Employee>}
 */
async function assertValidDeliveryHead(employeeId, companyId) {
  const employee = await employeeRepository.findById(employeeId, companyId);
  if (!employee) {
    const err = new Error('Delivery Head employee not found.');
    err.statusCode = 404;
    throw err;
  }
  if (employee.status !== 'active') {
    const err = new Error('Cannot assign an inactive employee as Delivery Head.');
    err.statusCode = 400;
    throw err;
  }
  return employee;
}

/**
 * Return a paginated list of Service POs.
 *
 * @param {object} query - req.query
 * @returns {Promise<{ data: ServicePO[], meta: object }>}
 */
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || null,
    status: query.status || 'active',
    client_id: query.client_id ? parseInt(query.client_id, 10) : null,
    service_category_id: query.service_category_id ? parseInt(query.service_category_id, 10) : null,
    service_type_id: query.service_type_id ? parseInt(query.service_type_id, 10) : null,
    service_po_id: query.service_po_id ? parseInt(query.service_po_id, 10) : null,
    is_billable: query.is_billable !== undefined ? query.is_billable : undefined,
    start_date_from: query.start_date_from || null,
    start_date_to: query.start_date_to || null,
    companyId,
  };

  const sort = {
    sortBy: query.sort_by || 'created_at',
    sortOrder: query.sort_order || 'DESC',
  };

  const { rows, count } = await servicePORepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * Return the full details for a single Service PO, including resources.
 *
 * @param {number} id
 * @returns {Promise<ServicePO>}
 */
const getById = async (id, companyId) => {
  const po = await servicePORepository.findById(id, companyId);

  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  return po;
};

/**
 * Create a new Service PO.
 * - Auto-generates a PO code (PO-YYYYMMDD-XXXX)
 * - Validates that start_date < end_date
 * - Validates that client and service type exist and are active
 *
 * @param {object} data   - Validated request body
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<ServicePO>}
 */
const create = async (data, userId, req) => {
  const companyId = req.companyId;

  // Validate client exists, is active, AND belongs to the same company —
  // otherwise a PO could be attached to another company's client.
  const client = await clientRepository.findById(data.client_id, companyId);
  if (!client) {
    const err = new Error('Client not found.');
    err.statusCode = 404;
    throw err;
  }
  if (client.status !== 'active') {
    const err = new Error('Cannot create a Service PO for an inactive client.');
    err.statusCode = 400;
    throw err;
  }

  // Validate project exists, is active, AND belongs to the same company —
  // same pattern as the client_id check above (independent grouping).
  const project = await projectRepository.findById(data.project_id, companyId);
  if (!project) {
    const err = new Error('Project not found.');
    err.statusCode = 404;
    throw err;
  }
  if (project.status !== 'active') {
    const err = new Error('Cannot create a Service PO for an inactive project.');
    err.statusCode = 400;
    throw err;
  }
  // Client -> Project -> Service PO: the selected Project must actually
  // belong to the selected Client.
  assertProjectBelongsToClient(project, data.client_id);

  // Delivery Head — mandatory on create (see createServicePOSchema).
  await assertValidDeliveryHead(data.delivery_head_employee_id, companyId);

  // Date ordering guard (Joi already checks, but we also enforce in service)
  if (data.start_date && data.end_date && data.end_date < data.start_date) {
    const err = new Error('End date must be on or after the start date.');
    err.statusCode = 400;
    throw err;
  }

  // The PO number is always supplied by the frontend now (required on
  // createServicePOSchema) — never auto-generated. Only uniqueness is
  // enforced here; scoped to this company (uq_service_pos_company_code).
  const service_po_code = data.service_po_code;

  const existing = await servicePORepository.findByCode(service_po_code, companyId);
  if (existing) {
    const err = new Error(`Service PO code "${service_po_code}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

  const payload = {
    ...data,
    service_po_code,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const po = await servicePORepository.create(payload);

  await createAuditLog(
    userId,
    'CREATE',
    'service_pos',
    po.id,
    null,
    { service_po_code: po.service_po_code, service_po_name: po.service_po_name, client_id: po.client_id, project_id: po.project_id, delivery_head_employee_id: po.delivery_head_employee_id },
    getIpAddress(req)
  );

  logger.info('Service PO created', { poId: po.id, service_po_code: po.service_po_code, userId });

  // AI Insights: New PO Staffing Suggestion — fires on every new Service PO,
  // fully fire-and-forget so a Claude/AI failure can never affect PO
  // creation itself (already logged and recorded by aiInsight.service.js).
  aiInsightService.runJob('new_po_staffing_suggestion', { referenceId: po.id }, companyId).catch((err) => {
    logger.error('AI Insight new_po_staffing_suggestion failed', { poId: po.id, error: err.message });
  });

  return po;
};

/**
 * Update an existing Service PO.
 * Cannot update a PO that is already closed or cancelled.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<ServicePO>}
 */
const update = async (id, data, userId, req) => {
  const companyId = req.companyId;

  const existing = await servicePORepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  if (existing.status === 'closed' || existing.status === 'cancelled') {
    const err = new Error(`Cannot update a Service PO with status "${existing.status}".`);
    err.statusCode = 400;
    throw err;
  }

  // If the caller is changing the service_po_code, ensure it is not taken by
  // any other PO in this company, regardless of its status or soft-delete state.
  if (data.service_po_code && data.service_po_code !== existing.service_po_code) {
    const taken = await servicePORepository.findByCode(data.service_po_code, companyId);
    if (taken && taken.id !== id) {
      const err = new Error(`Service PO code "${data.service_po_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // If client_id is being changed, validate the new client — findById is
  // company-scoped, so a client belonging to another company simply 404s.
  const clientChanged = data.client_id && data.client_id !== existing.client_id;
  if (clientChanged) {
    const client = await clientRepository.findById(data.client_id, companyId);
    if (!client) {
      const err = new Error('Client not found.');
      err.statusCode = 404;
      throw err;
    }
    if (client.status !== 'active') {
      const err = new Error('Cannot reassign a Service PO to an inactive client.');
      err.statusCode = 400;
      throw err;
    }
  }

  // If project_id is being changed, validate the new project — same
  // conditional-on-change pattern as client_id above.
  const projectChanged = data.project_id && data.project_id !== existing.project_id;
  let projectForCrossCheck = null;
  if (projectChanged) {
    const project = await projectRepository.findById(data.project_id, companyId);
    if (!project) {
      const err = new Error('Project not found.');
      err.statusCode = 404;
      throw err;
    }
    if (project.status !== 'active') {
      const err = new Error('Cannot reassign a Service PO to an inactive project.');
      err.statusCode = 400;
      throw err;
    }
    projectForCrossCheck = project;
  } else if (clientChanged) {
    // Client is changing but project_id isn't — the EXISTING project must
    // still belong to the NEW client, otherwise a project_id must also be
    // supplied. Re-fetches the existing project rather than trusting the
    // (possibly stale) `existing` include.
    projectForCrossCheck = await projectRepository.findById(existing.project_id, companyId);
  }

  // Client -> Project -> Service PO: whichever end changed, the resulting
  // pairing must still be consistent.
  if (projectForCrossCheck) {
    assertProjectBelongsToClient(projectForCrossCheck, data.client_id || existing.client_id);
  }

  // Delivery Head — optional on update (a pre-existing Service PO without
  // one must not be broken; see database/migrations/
  // 20260849_add_service_pos_delivery_head.sql), but validated the same
  // way as create() whenever it IS being set/changed.
  if (data.delivery_head_employee_id) {
    await assertValidDeliveryHead(data.delivery_head_employee_id, companyId);
  }

  // Cross-field date validation when one or both dates are being changed
  const newStartDate = data.start_date || existing.start_date;
  const newEndDate = data.end_date || existing.end_date;
  if (newStartDate && newEndDate && newEndDate < newStartDate) {
    const err = new Error('End date must be on or after the start date.');
    err.statusCode = 400;
    throw err;
  }

  const oldValues = {
    service_po_name:     existing.service_po_name,
    client_id:           existing.client_id,
    project_id:          existing.project_id,
    delivery_head_employee_id: existing.delivery_head_employee_id,
    service_type_id:     existing.service_type_id,
    po_value:            existing.po_value,
    start_date:          existing.start_date,
    end_date:            existing.end_date,
    status:              existing.status,
    account_manager:     existing.account_manager,
    service_description: existing.service_description,
    invoice_frequency:   existing.invoice_frequency,
    invoice_amount:      existing.invoice_amount,
  };

  const payload = { ...data, updated_by: userId };
  const updated = await servicePORepository.update(id, payload, companyId);

  await createAuditLog(
    userId,
    'UPDATE',
    'service_pos',
    id,
    oldValues,
    payload,
    getIpAddress(req)
  );

  logger.info('Service PO updated', { poId: id, userId });

  return updated;
};

/**
 * Close a Service PO.
 * Only an 'active' PO can be closed.
 *
 * @param {number} id
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const close = async (id, userId, req) => {
  const companyId = req.companyId;

  const existing = await servicePORepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  if (!ALLOWED_CLOSE_FROM.includes(existing.status)) {
    const err = new Error(
      `Cannot close a Service PO with status "${existing.status}". ` +
      `Only POs with status "active" can be closed.`
    );
    err.statusCode = 400;
    throw err;
  }

  await servicePORepository.close(id, userId, companyId);

  await createAuditLog(
    userId,
    'CLOSE',
    'service_pos',
    id,
    { status: existing.status },
    { status: 'closed' },
    getIpAddress(req)
  );

  logger.info('Service PO closed', { poId: id, userId });
};

/**
 * Allocate one or more employees to a Service PO.
 * - Validates that the PO is active
 * - Validates that all provided employee IDs are active employees
 *
 * @param {number} poId
 * @param {number[]} employeeIds
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const allocateResources = async (poId, employeeIds, userId, req) => {
  const companyId = req.companyId;

  const po = await servicePORepository.findById(poId, companyId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  if (po.status !== 'active') {
    const err = new Error(`Cannot allocate resources to a Service PO with status "${po.status}".`);
    err.statusCode = 400;
    throw err;
  }

  // Validate all employees exist, are active, AND belong to this company —
  // an id from another company simply resolves as "not found" below, the
  // same branch as a genuinely missing id.
  const employees = await Employee.findAll({
    where: { id: employeeIds, company_id: companyId },
    attributes: ['id', 'full_name', 'status'],
  });

  if (employees.length !== employeeIds.length) {
    const foundIds = employees.map((e) => e.id);
    const missing = employeeIds.filter((id) => !foundIds.includes(id));
    const err = new Error(`Employee(s) not found: ${missing.join(', ')}.`);
    err.statusCode = 404;
    throw err;
  }

  const inactiveEmployees = employees.filter((e) => e.status !== 'active');
  if (inactiveEmployees.length > 0) {
    const names = inactiveEmployees.map((e) => `${e.full_name} (ID: ${e.id})`).join(', ');
    const err = new Error(`Cannot allocate inactive employee(s): ${names}.`);
    err.statusCode = 400;
    throw err;
  }

  await servicePORepository.allocateResources(poId, employeeIds, companyId);

  await createAuditLog(
    userId,
    'ALLOCATE_RESOURCES',
    'service_pos',
    poId,
    null,
    { employee_ids: employeeIds },
    getIpAddress(req)
  );

  logger.info('Resources allocated to Service PO', { poId, employeeIds, userId });
};

/**
 * Remove a single employee from a Service PO.
 *
 * @param {number} poId
 * @param {number} employeeId
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const deallocateResource = async (poId, employeeId, userId, req) => {
  const companyId = req.companyId;

  const po = await servicePORepository.findById(poId, companyId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  const deleted = await servicePORepository.deallocateResource(poId, employeeId, companyId);

  if (deleted === 0) {
    const err = new Error('Employee is not allocated to this Service PO.');
    err.statusCode = 404;
    throw err;
  }

  await createAuditLog(
    userId,
    'DEALLOCATE_RESOURCE',
    'service_pos',
    poId,
    { employee_id: employeeId },
    null,
    getIpAddress(req)
  );

  logger.info('Resource deallocated from Service PO', { poId, employeeId, userId });
};

/**
 * Get utilisation data for a Service PO.
 * Returns hours logged, expected hours, and a utilisation percentage.
 *
 * @param {number} poId
 * @returns {Promise<object>}
 */
const getUtilisation = async (poId, companyId) => {
  const po = await servicePORepository.findById(poId, companyId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  const raw = await servicePORepository.getUtilisation(poId, companyId);

  const totalHoursLogged = raw ? raw.total_hours_logged : 0;
  const expectedManHours = raw ? raw.expected_man_hours : 0;

  let utilisationPercentage = 0;
  if (expectedManHours > 0) {
    utilisationPercentage = Math.min(
      parseFloat(((totalHoursLogged / expectedManHours) * 100).toFixed(2)),
      9999.99
    );
  }

  const remainingHours = Math.max(expectedManHours - totalHoursLogged, 0);

  return {
    service_po_id: poId,
    service_po_code: po.service_po_code,
    service_po_name: po.service_po_name,
    expected_man_hours: expectedManHours,
    total_hours_logged: totalHoursLogged,
    remaining_hours: remainingHours,
    utilisation_percentage: utilisationPercentage,
    is_over_utilised: totalHoursLogged > expectedManHours,
  };
};

/**
 * Return a lightweight list of active POs.
 *
 * @returns {Promise<ServicePO[]>}
 */
const getActivePOs = async (companyId) => {
  return servicePORepository.getActivePOs(companyId);
};

/**
 * Whether any work log entry exists anywhere in this Service PO's
 * hierarchy — the Main PO itself, or any Parent/Child node under it —
 * across BOTH work-log sources: the official `timesheets` table and the
 * Employee Self Timesheet draft table (`employee_work_logs`). Used as the
 * delete guard in deleteServicePO() below; nowhere else.
 *
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function hasWorkLogsInHierarchy(servicePOId, companyId) {
  const hierarchyNodes = await servicePOHierarchyRepository.findByServicePO(servicePOId);
  const hierarchyNodeIds = hierarchyNodes.map((node) => node.id);

  const [hasTimesheets, hasEmployeeWorkLogs] = await Promise.all([
    timesheetRepository.existsForServicePO(servicePOId, companyId),
    employeeWorkLogRepository.existsForServicePOOrHierarchy(servicePOId, hierarchyNodeIds, companyId),
  ]);

  return hasTimesheets || hasEmployeeWorkLogs;
}

const deleteServicePO = async (id, userId, companyId) => {
  const existing = await servicePORepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  if (await hasWorkLogsInHierarchy(id, companyId)) {
    const err = new Error(
      'This Service PO cannot be deleted because work log entries exist for this Service PO or its hierarchy.'
    );
    err.statusCode = 400;
    throw err;
  }

  await servicePORepository.softDelete(id, userId, companyId);
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  close,
  delete: deleteServicePO,
  allocateResources,
  deallocateResource,
  getUtilisation,
  getActivePOs,
};
