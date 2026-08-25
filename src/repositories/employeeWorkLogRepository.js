'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { EmployeeWorkLog, Employee, ServicePO, SubProject, Project, ServicePOHierarchy, EmployeeWorkLogTimeEntry } = require('../models');

/**
 * Employee Work Log Repository
 *
 * Raw database access for `employee_work_logs` — the Employee Self
 * Timesheet "draft" table. This is a COMPLETELY SEPARATE table from
 * `timesheets` (see timesheetRepository.js, which this file never touches
 * or delegates to). Every method is company_id-scoped.
 */

const ALLOWED_SORT_COLUMNS = new Set(['work_date', 'hours', 'created_at']);

/**
 * A company-less actor (Platform Admin/Admin/Entity Admin — hierarchyRank
 * 1-3, see resolveCompany.js) never gets a req.companyId resolved, unlike a
 * real BU-scoped Employee — yet since every login is now an Employee, such
 * an actor can still reach these read-only self-service report/summary
 * queries if their role grants the report capability. Every one of the
 * functions using this helper is already scoped by a fixed employee_id (the
 * caller's own) or a pre-authorized employeeIds set (a Manager's resolved
 * team) — never an arbitrary company-wide scan — so company_id here is a
 * "narrow to my current BU" refinement, not an authorization boundary.
 * Passing `company_id: undefined` straight into a Sequelize `where` throws
 * ("WHERE parameter \"company_id\" has invalid \"undefined\" value" —
 * reported live on GET /employee-reports/project-hours); this omits the key
 * entirely instead, so a company-less caller sees their own rows across
 * every company rather than crashing.
 * @param {number|number[]|null|undefined} companyId
 * @returns {object}
 */
function companyIdScope(companyId) {
  if (companyId == null) return {};
  return Array.isArray(companyId) ? { company_id: { [Op.in]: companyId } } : { company_id: companyId };
}

function buildIncludes() {
  return [
    { model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'full_name'] },
    { model: ServicePO, as: 'servicePO', attributes: ['id', 'service_po_code', 'service_po_name', 'status'] },
    { model: SubProject, as: 'subProject', attributes: ['id', 'sub_project_code', 'sub_project_name'], required: false },
    {
      model: Employee,
      as: 'rejectedByEmployee',
      attributes: ['id', 'full_name'],
      required: false,
    },
    // The detailed Start Time/End Time breakdown behind this row's own
    // (aggregated) `hours` — see EmployeeWorkLogTimeEntry.js. Empty for any
    // row not created via the detailed-entry flow (plain hours-only rows,
    // or old single start_time/end_time rows from before this feature).
    {
      model: EmployeeWorkLogTimeEntry,
      as: 'timeEntries',
      required: false,
      separate: true,
      order: [['start_time', 'ASC'], ['id', 'ASC']],
    },
  ];
}

/**
 * Fetch a paginated, filtered list of an employee's work log entries.
 * @param {object} filters - { employeeId, startDate, endDate, companyId, status, poId, subProjectId }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort - { sortBy, sortOrder }
 * @returns {Promise<{ rows: EmployeeWorkLog[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { employeeId, startDate, endDate, companyId, status, poId, subProjectId } = filters;
  const { limit = 20, offset = 0 } = pagination;

  let { sortBy = 'work_date', sortOrder = 'DESC' } = sort;
  if (!ALLOWED_SORT_COLUMNS.has(sortBy)) sortBy = 'work_date';
  const order = (sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const where = { company_id: companyId };
  if (employeeId) where.employee_id = parseInt(employeeId, 10);
  if (status) where.status = status;
  if (poId) where.service_po_id = parseInt(poId, 10);
  if (subProjectId) where.sub_project_id = parseInt(subProjectId, 10);
  if (startDate) where.work_date = { ...where.work_date, [Op.gte]: startDate };
  if (endDate) where.work_date = { ...where.work_date, [Op.lte]: endDate };

  return EmployeeWorkLog.findAndCountAll({
    where,
    include: buildIncludes(),
    limit,
    offset,
    order: [[sortBy, order]],
    distinct: true,
  });
};

/**
 * Fetch a single work log entry by primary key.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog|null>}
 */
const findById = async (id, companyId) => {
  return EmployeeWorkLog.findOne({ where: { id, company_id: companyId }, include: buildIncludes() });
};

/**
 * Fetch a single work log entry, scoped to one employee (ownership check
 * for update/delete — an employee may only touch their own entries).
 * @param {number} id
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog|null>}
 */
const findByIdForEmployee = async (id, employeeId, companyId) => {
  return EmployeeWorkLog.findOne({
    where: { id, employee_id: employeeId, company_id: companyId },
    include: buildIncludes(),
  });
};

