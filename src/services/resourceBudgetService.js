'use strict';

const { sequelize } = require('../models');
const resourceBudgetRepository = require('../repositories/resourceBudgetRepository');
const servicePORepository = require('../repositories/servicePORepository');
const employeeRepository = require('../repositories/employeeRepository');
const companyAccessControlService = require('./companyAccessControlService');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { parseMonthString, toMonthString } = require('../helpers/monthPeriodHelper');
const { MAX_MONTHLY_HOURS } = require('../config/resourceBudget.config');
const logger = require('../utils/logger');

/**
 * Resource Budget Service
 * Business logic for the Resource Budget Master (planned monthly hours per
 * Employee + Service PO) — see
 * database/migrations/20260859_create_resource_budget_master.sql.
 *
 * Central rule enforced everywhere hours are written: one employee's total
 * ACTIVE resource budget hours across every Service PO, for one month, must
 * never exceed MAX_MONTHLY_HOURS (176 by default).
 */

const round2 = (value) => Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * Resolve the caller's company scope from server-verified req fields only —
 * a plain companyId for a BU-scoped actor, or the resolved array of owned
 * Company ids for a company-less Admin/Entity Admin
 * (companyAccessControlService.resolveActorCompanyScope). Every function
 * below used to read `req.companyId` directly, which is undefined for
 * Admin/Entity Admin and previously crashed on every real write/aggregate.
 *
 * @param {import('express').Request} req
 * @returns {Promise<number|number[]>}
 */
function resolveScope(req) {
  return companyAccessControlService.resolveActorCompanyScope({
    companyId: req.companyId,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
  });
}

/**
 * `createdBy` is passed through to servicePORepository.findById()'s
 * companyScope() so a Centralised (BU-less, company_id NULL) Service PO's
 * own creator can still resolve it here — without it, a company-less
 * actor's array-form scope has no NULL-company fallback at all, and even
 * the PO's own creator gets a false "Service PO not found."
 *
 * @param {number} servicePOId
 * @param {number|number[]} companyId
 * @param {number} [createdBy]
 * @returns {Promise<ServicePO>}
 */
async function assertServicePOExists(servicePOId, companyId, createdBy) {
  const po = await servicePORepository.findById(servicePOId, companyId, createdBy);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  return po;
}

/**
 * Confirm the Employee record itself exists (and isn't soft-deleted) — NOT
 * scoped to any company/Business Unit. Cross-BU staffing is a deliberate,
 * supported pattern in this app (employeeServicePOMappingService.assign()
 * allows mapping an Employee to a Service PO in a different company, and
 * even an Employee with no Business Unit at all, "as long as each is
 * independently within the caller's owned scope" at assign time) —
 * authorization for budgeting against a specific Service PO is
 * assertEmployeeMappedToServicePO() below, not a second, redundant
 * "does the Employee also have a BU matching this PO's company" check.
 * That extra check used to live here and rejected legitimately
 * cross-BU-mapped employees with a false "not found" — confirmed live on
 * two separate Service POs/employees.
 * @param {number} empId
 * @returns {Promise<Employee>}
 */
