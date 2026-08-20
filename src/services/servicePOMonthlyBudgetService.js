'use strict';

const moment = require('moment-timezone');
const servicePOMonthlyBudgetRepository = require('../repositories/servicePOMonthlyBudgetRepository');
const servicePORepository = require('../repositories/servicePORepository');
const managerServicePOMappingRepository = require('../repositories/managerServicePOMappingRepository');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const dateHelper = require('../helpers/dateHelper');
const { getDeadlineInfo, assertWithinEditWindow } = require('../config/servicePOMonthlyBudget.config');
const logger = require('../utils/logger');

/**
 * Service PO Monthly Budget Service
 * Business logic for the Service PO Manager's month-wise Invoice Amount /
 * Billed Amount master (see database/migrations/20260853_*.sql).
 */

const round2 = (value) => Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * Confirm a Service PO exists and belongs to the caller's company.
 * findById() is already company-scoped, so a PO from another company simply
 * 404s here, same as a genuinely missing id.
 *
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<ServicePO>}
 */
async function assertServicePOExists(servicePOId, companyId) {
  const po = await servicePORepository.findById(servicePOId, companyId);
  if (!po) {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }
  return po;
}

/**
 * Role-based Service PO access scope shared by every endpoint in this file
 * (dropdown list, monthly budget list/fetch, and upsert). The primary role
 * (req.userRoleName) is the sole source of truth — same convention
 * auth.js/resolveCompany.js use for hierarchy/company scoping — never a
 * request parameter, and always narrowed by companyId (itself always the
 * DB-verified req.companyId, never client input) so a mapping row from
 * another company can never widen access.
 *
 * - Manager: the UNION of Service POs mapped to them via either of the two
 *   independent mapping paths that exist in this data model:
 *     1. manager_servicepo_mappings (manager_user_id) — a Service PO Admin's
 *        formal grant to a Manager on their team (see teamMappingService).
 *     2. employee_servicepo_mapping (employee_id), via the Manager's own
 *        linked Employee record (req.employeeId) — the same staffing
 *        assignment employeeServicePOMappingRepository.findByEmployee()
 *        feeds to the Employee Timesheet module. A Manager IS an Employee
 *        and can be assigned to a PO as a resource the same way any other
 *        Employee is, independent of any Service PO Admin grant.
 *   Both are real, independently-populated mapping tables in this app — a
 *   Manager mapped through only one of them must still see that PO here.
 * - Every other role (BU Admin, Service PO Admin, Admin, HR, Employee,
 *   Project Admin, ...): no individual-mapping restriction — every Service
 *   PO in the caller's own company. A Company IS the BU/entity boundary
 *   here, so companyId scoping (applied by every repository call this
 *   feeds into) already satisfies "all Service POs in the user's BU/entity,
 *   never another BU's" for these roles.
 *
 * @param {number} userId
 * @param {string} roleName
 * @param {number} companyId
 * @param {number|null} employeeId - req.employeeId; may be null for a non-Employee-backed account
 * @returns {Promise<number[]|null>} allowed service_po_ids, or null = no PO-level restriction
 */
async function getAllowedServicePOIds(userId, roleName, companyId, employeeId) {
  if (roleName === 'Manager') {
    const [grantedMappings, staffedMappings] = await Promise.all([
      managerServicePOMappingRepository.findByManager(userId, companyId),
      employeeId
        ? employeeServicePOMappingRepository.findByEmployee(employeeId, companyId, 'active')
        : Promise.resolve([]),
    ]);

    const ids = new Set([
      ...grantedMappings.map((m) => m.service_po_id),
      ...staffedMappings.map((m) => m.service_po_id),
    ]);
    return Array.from(ids);
  }

  return null;
}

/**
 * GET /service-po-monthly-budgets — fetch the single record for one Service
 * PO in one month/year.
 *
 * @param {object} query - { service_po_id, month, year }
 * @param {number} companyId
 * @param {number} userId - authenticated caller (req.userId) — never trust a request param for this
 * @param {string} roleName - authenticated caller's primary role (req.userRoleName)
 * @param {number|null} employeeId - authenticated caller's linked Employee id (req.employeeId)
 * @returns {Promise<ServicePOMonthlyBudget>}
 */