/**
 * Check whether a work log entry already exists for this employee/PO/
 * hierarchy-node/date. Scoped to hierarchyNodeId (not just PO+date) so
 * separate Parent/Child hierarchy rows under the SAME Service PO on the
 * SAME date are distinct entries, not duplicates of each other — matches
 * the DB's uq_employee_work_logs functional unique index (see
 * database/migrations/20260807_hierarchy_node_id_unique_scope.sql), which
 * keys on COALESCE(hierarchy_node_id, 0) for the same reason.
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {number|null} hierarchyNodeId - null means "logged directly against the PO"
 * @param {string} date - "YYYY-MM-DD"
 * @param {number} [excludeId]
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog|null>}
 */
const checkDuplicate = async (employeeId, servicePOId, hierarchyNodeId, date, excludeId = null, companyId) => {
  const where = {
    employee_id: employeeId,
    service_po_id: servicePOId,
    hierarchy_node_id: hierarchyNodeId || null,
    work_date: date,
    company_id: companyId,
  };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return EmployeeWorkLog.findOne({ where });
};

/**
 * Insert a new work log entry.
 * @param {object} data
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<EmployeeWorkLog>}
 */
const create = async (data, options = {}) => {
  return EmployeeWorkLog.create(data, options);
};

/**
 * Bulk-insert several work log entries in one statement — used by the
 * REPLACE SAVE flow (employeeTimesheetService.replaceDailyEntries) to
 * insert an entire day's entries after deleteByEmployeeAndDate() has
 * cleared the old ones, both inside the same transaction.
 * @param {object[]} rows
 * @param {object} transaction
 * @returns {Promise<EmployeeWorkLog[]>}
 */
const bulkCreate = async (rows, transaction) => {
  if (rows.length === 0) return [];
  return EmployeeWorkLog.bulkCreate(rows, { transaction, returning: true });
};

/**
 * Hard-delete EVERY work log entry for one employee on one date — the
 * "clear the day" half of the REPLACE SAVE flow
 * (employeeTimesheetService.replaceDailyEntries). Always called inside the
 * same transaction as the bulkCreate() that reinserts the day's entries, so
 * a failure partway through leaves the employee's previous entries for that
 * date untouched rather than half-replaced.
 * @param {number} employeeId
 * @param {string} date - "YYYY-MM-DD"
 * @param {number} companyId
 * @param {object} transaction
 * @returns {Promise<number>} rows deleted
 */
const deleteByEmployeeAndDate = async (employeeId, date, companyId, transaction) => {
  return EmployeeWorkLog.destroy({
    where: { employee_id: employeeId, work_date: date, company_id: companyId },
    transaction,
  });
};

/**
 * Update an existing work log entry by primary key.
 * @param {number} id
 * @param {object} data
 * @param {number} companyId
 * @param {object} [transaction] - passed through when the update needs to
 *   stay atomic with a time-entries replace (see updateEntry() in
 *   employeeTimesheetService.js)
 * @returns {Promise<EmployeeWorkLog|null>}
 */
const update = async (id, data, companyId, transaction = null) => {
  const entry = await EmployeeWorkLog.findOne({ where: { id, company_id: companyId }, transaction });
  if (!entry) return null;
  return entry.update(data, { transaction });
};

/**
 * Hard-delete a work log entry.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<number>} rows deleted
 */
const deleteById = async (id, companyId) => {
  return EmployeeWorkLog.destroy({ where: { id, company_id: companyId } });
};

/**
 * Total hours already logged by this employee on one date — the aggregate
 * behind the 12-hours/day cap. Single SQL SUM, no joins (mirrors
 * timesheetRepository.getMonthlyHours' shape/efficiency).
 * @param {string} date - "YYYY-MM-DD"
 * @param {number} employeeId
 * @param {number} [excludeId] - exclude this row (Update only)
 * @param {number} companyId
 * @returns {Promise<number>}
 */
const getDailyHours = async (date, employeeId, excludeId = null, companyId) => {
  const where = { work_date: date, employee_id: employeeId, company_id: companyId };
  if (excludeId) where.id = { [Op.ne]: excludeId };

  const result = await EmployeeWorkLog.findOne({
    attributes: [[fn('SUM', col('hours')), 'total_hours']],
    where,
    raw: true,
  });

  return parseFloat(result?.total_hours ?? 0) || 0;
};

/**
 * Calendar Summary — one row per date with entries, for one employee/month.
 * @param {object} params - { employeeId, month, year, companyId }
 * @returns {Promise<Array<{ date, totalHours, entryCount }>>}
 */
