'use strict';

const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const timesheetService = require('./timesheetService');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const dateHelper = require('../helpers/dateHelper');
const logger = require('../utils/logger');

/**
 * Employee Timesheet Service — Employee Self Timesheet module, STAGE 1 ONLY.
 *
 * REDESIGN NOTE: Employee entries are written EXCLUSIVELY to
 * `employee_work_logs` (employeeWorkLogRepository) — never to `timesheets`.
 * They only become official Timesheet records when an Admin runs the Sync
 * (see timesheetService.previewPmsImport/confirmImport, which read from
 * employee_work_logs and reuse the exact Excel-import pipeline). This file
 * must never require timesheetRepository or write to the Timesheet model.
 *
 * `timesheetService.resolveManualEntryReferences` IS still reused here —
 * it only queries the Employee/ServicePO models (employee-active,
 * PO-loggable-status, sub-project-belongs-to-PO), never the `timesheets`
 * table itself, so reusing it does not violate "don't validate against
 * timesheets."
 *
 * The 176-hour monthly cap is intentionally NOT enforced here — that rule
 * is part of the official Timesheet and is applied once, at Sync time,
 * by the same logic the Excel import already uses.
 */

const DAILY_HOUR_CAP = 12;

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

/** Normalise a Date object or ISO string to a plain "YYYY-MM-DD" string. */
function toDateString(date) {
  return dateHelper.formatDate(date);
}

/**
 * Reject any date after today (Asia/Kolkata) — "current month and previous
 * dates only", per the Calendar API's futureDisabled rule.
 */
function assertNotFutureDate(dateValue) {
  const dateStr = toDateString(dateValue);
  const todayStr = toDateString(dateHelper.nowDate());
  if (dateStr > todayStr) {
    const err = new Error('Timesheet entries cannot be created or edited for a future date.');
    err.statusCode = 400;
    throw err;
  }
  return dateStr;
}

/**
 * Confirm the Service PO is actively mapped to this employee
 * (employee_servicepo_mapping, status = 'active') — the ONLY gate that
 * decides which projects an employee may log work against.
 */
async function assertProjectMapped(employeeId, servicePOId, companyId) {
  const mapping = await employeeServicePOMappingRepository.findByEmployeeAndPO(employeeId, servicePOId, companyId);
  if (!mapping || mapping.status !== 'active') {
    throw forbiddenError(`Service PO #${servicePOId} is not assigned to you.`);
  }
}

/**
 * 12-hours/day cap — sums this employee's work_logs on one date (excluding
 * the row being updated, if any) and rejects if the requested hours would
 * push the day's total over DAILY_HOUR_CAP.
 */
