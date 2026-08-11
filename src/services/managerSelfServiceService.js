'use strict';

const { Employee, ServicePO, sequelize } = require('../models');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const managerServicePOMappingRepository = require('../repositories/managerServicePOMappingRepository');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const timesheetRepository = require('../repositories/timesheetRepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Manager Self-Service — a Manager's own view of their delegated Employees
 * and granted Service POs, and the final step of the delegation chain:
 * assigning a granted Service PO to one of their own Employees. This
 * reuses the EXISTING, UNMODIFIED employeeServicePOMappingService (the
 * same engine every other caller of Employee<->ServicePO mapping already
 * uses) — the only new logic here is the cascading scope check: the
 * Employee must be one this Manager was delegated (via
 * manager_employee_mappings) and the Service PO must be one this Manager
 * was granted (via manager_servicepo_mappings). Managers must NOT be able
 * to map another Manager's Employees — enforced by these same two checks.
 */

function forbiddenError(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

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

/**
 * The Manager's own delegated Employees.
 *
 * @param {number} managerUserId
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
const getMyEmployees = async (managerUserId, companyId) => {
  const mappings = await managerEmployeeMappingRepository.findByManager(managerUserId, companyId);
  if (mappings.length === 0) return [];

  const employees = await Employee.findAll({
    where: { id: mappings.map((m) => m.employee_id) },
    attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
  });
  return employees;
};

/**
 * The Service POs granted to this Manager.
 *
 * @param {number} managerUserId
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
const getMyGrantedServicePOs = async (managerUserId, companyId) => {
  const grants = await managerServicePOMappingRepository.findByManager(managerUserId, companyId);
  if (grants.length === 0) return [];

  const pos = await ServicePO.findAll({
    where: { id: grants.map((g) => g.service_po_id) },
    attributes: ['id', 'service_po_code', 'service_po_name', 'status'],
  });
  return pos;
};

async function assertOwnEmployee(managerUserId, employeeId, companyId) {
  const mapping = await managerEmployeeMappingRepository.findByManagerAndEmployee(managerUserId, employeeId, companyId);
  if (!mapping) {
    throw forbiddenError('This Employee is not one of your mapped Employees.');
  }
}

async function assertGrantedServicePO(managerUserId, servicePOId, companyId) {
  const grant = await managerServicePOMappingRepository.findByManagerAndServicePO(managerUserId, servicePOId, companyId);
  if (!grant) {
    throw forbiddenError('This Service PO has not been granted to you.');
  }
}

/**
 * Assign a Service PO to one of the Manager's own Employees — the
 * cascading restriction, then delegates to the existing, unmodified
 * employeeServicePOMappingService.assign().
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} companyId
 * @param {number} actorId
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const assignServicePOToEmployee = async (managerUserId, employeeId, servicePOId, companyId, actorId) => {
  await assertOwnEmployee(managerUserId, employeeId, companyId);
  await assertGrantedServicePO(managerUserId, servicePOId, companyId);

  const mapping = await employeeServicePOMappingService.assign(employeeId, servicePOId, actorId, companyId);

  logger.info('Manager assigned Service PO to own Employee', { managerUserId, employeeId, servicePOId, actorId });

  return mapping;
};

/**
 * List the Service POs currently assigned to one of the Manager's own
 * Employees — same scoping check as assign/remove, then delegates to the
 * existing, unmodified employeeServicePOMappingRepository.findByEmployee().
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const getEmployeeServicePOs = async (managerUserId, employeeId, companyId) => {
  await assertOwnEmployee(managerUserId, employeeId, companyId);

  return employeeServicePOMappingRepository.findByEmployee(employeeId, companyId);
};

// listMyTeamTimesheetsQuerySchema's sortBy values (kept as-is for API
// backward-compatibility — the query param name doesn't change even though
// the underlying source/column does) mapped onto the actual
// employee_work_logs columns findAll() sorts by.
const TIMESHEET_SORT_BY_TO_WORK_LOG_COLUMN = {
  timesheet_date: 'work_date',
  hours_logged: 'hours',
  created_at: 'created_at',
};

/**
 * The Manager's own COMPLETE timesheet, or one of their mapped Employees'
 * complete timesheet — "complete" meaning every Service PO/hierarchy-node
 * entry that employee has, regardless of which Service PO the MANAGER
 * themselves is granted (Service PO mapping is never used to restrict
 * Timesheet view access — only Employee mapping is).
 *
 * Single unified source: `employee_work_logs` (employeeWorkLogRepository.
 * findAll()), covering every lifecycle stage (pending/approved/synced) in
 * ONE array — there is no longer a separate `drafts` collection. Approval
 * now happens on employee_work_logs BEFORE Sync (see getApprovalSummary/
 * bulkApproveTimesheets above), so this is also the same data Manager
 * approval acts on — one record shape, one collection, everywhere.
 * `approval_status` mirrors the row's own `status` column verbatim
 * (pending/approved/synced) — no separate label is invented for "not yet
 * synced" since employee_work_logs has no stage more granular than that.
 *
 * @param {number} managerUserId
 * @param {number|null} employeeId - null/omitted means "my own timesheet"
 * @param {number} ownEmployeeId - the calling Manager's own req.employeeId (may be null)
 * @param {number} companyId
 * @param {object} query - startDate, endDate, poId, subProjectId, sortBy, sortOrder, page, limit
 * @returns {Promise<{ data, meta }>}
 */
const getTimesheets = async (managerUserId, employeeId, ownEmployeeId, companyId, query) => {
  let targetEmployeeId;

  if (employeeId) {
    await assertOwnEmployee(managerUserId, employeeId, companyId);
    targetEmployeeId = employeeId;
  } else {
    targetEmployeeId = ownEmployeeId;
  }

  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 20;

  if (!targetEmployeeId) {
    // Manager has no linked Employee record of their own and asked for
    // "My Timesheet" — there is nothing to show, not an error.
    return {
      data: [],
      meta: { total: 0, page, limit, totalPages: 0, hasNext: false, hasPrev: false },
    };
  }

  const { rows, count } = await employeeWorkLogRepository.findAll(
    {
      employeeId: targetEmployeeId,
      companyId,
      startDate: query.startDate,
      endDate: query.endDate,
      poId: query.poId,
      subProjectId: query.subProjectId,
    },
    { limit, offset: (page - 1) * limit },
    {
      sortBy: TIMESHEET_SORT_BY_TO_WORK_LOG_COLUMN[query.sortBy] || 'work_date',
      sortOrder: query.sortOrder,
    }
  );

  const data = rows.map((row) => {
    const plain = row.toJSON();
    return {
      ...plain,
      timesheet_date: plain.work_date,
      hours_logged: plain.hours,
      approval_status: plain.status,
    };
  });

  const totalPages = Math.ceil(count / limit) || 0;

  return {
    data,
    meta: { total: count, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
};

/**
 * Manager "Approve" action — approves ONE pending timesheet entry belonging
 * to one of the Manager's own (Primary or Secondary) mapped Employees.
 * Reuses the exact same is_publish mechanism the existing Publish flow
 * already uses (timesheetRepository.publishById — the single-row analog of
 * the existing publishByImportId) — this is not a new approval mechanism,
 * just a new, Manager-scoped entry point into the same one.
 *
 * @param {number} managerUserId
 * @param {number} timesheetId
 * @param {number} companyId
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<Timesheet>}
 */
const approveTimesheet = async (managerUserId, timesheetId, companyId, actorId, ipAddress) => {
  const timesheet = await timesheetRepository.findById(timesheetId, companyId);
  if (!timesheet) {
    throw notFoundError('Timesheet not found.');
  }

  await assertOwnEmployee(managerUserId, timesheet.employee_id, companyId);

  if (timesheet.is_publish) {
    throw conflictError('This timesheet has already been approved.');
  }

  await timesheetRepository.publishById(timesheetId, companyId);

  await createAuditLog(
    actorId,
    'APPROVE',
    'timesheets',
    timesheetId,
    { is_publish: false },
    { is_publish: true },
    ipAddress
  );

  logger.info('Manager approved Employee timesheet', { managerUserId, timesheetId, employeeId: timesheet.employee_id, actorId });

  return timesheetRepository.findById(timesheetId, companyId);
};

/**
 * Day/Month-aggregated approval view — one bucket per calendar day (or
 * per calendar month, when log_type='monthly') summing every Service
 * PO/hierarchy-node Employee Work Log entry for that day/month. Approval
 * happens BEFORE Sync (see bulkApproveTimesheets below and
 * employeeTimesheetService.replaceDailyEntries) — this reads
 * `employee_work_logs` directly, never `timesheets`, so a Manager can act
 * on entries the Employee has genuinely already submitted, whether or not
 * Sync has run yet. Each bucket embeds its underlying rows in `entries` (no
 * separate drill-down call needed) via
 * employeeWorkLogRepository.findForApprovalSummary(), grouped here in
 * application code by work_date (daily) or (year, month) (monthly) — a
 * plain SQL GROUP BY can't also return the row-level detail `entries`
 * needs.
 *
 * @param {number} managerUserId
 * @param {number|null} employeeId - null/omitted means "my own timesheet"
 * @param {number} ownEmployeeId - the calling Manager's own req.employeeId (may be null)
 * @param {number} companyId
 * @param {object} query - startDate, endDate, log_type ('daily'|'monthly'), page, limit
 * @returns {Promise<{ data: object[], meta: object }>}
 */
const getApprovalSummary = async (managerUserId, employeeId, ownEmployeeId, companyId, query) => {
  let targetEmployeeId;

  if (employeeId) {
    await assertOwnEmployee(managerUserId, employeeId, companyId);
    targetEmployeeId = employeeId;
  } else {
    targetEmployeeId = ownEmployeeId;
  }

  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 20;

  if (!targetEmployeeId) {
    return { data: [], meta: { total: 0, page, limit, totalPages: 0, hasNext: false, hasPrev: false } };
  }

  const isMonthly = query.log_type === 'monthly';

  const rows = await employeeWorkLogRepository.findForApprovalSummary({
    employeeId: targetEmployeeId,
    companyId,
    startDate: query.startDate,
    endDate: query.endDate,
  });

  // Group rows into buckets — keyed by the date string (daily) or
  // "year-month" (monthly) — preserving each row's full detail in `entries`.
  const bucketsByKey = new Map();
  for (const row of rows) {
    const plain = row.toJSON();
    const workDate = plain.work_date; // "YYYY-MM-DD"
    const key = isMonthly ? workDate.slice(0, 7) : workDate; // "YYYY-MM" or "YYYY-MM-DD"

    if (!bucketsByKey.has(key)) {
      bucketsByKey.set(key, isMonthly
        ? { employee_id: plain.employee_id, month: parseInt(workDate.slice(5, 7), 10), year: parseInt(workDate.slice(0, 4), 10), entries: [] }
        : { employee_id: plain.employee_id, date: workDate, entries: [] });
    }
    bucketsByKey.get(key).entries.push(plain);
  }

  const buckets = Array.from(bucketsByKey.values()).map((bucket) => {
    const totalHours = bucket.entries.reduce((sum, e) => sum + (parseFloat(e.hours) || 0), 0);
    const approvalStatus = bucket.entries.some((e) => e.status === 'pending') ? 'pending' : 'approved';
    return {
      ...bucket,
      total_hours: totalHours,
      entry_count: bucket.entries.length,
      approval_status: approvalStatus,
    };
  });

  buckets.sort((a, b) => (isMonthly
    ? (b.year - a.year) || (b.month - a.month)
    : b.date.localeCompare(a.date)));

  // Bucket counts are inherently small — bounded by the caller-supplied
  // date range (at most ~31 daily buckets, or a handful of monthly ones)
  // — so pagination is applied in-memory rather than via a second
  // COUNT(DISTINCT ...) aggregate query.
  const total = buckets.length;
  const totalPages = Math.ceil(total / limit) || 0;
  const paged = buckets.slice((page - 1) * limit, page * limit);

  return {
    data: paged,
    meta: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
};

/**
 * Bulk-approve — one action across several dates (daily) or several
 * months (monthly) for one Employee's PENDING Employee Work Log entries
 * (never `timesheets` — approval happens before Sync). Exactly one of
 * `dates`/`months` is expected (enforced by managerSelfServiceValidation.js's
 * Joi .xor()). Only rows currently status='pending' are touched; a
 * date/month with nothing pending is a harmless no-op (0 rows), not an
 * error — unlike the single-row approveTimesheet() above (which targets
 * `timesheets` directly and 409s on an already-approved row). That
 * distinction is deliberate: a bulk multi-select is inherently more likely
 * to include an already-settled item than one deliberate click on a
 * known-pending row.
 *
 * @param {number} managerUserId
 * @param {object} body - { employee_id, dates?, months? }
 * @param {number} companyId
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<{ employee_id, approved: object[], total_rows_approved }>}
 */
const bulkApproveTimesheets = async (managerUserId, body, companyId, actorId, ipAddress) => {
  const { employee_id: employeeId, dates, months } = body;

  await assertOwnEmployee(managerUserId, employeeId, companyId);

  let totalRowsApproved = 0;
  let approved;

  await sequelize.transaction(async (transaction) => {
    if (dates) {
      totalRowsApproved = await employeeWorkLogRepository.approveByEmployeeAndDates(employeeId, dates, companyId, transaction);
      approved = dates.map((date) => ({ date }));
    } else {
      totalRowsApproved = await employeeWorkLogRepository.approveByEmployeeAndMonths(employeeId, months, companyId, transaction);
      approved = months.map(({ month, year }) => ({ month, year }));
    }
  });

  await createAuditLog(
    actorId,
    'APPROVE',
    'employee_work_logs',
    null,
    null,
    { employee_id: employeeId, dates: dates || null, months: months || null, total_rows_approved: totalRowsApproved },
    ipAddress
  );

  logger.info('Manager bulk-approved Employee Work Log entries', {
    managerUserId, employeeId, dates: dates || null, months: months || null, totalRowsApproved, actorId,
  });

  return { employee_id: employeeId, approved, total_rows_approved: totalRowsApproved };
};

/**
 * Remove a Service PO assignment from one of the Manager's own Employees —
 * same scoping check, then delegates to the existing removeMapping().
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const removeServicePOFromEmployee = async (managerUserId, employeeId, servicePOId, companyId) => {
  await assertOwnEmployee(managerUserId, employeeId, companyId);

  const existing = await employeeServicePOMappingRepository.findByEmployeeAndPO(employeeId, servicePOId, companyId);
  if (!existing) {
    const err = new Error('This Service PO is not assigned to this Employee.');
    err.statusCode = 404;
    throw err;
  }

  await employeeServicePOMappingService.removeMapping(existing.id, companyId);

  logger.info('Manager removed Service PO from own Employee', { managerUserId, employeeId, servicePOId });
};

/**
 * Manager self-service "Map Employees" — claim the SECONDARY manager slot
 * for an Employee in the same company. HR sets the mandatory PRIMARY
 * manager at Employee creation (see employeeService.js); this is how a
 * Manager extends their own team afterward. Idempotent if the caller
 * already holds that slot; 409s if someone else does.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} actorId
 * @returns {Promise<ManagerEmployeeMapping>}
 */
const mapEmployeeToSelf = async (managerUserId, employeeId, companyId, actorId) => {
  const employee = await Employee.findOne({ where: { id: employeeId, company_id: companyId, is_deleted: false } });
  if (!employee) {
    throw notFoundError('Employee not found in this company.');
  }

  const existing = await managerEmployeeMappingRepository.findByEmployeeAndType(employeeId, 'SECONDARY');
  if (existing) {
    if (existing.manager_user_id === managerUserId) {
      return existing;
    }
    throw conflictError('This Employee already has a Secondary Manager.');
  }

  const mapping = await managerEmployeeMappingRepository.create({
    company_id: companyId,
    manager_user_id: managerUserId,
    employee_id: employeeId,
    mapping_type: 'SECONDARY',
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  logger.info('Manager self-mapped as Secondary Manager', { managerUserId, employeeId, actorId });

  return mapping;
};

/**
 * Manager self-service "unmap" — remove the calling Manager's own mapping
 * (PRIMARY or SECONDARY, whichever they hold) for an Employee.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const unmapEmployeeFromSelf = async (managerUserId, employeeId, companyId) => {
  const mapping = await managerEmployeeMappingRepository.findByManagerAndEmployee(managerUserId, employeeId, companyId);
  if (!mapping) {
    throw notFoundError('This Employee is not one of your mapped Employees.');
  }

  await managerEmployeeMappingRepository.deleteById(mapping.id);

  logger.info('Manager removed own mapping to Employee', { managerUserId, employeeId });
};

module.exports = {
  getMyEmployees,
  getMyGrantedServicePOs,
  getEmployeeServicePOs,
  getTimesheets,
  approveTimesheet,
  getApprovalSummary,
  bulkApproveTimesheets,
  assignServicePOToEmployee,
  removeServicePOFromEmployee,
  mapEmployeeToSelf,
  unmapEmployeeFromSelf,
};