const getCalendarSummary = async ({ employeeId, month, year, companyId }) => {
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  if (!Number.isInteger(monthNum) || !Number.isInteger(yearNum)) {
    throw new Error(`getCalendarSummary: month/year must be numbers (got month=${month}, year=${year}).`);
  }

  const rows = await EmployeeWorkLog.findAll({
    attributes: [
      'work_date',
      [fn('SUM', col('hours')), 'total_hours'],
      [fn('COUNT', col('id')), 'entry_count'],
    ],
    where: {
      [Op.and]: [
        literal(`EXTRACT(MONTH FROM work_date) = ${monthNum}`),
        literal(`EXTRACT(YEAR  FROM work_date) = ${yearNum}`),
      ],
      employee_id: parseInt(employeeId, 10),
      company_id: companyId,
    },
    group: ['work_date'],
    raw: true,
  });

  return rows.map((r) => ({
    date: r.work_date,
    totalHours: parseFloat(r.total_hours) || 0,
    entryCount: parseInt(r.entry_count, 10) || 0,
  }));
};

/**
 * Daily Hierarchy Breakdown — hours grouped by (service_po_id,
 * hierarchy_node_id), for one employee/date. hierarchy_node_id is null for
 * hours logged directly against the Service PO itself (no Parent/Child tag).
 * This is the sole data source employeeTimesheetService.getDailyEntries uses
 * to build the same Service PO -> Parent -> Child hours tree the Monthly
 * Summary returns, scoped to a single date.
 * @param {object} params - { employeeId, date, companyId }
 * @returns {Promise<Array<{ service_po_id, hierarchy_node_id, total_hours }>>}
 */
const getDailyHierarchyBreakdown = async ({ employeeId, date, companyId }) => {
  return EmployeeWorkLog.findAll({
    attributes: [
      'service_po_id',
      'hierarchy_node_id',
      [fn('SUM', col('hours')), 'total_hours'],
    ],
    where: {
      work_date: date,
      employee_id: parseInt(employeeId, 10),
      company_id: companyId,
    },
    group: ['service_po_id', 'hierarchy_node_id'],
    raw: true,
  });
};

/**
 * Monthly Hierarchy Breakdown — hours grouped by (date, service_po_id,
 * hierarchy_node_id), for one employee/month. hierarchy_node_id is null for
 * hours logged directly against the Service PO itself (no Parent/Child tag).
 * This is the sole data source employeeTimesheetService.getMonthlySummary
 * uses to build the per-date Service PO -> Parent -> Child hours tree.
 * @param {object} params - { employeeId, month, year, companyId }
 * @returns {Promise<Array<{ work_date, service_po_id, hierarchy_node_id, total_hours }>>}
 */
const getMonthlyHierarchyBreakdown = async ({ employeeId, month, year, companyId }) => {
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  if (!Number.isInteger(monthNum) || !Number.isInteger(yearNum)) {
    throw new Error(`getMonthlyHierarchyBreakdown: month/year must be numbers (got month=${month}, year=${year}).`);
  }

  return EmployeeWorkLog.findAll({
    attributes: [
      'work_date',
      'service_po_id',
      'hierarchy_node_id',
      [fn('SUM', col('hours')), 'total_hours'],
    ],
    where: {
      [Op.and]: [
        literal(`EXTRACT(MONTH FROM work_date) = ${monthNum}`),
        literal(`EXTRACT(YEAR  FROM work_date) = ${yearNum}`),
      ],
      employee_id: parseInt(employeeId, 10),
      company_id: companyId,
    },
    group: ['work_date', 'service_po_id', 'hierarchy_node_id'],
    raw: true,
  });
};

/**
 * Hierarchy Breakdown for an arbitrary inclusive date range — hours grouped
 * by (service_po_id, hierarchy_node_id), for one employee. Same shape/
 * semantics as getDailyHierarchyBreakdown/getMonthlyHierarchyBreakdown
 * (hierarchy_node_id is null for hours logged directly against the Service
 * PO itself), generalised to any [startDate, endDate] span so a single
 * function covers "specific date" (startDate === endDate), "month"
 * (calendar month's bounds), and "date range" callers alike — see
 * employeeProjectHoursReportService.js. Deliberately NOT filtered by
 * status, matching every other Employee-facing aggregate in this file
 * (getDailyHierarchyBreakdown, getMonthlyHierarchyBreakdown): an employee
 * sees their own logged hours regardless of approval/sync state.
 * @param {object} params - { employeeId, startDate, endDate, companyId }
 * @returns {Promise<Array<{ service_po_id, hierarchy_node_id, total_hours }>>}
 */