async function assertDailyCap(employeeId, dateStr, hoursRequested, companyId, excludeId = null) {
  const existingHours = await employeeWorkLogRepository.getDailyHours(dateStr, employeeId, excludeId, companyId);
  const total = existingHours + parseFloat(hoursRequested);
  if (total > DAILY_HOUR_CAP) {
    const err = new Error(
      `Total hours for ${dateStr} cannot exceed ${DAILY_HOUR_CAP}. ` +
      `Current total after this request would be ${Math.round(total * 100) / 100} hours.`
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Create a new work log entry (Stage 1 — draft, not yet official).
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {object} data - { service_po_id, sub_project_id?, hours, description, timesheet_date }
 * @returns {Promise<EmployeeWorkLog>}
 */
const createEntry = async (employeeId, companyId, data) => {
  const dateStr = assertNotFutureDate(data.timesheet_date);

  await assertProjectMapped(employeeId, data.service_po_id, companyId);

  // Reuse the Admin module's employee-active / PO-eligible-status /
  // sub-project-belongs-to-PO checks — these only query Employee/ServicePO,
  // never `timesheets`.
  await timesheetService.resolveManualEntryReferences(
    { employee_id: employeeId, service_po_id: data.service_po_id, sub_project_id: data.sub_project_id },
    companyId
  );

  const duplicate = await employeeWorkLogRepository.checkDuplicate(employeeId, data.service_po_id, dateStr, null, companyId);
  if (duplicate) {
    throw conflictError(`You already have a work log entry for ${dateStr} under this Service PO.`);
  }

  await assertDailyCap(employeeId, dateStr, data.hours, companyId);

  const record = await employeeWorkLogRepository.create({
    employee_id: employeeId,
    service_po_id: data.service_po_id,
    sub_project_id: data.sub_project_id || null,
    work_date: dateStr,
    hours: data.hours,
    description: data.description,
    company_id: companyId,
    status: 'pending',
    created_by: employeeId,
    updated_by: employeeId,
  });

  logger.info('Employee work log entry created', { workLogId: record.id, employeeId, companyId });

  return record;
};

/**
 * Update an existing work log entry. Employee may only edit their own
 * entries — INCLUDING already-synced ones: Employee Work Logs are the
 * source of truth, and Sync is an idempotent/overwrite operation that
 * always re-projects the CURRENT state of the month into `timesheets` (see
 * timesheetService.previewPmsImport). Editing a previously-synced entry
 * reverts it to status='pending' (clearing synced_at/timesheet_import_id)
 * to signal "this no longer matches what's in the official Timesheet —
 * re-sync to update it."
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} id
 * @param {object} data - Any subset of { service_po_id, sub_project_id, hours, description, timesheet_date }
 * @returns {Promise<EmployeeWorkLog>}
 */
const updateEntry = async (employeeId, companyId, id, data) => {
  const existing = await employeeWorkLogRepository.findByIdForEmployee(id, employeeId, companyId);
  if (!existing) {
    throw notFoundError(`Work log entry #${id} was not found.`);
  }

  const servicePOId = data.service_po_id ?? existing.service_po_id;
  const subProjectId = data.sub_project_id !== undefined ? data.sub_project_id : existing.sub_project_id;
  const hours = data.hours ?? existing.hours;
  const dateStr = data.timesheet_date ? assertNotFutureDate(data.timesheet_date) : existing.work_date;

  await assertProjectMapped(employeeId, servicePOId, companyId);

  await timesheetService.resolveManualEntryReferences(
    { employee_id: employeeId, service_po_id: servicePOId, sub_project_id: subProjectId },
    companyId
  );

  const duplicate = await employeeWorkLogRepository.checkDuplicate(employeeId, servicePOId, dateStr, id, companyId);
  if (duplicate) {
    throw conflictError(`You already have a work log entry for ${dateStr} under this Service PO.`);
  }

  await assertDailyCap(employeeId, dateStr, hours, companyId, id);

  const updated = await employeeWorkLogRepository.update(id, {
    service_po_id: servicePOId,
    sub_project_id: subProjectId || null,
    work_date: dateStr,
    hours,
    description: data.description !== undefined ? data.description : existing.description,
    updated_by: employeeId,
    // Any edit invalidates a prior sync snapshot — revert unconditionally
    // (a no-op if it was already 'pending') rather than diffing fields.
    status: 'pending',
    synced_at: null,
    timesheet_import_id: null,
  }, companyId);

  logger.info('Employee work log entry updated', { workLogId: id, employeeId, companyId });

  return updated;
};

/**
 * Delete an existing work log entry (own entries only — INCLUDING
 * already-synced ones; see updateEntry's doc). If the employee later
 * re-syncs this month, a deleted entry simply won't be part of the "latest
 * Employee Work Logs" the sync reads, so it drops out of `timesheets` too
 * on the next sync's overwrite.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} id
 * @returns {Promise<void>}
 */
const deleteEntry = async (employeeId, companyId, id) => {
  const existing = await employeeWorkLogRepository.findByIdForEmployee(id, employeeId, companyId);
  if (!existing) {
    throw notFoundError(`Work log entry #${id} was not found.`);
  }

  await employeeWorkLogRepository.deleteById(id, companyId);
  logger.info('Employee work log entry deleted', { workLogId: id, employeeId, companyId });
};

/**
 * Calendar Summary for one month: one entry per date with { totalHours,
 * hasEntries, futureDisabled }. Only current month and previous dates are
 * editable — futureDisabled marks every date after today.
 *
 * @param {number} employeeId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<Array<{ date, totalHours, hasEntries, futureDisabled }>>}
 */
const getCalendarSummary = async (employeeId, month, year, companyId) => {
  const summaryRows = await employeeWorkLogRepository.getCalendarSummary({ employeeId, month, year, companyId });
  const summaryByDate = new Map(summaryRows.map((row) => [row.date, row]));

  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  const todayStr = toDateString(dateHelper.nowDate());

  const days = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const entry = summaryByDate.get(cursor);
    days.push({
      date: cursor,
      totalHours: entry ? entry.totalHours : 0,
      hasEntries: !!entry,
      futureDisabled: cursor > todayStr,
    });
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    cursor = toDateString(next);
  }

  return days;
};

/**
 * Daily Entries for one date.
 *
 * @param {number} employeeId
 * @param {string} date - "YYYY-MM-DD"
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog[]>}
 */
const getDailyEntries = async (employeeId, date, companyId) => {
  const { rows } = await employeeWorkLogRepository.findAll(
    { employeeId, startDate: date, endDate: date, companyId },
    { limit: 100, offset: 0 }
  );
  return rows;
};

const INTERNAL_ROW_LABEL = 'Internal';

/**
 * Monthly Summary: total hours per Service PO for the month, plus a
 * day-by-day breakdown (Service PO rows x day-of-month columns) for the
 * frontend matrix view. Purely informational at this stage — this is NOT
 * the 176-hour official cap (that only applies once entries are synced into
 * `timesheets`).
 *
 * Every row is one of the employee's currently-mapped Service POs (same set
 * '/projects' returns) — hours always show under the actual PO's own name,
 * even a PO whose is_billable flag is false (e.g. "Idle"). Only entries left
 * over from a Service PO the employee is no longer actively mapped to (the
 * mapping was removed after the hours were logged) fall into a catch-all
 * "Internal" row.
 *
 * @param {number} employeeId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<{ byServicePO: Array, totalHours: number, days: number[], rows: Array, columnTotals: object, grandTotal: number }>}
 */
const getMonthlySummary = async (employeeId, month, year, companyId) => {
  const [byServicePORows, dayBreakdownRows, mappings] = await Promise.all([
    employeeWorkLogRepository.getMonthlySummary({ employeeId, month, year, companyId }),
    employeeWorkLogRepository.getMonthlyDayBreakdown({ employeeId, month, year, companyId }),
    employeeServicePOMappingRepository.findByEmployee(employeeId, companyId, 'active'),
  ]);

  const totalHours = byServicePORows.reduce(
    (sum, row) => sum + (parseFloat(row.get('total_hours')) || 0),
    0
  );

  const byServicePO = byServicePORows.map((row) => ({
    servicePOId: row.service_po_id,
    servicePOCode: row.servicePO?.service_po_code,
    servicePOName: row.servicePO?.service_po_name,
    totalHours: parseFloat(row.get('total_hours')) || 0,
    entryCount: parseInt(row.get('entry_count'), 10) || 0,
  }));

  const { endDate } = dateHelper.getMonthBounds(month, year);
  const daysInMonth = parseInt(endDate.split('-')[2], 10);
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const emptyHoursByDay = () => days.reduce((acc, d) => ({ ...acc, [d]: 0 }), {});

  const rowsByKey = new Map();
  const mappedPOsById = new Map();
  // Seed every currently-mapped Service PO up front (same source as
  // getMappedProjects/'/projects') so a PO with zero hours this month still
  // shows up as an all-zero row instead of being silently dropped.
  for (const mapping of mappings) {
    if (!mapping.servicePO) continue;
    mappedPOsById.set(mapping.servicePO.id, mapping.servicePO);
    rowsByKey.set(`po-${mapping.servicePO.id}`, {
      servicePOId: mapping.servicePO.id,
      label: mapping.servicePO.service_po_name,
      hoursByDay: emptyHoursByDay(),
      total: 0,
    });
  }

  for (const row of dayBreakdownRows) {
    const servicePO = mappedPOsById.get(row.service_po_id);
    const day = parseInt(row.day, 10);
    const hours = parseFloat(row.total_hours) || 0;

    const key = servicePO ? `po-${row.service_po_id}` : 'internal';
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        servicePOId: servicePO ? row.service_po_id : null,
        label: servicePO ? servicePO.service_po_name : INTERNAL_ROW_LABEL,
        hoursByDay: emptyHoursByDay(),
        total: 0,
      });
    }
    const bucket = rowsByKey.get(key);
    bucket.hoursByDay[day] += hours;
    bucket.total += hours;
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  const mappedRows = [...rowsByKey.values()]
    .filter((row) => row.servicePOId !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
  const internalRow = rowsByKey.get('internal');
  const orderedRows = internalRow ? [...mappedRows, internalRow] : mappedRows;

  const rows = orderedRows.map((row) => ({
    servicePOId: row.servicePOId,
    label: row.label,
    hoursByDay: Object.fromEntries(
      Object.entries(row.hoursByDay).map(([d, h]) => [d, round2(h)])
    ),
    total: round2(row.total),
  }));

  const columnTotals = emptyHoursByDay();
  for (const row of orderedRows) {
    for (const day of days) columnTotals[day] += row.hoursByDay[day];
  }

  return {
    byServicePO,
    totalHours: round2(totalHours),
    days,
    rows,
    columnTotals: Object.fromEntries(
      Object.entries(columnTotals).map(([d, h]) => [d, round2(h)])
    ),
    grandTotal: round2(orderedRows.reduce((sum, row) => sum + row.total, 0)),
  };
};

/**
 * Project Loading — the only source for the Service PO dropdown. Unmapped
 * or inactive-mapping POs are never returned.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<Array<{ id, code, name }>>}
 */
const getMappedProjects = async (employeeId, companyId) => {
  const mappings = await employeeServicePOMappingRepository.findByEmployee(employeeId, companyId, 'active');
  return mappings
    .filter((m) => m.servicePO)
    .map((m) => ({
      id: m.servicePO.id,
      code: m.servicePO.service_po_code,
      name: m.servicePO.service_po_name,
    }));
};

module.exports = {
  createEntry,
  updateEntry,
  deleteEntry,
  getCalendarSummary,
  getDailyEntries,
  getMonthlySummary,
  getMappedProjects,
  DAILY_HOUR_CAP,
};