const getOne = async (query, companyId, userId, roleName, employeeId) => {
  const { service_po_id, month, year } = query;

  await assertServicePOExists(service_po_id, companyId);

  const allowedIds = await getAllowedServicePOIds(userId, roleName, companyId, employeeId);
  if (allowedIds !== null && !allowedIds.includes(Number(service_po_id))) {
    // Same 404 as a genuinely missing/other-company PO — doesn't leak
    // whether the PO exists outside the caller's mapped scope.
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  const record = await servicePOMonthlyBudgetRepository.findOne(service_po_id, month, year, companyId);
  if (!record) {
    const err = new Error('Service PO monthly budget not found.');
    err.statusCode = 404;
    throw err;
  }

  return record;
};

/**
 * GET /service-po-monthly-budgets (no service_po_id) — every monthly budget
 * record actually saved for the given year — optionally narrowed to one
 * month — across every Service PO the caller's role is allowed to see (see
 * getAllowedServicePOIds). Not a zero-defaulted placeholder for every active
 * PO (that's what /current is for); this returns only rows that exist in
 * service_po_monthly_budgets. Each returned record carries its own `month`,
 * so a year-only call (no month filter) can still be grouped/displayed
 * per month on the frontend.
 *
 * @param {object} query - { year, month? }
 * @param {number} companyId
 * @param {number} userId - authenticated caller (req.userId)
 * @param {string} roleName - authenticated caller's primary role (req.userRoleName)
 * @param {number|null} employeeId - authenticated caller's linked Employee id (req.employeeId)
 * @returns {Promise<{ month: number|null, year: number, records: object[] }>}
 */
const listMonthlyBudgets = async (query, companyId, userId, roleName, employeeId) => {
  const year = parseInt(query.year, 10);
  const month = query.month !== undefined ? parseInt(query.month, 10) : null;

  const allowedIds = await getAllowedServicePOIds(userId, roleName, companyId, employeeId);

  const records = await servicePOMonthlyBudgetRepository.findBudgetsForMonth(month, year, companyId, allowedIds);

  return {
    month,
    year,
    records: records.map((record) => ({
      id: record.id,
      service_po_id: record.service_po_id,
      service_po_code: record.servicePO ? record.servicePO.service_po_code : null,
      service_po_name: record.servicePO ? record.servicePO.service_po_name : null,
      client: record.servicePO && record.servicePO.client
        ? { id: record.servicePO.client.id, client_code: record.servicePO.client.client_code, client_name: record.servicePO.client.client_name }
        : null,
      month: record.month,
      year: record.year,
      invoice_amount: round2(record.invoice_amount),
      invoice_description: record.invoice_description,
      billed_amount: round2(record.billed_amount),
      billed_remark: record.billed_remark,
      updated_at: record.updated_at,
    })),
  };
};

/**
 * GET /service-po-monthly-budgets/service-pos — the Service PO dropdown.
 * Active Service POs the caller's role is allowed to see, no budget data.
 *
 * @param {number} companyId
 * @param {number} userId - authenticated caller (req.userId)
 * @param {string} roleName - authenticated caller's primary role (req.userRoleName)
 * @param {number|null} employeeId - authenticated caller's linked Employee id (req.employeeId)
 * @returns {Promise<object[]>}
 */
const listServicePOsForDropdown = async (companyId, userId, roleName, employeeId) => {
  const allowedIds = await getAllowedServicePOIds(userId, roleName, companyId, employeeId);
  const servicePOs = await servicePOMonthlyBudgetRepository.findActiveServicePOsForDropdown(companyId, allowedIds);

  return servicePOs.map((po) => ({
    service_po_id: po.id,
    service_po_code: po.service_po_code,
    service_po_name: po.service_po_name,
    is_billable: po.is_billable,
    status: po.status,
    client: po.client ? { id: po.client.id, client_code: po.client.client_code, client_name: po.client.client_name } : null,
  }));
};

/**
 * GET /service-po-monthly-budgets/current — everything the Service PO
 * Manager screen needs for the CURRENT server month/year: the deadline
 * status plus every active Service PO's existing entry (or defaulted-to-zero
 * placeholder when nothing has been filled in yet).
 *
 * @param {number} companyId
 * @param {number} userId - authenticated caller (req.userId)
 * @param {string} roleName - authenticated caller's primary role (req.userRoleName)
 * @param {number|null} employeeId - authenticated caller's linked Employee id (req.employeeId)
 * @returns {Promise<object>}
 */
const getCurrentMonth = async (companyId, userId, roleName, employeeId) => {
  const month = dateHelper.getCurrentMonth();
  const year = dateHelper.getCurrentYear();
  const monthName = moment.tz(dateHelper.DEFAULT_TZ).format('MMMM');

  const { deadline, days_remaining, deadline_passed } = getDeadlineInfo(month, year);

  const allowedIds = await getAllowedServicePOIds(userId, roleName, companyId, employeeId);

  let servicePOs = await servicePOMonthlyBudgetRepository.findActiveServicePOsWithBudget(month, year, companyId);
  if (allowedIds !== null) {
    const allowedSet = new Set(allowedIds);
    servicePOs = servicePOs.filter((po) => allowedSet.has(po.id));
  }

  const data = servicePOs.map((po) => {
    const budget = po.monthlyBudgets && po.monthlyBudgets[0];
    return {
      service_po_id: po.id,
      service_po_code: po.service_po_code,
      service_po_name: po.service_po_name,
      client: po.client ? { id: po.client.id, client_code: po.client.client_code, client_name: po.client.client_name } : null,
      invoice_amount: budget ? round2(budget.invoice_amount) : 0,
      invoice_description: budget ? budget.invoice_description : null,
      billed_amount: budget ? round2(budget.billed_amount) : 0,
      billed_remark: budget ? budget.billed_remark : null,
      updated_at: budget ? budget.updated_at : null,
    };
  });

  return {
    month,
    year,
    month_name: monthName,
    deadline,
    days_remaining,
    deadline_passed,
    service_pos: data,
  };
};

/**
 * POST /service-po-monthly-budgets — upsert (create or update) the record
 * for one Service PO + month/year, per the unique constraint on
 * (service_po_id, month, year).
 *
 * Two independent rules from servicePOMonthlyBudget.config.js apply here:
 *   - assertWithinEditWindow(): a HARD gate — this record's month is
 *     writable from the 1st of that month through the 7th of the
 *     FOLLOWING month (inclusive); outside that window the write is
 *     rejected with 400.
 *   - getDeadlineInfo(): informational only, unaffected by the above — a
 *     data-completeness target (default 10th of the month) purely for the
 *     response's deadline/days_remaining/deadline_passed fields, so the
 *     caller/UI can still warn the user even on a write that already passed
 *     assertWithinEditWindow().
 *
 * @param {object} data - { service_po_id, month, year, invoice_amount, invoice_description, billed_amount, billed_remark }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<{ record: ServicePOMonthlyBudget, deadline: object }>}
 */
const upsert = async (data, userId, req) => {
  const companyId = req.companyId;
  const { service_po_id, month, year } = data;

  assertWithinEditWindow(month, year);

  await assertServicePOExists(service_po_id, companyId);

  const allowedIds = await getAllowedServicePOIds(userId, req.userRoleName, companyId, req.employeeId);
  if (allowedIds !== null && !allowedIds.includes(Number(service_po_id))) {
    // Same 404 as a genuinely missing/other-company PO — a Manager cannot
    // create/update a budget for a Service PO outside their own mapped scope,
    // regardless of what service_po_id they submit.
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  }

  const deadlineInfo = getDeadlineInfo(month, year);

  const existing = await servicePOMonthlyBudgetRepository.findOne(service_po_id, month, year, companyId);

  const payload = {
    service_po_id,
    month,
    year,
    invoice_amount: round2(data.invoice_amount),
    invoice_description: data.invoice_description ?? null,
    billed_amount: round2(data.billed_amount),
    billed_remark: data.billed_remark ?? null,
    company_id: companyId,
    updated_by: userId,
  };

  let record;
  let action;

  if (existing) {
    action = 'UPDATE';
    const oldValues = {
      invoice_amount: existing.invoice_amount,
      invoice_description: existing.invoice_description,
      billed_amount: existing.billed_amount,
      billed_remark: existing.billed_remark,
    };

    record = await servicePOMonthlyBudgetRepository.update(existing.id, payload, companyId);

    await createAuditLog(
      userId,
      'UPDATE',
      'service_po_monthly_budgets',
      existing.id,
      oldValues,
      payload,
      req ? getIpAddress(req) : null
    );
  } else {
    action = 'CREATE';
    payload.created_by = userId;
    record = await servicePOMonthlyBudgetRepository.create(payload);

    await createAuditLog(
      userId,
      'CREATE',
      'service_po_monthly_budgets',
      record.id,
      null,
      payload,
      req ? getIpAddress(req) : null
    );
  }

  logger.info('Service PO monthly budget upserted', { servicePOId: service_po_id, month, year, action, userId });

  const withAssociations = await servicePOMonthlyBudgetRepository.findById(record.id, companyId);

  return { record: withAssociations, deadline: deadlineInfo };
};

module.exports = {
  getOne,
  listMonthlyBudgets,
  listServicePOsForDropdown,
  getCurrentMonth,
  upsert,
};
