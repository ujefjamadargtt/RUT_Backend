'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { EmployeeWorkLog, Employee, ServicePO, SubProject } = require('../models');

/**
 * Employee Work Log Repository
 *
 * Raw database access for `employee_work_logs` — the Employee Self
 * Timesheet "draft" table. This is a COMPLETELY SEPARATE table from
 * `timesheets` (see timesheetRepository.js, which this file never touches
 * or delegates to). Every method is company_id-scoped.
 */

const ALLOWED_SORT_COLUMNS = new Set(['work_date', 'hours', 'created_at']);

function buildIncludes() {
  return [
    { model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'full_name'] },
    { model: ServicePO, as: 'servicePO', attributes: ['id', 'service_po_code', 'service_po_name', 'status'] },
    { model: SubProject, as: 'subProject', attributes: ['id', 'sub_project_code', 'sub_project_name'], required: false },
  ];
}

/**
 * Fetch a paginated, filtered list of an employee's work log entries.
 * @param {object} filters - { employeeId, startDate, endDate, companyId, status }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort - { sortBy, sortOrder }
 * @returns {Promise<{ rows: EmployeeWorkLog[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { employeeId, startDate, endDate, companyId, status } = filters;
  const { limit = 20, offset = 0 } = pagination;

  let { sortBy = 'work_date', sortOrder = 'DESC' } = sort;
  if (!ALLOWED_SORT_COLUMNS.has(sortBy)) sortBy = 'work_date';
  const order = (sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const where = { company_id: companyId };
  if (employeeId) where.employee_id = parseInt(employeeId, 10);
  if (status) where.status = status;
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
 * Check whether a work log entry already exists for this employee/PO/date.
 * @param {number} employeeId
 * @param {number} servicePOId
 * @param {string} date - "YYYY-MM-DD"
 * @param {number} [excludeId]
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog|null>}
 */
const checkDuplicate = async (employeeId, servicePOId, date, excludeId = null, companyId) => {
  const where = {
    employee_id: employeeId,
    service_po_id: servicePOId,
    work_date: date,
    company_id: companyId,
  };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return EmployeeWorkLog.findOne({ where });
};

/**
 * Insert a new work log entry.
 * @param {object} data
 * @returns {Promise<EmployeeWorkLog>}
 */
const create = async (data) => {
  return EmployeeWorkLog.create(data);
};

/**
 * Update an existing work log entry by primary key.
 * @param {number} id
 * @param {object} data
 * @param {number} companyId
 * @returns {Promise<EmployeeWorkLog|null>}
 */
const update = async (id, data, companyId) => {
  const entry = await EmployeeWorkLog.findOne({ where: { id, company_id: companyId } });
  if (!entry) return null;
  return entry.update(data);
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
 * Monthly Summary — total hours grouped by Service PO, for one employee/month.
 * @param {object} params - { employeeId, month, year, companyId }
 * @returns {Promise<Array>}
 */
const getMonthlySummary = async ({ employeeId, month, year, companyId }) => {
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  if (!Number.isInteger(monthNum) || !Number.isInteger(yearNum)) {
    throw new Error(`getMonthlySummary: month/year must be numbers (got month=${month}, year=${year}).`);
  }

  const rows = await EmployeeWorkLog.findAll({
    attributes: [
      'service_po_id',
      [fn('SUM', col('EmployeeWorkLog.hours')), 'total_hours'],
      [fn('COUNT', col('EmployeeWorkLog.id')), 'entry_count'],
    ],
    where: {
      [Op.and]: [
        literal(`EXTRACT(MONTH FROM work_date) = ${monthNum}`),
        literal(`EXTRACT(YEAR  FROM work_date) = ${yearNum}`),
      ],
      employee_id: parseInt(employeeId, 10),
      company_id: companyId,
    },
    include: [
      { model: ServicePO, as: 'servicePO', attributes: ['id', 'service_po_code', 'service_po_name'] },
    ],
    group: [
      'EmployeeWorkLog.service_po_id',
      'servicePO.id',
      'servicePO.service_po_code',
      'servicePO.service_po_name',
    ],
    order: [[fn('SUM', col('EmployeeWorkLog.hours')), 'DESC']],
    raw: false,
  });

  return rows;
};

/**
 * ALL work log rows for one company/month/year (regardless of status),
 * joined with Employee/ServicePO/SubProject — the ONLY data source for the
 * Admin "Sync Employee Work Logs" flow (see timesheetService.previewPmsImport
 * / confirmImport). Never reads from `timesheets`.
 *
 * Deliberately NOT filtered by status='pending': Employee Work Logs are the
 * source of truth and can keep changing after a sync (an employee may edit
 * or delete an already-synced entry — see employeeTimesheetService.js).
 * Sync is idempotent/overwrite (re-projects the ENTIRE current state of the
 * month into `timesheets` every time it runs), so it must read every row
 * for the month, not just the ones changed since the last sync — otherwise
 * an unmodified-but-previously-synced entry would be silently dropped from
 * the official Timesheet on a repeat sync.
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
  const where = { employee_id: employeeId, company_id: companyId };
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

module.exports = {
  findAll,
  findById,
  findByIdForEmployee,
  checkDuplicate,
  create,
  update,
  deleteById,
  getDailyHours,
  getCalendarSummary,
  getMonthlySummary,
  findForSync,
  markSyncedByTuples,
  revertSyncStatusByImportIds,
  getReportRows,
};