const getHierarchyBreakdownForRange = async ({ employeeId, startDate, endDate, companyId }) => {
  return EmployeeWorkLog.findAll({
    attributes: [
      'service_po_id',
      'hierarchy_node_id',
      [fn('SUM', col('hours')), 'total_hours'],
    ],
    where: {
      employee_id: parseInt(employeeId, 10),
      ...companyIdScope(companyId),
      work_date: { [Op.gte]: startDate, [Op.lte]: endDate },
    },
    group: ['service_po_id', 'hierarchy_node_id'],
    raw: true,
  });
};

/**
 * ALL work log rows for one company/month/year (regardless of status),
 * joined with Employee/ServicePO/SubProject — the ONLY data source for the
 * Admin "Sync Employee Work Logs" flow (see timesheetService.previewPmsImport
 * / confirmImport). Never reads from `timesheets`.
 *
 * Deliberately NOT filtered by status='synced' vs 'approved': Employee Work
 * Logs are the source of truth and can keep changing after a sync (an
 * employee may edit or delete an already-synced entry — see
 * employeeTimesheetService.js). Sync is idempotent/overwrite (re-projects
 * the ENTIRE current state of the month into `timesheets` every time it
 * runs), so it must read every non-pending row for the month, not just the
 * ones changed since the last sync — otherwise an unmodified-but-previously-
 * synced entry would be silently dropped from the official Timesheet on a
 * repeat sync.
 *
 * IS filtered to exclude status='pending': approval now happens BEFORE
 * Sync (a Manager approves an Employee's pending Work Log entries directly,
 * or they're auto-approved when is_timesheet_approval_required is false —
 * see managerSelfServiceService.bulkApproveTimesheets and
 * employeeTimesheetService.replaceDailyEntries), so an entry a Manager
 * hasn't approved yet must be structurally impossible for Sync to pick up.
 *
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 * @returns {Promise<EmployeeWorkLog[]>}
 */
const findForSync = async (companyId, month, year) => {
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);

  return EmployeeWorkLog.findAll({
    where: {
      [Op.and]: [
        literal(`EXTRACT(MONTH FROM work_date) = ${monthNum}`),
        literal(`EXTRACT(YEAR  FROM work_date) = ${yearNum}`),
      ],
      company_id: companyId,
      status: { [Op.ne]: 'pending' },
    },
    include: buildIncludes(),
    order: [['id', 'ASC']],
  });
};

/**
 * Mark every work log row matching one of the given (employeeId, poId, date)
 * tuples as 'synced', linked to the resulting import batch — regardless of
 * its CURRENT status, since a repeat sync must re-affirm already-synced,
 * unchanged rows just as much as newly pending ones (see findForSync's
 * doc). Called from inside confirmImport()'s transaction so the timesheets
 * insert and this status flip commit/rollback together.
 * @param {number} companyId
 * @param {Array<{ employeeId: number, poId: number, date: string }>} tuples
 * @param {number} timesheetImportId
 * @param {object} [transaction]
 * @returns {Promise<number>} rows updated
 */
const markSyncedByTuples = async (companyId, tuples, timesheetImportId, transaction = null) => {
  if (!tuples || tuples.length === 0) return 0;

  const orConditions = tuples.map((t) => ({
    employee_id: t.employeeId,
    service_po_id: t.poId,
    work_date: t.date,
  }));

  const [count] = await EmployeeWorkLog.update(
    {
      status: 'synced',
      synced_at: new Date(),
      timesheet_import_id: timesheetImportId,
    },
    {
      where: {
        company_id: companyId,
        [Op.or]: orConditions,
      },
      ...(transaction ? { transaction } : {}),
    }
  );

  return count;
};

/**
 * Revert every work log row currently linked to one of the given
 * timesheet_import_id values back to its pre-sync state — status='pending',
 * synced_at=null, timesheet_import_id=null. Called when an Admin deletes a
 * Timesheet Import (timesheetService.deleteImports): the official Timesheet
 * data for that import is gone, so the source work logs are no longer
 * "reflected in an official Timesheet" and must not be left stuck showing
 * status='synced' with a dangling reference. This is deliberately separate
 * from the DB-level ON DELETE SET NULL on the FK (which only clears the FK
 * column itself, not `status`) — the two together are what make Employee
 * Work Logs genuinely "remain intact" after an import deletion, not merely
 * "not deleted."
 *
 * @param {number[]} importIds
 * @param {object} [transaction]
 * @returns {Promise<number>} rows reverted
 */
const revertSyncStatusByImportIds = async (importIds, transaction = null) => {
  if (!importIds || importIds.length === 0) return 0;

  const [count] = await EmployeeWorkLog.update(
    { status: 'pending', synced_at: null, timesheet_import_id: null },
    {
      where: { timesheet_import_id: { [Op.in]: importIds } },
      ...(transaction ? { transaction } : {}),
    }
  );

  return count;
};

