'use strict';

const { sequelize } = require('../models');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const timesheetService = require('./timesheetService');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const servicePOHierarchyDTO = require('../dtos/servicePOHierarchyDTO');
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

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
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
 * When a hierarchy node (Parent or Child — see servicePOHierarchyService.js)
 * is supplied, confirm it actually belongs to the Service PO being logged
 * against and return it (with its parentNode loaded, for
 * servicePOHierarchyDTO.buildBreadcrumb) — both node types are equally
 * valid to log against, there is no leaf-only restriction. Returns null
 * (no error) when hierarchyNodeId is null/undefined.
 */
async function resolveHierarchyNode(hierarchyNodeId, servicePOId) {
  if (!hierarchyNodeId) return null;
  const node = await servicePOHierarchyRepository.findByIdAndServicePOWithParent(hierarchyNodeId, servicePOId);
  if (!node) {
    const err = new Error(`Hierarchy node #${hierarchyNodeId} does not belong to Service PO #${servicePOId}.`);
    err.statusCode = 400;
    throw err;
  }
  return node;
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
 * REPLACE SAVE for one employee's entire timesheet on one date (Stage 1 —
 * draft, not yet official). The frontend always sends the COMPLETE set of
 * entries for (employee, date) — this treats that payload as the source of
 * truth: every existing employee_work_logs row for the date is deleted and
 * exactly the given `entries` are reinserted, in one transaction. There is
 * no per-entry duplicate-key concept at all here (unlike the single-row
 * updateEntry/deleteEntry below): the whole date is wiped first, so nothing
 * from before this call can collide with what's being inserted now. Passing
 * an empty `entries` array is valid and clears the date entirely.
 *
 * Every line is validated (project mapping, employee-active/PO-eligible/
 * sub-project-belongs-to-PO, hierarchy node ownership) and the 12-hour/day
 * cap is checked against the SUM of this payload's hours alone — BEFORE the
 * transaction opens, so a validation failure never touches the database (the
 * "rollback everything on failure" requirement holds trivially: either
 * nothing in the DB changes, or the transaction's DELETE+INSERT commits as a
 * unit). The 176-hour monthly cap is intentionally untouched — see this
 * file's header comment; that rule stays Sync-only.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {object} data - { timesheet_date, entries: [{ service_po_id, sub_project_id?, hierarchy_node_id?, hours, description }] }
 * @returns {Promise<object[]>} the date's entries after the replace, each plus service_po_breadcrumb
 */