async function assertEmployeeExists(empId) {
  const employee = await employeeRepository.findById(empId, null);
  if (!employee) {
    const err = new Error(`Employee ${empId} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return employee;
}

/**
 * The authorization gate for budgeting an Employee against a Service PO —
 * the mapping row's own company_id is always stamped from the Service PO's
 * company at assign time (see employeeServicePOMappingService.assign()), so
 * this alone already confirms the pairing was authorized within the
 * caller's scope; no separate Employee-BU-match check is needed on top.
 * @param {number} empId
 * @param {number} servicePOId
 * @param {number} companyId
 */
async function assertEmployeeMappedToServicePO(empId, servicePOId, companyId) {
  const mapped = await resourceBudgetRepository.isEmployeeMappedToServicePO(empId, servicePOId, companyId);
  if (!mapped) {
    const err = new Error(`Employee ${empId} is not mapped to Service PO ${servicePOId}.`);
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Build the "cannot exceed N hours" message shared by the single-record and
 * bulk validation paths.
 * @param {number} newTotal
 * @returns {string}
 */
function overCapMessage(newTotal) {
  return `Employee monthly resource budget cannot exceed ${MAX_MONTHLY_HOURS} hours. Current total after this request would be ${newTotal} hours.`;
}

/**
 * @param {ResourceBudget} record
 * @returns {object}
 */
function toResponse(record) {
  const json = record.toJSON();
  return {
    id: json.id,
    emp_id: json.emp_id,
    employee_code: json.employee ? json.employee.employee_code : null,
    employee_name: json.employee ? json.employee.full_name : null,
    service_po_id: json.service_po_id,
    service_po_code: json.servicePO ? json.servicePO.service_po_code : null,
    service_po_name: json.servicePO ? json.servicePO.service_po_name : null,
    month: toMonthString(json.month, json.year),
    hours: round2(json.hours),
    status: json.status,
    created_at: json.created_at,
    updated_at: json.updated_at,
  };
}

/**
 * GET /service-pos/:servicePoId mapped-employees equivalent — every
 * employee actively mapped to this Service PO (employee_servicepo_mapping,
 * status 'active'), reusing the existing mapping table rather than
 * introducing a new mapping concept. Deliberately NOT further filtered by
 * the employee's own Business Unit — cross-BU staffing (mapping an Employee
 * to a Service PO in a different company than their own) is a supported
 * pattern (see employeeServicePOMappingService.assign()), and this list
 * must match what create()/bulkUpsert() will actually accept.
 * @param {number} servicePOId
 * @param {import('express').Request} req
 * @returns {Promise<object[]>}
 */
const getMappedEmployees = async (servicePOId, req) => {
  const scope = await resolveScope(req);
  const po = await assertServicePOExists(servicePOId, scope, req.employeeId);
  const employees = await resourceBudgetRepository.findMappedEmployees(servicePOId, po.company_id);
  return employees.map((e) => ({
    id: e.id,
    employee_code: e.employee_code,
    full_name: e.full_name,
    designation: e.designation,
    status: e.status,
  }));
};

/**
 * POST /resource-budgets — create a single record.
 * @param {object} data - { emp_id, service_po_id, month: "YYYY-MM", hours }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object>}
 */
const create = async (data, userId, req) => {
  const scope = await resolveScope(req);
  const { emp_id, service_po_id } = data;
  const { month, year } = parseMonthString(data.month);
  const hours = round2(data.hours);

  // Resolve the Service PO's OWN concrete company_id first (within the
  // caller's permitted scope) — every budget row is stamped/scoped with
  // THIS company, regardless of which of the caller's owned companies the
  // Employee themselves happens to belong to (cross-BU staffing is allowed
  // — see assertEmployeeMappedToServicePO()'s doc comment).
  const po = await assertServicePOExists(service_po_id, scope, req.employeeId);
  const companyId = po.company_id;
  await assertEmployeeExists(emp_id);
  await assertEmployeeMappedToServicePO(emp_id, service_po_id, companyId);

  const existing = await resourceBudgetRepository.findOne(emp_id, service_po_id, month, year, companyId);
  if (existing) {
    const err = new Error(
      `A resource budget record already exists for this employee, Service PO, and month (${data.month}).`
    );
    err.statusCode = 400;
    throw err;
  }

  const currentTotal = await resourceBudgetRepository.sumActiveHoursForEmployeeMonth(emp_id, month, year);
  const newTotal = round2(currentTotal + hours);
  if (newTotal > MAX_MONTHLY_HOURS) {
    const err = new Error(overCapMessage(newTotal));
    err.statusCode = 400;
    throw err;
  }

  const payload = {
    emp_id,
    service_po_id,
    month,
    year,
    hours,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const record = await resourceBudgetRepository.create(payload);
  await createAuditLog(userId, 'CREATE', 'resource_budget_master', record.id, null, payload, req ? getIpAddress(req) : null);
  logger.info('Resource budget created', { empId: emp_id, servicePOId: service_po_id, month: data.month, userId });

  const withAssociations = await resourceBudgetRepository.findById(record.id, companyId);
  return toResponse(withAssociations);
};

/**
 * PUT /resource-budgets/:id — update hours. emp_id/service_po_id/month are
 * immutable via update (deactivate + create a new record to move a budget).
 * @param {number} id
 * @param {object} data - { hours }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object>}
 */
const update = async (id, data, userId, req) => {
  const scope = await resolveScope(req);

  const existing = await resourceBudgetRepository.findById(id, scope);
  if (!existing) {
    const err = new Error('Resource budget record not found.');
    err.statusCode = 404;
    throw err;
  }
  const companyId = existing.company_id;

  const hours = round2(data.hours);

  // Exclude THIS record from the running total, then add back the
  // requested hours — never simply add on top of the old total (that would
  // double-count this record's own existing hours).
  const currentTotal = await resourceBudgetRepository.sumActiveHoursForEmployeeMonth(
    existing.emp_id,
    existing.month,
    existing.year,
    { excludeId: id }
  );
  const newTotal = round2(currentTotal + hours);
  if (newTotal > MAX_MONTHLY_HOURS) {
    const err = new Error(overCapMessage(newTotal));
    err.statusCode = 400;
    throw err;
  }

  const oldValues = { hours: existing.hours };
  await resourceBudgetRepository.update(id, { hours, updated_by: userId }, companyId);
  await createAuditLog(userId, 'UPDATE', 'resource_budget_master', id, oldValues, { hours }, req ? getIpAddress(req) : null);
  logger.info('Resource budget updated', { id, userId });

  const updated = await resourceBudgetRepository.findById(id, companyId);
  return toResponse(updated);
};

/**
 * DELETE /resource-budgets/:id — soft deactivate.
 * @param {number} id
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const deactivate = async (id, userId, req) => {
  const scope = await resolveScope(req);

  const existing = await resourceBudgetRepository.findById(id, scope);
  if (!existing) {
    const err = new Error('Resource budget record not found.');
    err.statusCode = 404;
    throw err;
  }
  const companyId = existing.company_id;

  await resourceBudgetRepository.update(id, { status: 'inactive', updated_by: userId }, companyId);
  await createAuditLog(userId, 'DELETE', 'resource_budget_master', id, { status: existing.status }, { status: 'inactive' }, req ? getIpAddress(req) : null);
  logger.info('Resource budget deactivated', { id, userId });
};

/**
 * GET /resource-budgets/service-po/:servicePoId
 * @param {number} servicePOId
 * @param {import('express').Request} req
 * @returns {Promise<object[]>}
 */
const listByServicePO = async (servicePOId, req) => {
  const companyId = await resolveScope(req);
  await assertServicePOExists(servicePOId, companyId, req.employeeId);
  const records = await resourceBudgetRepository.findByServicePO(servicePOId, companyId);
  return records.map(toResponse);
};

/**
 * GET /resource-budgets — filtered list (emp_id and/or month, both optional).
 * @param {object} query - { emp_id?, month? } (month is "YYYY-MM")
 * @param {import('express').Request} req
 * @returns {Promise<object[]>}
 */
const list = async (query, req) => {
  const companyId = await resolveScope(req);
  const filters = {};
  if (query.emp_id !== undefined) filters.emp_id = query.emp_id;
  if (query.month !== undefined) {
    const { month, year } = parseMonthString(query.month);
    filters.month = month;
    filters.year = year;
  }

  const records = await resourceBudgetRepository.findAll(filters, companyId);
  return records.map(toResponse);
};

/**
 * POST /resource-budgets/bulk — create/update every employee's hours for one
 * Service PO + month in a single transaction. Every employee's FINAL
 * monthly total (existing hours on every OTHER Service PO + the hours this
 * request sets for the current Service PO) is validated BEFORE any write —
 * if even one employee would exceed the cap, nothing is saved and every
 * per-employee failure is reported.
 *
 * @param {object} data - { service_po_id, month: "YYYY-MM", resources: [{ emp_id, hours }] }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object[]>}
 */
const bulkUpsert = async (data, userId, req) => {
  const scope = await resolveScope(req);
  const { service_po_id, resources } = data;
  const { month, year } = parseMonthString(data.month);

  // Same "resolve the PO's own company first" pattern as create() — every
  // budget row is stamped/scoped with THIS company, regardless of which of
  // the caller's owned companies each Employee themselves belongs to
  // (cross-BU staffing is allowed — see assertEmployeeMappedToServicePO()'s
  // doc comment).
  const po = await assertServicePOExists(service_po_id, scope, req.employeeId);
  const companyId = po.company_id;

  // Pass 1 — employee existence + Service PO mapping, collected per-employee
  // rather than failing on the first bad row.
  const mappingErrors = [];
  for (const item of resources) {
    try {
      await assertEmployeeExists(item.emp_id);
      await assertEmployeeMappedToServicePO(item.emp_id, service_po_id, companyId);
    } catch (err) {
      mappingErrors.push({ emp_id: item.emp_id, message: err.message });
    }
  }
  if (mappingErrors.length > 0) {
    const err = new Error('Resource budget validation failed');
    err.statusCode = 400;
    err.errors = mappingErrors;
    throw err;
  }

  // Pass 2 — the 176-hour cap, per employee. baseTotal excludes this Service
  // PO entirely (whatever existing row it has for this PO/month is being
  // REPLACED by this request's value, not added to), then adds the
  // requested hours back on top of every OTHER Service PO's active total.
  const hoursErrors = [];
  for (const item of resources) {
    const hours = round2(item.hours);
    const baseTotal = await resourceBudgetRepository.sumActiveHoursForEmployeeMonth(
      item.emp_id,
      month,
      year,
      { excludeServicePOId: service_po_id }
    );
    const newTotal = round2(baseTotal + hours);
    if (newTotal > MAX_MONTHLY_HOURS) {
      hoursErrors.push({
        emp_id: item.emp_id,
        message: `Employee monthly resource budget cannot exceed ${MAX_MONTHLY_HOURS} hours. Current total would be ${newTotal} hours.`,
      });
    }
  }
  if (hoursErrors.length > 0) {
    const err = new Error('Resource budget validation failed');
    err.statusCode = 400;
    err.errors = hoursErrors;
    throw err;
  }

  // Every employee validated — now perform every create/update inside one
  // transaction. If anything throws here, the whole batch rolls back and no
  // partial data is left behind.
  const savedIds = await sequelize.transaction(async (transaction) => {
    const ids = [];
    for (const item of resources) {
      const hours = round2(item.hours);
      const existing = await resourceBudgetRepository.findOne(item.emp_id, service_po_id, month, year, companyId, transaction);

      if (existing) {
        const oldValues = { hours: existing.hours, status: existing.status };
        await resourceBudgetRepository.update(existing.id, { hours, status: 'active', updated_by: userId }, companyId, transaction);
        await createAuditLog(userId, 'UPDATE', 'resource_budget_master', existing.id, oldValues, { hours }, req ? getIpAddress(req) : null);
        ids.push(existing.id);
      } else {
        const payload = {
          emp_id: item.emp_id,
          service_po_id,
          month,
          year,
          hours,
          company_id: companyId,
          created_by: userId,
          updated_by: userId,
        };
        const record = await resourceBudgetRepository.create(payload, { transaction });
        await createAuditLog(userId, 'CREATE', 'resource_budget_master', record.id, null, payload, req ? getIpAddress(req) : null);
        ids.push(record.id);
      }
    }
    return ids;
  });

  logger.info('Resource budgets bulk-saved', { servicePOId: service_po_id, month: data.month, count: savedIds.length, userId });

  const withAssociations = await Promise.all(savedIds.map((id) => resourceBudgetRepository.findById(id, companyId)));
  return withAssociations.map(toResponse);
};

module.exports = {
  getMappedEmployees,
  create,
  update,
  deactivate,
  listByServicePO,
  list,
  bulkUpsert,
};