/**
 * Report rows for the Employee Reports module (Phase 4) — reads ONLY from
 * employee_work_logs, never from `timesheets` (Admin Reports keep reading
 * timesheets via reportRepository.js; the two data sources are never mixed).
 * @param {object} params - { employeeId, companyId, startDate, endDate }
 * @returns {Promise<Array>}
 */
const getReportRows = async ({ employeeId, companyId, startDate, endDate }) => {
  const where = { employee_id: employeeId, ...companyIdScope(companyId) };
  if (startDate) where.work_date = { ...where.work_date, [Op.gte]: startDate };
  if (endDate) where.work_date = { ...where.work_date, [Op.lte]: endDate };

  return EmployeeWorkLog.findAll({
    where,
    include: [
      { model: ServicePO, as: 'servicePO', attributes: ['id', 'service_po_code', 'service_po_name'] },
    ],
    order: [['work_date', 'ASC']],
  });
};

/**
 * Work Log Time Report rows — one row per employee_work_logs entry (never
 * aggregated, unlike getReportRows()'s callers), with everything the report
 * needs to map Project (via ServicePO -> Project) and Module (via the
 * hierarchy node's own name, or its Parent's name when the tagged node is a
 * CHILD — see workLogTimeReportService.js). Supports multiple employeeIds at
 * once (Manager/team scope) — see
 * timesheetApprovalReportService.resolveEmployeeScope, reused by
 * workLogTimeReportService.js for this report's own scoping. Default sort:
 * work_date DESC, then start_time ASC (nulls last) for deterministic
 * same-day ordering.
 *
 * @param {object} filters - { employeeIds: number[], companyId, startDate, endDate, servicePOId?, projectId? }
 * @returns {Promise<EmployeeWorkLog[]>}
 */
const getWorkLogTimeReportRows = async ({ employeeIds, companyId, startDate, endDate, servicePOId, projectId }) => {
  const where = { ...companyIdScope(companyId), employee_id: { [Op.in]: employeeIds } };
  if (startDate) where.work_date = { ...where.work_date, [Op.gte]: startDate };
  if (endDate) where.work_date = { ...where.work_date, [Op.lte]: endDate };
  if (servicePOId) where.service_po_id = servicePOId;

  return EmployeeWorkLog.findAll({
    where,
    include: [
      { model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'full_name'] },
      {
        model: ServicePO,
        as: 'servicePO',
        attributes: ['id', 'service_po_code', 'service_po_name', 'project_id'],
        include: [
          {
            model: Project,
            as: 'project',
            attributes: ['id', 'project_code', 'project_name'],
            required: !!projectId,
            ...(projectId ? { where: { id: projectId } } : {}),
          },
        ],
      },
      {
        model: ServicePOHierarchy,
        as: 'hierarchyNode',
        attributes: ['id', 'node_name', 'node_type'],
        required: false,
        include: [
          { model: ServicePOHierarchy, as: 'parentNode', attributes: ['id', 'node_name', 'node_type'], required: false },
        ],
      },
      {
        model: EmployeeWorkLogTimeEntry,
        as: 'timeEntries',
        required: false,
        separate: true,
        order: [['start_time', 'ASC'], ['id', 'ASC']],
      },
    ],
    // Per-entry Start Time ordering now happens inside the `timeEntries`
    // include above (its own column, on a separate query — `separate: true`
    // means it can't be ordered from this outer `order` clause anyway);
    // employee_work_logs itself no longer has a start_time column to sort by
    // (see 20260886_backfill_and_drop_worklog_start_end_time.sql).
    order: [['work_date', 'DESC'], ['id', 'ASC']],
  });
};

/**
 * ALL work log rows for one employee/date-range, with full row detail —
 * the source data for the Manager Daily/Monthly approval-summary view
 * (managerSelfServiceService.getApprovalSummary). This is NOT filtered by
 * status: a bucket must be able to show 'approved'/'synced' rows too (so an already-
 * approved day still displays its full detail), and bucket-level
 * approval_status is derived by the caller from whether ANY row in that
 * bucket is still 'pending'.
 * @param {object} params - { employeeId, companyId, startDate, endDate }
 * @returns {Promise<EmployeeWorkLog[]>}
 */
const findForApprovalSummary = async ({ employeeId, companyId, startDate, endDate }) => {
  const where = { employee_id: employeeId, company_id: companyId };
  if (startDate) where.work_date = { ...where.work_date, [Op.gte]: startDate };
  if (endDate) where.work_date = { ...where.work_date, [Op.lte]: endDate };

  return EmployeeWorkLog.findAll({
    where,
    include: buildIncludes(),
    order: [['work_date', 'DESC'], ['id', 'ASC']],
  });
};

