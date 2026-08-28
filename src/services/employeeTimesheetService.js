'use strict';

const { sequelize } = require('../models');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const employeeWorkLogTimeEntryRepository = require('../repositories/employeeWorkLogTimeEntryRepository');
const employeeRepository = require('../repositories/employeeRepository');
const timesheetService = require('./timesheetService');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const servicePOHierarchyDTO = require('../dtos/servicePOHierarchyDTO');
const dateHelper = require('../helpers/dateHelper');
const { calculateHoursFromTimes, assertNoOverlappingEntries, sumHours } = require('../helpers/workLogTimeHelper');
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
 * decides which projects an employee may log work against. Intentionally
 * not company-scoped (see findByEmployeeAndPO's doc comment) — an active
 * mapping row is itself sufficient authorization even when the Service PO
 * belongs to a different Business Unit than the employee's own (cross-BU
 * resourcing, allowed since employeeServicePOMappingService.assign()).
 */
async function assertProjectMapped(employeeId, servicePOId) {
  const mapping = await employeeServicePOMappingRepository.findByEmployeeAndPO(employeeId, servicePOId);
  if (!mapping || mapping.status !== 'active') {
    throw forbiddenError(`Service PO #${servicePOId} is not assigned to you.`);
  }
}

// Shared display labels for the 3 Work Log entry modes — used to build a
// consistent "You already have X entries for this month, Y cannot be added"
// message from whichever direction the conflict is detected (see
// assertNoMonthlyLogForDate and assertConsistentDailyEntryMode below).
// NOTE: this mutual-exclusivity rule is intentionally ONE-DIRECTIONAL for
// the Monthly axis — a Monthly Work Log already existing blocks new Daily
// (TIME_BASED/HOURLY) writes (assertNoMonthlyLogForDate), but Daily entries
// already existing do NOT block submitting a Monthly Work Log — see
// employeeMonthlyWorkLogService.submitMonthlyWorkLog's own comment: Monthly
// submission is allowed to consolidate/replace whatever Daily entries
// already exist for that month.
const ENTRY_MODE_LABEL = {
  TIME_BASED: 'Start/End Time based',
  HOURLY: 'Hourly',
  MONTHLY: 'Monthly',
};

/**
 * Reject a Daily create/update for a date whose month already has a
 * Monthly Work Log entry (employeeMonthlyWorkLogService.submitMonthlyWorkLog)
 * — the two modes are mutually exclusive per month, so a Daily row can never
 * coexist with (and double-count against) a Monthly total for the same
 * month. No-op when no Monthly entry exists for that month.
 *
 * @param {number} employeeId
 * @param {string} dateStr
 * @param {number} companyId
 * @param {'TIME_BASED'|'HOURLY'|null} [attemptedMode] - which mode this
 *   write is attempting, for a precise "X already exists, Y cannot be
 *   added" message; omitted (e.g. replaceDailyEntries clearing a date, with
 *   no resulting mode of its own) falls back to a generic message.
 */
async function assertNoMonthlyLogForDate(employeeId, dateStr, companyId, attemptedMode = null) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10);
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  const hasMonthly = await employeeWorkLogRepository.hasMonthlyEntry(employeeId, startDate, endDate, companyId);
  if (hasMonthly) {
    throw conflictError(
      attemptedMode
        ? `You already have Monthly timesheet entries for this month. ` +
          `${ENTRY_MODE_LABEL[attemptedMode]} timesheet entries cannot be added for the same month.`
        : `A Monthly Work Log already exists for ${dateHelper.formatDate(dateStr, 'MMMM YYYY')}. ` +
          'Delete it before logging daily entries for this month.'
    );
  }
}

/**
 * Reject a Daily entry (create or update) whose resulting mode — TIME_BASED
 * (has a `time_entries` breakdown) or HOURLY (a plain `hours` number, no
 * breakdown) — conflicts with the OTHER mode already present elsewhere in
 * the same employee+month. The Monthly axis is a SEPARATE, already-existing
 * check (assertNoMonthlyLogForDate, called unconditionally alongside this
 * one everywhere) — this only covers the TIME_BASED-vs-HOURLY axis within
 * 'daily' rows. Multiple entries of the SAME mode (different Service
 * POs/Projects/Tasks/dates/slots) are always allowed — this never rejects
 * on account of a same-mode entry, only the OPPOSITE one.
 *
 * @param {number} employeeId
 * @param {string} dateStr - "YYYY-MM-DD", used only to resolve the month
 * @param {number} companyId
 * @param {'TIME_BASED'|'HOURLY'} incomingMode - the mode this write is producing
 * @param {{ excludeDate?: string, excludeId?: number }} [excludeOptions] - see
 *   employeeWorkLogRepository.getMonthEntryModeSummary's doc comment
 */