const replaceDailyEntries = async (employeeId, companyId, data) => {
  const dateStr = assertNotFutureDate(data.timesheet_date);
  const lines = data.entries || [];

  // Two lines at the same (service_po_id, hierarchy_node_id) would collide
  // on insert (uq_employee_work_logs) — reject up front rather than letting
  // the transaction fail on a DB constraint violation partway through.
  const seenKeys = new Set();
  for (const line of lines) {
    const key = `${line.service_po_id}|${line.hierarchy_node_id || 'po'}`;
    if (seenKeys.has(key)) {
      const nodeSuffix = line.hierarchy_node_id ? ` / hierarchy node #${line.hierarchy_node_id}` : '';
      throw badRequestError(`Duplicate entry for Service PO #${line.service_po_id}${nodeSuffix} in the same request.`);
    }
    seenKeys.add(key);
  }

  // 12-hour/day cap, computed purely from this payload — the old rows for
  // this date are being replaced wholesale, so there is nothing left in the
  // DB to add on top of. assertDailyCap's DB-lookup version still backs
  // updateEntry below, which edits one row in place rather than replacing
  // the whole day.
  const totalHours = lines.reduce((sum, line) => sum + parseFloat(line.hours), 0);
  if (totalHours > DAILY_HOUR_CAP) {
    throw badRequestError(
      `Total hours for ${dateStr} cannot exceed ${DAILY_HOUR_CAP}. This request totals ${Math.round(totalHours * 100) / 100} hours.`
    );
  }

  // Resolve/validate every line before touching the database at all.
  const resolvedLines = [];
  for (const line of lines) {
    await assertProjectMapped(employeeId, line.service_po_id, companyId);

    // Reuse the Admin module's employee-active / PO-eligible-status /
    // sub-project-belongs-to-PO checks — these only query Employee/ServicePO,
    // never `timesheets`.
    const { po } = await timesheetService.resolveManualEntryReferences(
      { employee_id: employeeId, service_po_id: line.service_po_id, sub_project_id: line.sub_project_id },
      companyId
    );

    const hierarchyNode = await resolveHierarchyNode(line.hierarchy_node_id, line.service_po_id);

    resolvedLines.push({ line, po, hierarchyNode });
  }

  const insertedRows = await sequelize.transaction(async (transaction) => {
    await employeeWorkLogRepository.deleteByEmployeeAndDate(employeeId, dateStr, companyId, transaction);

    return employeeWorkLogRepository.bulkCreate(
      resolvedLines.map(({ line }) => ({
        employee_id: employeeId,
        service_po_id: line.service_po_id,
        sub_project_id: line.sub_project_id || null,
        hierarchy_node_id: line.hierarchy_node_id || null,
        work_date: dateStr,
        hours: line.hours,
        description: line.description,
        company_id: companyId,
        status: 'pending',
        created_by: employeeId,
        updated_by: employeeId,
      })),
      transaction
    );
  });

  logger.info('Employee daily timesheet replace-saved', {
    employeeId, companyId, date: dateStr, entryCount: insertedRows.length,
  });

  return insertedRows.map((row, i) => ({
    ...row.get({ plain: true }),
    service_po_breadcrumb: servicePOHierarchyDTO.buildBreadcrumb(
      resolvedLines[i].po.service_po_name,
      resolvedLines[i].hierarchyNode
    ),
  }));
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
 * @param {object} data - Any subset of { service_po_id, sub_project_id, hierarchy_node_id, hours, description, timesheet_date }
 * @returns {Promise<object>} the updated entry, plus service_po_breadcrumb
 */
const updateEntry = async (employeeId, companyId, id, data) => {
  const existing = await employeeWorkLogRepository.findByIdForEmployee(id, employeeId, companyId);
  if (!existing) {
    throw notFoundError(`Work log entry #${id} was not found.`);
  }

  const servicePOId = data.service_po_id ?? existing.service_po_id;
  const subProjectId = data.sub_project_id !== undefined ? data.sub_project_id : existing.sub_project_id;
  const hierarchyNodeId = data.hierarchy_node_id !== undefined ? data.hierarchy_node_id : existing.hierarchy_node_id;
  const hours = data.hours ?? existing.hours;
  const dateStr = data.timesheet_date ? assertNotFutureDate(data.timesheet_date) : existing.work_date;

  await assertProjectMapped(employeeId, servicePOId, companyId);

  const { po } = await timesheetService.resolveManualEntryReferences(
    { employee_id: employeeId, service_po_id: servicePOId, sub_project_id: subProjectId },
    companyId
  );

  const hierarchyNode = await resolveHierarchyNode(hierarchyNodeId, servicePOId);

  const duplicate = await employeeWorkLogRepository.checkDuplicate(
    employeeId, servicePOId, hierarchyNodeId || null, dateStr, id, companyId
  );
  if (duplicate) {
    const nodeSuffix = hierarchyNode ? ` under "${hierarchyNode.node_name}"` : '';
    throw conflictError(`You already have a work log entry for ${dateStr} under this Service PO${nodeSuffix}.`);
  }

  await assertDailyCap(employeeId, dateStr, hours, companyId, id);

  const updated = await employeeWorkLogRepository.update(id, {
    service_po_id: servicePOId,
    sub_project_id: subProjectId || null,
    hierarchy_node_id: hierarchyNodeId || null,
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

  return {
    ...updated.get({ plain: true }),
    service_po_breadcrumb: servicePOHierarchyDTO.buildBreadcrumb(po.service_po_name, hierarchyNode),
  };
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
 * Load every currently-mapped Service PO (same source as '/projects') plus
 * the complete hierarchy (Parent/Child nodes) for all of them, in two
 * batched queries — shared by getDailyEntries and getMonthlySummary so both
 * build the identical Service PO -> Parent -> Child tree shape.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<{ mappedPOs: Array<object>, hierarchyRowsByPOId: Map<string, ServicePOHierarchy[]> }>}
 */
const loadMappedPOsWithHierarchy = async (employeeId, companyId) => {
  const mappings = await employeeServicePOMappingRepository.findByEmployee(employeeId, companyId, 'active');
  const mappedPOs = mappings
    .map((m) => m.servicePO)
    .filter(Boolean)
    .sort((a, b) => a.service_po_name.localeCompare(b.service_po_name));

  const hierarchyRows = await servicePOHierarchyRepository.findByServicePOIds(mappedPOs.map((po) => po.id));
  const hierarchyRowsByPOId = new Map();
  for (const row of hierarchyRows) {
    const key = String(row.service_po_id);
    if (!hierarchyRowsByPOId.has(key)) hierarchyRowsByPOId.set(key, []);
    hierarchyRowsByPOId.get(key).push(row);
  }

  return { mappedPOs, hierarchyRowsByPOId };
};

/**
 * Group flat (service_po_id, hierarchy_node_id, total_hours) breakdown rows
 * — for ONE date — into servicePOId -> Map(nodeKey -> hours), where nodeKey
 * is 'po' for hours logged directly against the Service PO itself (no
 * hierarchy_node_id) or the hierarchy node's own id otherwise.
 *
 * @param {Array<{ service_po_id, hierarchy_node_id, total_hours }>} rows
 * @returns {Map<string, Map<string, number>>}
 */
const groupHoursByServicePO = (rows) => {
  const hoursByPOId = new Map();
  for (const row of rows) {
    const poKey = String(row.service_po_id);
    const nodeKey = row.hierarchy_node_id ? String(row.hierarchy_node_id) : 'po';
    const hours = parseFloat(row.total_hours) || 0;

    if (!hoursByPOId.has(poKey)) hoursByPOId.set(poKey, new Map());
    hoursByPOId.get(poKey).set(nodeKey, hours);
  }
  return hoursByPOId;
};

/**
 * Build the `service_pos` array — the shared hierarchy response shape
 * returned by BOTH getDailyEntries and getMonthlySummary (per date) — for
 * ONE date's worth of hours. Every mapped Service PO is included, and every
 * Parent/Child node under it, even when nothing was logged that day (hours
 * default to 0 — see servicePOHierarchyDTO.toHierarchyTreeWithHours).
 *
 * po_total_hrs = hours logged directly against the Service PO itself +
 * every Parent's hours + every Child's hours, for that date.
 *
 * @param {Array<object>} mappedPOs
 * @param {Map<string, ServicePOHierarchy[]>} hierarchyRowsByPOId
 * @param {Map<string, Map<string, number>>} hoursByPOId - this date's hours only
 * @returns {Array<object>}
 */
const buildServicePOsForDate = (mappedPOs, hierarchyRowsByPOId, hoursByPOId) => {
  const round2 = (n) => Math.round(n * 100) / 100;

  return mappedPOs.map((po) => {
    const poHours = hoursByPOId.get(String(po.id));
    const directHours = poHours ? (poHours.get('po') || 0) : 0;

    const nodeHoursMap = new Map();
    if (poHours) {
      for (const [key, hrs] of poHours) {
        if (key !== 'po') nodeHoursMap.set(key, hrs);
      }
    }

    const children = servicePOHierarchyDTO.toHierarchyTreeWithHours(
      hierarchyRowsByPOId.get(String(po.id)) || [],
      nodeHoursMap
    );
    const hierarchyHours = servicePOHierarchyDTO.sumHierarchyHours(children);

    return {
      service_po_id: po.id,
      service_po_name: po.service_po_name,
      hours: round2(directHours),
      po_total_hrs: round2(directHours + hierarchyHours),
      children,
    };
  });
};

/**
 * Daily Entries for one date: the same Service PO -> Parent -> Child
 * hierarchy shape the Monthly Summary returns per date (see
 * buildServicePOsForDate), scoped to a single day — every mapped Service PO
 * and its complete hierarchy is always present, hours default to 0. No
 * breadcrumb, so the frontend can render Daily and Monthly with the same
 * component.
 *
 * @param {number} employeeId
 * @param {string} date - "YYYY-MM-DD"
 * @param {number} companyId
 * @returns {Promise<{ date: string, service_pos: Array }>}
 */
const getDailyEntries = async (employeeId, date, companyId) => {
  const dateStr = toDateString(date);

  const [{ mappedPOs, hierarchyRowsByPOId }, breakdownRows] = await Promise.all([
    loadMappedPOsWithHierarchy(employeeId, companyId),
    employeeWorkLogRepository.getDailyHierarchyBreakdown({ employeeId, date: dateStr, companyId }),
  ]);

  const hoursByPOId = groupHoursByServicePO(breakdownRows);
  const service_pos = buildServicePOsForDate(mappedPOs, hierarchyRowsByPOId, hoursByPOId);

  return { date: dateStr, service_pos };
};

/**
 * Monthly Summary: for every date in the month, the complete Service PO ->
 * Parent -> Child hierarchy with hours-per-node (same shape getDailyEntries
 * returns per date — see buildServicePOsForDate). One entry per calendar
 * date; each date lists EVERY currently-mapped Service PO (same set
 * '/projects' returns), and every Parent/Child node under it, even when
 * nothing was logged against it that day (hours default to 0). Purely
 * informational at this stage — this is NOT the 176-hour official cap
 * (that only applies once entries are synced into `timesheets`).
 *
 * No breadcrumb: the assembled hierarchy tree carries the same information
 * a breadcrumb string used to.
 *
 * @param {number} employeeId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<Array<{ date: string, service_pos: Array }>>}
 */
const getMonthlySummary = async (employeeId, month, year, companyId) => {
  const [{ mappedPOs, hierarchyRowsByPOId }, breakdownRows] = await Promise.all([
    loadMappedPOsWithHierarchy(employeeId, companyId),
    employeeWorkLogRepository.getMonthlyHierarchyBreakdown({ employeeId, month, year, companyId }),
  ]);

  const rowsByDate = new Map();
  for (const row of breakdownRows) {
    const dateStr = row.work_date;
    if (!rowsByDate.has(dateStr)) rowsByDate.set(dateStr, []);
    rowsByDate.get(dateStr).push(row);
  }

  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  const days = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const dateStr = cursor;
    const hoursByPOId = groupHoursByServicePO(rowsByDate.get(dateStr) || []);
    const service_pos = buildServicePOsForDate(mappedPOs, hierarchyRowsByPOId, hoursByPOId);

    days.push({ date: dateStr, service_pos });

    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    cursor = toDateString(next);
  }

  return days;
};

/**
 * Project Loading — the only source for the Service PO dropdown. Unmapped
 * or inactive-mapping POs are never returned.
 *
 * `hierarchy` (Parent/Child nodes from service_po_hierarchy — see
 * servicePOHierarchyService.js) is included per PO so the employee can log
 * hours against a Parent OR a Child, not just the PO itself. All mapped
 * POs' hierarchies are fetched in one batched query, not one call per PO.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<Array<{ id, code, name, service_po_breadcrumb, hierarchy: Array<object> }>>}
 */
const getMappedProjects = async (employeeId, companyId) => {
  const mappings = await employeeServicePOMappingRepository.findByEmployee(employeeId, companyId, 'active');
  const projects = mappings
    .filter((m) => m.servicePO)
    .map((m) => ({
      id: m.servicePO.id,
      code: m.servicePO.service_po_code,
      name: m.servicePO.service_po_name,
      // A project listing represents the whole PO, not a specific logged
      // node, so its breadcrumb is always just the PO name (Case 3 shape).
      service_po_breadcrumb: m.servicePO.service_po_name,
    }));

  if (projects.length === 0) return projects;

  const hierarchyRows = await servicePOHierarchyRepository.findByServicePOIds(projects.map((p) => p.id));
  const rowsByServicePOId = new Map();
  for (const row of hierarchyRows) {
    const key = String(row.service_po_id);
    if (!rowsByServicePOId.has(key)) rowsByServicePOId.set(key, []);
    rowsByServicePOId.get(key).push(row);
  }

  return projects.map((project) => ({
    ...project,
    hierarchy: servicePOHierarchyDTO.toTree(rowsByServicePOId.get(String(project.id)) || []),
  }));
};

module.exports = {
  replaceDailyEntries,
  updateEntry,
  deleteEntry,
  getCalendarSummary,
  getDailyEntries,
  getMonthlySummary,
  getMappedProjects,
  DAILY_HOUR_CAP,
};