/**
 * Same as findForApprovalSummary() above, but for MULTIPLE employees at
 * once — the source data for the Timesheet Approval Status Report
 * (timesheetApprovalReportService.js), which can show a Manager's whole
 * mapped team in one call rather than one employee at a time. Not filtered
 * by status, for the same reason findForApprovalSummary() isn't.
 * @param {object} params - { employeeIds, companyId, startDate, endDate }
 * @returns {Promise<EmployeeWorkLog[]>}
 */
const findForApprovalSummaryByEmployees = async ({ employeeIds, companyId, startDate, endDate }) => {
  if (!employeeIds || employeeIds.length === 0) return [];

  const where = { employee_id: { [Op.in]: employeeIds }, ...companyIdScope(companyId) };
  if (startDate) where.work_date = { ...where.work_date, [Op.gte]: startDate };
  if (endDate) where.work_date = { ...where.work_date, [Op.lte]: endDate };

  return EmployeeWorkLog.findAll({
    where,
    include: buildIncludes(),
    order: [['employee_id', 'ASC'], ['work_date', 'DESC'], ['id', 'ASC']],
  });
};

/**
 * Manager bulk-approve, daily grain — flips every currently-'pending' row
 * for one employee on one of the given dates to 'approved'. A date with
 * nothing pending is a harmless no-op (0 rows), not an error — mirrors the
 * bulk-approve convention already used elsewhere in this codebase.
 * @param {number} employeeId
 * @param {string[]} dates - "YYYY-MM-DD"
 * @param {number} companyId
 * @param {object} [transaction]
 * @returns {Promise<number>} rows updated
 */
const approveByEmployeeAndDates = async (employeeId, dates, companyId, transaction = null) => {
  const [count] = await EmployeeWorkLog.update(
    { status: 'approved' },
    {
      where: { employee_id: employeeId, company_id: companyId, work_date: { [Op.in]: dates }, status: 'pending' },
      ...(transaction ? { transaction } : {}),
    }
  );
  return count;
};

/**
 * Manager bulk-approve, monthly grain — flips every currently-'pending' row
 * for one employee within the given month/year pairs to 'approved'.
 * @param {number} employeeId
 * @param {Array<{ month: number, year: number }>} months
 * @param {number} companyId
 * @param {object} [transaction]
 * @returns {Promise<number>} rows updated
 */
const approveByEmployeeAndMonths = async (employeeId, months, companyId, transaction = null) => {
  const monthYearConditions = months.map(({ month, year }) => {
    const monthNum = parseInt(month, 10);
    const yearNum = parseInt(year, 10);
    if (!Number.isInteger(monthNum) || !Number.isInteger(yearNum)) {
      throw new Error(`approveByEmployeeAndMonths: month/year must be numbers (got month=${month}, year=${year}).`);
    }
    return literal(`(EXTRACT(MONTH FROM work_date) = ${monthNum} AND EXTRACT(YEAR FROM work_date) = ${yearNum})`);
  });

  const [count] = await EmployeeWorkLog.update(
    { status: 'approved' },
    {
      where: { employee_id: employeeId, company_id: companyId, status: 'pending', [Op.or]: monthYearConditions },
      ...(transaction ? { transaction } : {}),
    }
  );
  return count;
};

/**
 * Flip specific rows straight to 'approved' by id — used right after
 * Draft creation (replaceDailyEntries / submitMonthlyWorkLog) for an
 * employee whose is_timesheet_approval_required is false, so their entries
 * never sit waiting for a Manager action they don't need. Deliberately a
 * separate, additive call made AFTER the creation transaction commits —
 * Draft creation itself always inserts status='pending' unchanged.
 * @param {number[]} ids
 * @param {number} companyId
 * @param {object} [transaction]
 * @returns {Promise<number>} rows updated
 */
const markApprovedByIds = async (ids, companyId, transaction = null) => {
  if (!ids || ids.length === 0) return 0;
  const [count] = await EmployeeWorkLog.update(
    { status: 'approved' },
    {
      where: { id: { [Op.in]: ids }, company_id: companyId },
      ...(transaction ? { transaction } : {}),
    }
  );
  return count;
};

/**
 * Manager Approve — atomically flips ONE row from 'pending' to 'approved'.
 * The single-row analog of markApprovedByIds (bulk, used internally right
 * after Draft creation for an employee who skips approval) and of
 * rejectById below — same atomic status='pending' guard, for the same
 * reason: a lost race against a concurrent reject/resubmit on this row
 * shows up as a no-op (0 rows) rather than silently overwriting it. The
 * caller (managerSelfServiceService.approveTimesheet) treats null as "not
 * pending anymore" and 409s.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog|null>} the updated row, or null if it wasn't pending
 */