async function assertConsistentDailyEntryMode(employeeId, dateStr, companyId, incomingMode, excludeOptions = {}) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10);
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  const { hasTimeBased, hasHourly } = await employeeWorkLogRepository.getMonthEntryModeSummary(
    employeeId, startDate, endDate, companyId, excludeOptions
  );

  const existingMode = incomingMode === 'TIME_BASED' && hasHourly ? 'HOURLY'
    : incomingMode === 'HOURLY' && hasTimeBased ? 'TIME_BASED'
    : null;

  if (existingMode) {
    throw badRequestError(
      `You already have ${ENTRY_MODE_LABEL[existingMode]} timesheet entries for this month. ` +
      `${ENTRY_MODE_LABEL[incomingMode]} timesheet entries cannot be added for the same month.`
    );
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
 * Validate (no overlaps) + compute the duration of every segment in a
 * `time_entries` array (see EmployeeWorkLogTimeEntry.js), and their combined
 * total — shared by the create (replaceDailyEntries) and update
 * (updateEntry) paths so both compute this identically.
 *
 * @param {Array<{ start_time: string, end_time: string }>} timeEntries
 * @returns {{ hours: number, resolvedEntries: Array<{ start_time: string, end_time: string, duration_hours: number }> }}
 */
/**
 * Fill in a missing per-segment `description` from a fallback (the owning
 * line's own top-level `description`) — a segment that supplied its own
 * description is left exactly as given, never overwritten. Lets a caller
 * that only ever sends one description per request (one time_entry per
 * line — the common case) omit the now-optional per-segment field entirely,
 * while a caller that DOES want distinct text per slot can still supply it.
 *
 * @param {Array<{ start_time: string, end_time: string, description?: string }>} timeEntries
 * @param {string} fallbackDescription
 * @returns {Array<{ start_time: string, end_time: string, description: string }>}
 */
function withFallbackDescription(timeEntries, fallbackDescription) {
  return timeEntries.map((entry) => ({
    ...entry,
    // Own description wins; else the line's; else genuinely blank — never
    // undefined/null, since employee_work_log_time_entries.description is
    // NOT NULL (see EmployeeWorkLogTimeEntry.js's doc comment — blank is
    // an intentionally allowed value now, undefined is not).
    description: entry.description || fallbackDescription || '',
  }));
}

function resolveTimeEntries(timeEntries) {
  assertNoOverlappingEntries(timeEntries);

  const resolvedEntries = timeEntries.map((entry) => ({
    start_time: entry.start_time,
    end_time: entry.end_time,
    // Each segment's own description, carried through untouched — never
    // merged with another segment's text and never defaulted from the
    // parent line (see EmployeeWorkLogTimeEntry.js's doc comment).
    description: entry.description,
    duration_hours: calculateHoursFromTimes(entry.start_time, entry.end_time),
  }));

  return { hours: sumHours(resolvedEntries.map((entry) => entry.duration_hours)), resolvedEntries };
}

/**
 * Group a REPLACE SAVE payload's lines by (service_po_id, hierarchy_node_id)
 * so multiple TIME-BASED lines against the same Module/Task/date — e.g. the
 * frontend sending one array element per slot, rather than one line with a
 * multi-item `time_entries` array — are merged into a single logical line
 * instead of being rejected as duplicates. A key is only ever merged when
 * EVERY line under it is time-based (has a non-empty `time_entries`); a key
 * repeated on a plain hours-only line still throws the original duplicate
 * error, unchanged from before — this only loosens the rule for time-based
 * entries (see this file's header comment / replaceDailyEntries doc).
 *
 * Merging concatenates `time_entries` in payload order and keeps the first
 * line's other fields (sub_project_id, top-level description) — overlap
 * across the merged set (including two lines each supplying the exact same
 * slot) is still caught downstream by resolveTimeEntries/
 * assertNoOverlappingEntries, so this never silently drops a genuine
 * conflict.
 *
 * @param {Array<object>} rawLines - the raw `entries` array from the request
 * @returns {Array<object>} one line per (service_po_id, hierarchy_node_id) key
 */
function mergeDuplicateKeyLines(rawLines) {
  const groups = new Map();
  const order = [];

  for (const raw of rawLines) {
    const key = `${raw.service_po_id}|${raw.hierarchy_node_id || 'po'}`;
    const isTimeBased = Array.isArray(raw.time_entries) && raw.time_entries.length > 0;
    // Each of THIS line's own segments falls back to THIS line's own
    // description when it didn't supply one of its own — applied before
    // merging, so a later line's description is never lost/overwritten by
    // an earlier line's (see withFallbackDescription's doc comment).
    const timeEntriesWithDescription = isTimeBased
      ? withFallbackDescription(raw.time_entries, raw.description)
      : null;

    const existingGroup = groups.get(key);
    if (!existingGroup) {
      groups.set(key, { base: raw, timeEntries: timeEntriesWithDescription, isTimeBased });
      order.push(key);
      continue;
    }

    if (!isTimeBased || !existingGroup.isTimeBased) {
      const nodeSuffix = raw.hierarchy_node_id ? ` / hierarchy node #${raw.hierarchy_node_id}` : '';
      throw badRequestError(`Duplicate entry for Service PO #${raw.service_po_id}${nodeSuffix} in the same request.`);
    }

    existingGroup.timeEntries.push(...timeEntriesWithDescription);
  }

  return order.map((key) => {
    const group = groups.get(key);
    return group.isTimeBased ? { ...group.base, time_entries: group.timeEntries } : group.base;
  });
}

/**
 * Preserve an EXISTING TIME_BASED row's segments when the incoming REPLACE
 * SAVE line for the SAME (service_po_id, hierarchy_node_id) key doesn't
 * supply its own `time_entries` at all.
 *
 * Why this is needed: `GET /employee-timesheets/daily` (the natural data
 * source for a screen showing multiple Service POs/Tasks with per-task
 * "Add Slot" actions) only ever returns an AGGREGATE `hours` number per
 * node — never a `time_entries` breakdown (see getDailyEntries/
 * buildServicePOsForDate/getDailyHierarchyBreakdown, a `SUM(hours) GROUP BY`
 * query). So a caller adding a slot for a DIFFERENT Project/Task under the
 * same Service PO, then resending the whole day via replaceDailyEntries
 * (REPLACE SAVE — the frontend has no other endpoint capable of adding a
 * brand-new line), has no way to include a breakdown it was never given for
 * the OTHER, untouched entries. Without this fallback, that untouched line
 * would be (mis)treated as a fresh HOURLY entry — the reported "existing
 * TIME_BASED entry silently converted to Hourly" bug — even though nothing
 * about it was meant to change.
 *
 * Only ever ADDS a breakdown to a line that didn't specify one; a line that
 * DOES supply `time_entries` (including an intentional edit, or an
 * intentional conversion via a different flow) is always left exactly as
 * given, never overridden.
 *
 * @param {object[]} lines - merged lines, see mergeDuplicateKeyLines()
 * @param {object[]} existingRows - this date's CURRENT employee_work_logs
 *   rows, each with `timeEntries` eager-loaded (see employeeWorkLogRepository.findAll)
 * @returns {object[]}
 */
function preserveExistingTimeEntries(lines, existingRows) {
  const existingByKey = new Map();
  for (const row of existingRows) {
    const key = `${row.service_po_id}|${row.hierarchy_node_id || 'po'}`;
    const timeEntries = (row.timeEntries || []).map((entry) => ({
      start_time: entry.start_time,
      end_time: entry.end_time,
      description: entry.description,
    }));
    if (timeEntries.length > 0) existingByKey.set(key, timeEntries);
  }

  return lines.map((line) => {
    if (line.time_entries !== undefined) return line;
    const key = `${line.service_po_id}|${line.hierarchy_node_id || 'po'}`;
    const existingTimeEntries = existingByKey.get(key);
    return existingTimeEntries ? { ...line, time_entries: existingTimeEntries } : line;
  });
}

/**
 * Resolve the authoritative hours + time-entry breakdown for one CREATE
 * line. When `time_entries` (one or more Start Time/End Time segments
 * against this Module/Task/date — see EmployeeWorkLogTimeEntry.js) is
 * given, hours is ALWAYS the sum of every segment's own duration — any
 * caller-supplied `hours` on the same line is discarded, never trusted
 * (Joi requires `hours` only when `time_entries` is absent, so this is the
 * only other shape a line can take). Neither given is impossible (Joi's
 * `.when()` rejects it); no `time_entries` at all is the plain hours-only
 * path, used exactly as supplied.
 *
 * @param {{ hours?: number, time_entries?: Array }} line
 * @returns {{ hours: number, resolvedEntries: Array }}
 */
function resolveHoursAndTimeEntries(line) {
  if (line.time_entries && line.time_entries.length > 0) {
    return resolveTimeEntries(line.time_entries);
  }
  return { hours: line.hours, resolvedEntries: [] };
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
 * A line that omits `time_entries` but matches an existing TIME_BASED row's
 * key has that row's breakdown carried forward automatically instead of
 * being flattened into a plain HOURLY row — see
 * preserveExistingTimeEntries()'s doc comment. This date's resulting mix of
 * TIME_BASED/HOURLY entries is also checked for consistency against the
 * rest of the month — see assertConsistentDailyEntryMode().
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

  // Two lines at the same (service_po_id, hierarchy_node_id) would collide
  // on insert (uq_employee_work_logs) — for a PLAIN hours-only line that's
  // still rejected up front, same as before. For TIME-BASED lines (each
  // carrying its own `time_entries`) it no longer is: multiple slots
  // against the same Module/Task/date are a valid, expected shape, so those
  // lines are merged into one combined line per key instead — see
  // mergeDuplicateKeyLines().
  const mergedLines = mergeDuplicateKeyLines(data.entries || []);

  // A line that didn't supply its own `time_entries` but matches an
  // EXISTING TIME_BASED row's key gets that row's breakdown carried
  // forward automatically — see preserveExistingTimeEntries's doc comment
  // for why this is necessary (GET /daily can't expose enough for the
  // caller to do this itself). No-op for a line that supplies its own
  // time_entries, or one whose key has no existing TIME_BASED row.
  const existingRowsForDate = mergedLines.length > 0
    ? (await employeeWorkLogRepository.findAll(
        { employeeId, startDate: dateStr, endDate: dateStr, companyId },
        { limit: 1000 }
      )).rows
    : [];
  const lines = preserveExistingTimeEntries(mergedLines, existingRowsForDate);

  // Resolve the authoritative hours/time-entry breakdown for every line
  // FIRST — when a line supplies time_entries, this recalculates hours as
  // their sum (discarding whatever hours value the line also sent) — see
  // resolveHoursAndTimeEntries(). The 12-hour/day cap below, and everything
  // downstream, uses these resolved values, never the raw line.hours.
  const resolvedTimes = lines.map((line) => resolveHoursAndTimeEntries(line));

  // 12-hour/day cap, computed purely from this payload — the old rows for
  // this date are being replaced wholesale, so there is nothing left in the
  // DB to add on top of. assertDailyCap's DB-lookup version still backs
  // updateEntry below, which edits one row in place rather than replacing
  // the whole day.
  const totalHours = resolvedTimes.reduce((sum, r) => sum + r.hours, 0);
  if (totalHours > DAILY_HOUR_CAP) {
    throw badRequestError(
      `Total hours for ${dateStr} cannot exceed ${DAILY_HOUR_CAP}. This request totals ${Math.round(totalHours * 100) / 100} hours.`
    );
  }

  // Monthly entry-mode consistency: this date's own lines must not mix
  // TIME_BASED and HOURLY with EACH OTHER, nor with whatever mode (Daily OR
  // Monthly) already exists elsewhere in the same month — checked AFTER
  // resolving every line so the resulting mode (if any) is known, letting
  // both checks below name it precisely in their message. Skipped entirely
  // when this payload clears the date (empty `lines`, dayMode stays null) —
  // nothing to validate; assertNoMonthlyLogForDate then falls back to its
  // generic message, same as before this change.
  const dayHasTimeBased = resolvedTimes.some((r) => r.resolvedEntries.length > 0);
  const dayHasHourly = resolvedTimes.some((r) => r.resolvedEntries.length === 0);
  if (dayHasTimeBased && dayHasHourly) {
    throw badRequestError(
      'Start/End Time based and Hourly timesheet entries cannot be mixed within the same month.'
    );
  }
  const dayMode = dayHasTimeBased ? 'TIME_BASED' : dayHasHourly ? 'HOURLY' : null;
  await assertNoMonthlyLogForDate(employeeId, dateStr, companyId, dayMode);
  if (dayMode) {
    await assertConsistentDailyEntryMode(employeeId, dateStr, companyId, dayMode, { excludeDate: dateStr });
  }

  // Resolve/validate every line before touching the database at all.
  const resolvedLines = [];
  for (const line of lines) {
    await assertProjectMapped(employeeId, line.service_po_id, companyId);

    // Reuse the Admin module's employee-active / PO-eligible-status /
    // sub-project-belongs-to-PO checks — these only query Employee/ServicePO,
    // never `timesheets`. assertProjectMapped() above already authorized
    // this exact PO for this employee, so skip its redundant company check
    // (cross-BU resourcing).
    const { po } = await timesheetService.resolveManualEntryReferences(
      { employee_id: employeeId, service_po_id: line.service_po_id, sub_project_id: line.sub_project_id },
      companyId,
      { skipPOCompanyScope: true }
    );

    const hierarchyNode = await resolveHierarchyNode(line.hierarchy_node_id, line.service_po_id);

    resolvedLines.push({ line, po, hierarchyNode });
  }

  const insertedRows = await sequelize.transaction(async (transaction) => {
    await employeeWorkLogRepository.deleteByEmployeeAndDate(employeeId, dateStr, companyId, transaction);

    const rows = await employeeWorkLogRepository.bulkCreate(
      resolvedLines.map(({ line }, i) => ({
        employee_id: employeeId,
        service_po_id: line.service_po_id,
        sub_project_id: line.sub_project_id || null,
        hierarchy_node_id: line.hierarchy_node_id || null,
        work_date: dateStr,
        hours: resolvedTimes[i].hours,
        // Required by Joi for a plain HOURLY line; optional (may be
        // undefined) for a TIME_BASED line, which the DB's NOT NULL column
        // still needs a real value for — default to blank, never a crash.
        description: line.description || '',
        company_id: companyId,
        status: 'pending',
        created_by: employeeId,
        updated_by: employeeId,
      })),
      transaction
    );

    // The old rows for this date were just wiped above (deleteByEmployeeAndDate,
    // same transaction), cascading away any of their own time entries with
    // them — so every row created here starts with none, and only lines that
    // supplied `time_entries` get any inserted now.
    for (let i = 0; i < rows.length; i++) {
      if (resolvedTimes[i].resolvedEntries.length > 0) {
        await employeeWorkLogTimeEntryRepository.bulkCreate(
          rows[i].id,
          resolvedTimes[i].resolvedEntries.map((entry) => ({ ...entry, entry_date: dateStr })),
          employeeId,
          transaction
        );
      }
    }

    return rows;
  });

  // Approval happens BEFORE Sync (see managerSelfServiceService.
  // getApprovalSummary/bulkApproveTimesheets): a Manager approves pending
  // entries directly. When approval isn't required for this employee, they
  // skip straight to 'approved' here — a separate, additive step AFTER
  // creation, so the insert above (and its validation/hour-cap checks)
  // stays exactly as it was.
  const employee = await employeeRepository.findById(employeeId, companyId);
  if (employee && !employee.is_timesheet_approval_required && insertedRows.length > 0) {
    await employeeWorkLogRepository.markApprovedByIds(insertedRows.map((row) => row.id), companyId);
  }

  logger.info('Employee daily timesheet replace-saved', {
    employeeId, companyId, date: dateStr, entryCount: insertedRows.length,
  });

  return insertedRows.map((row, i) => ({
    ...row.get({ plain: true }),
    entry_type: resolvedTimes[i].resolvedEntries.length > 0 ? 'TIME_BASED' : 'HOURLY',
    time_entries: resolvedTimes[i].resolvedEntries,
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

  // Effective time_entries after merging this update against the existing
  // row: an explicit array in `data` (including an empty one, which clears
  // the breakdown) always wins; omitting the field entirely keeps whatever
  // this row already has (already eager-loaded via findByIdForEmployee's
  // include — see employeeWorkLogRepository.buildIncludes). When the
  // effective set is non-empty, hours is ALWAYS recalculated as their sum —
  // a caller-supplied `hours` in `data` is discarded in that case, never
  // trusted (same rule as create). Only when the effective set is empty does
  // `data.hours` (or the existing hours) apply.
  // Same fallback as create: a segment in an explicitly-supplied
  // `data.time_entries` that didn't provide its own description falls back
  // to this update's effective description (the new one if given, else
  // whatever the row already had) — see withFallbackDescription's doc
  // comment.
  const effectiveDescription = data.description !== undefined ? data.description : existing.description;
  const effectiveTimeEntries = data.time_entries !== undefined
    ? withFallbackDescription(data.time_entries, effectiveDescription)
    : (existing.timeEntries || []).map((entry) => ({
        start_time: entry.start_time,
        end_time: entry.end_time,
        description: entry.description,
      }));

  const { hours, resolvedEntries } = effectiveTimeEntries.length > 0
    ? resolveTimeEntries(effectiveTimeEntries)
    : { hours: data.hours ?? existing.hours, resolvedEntries: [] };

  const dateStr = data.timesheet_date ? assertNotFutureDate(data.timesheet_date) : existing.work_date;

  // This row's resulting mode (after applying this update) must not
  // conflict with whatever mode the REST of the month already has — see
  // assertConsistentDailyEntryMode's doc comment. Excludes this row itself
  // from the "existing" scan since it's the one being changed in place.
  const updatedMode = resolvedEntries.length > 0 ? 'TIME_BASED' : 'HOURLY';
  await assertNoMonthlyLogForDate(employeeId, dateStr, companyId, updatedMode);
  await assertConsistentDailyEntryMode(employeeId, dateStr, companyId, updatedMode, { excludeId: id });

  await assertProjectMapped(employeeId, servicePOId, companyId);

  const { po } = await timesheetService.resolveManualEntryReferences(
    { employee_id: employeeId, service_po_id: servicePOId, sub_project_id: subProjectId },
    companyId,
    { skipPOCompanyScope: true }
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

  const updated = await sequelize.transaction(async (transaction) => {
    const row = await employeeWorkLogRepository.update(id, {
      service_po_id: servicePOId,
      sub_project_id: subProjectId || null,
      hierarchy_node_id: hierarchyNodeId || null,
      work_date: dateStr,
      hours,
      description: effectiveDescription,
      updated_by: employeeId,
      // Any edit invalidates a prior sync snapshot — revert unconditionally
      // to 'pending' (a no-op if it was already 'pending') EXCEPT when the
      // entry is 'rejected': saving edits must NOT itself resubmit it — only
      // the explicit Resubmit action (resubmitEntry) may move REJECTED ->
      // PENDING (see EmployeeWorkLog.js's status doc comment). Editing a
      // rejected entry corrects it while leaving the Resubmit click as a
      // deliberate, separate step ("Edit -> Save Changes -> still REJECTED
      // -> Resubmit -> PENDING").
      status: existing.status === 'rejected' ? 'rejected' : 'pending',
      synced_at: null,
      timesheet_import_id: null,
    }, companyId, transaction);

    // Always replace-in-place: delete whatever this row's breakdown was
    // (a no-op if it had none) and reinsert exactly `resolvedEntries` (a
    // no-op if the effective set is empty) — simpler and just as correct as
    // diffing, and matches this codebase's other REPLACE SAVE flows.
    await employeeWorkLogTimeEntryRepository.deleteByWorkLogId(id, transaction);
    if (resolvedEntries.length > 0) {
      await employeeWorkLogTimeEntryRepository.bulkCreate(
        id,
        resolvedEntries.map((entry) => ({ ...entry, entry_date: dateStr })),
        employeeId,
        transaction
      );
    }

    return row;
  });

  logger.info('Employee work log entry updated', { workLogId: id, employeeId, companyId });

  return {
    ...updated.get({ plain: true }),
    entry_type: resolvedEntries.length > 0 ? 'TIME_BASED' : 'HOURLY',
    time_entries: resolvedEntries,
    service_po_breadcrumb: servicePOHierarchyDTO.buildBreadcrumb(po.service_po_name, hierarchyNode),
  };
};

/**
 * ADD one or more Start Time/End Time segments to a Module/Task's entry for
 * one date — the dedicated Time Entry form, deliberately separate from the
 * Daily Work Log form (replaceDailyEntries) and from updateEntry. Both of
 * those REPLACE a line's entire `time_entries` set with whatever the caller
 * sends; this is genuinely ADDITIVE — a caller adding a second segment
 * later in the day (or in a whole separate session) never needs to resend
 * the segments already saved earlier. That's the whole reason this exists
 * as its own operation: e.g. Module M1 logged 01:00-02:00 earlier, Task T1
 * logged 03:00-04:00 earlier, then a later call adds T1 04:00-06:00 — M1
 * stays at its own 1h total, T1 becomes 1h + 2h = 3h. Neither call's
 * segments are ever silently dropped by the other.
 *
 * Find-or-create the (employee, service_po_id, hierarchy_node_id,
 * work_date) row: if it doesn't exist yet, this call creates it (like a
 * single-line replaceDailyEntries) and `description` is required; if it
 * already exists, only the NEW segments are inserted (old ones are left
 * completely untouched in the DB — never deleted-and-reinserted), `hours`
 * is recomputed as old total + new segments' total, and `description` is
 * only changed if explicitly supplied.
 *
 * Overlap is checked across the COMBINED set (already-saved + new) — a new
 * segment overlapping one saved by an earlier call is rejected, not
 * silently allowed just because it wasn't part of THIS request.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {object} data - { work_date, service_po_id, sub_project_id?, hierarchy_node_id?, time_entries, description? }
 * @returns {Promise<object>} the entry after the add, plus service_po_breadcrumb
 */
const addTimeEntries = async (employeeId, companyId, data) => {
  const dateStr = assertNotFutureDate(data.work_date);
  await assertNoMonthlyLogForDate(employeeId, dateStr, companyId, 'TIME_BASED');
  await assertProjectMapped(employeeId, data.service_po_id, companyId);

  const { po } = await timesheetService.resolveManualEntryReferences(
    { employee_id: employeeId, service_po_id: data.service_po_id, sub_project_id: data.sub_project_id },
    companyId,
    { skipPOCompanyScope: true }
  );
  const hierarchyNode = await resolveHierarchyNode(data.hierarchy_node_id, data.service_po_id);

  const existingRef = await employeeWorkLogRepository.checkDuplicate(
    employeeId, data.service_po_id, data.hierarchy_node_id || null, dateStr, null, companyId
  );
  const existing = existingRef ? await employeeWorkLogRepository.findById(existingRef.id, companyId) : null;

  // This endpoint always produces a TIME_BASED row (time_entries is
  // required by its own schema) — must not conflict with an existing
  // HOURLY entry elsewhere in the month. The row being appended to (if any)
  // is already TIME_BASED itself, so excluding it is purely defensive, not
  // load-bearing — see assertConsistentDailyEntryMode's doc comment.
  await assertConsistentDailyEntryMode(
    employeeId, dateStr, companyId, 'TIME_BASED', existing ? { excludeId: existing.id } : {}
  );

  const existingEntries = existing
    ? (existing.timeEntries || []).map((entry) => ({
        start_time: entry.start_time,
        end_time: entry.end_time,
        description: entry.description,
      }))
    : [];

  // Computed BEFORE resolving the new segments so a segment that didn't
  // supply its own description can fall back to it (see
  // withFallbackDescription's doc comment). Fully optional, including on
  // this Module/Task's very first entry for this date — a missing
  // description anywhere (line-level or every new segment) resolves to an
  // empty string, never a validation error.
  const effectiveDescription = (data.description !== undefined
    ? data.description
    : (existing ? existing.description : data.description)) || '';

  // Overlap-checked and hours-computed across the COMBINED set — a new
  // segment overlapping one already saved is rejected even though it wasn't
  // resent in THIS request. Only the NEW segments (not the already-saved
  // `existingEntries`, which already carry their own real descriptions) get
  // the fallback applied.
  const { hours: newTotalHours, resolvedEntries: combinedResolvedEntries } =
    resolveTimeEntries([...existingEntries, ...withFallbackDescription(data.time_entries, effectiveDescription)]);
  const newlyResolvedEntries = combinedResolvedEntries.slice(existingEntries.length);

  await assertDailyCap(employeeId, dateStr, newTotalHours, companyId, existing ? existing.id : null);

  const workLogId = await sequelize.transaction(async (transaction) => {
    let id;
    if (existing) {
      await employeeWorkLogRepository.update(existing.id, {
        hours: newTotalHours,
        description: effectiveDescription,
        updated_by: employeeId,
        status: existing.status === 'rejected' ? 'rejected' : 'pending',
        synced_at: null,
        timesheet_import_id: null,
      }, companyId, transaction);
      id = existing.id;
    } else {
      const [row] = await employeeWorkLogRepository.bulkCreate([{
        employee_id: employeeId,
        service_po_id: data.service_po_id,
        sub_project_id: data.sub_project_id || null,
        hierarchy_node_id: data.hierarchy_node_id || null,
        work_date: dateStr,
        hours: newTotalHours,
        description: effectiveDescription,
        company_id: companyId,
        status: 'pending',
        created_by: employeeId,
        updated_by: employeeId,
      }], transaction);
      id = row.id;
    }

    // Only the NEWLY added segments are inserted — whatever this row
    // already had in employee_work_log_time_entries is left exactly as is.
    await employeeWorkLogTimeEntryRepository.bulkCreate(
      id,
      newlyResolvedEntries.map((entry) => ({ ...entry, entry_date: dateStr })),
      employeeId,
      transaction
    );

    return id;
  });

  if (!existing) {
    // Same "skip straight to approved when this employee doesn't require
    // approval" step replaceDailyEntries applies on create — see its own
    // doc comment. Only relevant the first time this Module/Task/date is
    // logged; an existing row's status is deliberately left as computed
    // above (reverted to 'pending' unless it was 'rejected').
    const employee = await employeeRepository.findById(employeeId, companyId);
    if (employee && !employee.is_timesheet_approval_required) {
      await employeeWorkLogRepository.markApprovedByIds([workLogId], companyId);
    }
  }

  logger.info('Employee added time entries to a work log', {
    workLogId, employeeId, companyId, addedSegments: data.time_entries.length, newTotalHours,
  });

  return {
    id: workLogId,
    employee_id: employeeId,
    service_po_id: data.service_po_id,
    sub_project_id: data.sub_project_id || null,
    hierarchy_node_id: data.hierarchy_node_id || null,
    work_date: dateStr,
    hours: newTotalHours,
    description: effectiveDescription,
    // Always TIME_BASED — this endpoint's own schema requires time_entries.
    entry_type: 'TIME_BASED',
    time_entries: combinedResolvedEntries,
    service_po_breadcrumb: servicePOHierarchyDTO.buildBreadcrumb(po.service_po_name, hierarchyNode),
  };
};

/**
 * Employee "Resubmit" action — the only way a REJECTED entry becomes
 * PENDING again (REJECTED -> PENDING is the sole valid transition out of
 * 'rejected' besides deletion — see EmployeeWorkLog.js's status doc
 * comment). The frontend never sends a status; the backend enforces it
 * unconditionally on every resubmit, exactly per spec ("every resubmission
 * must automatically change the status back to PENDING").
 *
 * Re-runs every business validation a fresh submission/edit already goes
 * through (project mapping, employee-active/PO-eligible/sub-project
 * ownership, hierarchy node ownership, 12-hour/day cap, Daily/Monthly
 * mutual exclusion) against the row's CURRENT field values — a mapping or
 * hierarchy node that was valid when this entry was first submitted may no
 * longer be, so resubmitting must fail loudly rather than silently
 * re-queue an entry that can no longer be approved. The employee edits the
 * row first (via updateEntry, which already re-validates everything and
 * reverts status to 'pending' itself — see its own doc comment) when a
 * validation actually needs fixing; calling resubmit directly on an
 * unedited-but-still-valid rejected row is the common case this exists for.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} id
 * @returns {Promise<EmployeeWorkLog>}
 */
const resubmitEntry = async (employeeId, companyId, id) => {
  const existing = await employeeWorkLogRepository.findByIdForEmployee(id, employeeId, companyId);
  if (!existing) {
    throw notFoundError(`Work log entry #${id} was not found.`);
  }

  if (existing.status !== 'rejected') {
    throw conflictError(`Only a rejected work log entry can be resubmitted (current status: ${existing.status}).`);
  }

  const existingMode = (existing.timeEntries || []).length > 0 ? 'TIME_BASED' : 'HOURLY';
  await assertNoMonthlyLogForDate(employeeId, existing.work_date, companyId, existingMode);
  await assertProjectMapped(employeeId, existing.service_po_id, companyId);
  await timesheetService.resolveManualEntryReferences(
    { employee_id: employeeId, service_po_id: existing.service_po_id, sub_project_id: existing.sub_project_id },
    companyId,
    { skipPOCompanyScope: true }
  );
  await resolveHierarchyNode(existing.hierarchy_node_id, existing.service_po_id);
  await assertDailyCap(employeeId, existing.work_date, existing.hours, companyId, id);

  const updated = await employeeWorkLogRepository.resubmitById(id, companyId);

  logger.info('Employee resubmitted a rejected work log entry', { workLogId: id, employeeId, companyId });

  // Resubmit never touches time_entries/hours — the row's mode is exactly
  // what it already was (existingMode, computed above), carried through
  // explicitly rather than left for the caller to re-infer.
  return { ...updated, entry_type: existingMode };
};

/**
 * Flat list of the calling Employee's OWN work log entries (id, status,
 * rejection_remark/rejected_by/rejected_at included), for the Employee
 * Work Log list/history view — the same employeeWorkLogRepository.findAll
 * managerSelfServiceService.getTimesheets already uses for the Manager's
 * equivalent view, scoped to req.employeeId instead of a Manager-chosen
 * employee_id. This is how the Employee discovers which of their own
 * entries are 'rejected' (and why), and their ids for resubmit/delete.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @param {object} query - startDate, endDate, status, poId, page, limit
 * @returns {Promise<{ data, meta }>}
 */
const getEntries = async (employeeId, companyId, query) => {
  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 20;

  const { rows, count } = await employeeWorkLogRepository.findAll(
    {
      employeeId,
      companyId,
      startDate: query.startDate,
      endDate: query.endDate,
      status: query.status,
      poId: query.poId,
    },
    { limit, offset: (page - 1) * limit },
    { sortBy: 'work_date', sortOrder: 'DESC' }
  );

  const data = rows.map((row) => {
    const plain = row.toJSON();
    return {
      ...plain,
      // The ORIGINAL entry type, explicit rather than left for the caller
      // to infer from `timeEntries`' presence — never derived from
      // `hours` (a TIME_BASED row's calculated total is still just a
      // number, it never implies HOURLY). See EmployeeWorkLog.js's
      // log_type doc comment for the separate Daily/Monthly axis this is
      // independent of.
      entry_type: (plain.timeEntries && plain.timeEntries.length > 0) ? 'TIME_BASED' : 'HOURLY',
      rejected_by_name: plain.rejectedByEmployee?.full_name || null,
    };
  });

  const totalPages = Math.ceil(count / limit) || 0;

  return {
    data,
    meta: { total: count, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
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
 * Load every currently-mapped Service PO (same source as '/projects', via
 * findAllByEmployee() — no company filter, see its doc comment for why:
 * this is always the caller's OWN employeeId, and a mapping to a Service PO
 * under a different Business Unit than the employee's own home company must
 * still be included, cross-BU resourcing) plus the complete hierarchy
 * (Parent/Child nodes) for all of them, in two batched queries — shared by
 * getDailyEntries and getMonthlySummary so both build the identical Service
 * PO -> Parent -> Child tree shape.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<{ mappedPOs: Array<object>, hierarchyRowsByPOId: Map<string, ServicePOHierarchy[]> }>}
 */
const loadMappedPOsWithHierarchy = async (employeeId, companyId) => {
  const mappings = await employeeServicePOMappingRepository.findAllByEmployee(employeeId, 'active');
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
 * Collapse a set of (date, service_po_id, hierarchy_node_id, total_hours)
 * rows spanning MULTIPLE dates into one row per (service_po_id,
 * hierarchy_node_id), summing total_hours across every date. Needed before
 * calling groupHoursByServicePO, which .set()s rather than accumulates —
 * safe when given one date's rows (each key already appears once, thanks
 * to the SQL GROUP BY), not safe across a whole month's.
 *
 * @param {Array<{ service_po_id, hierarchy_node_id, total_hours }>} rows
 * @returns {Array<{ service_po_id, hierarchy_node_id, total_hours }>}
 */
const collapseRowsAcrossDates = (rows) => {
  const totals = new Map();
  for (const row of rows) {
    const key = `${row.service_po_id}|${row.hierarchy_node_id || ''}`;
    const hours = parseFloat(row.total_hours) || 0;
    if (!totals.has(key)) {
      totals.set(key, { service_po_id: row.service_po_id, hierarchy_node_id: row.hierarchy_node_id, total_hours: 0 });
    }
    totals.get(key).total_hours += hours;
  }
  return Array.from(totals.values());
};

/**
 * Monthly Summary — Service PO view (viewType=month on the
 * /monthly-summary endpoint, see employeeTimesheetController.getMonthlySummary).
 * Same Service PO -> Parent -> Child hierarchy shape Day View returns per
 * date — reuses buildServicePOsForDate/toHierarchyTreeWithHours completely
 * unchanged, just fed month-aggregated hours instead of one date's. Every
 * node's `hours` is that node's OWN direct hours only (a Parent's hours
 * does NOT include its Children's — same independent-per-node meaning
 * Day View already uses, since hours can be logged directly against any
 * node). Only the Service PO's own top-level `hours` is a total — direct-
 * to-PO plus everything under it (via sumHierarchyHours, safe here because
 * every node's hours is independent/non-overlapping). Every Parent/Child
 * node is always present, even at 0 hours, for a shown Service PO — the
 * hierarchy is never flattened. Zero-hour Service POs (no activity
 * anywhere in the month) are omitted, matching the plain summary table
 * this view is for.
 *
 * @param {number} employeeId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<{ service_pos: Array<{ service_po_id, service_po_name, hours, children }>, total_hours: number }>}
 */
const getMonthlySummaryByServicePO = async (employeeId, month, year, companyId) => {
  const [{ mappedPOs, hierarchyRowsByPOId }, breakdownRows] = await Promise.all([
    loadMappedPOsWithHierarchy(employeeId, companyId),
    employeeWorkLogRepository.getMonthlyHierarchyBreakdown({ employeeId, month, year, companyId }),
  ]);

  const round2 = (n) => Math.round(n * 100) / 100;

  const hoursByPOId = groupHoursByServicePO(collapseRowsAcrossDates(breakdownRows));

  const service_pos = buildServicePOsForDate(mappedPOs, hierarchyRowsByPOId, hoursByPOId)
    .map(({ service_po_id, service_po_name, po_total_hrs, children }) => ({
      service_po_id,
      service_po_name,
      hours: po_total_hrs,
      children,
    }))
    .filter((po) => po.hours > 0);

  const total_hours = round2(service_pos.reduce((sum, po) => sum + po.hours, 0));

  return { service_pos, total_hours };
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
 * Uses findAllByEmployee() (no company filter) rather than findByEmployee()
 * — this is always called with the caller's OWN employeeId (never another
 * employee's), so every one of their active mappings must be listed here,
 * including a Service PO mapped under a different Business Unit than their
 * own home company (cross-BU resourcing — see findAllByEmployee()'s doc
 * comment). `companyId` is kept as a parameter for call-site symmetry with
 * the rest of this service but is intentionally unused here.
 *
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<Array<{ id, code, name, service_po_breadcrumb, hierarchy: Array<object> }>>}
 */
const getMappedProjects = async (employeeId, companyId) => {
  const mappings = await employeeServicePOMappingRepository.findAllByEmployee(employeeId, 'active');
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
  addTimeEntries,
  resubmitEntry,
  getEntries,
  deleteEntry,
  getCalendarSummary,
  getDailyEntries,
  getMonthlySummary,
  getMonthlySummaryByServicePO,
  getMappedProjects,
  DAILY_HOUR_CAP,

  // Shared with employeeMonthlyWorkLogService.js — reused as-is rather than
  // duplicated, since both modules need the identical project-mapping/
  // hierarchy-node validation and hierarchy-tree-building logic.
  assertProjectMapped,
  resolveHierarchyNode,
  loadMappedPOsWithHierarchy,
  groupHoursByServicePO,
  buildServicePOsForDate,
  toDateString,
};
