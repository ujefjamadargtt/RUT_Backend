'use strict';

const servicePORepository = require('../repositories/servicePORepository');
const clientRepository = require('../repositories/clientRepository');
const projectRepository = require('../repositories/projectRepository');
const employeeRepository = require('../repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../repositories/employeeBusinessUnitRepository');
const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const timesheetRepository = require('../repositories/timesheetRepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const { resolveActorCompanyScope, resolveCreateCompanyIdForActor, resolveActorCompanyScopeForSelectedBU } = require('./companyAccessControlService');
const { Employee, Company, sequelize } = require('../models');
const { Op } = require('sequelize');
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
 * Confirm a candidate Client/Project belongs to this Service PO's company —
 * matched two ways: its own company_id equals the PO's companyId, OR it has
 * no company_id at all yet (an Admin/Entity Admin may create a Client or
 * Project before assigning either to a Business Unit at all — see
 * clientService.js/projectService.js's resolveOptionalCreateCompanyId()
 * usage). A strict companyId-scoped findById() alone would 404 that record
 * here even though it's genuinely available to attach — the exact
 * "Client not found" a company-less Admin hits picking their own
 * not-yet-assigned Client. Same idiom as assertValidDeliveryHead() above:
 * fetched UNSCOPED (clientRepository/projectRepository's findByIdUnscoped)
 * and checked after, so an unrelated company's record still simply resolves
 * "not found" below, never leaking cross-company existence.
 *
 * @param {{company_id: number|null}|null} candidate
 * @param {number} companyId
 * @returns {boolean}
 */
function belongsToCompanyOrUnassigned(candidate, companyId) {
  return !!candidate && (candidate.company_id === companyId || candidate.company_id === null);
}

/**
 * Confirm a candidate Delivery Head: exists, belongs to the same Company
 * as the Service PO, is active, and is not soft-deleted. Always an
 * Employee Master id — never a User Master id (see ServicePO.js's model
 * doc comment on the `deliveryHead` association).
 *
 * "Belongs to the Company" is checked two ways, since the Employee Identity
 * redesign left both live: the legacy single `employees.company_id`
 * column (still populated for BU-scoped-created employees) OR a row in
 * `employee_business_units` (the multi-BU membership table — see
 * models/index.js's Employee<->Company belongsToMany doc comment). An
 * Admin-created Employee with no home `company_id` but a BU grant for
 * this exact company must still be a valid pick here. Fetched unscoped by
 * company and checked after, not via employeeRepository.findById()'s
 * strict single-column companyScope(), so that BU-membership case isn't
 * missed; an employee from another company entirely, or a deleted one,
 * still simply resolves as "not found" below — the same branch as a
 * genuinely missing id, which is deliberate (never leak cross-company
 * existence).
 *
 * `companyId` may itself be `null` — a Business Unit is mandatory for a
 * NEW Service PO (see servicePOService.create()'s resolveCreateCompanyId()
 * usage), but this is also called from update() with `existing.company_id`,
 * which can still be `null` on a Service PO created before that requirement
 * existed. There is then no target company to check membership against, so
 * this only confirms the employee exists and is active; company-membership
 * reconciles once a Business Unit is actually assigned. (Deliberately NOT
 * treated as "`employee.company_id ===
 * null` counts as belonging" — that would match almost every Employee post-
 * redesign, since employees.company_id is left NULL in favor of
 * employee_business_units — an unrelated employee would wrongly pass.)
 *
 * @param {number} employeeId
 * @param {number|null} companyId
 * @returns {Promise<Employee>}
 */
async function assertValidDeliveryHead(employeeId, companyId) {
  const employee = await employeeRepository.findById(employeeId, null);
  const belongsToCompany = companyId == null
    ? !!employee
    : !!employee &&
      (employee.company_id === companyId || (await employeeBusinessUnitRepository.exists(employeeId, companyId)));

  if (!belongsToCompany) {
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
 * Respects an OPTIONALLY selected Global Business Unit (X-Company-Id
 * header) for a company-less actor (Admin/Entity Admin), same as
 * getActivePOs() below — this is the "Search Service PO..." dropdown's own
 * list endpoint, so it must narrow the same way when a BU is selected,
 * instead of always returning every owned Company's POs regardless of the
 * UI's current BU selection. Falls back to the full owned set when none is
 * selected, unchanged from before. A BU-scoped actor is unaffected either
 * way (already limited to their own single active BU).
 *
 * @param {object} query - req.query
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @param {number|null} [headerCompanyId] - parsed X-Company-Id header, if any
 * @returns {Promise<{ data: ServicePO[], meta: object }>}
 */
const getAll = async (query = {}, authContext, headerCompanyId = null) => {
  const companyId = await resolveActorCompanyScopeForSelectedBU(authContext, headerCompanyId);
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
    // A company-less Admin/Entity Admin must still see their OWN Service
    // PO(s) created with no Business Unit assigned yet (company_id NULL) —
    // see servicePORepository.companyScope()'s doc comment. No-op for a
    // BU-scoped actor (companyId a plain number there, never an array).
    createdBy: authContext.employeeId,
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
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<ServicePO>}
 */
const getById = async (id, authContext) => {
  const companyId = await resolveActorCompanyScope(authContext);
  const po = await servicePORepository.findById(id, companyId, authContext.employeeId);

  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  return po;
};

/**
 * Create a new Service PO.
 * - Validates that start_date < end_date
 * - Validates that client and service type exist and are active
 *
 * Business Unit resolution for a company-less actor (Admin/Entity Admin):
 *   1. `company_id` in the request body (explicit picker on the frontend).
 *   2. `X-Company-Id` header as fallback (single-BU logins that omit the body field).
 *   3. Neither present → 400 error for a normal PO; NULL (allowed) for a
 *      centralised PO (is_centralised: true), which is intentionally BU-less.
 * A BU-scoped actor's own `req.companyId` always wins — body and header
 * are ignored for them entirely.
 *
 * @param {object} data   - Validated request body
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<ServicePO>}
 */
const create = async (data, userId, req) => {
  const { company_id: bodyCompanyId, ...fields } = data;
  const authContext = { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };

  // Normal Service PO: BU is mandatory (required=true).
  // Centralised Service PO: BU is optional — stays NULL if not supplied.
  // For a multi-BU BU Admin, an explicit body company_id wins over the
  // X-Company-Id header; validation is handled inside resolveCreateCompanyIdForActor.
  const companyId = await resolveCreateCompanyIdForActor(
    req,
    bodyCompanyId != null ? bodyCompanyId : null,
    fields.is_centralised === true
      ? { required: false }
      : { required: true, resourceLabel: 'a Service PO' }
  );
  data = fields;

  // Validate client exists, is active, AND belongs to the same company (or
  // has no company assigned yet — see belongsToCompanyOrUnassigned()) —
  // otherwise a PO could be attached to another company's client.
  const client = await clientRepository.findByIdUnscoped(data.client_id);
  if (!belongsToCompanyOrUnassigned(client, companyId)) {
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
  const project = await projectRepository.findByIdUnscoped(data.project_id);
  if (!belongsToCompanyOrUnassigned(project, companyId)) {
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

  // Delivery Head — NULL by default on create (frontend no longer collects
  // it at creation time; see createServicePOSchema). Only validated when a
  // caller actually supplies one, same conditional pattern update() already
  // uses below.
  if (data.delivery_head_employee_id) {
    await assertValidDeliveryHead(data.delivery_head_employee_id, companyId);
  }

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

  // Reject a duplicate service_po_name up front (case-insensitive, scoped
  // to this company) — code uniqueness alone doesn't stop the same PO
  // from being entered twice under two different codes.
  const duplicateName = await servicePORepository.findByName(data.service_po_name, companyId);
  if (duplicateName) {
    const err = new Error(`Service PO "${data.service_po_name}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

  const payload = {
    ...data,
    service_po_code,
    company_id: companyId,
    delivery_head_employee_id: data.delivery_head_employee_id ?? null,
    created_by: userId,
    updated_by: userId,
  };

  let po;
  await sequelize.transaction(async (transaction) => {
    po = await servicePORepository.create(payload, { transaction });

    // Centralised PO -> existing Employees, the mirror (in the other
    // direction) of employeeService.create()'s own
    // autoMapCentralisedServicePOs() call — see
    // employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO()'s
    // doc comment for the full ownership rule. Only Centralised POs
    // auto-map at all; a normal PO is never auto-mapped to anyone.
    if (payload.is_centralised === true) {
      await employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO(
        po.id, companyId, userId, transaction
      );
    }
  });

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
  const scope = await resolveActorCompanyScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });

  const existing = await servicePORepository.findById(id, scope, req.employeeId);
  if (!existing) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  const companyId = existing.company_id;

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

  // Same rule as create() — a renamed Service PO can't collide with
  // another Service PO's name in the same company.
  if (data.service_po_name && data.service_po_name.trim().toLowerCase() !== existing.service_po_name.toLowerCase()) {
    const nameConflict = await servicePORepository.findByName(data.service_po_name, companyId);
    if (nameConflict && nameConflict.id !== id) {
      const err = new Error(`Service PO "${data.service_po_name}" already exists.`);
      err.statusCode = 409;
      throw err;
    }
  }

  // If client_id is being changed, validate the new client — belongs to the
  // same company, or has no company assigned yet (see
  // belongsToCompanyOrUnassigned()); a client belonging to another company
  // entirely still simply 404s.
  const clientChanged = data.client_id && data.client_id !== existing.client_id;
  if (clientChanged) {
    const client = await clientRepository.findByIdUnscoped(data.client_id);
    if (!belongsToCompanyOrUnassigned(client, companyId)) {
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
    const project = await projectRepository.findByIdUnscoped(data.project_id);
    if (!belongsToCompanyOrUnassigned(project, companyId)) {
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
    is_centralised:      existing.is_centralised,
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
  const scope = await resolveActorCompanyScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });

  const existing = await servicePORepository.findById(id, scope, req.employeeId);
  if (!existing) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  const companyId = existing.company_id;

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
  const scope = await resolveActorCompanyScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });

  const po = await servicePORepository.findById(poId, scope, req.employeeId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  const companyId = po.company_id;

  if (po.status !== 'active') {
    const err = new Error(`Cannot allocate resources to a Service PO with status "${po.status}".`);
    err.statusCode = 400;
    throw err;
  }

  // Validate all employees exist, are active, AND belong to this company —
  // an id from another company simply resolves as "not found" below, the
  // same branch as a genuinely missing id. "Belongs to this company" is
  // checked the same two ways as assertValidDeliveryHead() above: the
  // legacy `company_id` column OR an `employee_business_units` grant, so
  // an Admin-created employee with only a BU grant for this company isn't
  // wrongly rejected. When this PO has no company assigned at all (a
  // legacy row from before a Business Unit became mandatory at create
  // time — companyId null), there is no target company to check
  // membership against, so the filter is skipped
  // entirely — deliberately NOT `{ company_id: null }`, which would wrongly
  // match almost every Employee post-redesign (employees.company_id is left
  // NULL in favor of employee_business_units).
  const employeeWhere = { id: employeeIds };
  if (companyId != null) {
    employeeWhere[Op.or] = [{ company_id: companyId }, { '$businessUnits.id$': companyId }];
  }
  const employees = await Employee.findAll({
    where: employeeWhere,
    include: [{ model: Company, as: 'businessUnits', attributes: [], through: { attributes: [] } }],
    attributes: ['id', 'full_name', 'status'],
    distinct: true,
    subQuery: false,
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
  const scope = await resolveActorCompanyScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });

  const po = await servicePORepository.findById(poId, scope, req.employeeId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  const companyId = po.company_id;

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
 * Get hours-logged data for a Service PO. Used to just also report
 * expected-hours-derived metrics (utilisation %, remaining hours,
 * over-utilised flag) — those all required an expected_man_hours target,
 * which no longer exists on Service PO, so this now returns only the raw
 * hours logged.
 *
 * @param {number} poId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<object>}
 */
const getUtilisation = async (poId, authContext) => {
  const companyId = await resolveActorCompanyScope(authContext);
  const po = await servicePORepository.findById(poId, companyId, authContext.employeeId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  const raw = await servicePORepository.getUtilisation(poId, companyId);

  return {
    service_po_id: poId,
    service_po_code: po.service_po_code,
    service_po_name: po.service_po_name,
    total_hours_logged: raw ? raw.total_hours_logged : 0,
  };
};

/**
 * Return a lightweight list of active POs — the Service PO dropdown data
 * source for BU-dependent screens (e.g. Cost Budget Master's "select a
 * Service PO" picker). Respects an OPTIONALLY selected Global Business Unit
 * (X-Company-Id header) for a company-less actor (Admin/Entity Admin): when
 * one is selected, the list narrows to just that BU's active POs; when none
 * is selected, it falls back to every owned Company's active POs, same as
 * before this narrowing existed — see resolveActorCompanyScopeForSelectedBU's
 * doc comment. A BU-scoped actor is unaffected either way (already limited
 * to their own single active BU).
 *
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @param {number|null} [headerCompanyId] - parsed X-Company-Id header, if any
 * @returns {Promise<ServicePO[]>}
 */
const getActivePOs = async (authContext, headerCompanyId = null) => {
  const companyId = await resolveActorCompanyScopeForSelectedBU(authContext, headerCompanyId);
  return servicePORepository.getActivePOs(companyId, authContext.employeeId);
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

const deleteServicePO = async (id, userId, req) => {
  const scope = await resolveActorCompanyScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });

  const existing = await servicePORepository.findById(id, scope, req.employeeId);
  if (!existing) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  const companyId = existing.company_id;

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