const approveById = async (id, companyId) => {
  const [count] = await EmployeeWorkLog.update(
    { status: 'approved' },
    { where: { id, company_id: companyId, status: 'pending' } }
  );
  if (count === 0) return null;
  return findById(id, companyId);
};

/**
 * Manager Reject — atomically flips ONE row from 'pending' to 'rejected',
 * recording the mandatory remark and who/when. The status='pending' guard
 * in the WHERE clause makes this a no-op (0 rows) rather than a race if the
 * row was approved/rejected by someone else a moment earlier — the caller
 * (managerSelfServiceService.rejectWorkLogEntry) treats 0 as "not pending
 * anymore" and 409s.
 * @param {number} id
 * @param {number} companyId
 * @param {{ remark: string, rejectedBy: number }} params
 * @returns {Promise<EmployeeWorkLog|null>} the updated row, or null if it wasn't pending
 */
const rejectById = async (id, companyId, { remark, rejectedBy }) => {
  const [count] = await EmployeeWorkLog.update(
    { status: 'rejected', rejection_remark: remark, rejected_by: rejectedBy, rejected_at: new Date() },
    { where: { id, company_id: companyId, status: 'pending' } }
  );
  if (count === 0) return null;
  return findById(id, companyId);
};

/**
 * Employee Resubmit — atomically flips ONE row from 'rejected' back to
 * 'pending'. Deliberately does NOT touch rejection_remark/rejected_by/
 * rejected_at — the most recent rejection stays visible even once the row
 * is pending again (see EmployeeWorkLog.js's doc comment); it's only
 * overwritten by a subsequent rejection. The status='rejected' guard makes
 * this a no-op (0 rows) if the row isn't currently rejected.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog|null>} the updated row, or null if it wasn't rejected
 */
const resubmitById = async (id, companyId) => {
  const [count] = await EmployeeWorkLog.update(
    { status: 'pending' },
    { where: { id, company_id: companyId, status: 'rejected' } }
  );
  if (count === 0) return null;
  return findById(id, companyId);
};

/**
 * Whether ANY employee_work_logs row exists for a Service PO OR any of its
 * hierarchy nodes (Parent/Child) — one half of the delete guard in
 * servicePOService.delete() (the other half is timesheetRepository.
 * existsForServicePO). In practice a hierarchy-tagged row's service_po_id
 * always already matches the node's own PO (enforced at write time — see
 * employeeTimesheetService.resolveHierarchyNode), so the service_po_id
 * check alone already covers Main/Parent/Child; the explicit
 * hierarchy_node_id check is kept as a defensive belt-and-braces match.
 * @param {number} servicePOId
 * @param {number[]} hierarchyNodeIds - every Parent/Child node id under this Service PO
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const existsForServicePOOrHierarchy = async (servicePOId, hierarchyNodeIds, companyId) => {
  const where = {
    company_id: companyId,
    [Op.or]: [
      { service_po_id: servicePOId },
      ...(hierarchyNodeIds.length > 0 ? [{ hierarchy_node_id: { [Op.in]: hierarchyNodeIds } }] : []),
    ],
  };

  const row = await EmployeeWorkLog.findOne({ where, attributes: ['id'] });
  return !!row;
};

/**
 * Whether ANY employee_work_logs row exists tagged against one or more
 * SPECIFIC hierarchy nodes — the delete guard in
 * servicePOHierarchyService.remove(). Unlike existsForServicePOOrHierarchy
 * above, this does NOT fall back to service_po_id: deleting a single
 * Parent/Child node must only be blocked by work logs on THAT node (and, for
 * a Parent, its own Children) — not by unrelated work logs logged directly
 * against the Service PO or against a sibling node elsewhere in the
 * hierarchy.
 * @param {number[]} hierarchyNodeIds - the node being deleted, plus its Children if it's a Parent
 * @param {number|number[]} companyId - a plain company id, or an array of owned company ids
 *   for a company-less Admin/Entity Admin caller (see companyAccessControlService)
 * @returns {Promise<boolean>}
 */
const existsForHierarchyNodes = async (hierarchyNodeIds, companyId) => {
  if (!hierarchyNodeIds || hierarchyNodeIds.length === 0) return false;

  const companyWhere = Array.isArray(companyId) ? { [Op.in]: companyId } : companyId;
  const row = await EmployeeWorkLog.findOne({
    where: { hierarchy_node_id: { [Op.in]: hierarchyNodeIds }, company_id: companyWhere },
    attributes: ['id'],
  });
  return !!row;
};

/**
 * Hard-delete EVERY work log entry (any log_type) for one employee whose
 * work_date falls within an inclusive date range — the "clear the month"
 * half of the Monthly Work Log REPLACE SAVE flow
 * (employeeMonthlyWorkLogService.submitMonthlyWorkLog). Mirrors
 * deleteByEmployeeAndDate above, scoped to a range instead of one date, so
 * a single call clears both any existing Daily entries for the month and
 * any previous Monthly entry, before the new Monthly rows are inserted in
 * the same transaction.
 * @param {number} employeeId
 * @param {string} startDate - "YYYY-MM-DD"
 * @param {string} endDate - "YYYY-MM-DD"
 * @param {number} companyId
 * @param {object} transaction
 * @returns {Promise<number>} rows deleted
 */
const deleteByEmployeeAndDateRange = async (employeeId, startDate, endDate, companyId, transaction) => {
  return EmployeeWorkLog.destroy({
    where: {
      employee_id: employeeId,
      work_date: { [Op.gte]: startDate, [Op.lte]: endDate },
      company_id: companyId,
    },
    transaction,
  });
};

/**
 * Monthly Work Log hierarchy breakdown for ONE date (the month's last day)
 * — same shape as getDailyHierarchyBreakdown, but filtered to
 * log_type: 'monthly' so a Daily row that happens to land on the month's
 * last day never leaks into the Monthly Work Log view.
 * @param {object} params - { employeeId, date, companyId }
 * @returns {Promise<Array<{ service_po_id, hierarchy_node_id, total_hours }>>}
 */
const getMonthlyLogHierarchyBreakdown = async ({ employeeId, date, companyId }) => {
  return EmployeeWorkLog.findAll({
    attributes: [
      'service_po_id',
      'hierarchy_node_id',
      [fn('SUM', col('hours')), 'total_hours'],
    ],
    where: {
      work_date: date,
      employee_id: parseInt(employeeId, 10),
      company_id: companyId,
      log_type: 'monthly',
    },
    group: ['service_po_id', 'hierarchy_node_id'],
    raw: true,
  });
};

/**
 * Hard-delete the Monthly Work Log entries (log_type: 'monthly' only —
 * never touches Daily rows) for one employee within a date range. Backs
 * employeeMonthlyWorkLogService.deleteMonthlyWorkLog.
 * @param {number} employeeId
 * @param {string} startDate - "YYYY-MM-DD"
 * @param {string} endDate - "YYYY-MM-DD"
 * @param {number} companyId
 * @returns {Promise<number>} rows deleted
 */
const deleteMonthlyEntries = async (employeeId, startDate, endDate, companyId) => {
  return EmployeeWorkLog.destroy({
    where: {
      employee_id: employeeId,
      work_date: { [Op.gte]: startDate, [Op.lte]: endDate },
      company_id: companyId,
      log_type: 'monthly',
    },
  });
};

/**
 * Whether a Monthly Work Log entry already exists for this employee within
 * a date range — backs the Daily-side guard
 * (employeeTimesheetService.assertNoMonthlyLogForDate) that blocks Daily
 * create/update for a month that already has a Monthly entry.
 * @param {number} employeeId
 * @param {string} startDate - "YYYY-MM-DD"
 * @param {string} endDate - "YYYY-MM-DD"
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const hasMonthlyEntry = async (employeeId, startDate, endDate, companyId) => {
  const row = await EmployeeWorkLog.findOne({
    where: {
      employee_id: employeeId,
      work_date: { [Op.gte]: startDate, [Op.lte]: endDate },
      company_id: companyId,
      log_type: 'monthly',
    },
    attributes: ['id'],
  });
  return !!row;
};

module.exports = {
  findAll,
  findById,
  findByIdForEmployee,
  checkDuplicate,
  create,
  bulkCreate,
  deleteByEmployeeAndDate,
  deleteByEmployeeAndDateRange,
  update,
  deleteById,
  getDailyHours,
  getCalendarSummary,
  getDailyHierarchyBreakdown,
  getMonthlyHierarchyBreakdown,
  getHierarchyBreakdownForRange,
  getMonthlyLogHierarchyBreakdown,
  deleteMonthlyEntries,
  hasMonthlyEntry,
  findForSync,
  markSyncedByTuples,
  revertSyncStatusByImportIds,
  getReportRows,
  getWorkLogTimeReportRows,
  findForApprovalSummary,
  findForApprovalSummaryByEmployees,
  approveByEmployeeAndDates,
  approveByEmployeeAndMonths,
  markApprovedByIds,
  approveById,
  rejectById,
  resubmitById,
  existsForServicePOOrHierarchy,
  existsForHierarchyNodes,
};
