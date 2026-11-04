'use strict';

const moment = require('moment-timezone');
const repository = require('../repositories/crossBuEmployeePoHoursReportRepository');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const { resolveAuthorizedEmployeeIds } = require('./employeeWorkLogHoursSummaryService');
const { expandBusinessUnitIdsWithDescendants } = require('./companyAccessControlService');
const dateHelper = require('../helpers/dateHelper');
const { parseIdList } = require('../utils/idListParser');
const { resolveApprovalStatuses } = require('../utils/approvalStatusFilter');
const { getPaginationMeta } = require('../utils/pagination');

/**
 * Cross-BU Employee & Service PO Hours Report.
 *
 * Shows Employee -> Employee BU/Sub-BU -> Client -> Project -> Service PO -> PO BU -> total hours
 * on that PO (per month; no Activity/Task breakdown) with Employee BU and PO BU as two INDEPENDENT dimensions, so cross-BU work is visible
 * from both sides (see crossBuEmployeePoHoursReportRepository.js for the data rules).
 *
 * Visibility (existing RBAC, no new permission):
 *  - Platform Admin / Admin / Entity Admin / BU Admin (rank <= 4): a row is visible when the
 *    EMPLOYEE belongs to one of the caller's BUs OR the PO belongs to one of them — their own
 *    people anywhere, and anyone working on their POs. Admin tier also sees its own tenant's
 *    BU-less POs.
 *  - Project Manager (rank 6): rows on the Service POs they are the flagged PM of — the same
 *    Service-PO-based scope Timesheet Approval and the Project-Wise Timesheet Report use.
 *  - Everyone else: the Employees they may see (resolveAuthorizedEmployeeIds), as the sibling
 *    work-log reports do.
 */

const BU_SCOPED_MAX_RANK = 4;
const ADMIN_TIER_MAX_RANK = 3;
const PROJECT_MANAGER_RANK = 6;
const MAX_RANGE_DAYS = 366;
const MAX_EXPORT_ROWS = 50000;

const WORK_TYPE_LABELS = { own: 'Own BU', cross: 'Cross BU', na: 'Not Applicable' };

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const num = (v) => Number.parseFloat(v) || 0;
const round2 = (v) => Math.round(v * 100) / 100;
const pct = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : 0);

/** month + year, or an inclusive start_date/end_date range (max 366 days); current month when neither. */
function resolvePeriod(query) {
  if (query.start_date || query.end_date) {
    const { start_date: startDate, end_date: endDate } = query;
    if (!startDate || !endDate) throw badRequest('start_date and end_date must be provided together.');
    if (startDate > endDate) throw badRequest('start_date must be on or before end_date.');
    if (dateHelper.daysBetween(startDate, endDate) + 1 > MAX_RANGE_DAYS) {
      throw badRequest(`The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
    }
    return { startDate, endDate, period: { type: 'range', start_date: startDate, end_date: endDate } };
  }
  const now = moment();
  const month = query.month || (query.year ? 1 : now.month() + 1);
  const year = query.year || now.year();
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  return { startDate, endDate, period: { type: 'month', month, year, start_date: startDate, end_date: endDate } };
}

async function resolveScope(authContext, companyIds) {
  const rank = authContext.hierarchyRank;
  if (rank != null && rank <= BU_SCOPED_MAX_RANK) {
    const reachIds = await expandBusinessUnitIdsWithDescendants(companyIds || []);
    if (!reachIds.length) return null;
    return { kind: 'reach', reachIds, includeTenantBuLessPOs: rank <= ADMIN_TIER_MAX_RANK };
  }
  if (rank === PROJECT_MANAGER_RANK) {
    const servicePoIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(authContext.employeeId);
    return servicePoIds.length ? { kind: 'servicePos', servicePoIds } : null;
  }
  const employeeIds = await resolveAuthorizedEmployeeIds(authContext, companyIds || []);
  return employeeIds.length ? { kind: 'employees', employeeIds } : null;
}

async function buildFilters(query, authContext, companyIds) {
  const { startDate, endDate, period } = resolvePeriod(query);
  const scope = await resolveScope(authContext, companyIds);
  if (!scope) return { period, filters: null };

  // A selected Parent BU covers its Sub-BUs on either side.
  const employeeBuIds = parseIdList(query.employee_bu_ids);
  const poBuIds = parseIdList(query.po_bu_ids);
  return {
    period,
    filters: {
      startDate,
      endDate,
      scope,
      employeeIds: parseIdList(query.employee_ids),
      employeeBuIds: employeeBuIds ? await expandBusinessUnitIdsWithDescendants(employeeBuIds) : null,
      employeeSubBuIds: parseIdList(query.employee_sub_bu_ids),
      clientIds: parseIdList(query.client_ids),
      projectIds: parseIdList(query.project_ids),
      servicePoIds: parseIdList(query.service_po_ids),
      poBuIds: poBuIds ? await expandBusinessUnitIdsWithDescendants(poBuIds) : null,
      statuses: resolveApprovalStatuses(query.approval_status),
      workType: query.work_type && query.work_type !== 'all' ? query.work_type : null,
      search: query.search || null,
    },
  };
}

function toRecord(row) {
  return {
    employee_id: row.employee_id,
    employee_code: row.employee_code,
    employee_name: row.employee_name,
    employee_bu: row.employee_bu,
    employee_sub_bu: row.employee_sub_bu,
    client_id: row.client_id,
    client_name: row.client_name,
    project_id: row.project_id,
    project_name: row.project_name,
    service_po_id: row.service_po_id,
    service_po_code: row.service_po_code,
    service_po_name: row.service_po_name,
    po_bu_id: row.po_bu_id,
    po_bu: row.po_bu,
    po_sub_bu: row.po_sub_bu,
    is_centralised: row.is_centralised === true,
    logged_hours: num(row.hours),
    // After the monthly-cap adjustment; null while none of the row's work has been synced yet.
    adjusted_hours: row.adjusted_hours == null ? null : num(row.adjusted_hours),
    days_logged: row.days_logged,
    month: row.month,
    year: row.year,
    work_type: row.work_type,
    work_type_label: WORK_TYPE_LABELS[row.work_type] || row.work_type,
  };
}

function toTotals(t) {
  const total = num(t.total_hours);
  const own = num(t.own_bu_hours);
  const cross = num(t.cross_bu_hours);
  return {
    total_employees: t.employee_count,
    total_hours: total,
    adjusted_total_hours: num(t.adjusted_total_hours),
    own_bu_hours: own,
    cross_bu_hours: cross,
    unclassified_hours: num(t.unclassified_hours),
    // Both bases of the work-type split. own_bu_hours / cross_bu_hours / unclassified_hours above (and total_hours)
    // are the ORIGINAL (as-logged) figures; the adjusted_* ones are after the monthly-cap adjustment (synced work only).
    original_total_hours: total,
    original_own_bu_hours: own,
    original_cross_bu_hours: cross,
    original_unclassified_hours: num(t.unclassified_hours),
    adjusted_own_bu_hours: num(t.adjusted_own_bu_hours),
    adjusted_cross_bu_hours: num(t.adjusted_cross_bu_hours),
    adjusted_unclassified_hours: num(t.adjusted_unclassified_hours),
    own_bu_percent: pct(own, total),
    cross_bu_percent: pct(cross, total),
    cross_bu_employee_count: t.cross_bu_employee_count,
  };
}

const UNASSIGNED = 'No Business Unit';

/** Pivot the Employee BU x PO BU rows into both management perspectives. */
function toBuFlow(matrix) {
  const rows = matrix.map((r) => ({
    employee_bu_id: r.employee_bu_id,
    employee_bu: r.employee_bu || UNASSIGNED,
    po_bu_id: r.po_bu_id,
    po_bu: r.po_bu || UNASSIGNED,
    hours: num(r.hours),
    employee_count: r.employee_count,
    work_type: r.employee_bu_id != null && r.employee_bu_id === r.po_bu_id ? 'own' : 'cross',
  }));

  const employeeToPo = [...rows].sort((a, b) => b.hours - a.hours);

  const byPo = new Map();
  for (const r of rows) {
    const key = r.po_bu_id ?? 'none';
    if (!byPo.has(key)) byPo.set(key, { po_bu_id: r.po_bu_id, po_bu: r.po_bu, total_hours: 0, employee_bus: [] });
    const entry = byPo.get(key);
    entry.total_hours = round2(entry.total_hours + r.hours);
    entry.employee_bus.push({
      employee_bu_id: r.employee_bu_id, employee_bu: r.employee_bu, hours: r.hours, employee_count: r.employee_count, work_type: r.work_type,
    });
  }
  const poToEmployee = [...byPo.values()]
    .map((e) => ({ ...e, employee_bus: e.employee_bus.sort((a, b) => b.hours - a.hours) }))
    .sort((a, b) => b.total_hours - a.total_hours);

  return { employee_bu_to_po_bu: employeeToPo, po_bu_to_employee_bu: poToEmployee };
}

const EMPTY_TOTALS = {
  employee_count: 0, total_hours: 0, own_bu_hours: 0, cross_bu_hours: 0, unclassified_hours: 0, cross_bu_employee_count: 0,
};

async function getReport(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  const page = query.page || 1;
  const limit = query.limit || 50;

  if (!filters) {
    return {
      period,
      totals: toTotals(EMPTY_TOTALS),
      bu_flow: toBuFlow([]),
      records: [],
      meta: getPaginationMeta(0, page, limit),
    };
  }

  const [rows, totals, matrix] = await Promise.all([
    repository.findRows(filters, { sortBy: query.sort_by, hoursSource: query.hoursSource, limit, offset: (page - 1) * limit }),
    repository.getTotals(filters),
    repository.getBuMatrix(filters),
  ]);

  const totalRows = rows.length ? Number(rows[0].total_rows) : 0;
  return {
    period,
    totals: toTotals(totals),
    bu_flow: toBuFlow(matrix),
    records: rows.map(toRecord),
    meta: getPaginationMeta(totalRows, page, limit),
  };
}

const DETAIL_COLUMNS = [
  { key: 'employee_name', label: 'Employee Name', width: 26 },
  { key: 'employee_code', label: 'Employee Code', width: 14 },
  { key: 'employee_bu', label: 'Employee BU', width: 22 },
  { key: 'employee_sub_bu', label: 'Employee Sub-BU', width: 22 },
  { key: 'client_name', label: 'Client', width: 26 },
  { key: 'project_name', label: 'Project', width: 28 },
  { key: 'service_po_code', label: 'Service PO No.', width: 16 },
  { key: 'service_po_name', label: 'Service PO', width: 28 },
  { key: 'po_bu', label: 'PO BU', width: 22 },
  { key: 'po_sub_bu', label: 'PO Sub-BU', width: 22 },
  { key: 'logged_hours', label: 'Logged Hours', width: 13, numFmt: '0.00' },
  { key: 'adjusted_hours', label: 'Adjusted Hours', width: 15, numFmt: '0.00' },
  { key: 'work_type_label', label: 'Work Type', width: 15 },
  { key: 'month', label: 'Month', width: 8 },
  { key: 'year', label: 'Year', width: 8 },
];

// Export: ONE hours column per metric, for the basis chosen with ?hoursSource ('O' = Original, anything else = Adjusted).
const isOriginal = (query) => query.hoursSource === 'O';
const detailColumnsFor = (query) => DETAIL_COLUMNS
  .filter((c) => c.key !== (isOriginal(query) ? 'adjusted_hours' : 'logged_hours'))
  .map((c) => (isOriginal(query) && c.key === 'logged_hours' ? { ...c, label: 'Logged Hours (Original)', width: 22 } : c));
const flowColumnsFor = (query) => FLOW_COLUMNS
  .map((c) => (c.key === 'hours' ? { ...c, label: isOriginal(query) ? 'Hours (Original)' : 'Hours (Adjusted)', width: 18 } : c));

const FLOW_COLUMNS = [
  { key: 'employee_bu', label: 'Employee BU', width: 24 },
  { key: 'po_bu', label: 'PO BU', width: 24 },
  { key: 'work_type_label', label: 'Work Type', width: 15 },
  { key: 'employee_count', label: 'Employees', width: 12 },
  { key: 'hours', label: 'Hours', width: 12, numFmt: '0.00' },
];

async function getExport(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  if (!filters) {
    return {
      period,
      sheets: [
        { name: 'Cross-BU Hours', columns: detailColumnsFor(query), rows: [] },
        { name: 'BU Flow', columns: flowColumnsFor(query), rows: [] },
      ],
    };
  }

  const matrix = isOriginal(query) ? await repository.getBuMatrix(filters) : await repository.getBuMatrixAdjusted(filters);
  // Window COUNT comes back with the first row; probe with a 1-row page before pulling everything.
  const probe = await repository.findRows(filters, { sortBy: query.sort_by, hoursSource: query.hoursSource, limit: 1, offset: 0 });
  if (probe.length && Number(probe[0].total_rows) > MAX_EXPORT_ROWS) {
    throw badRequest(`This download would contain ${probe[0].total_rows} rows (maximum ${MAX_EXPORT_ROWS}). Narrow the period or filters.`);
  }
  const rows = await repository.findRows(filters, { sortBy: query.sort_by, hoursSource: query.hoursSource });

  const flowRows = toBuFlow(matrix).employee_bu_to_po_bu.map((r) => ({ ...r, work_type_label: WORK_TYPE_LABELS[r.work_type] }));
  return {
    period,
    sheets: [
      { name: 'Cross-BU Hours', columns: detailColumnsFor(query), rows: rows.map(toRecord) },
      { name: 'BU Flow', columns: flowColumnsFor(query), rows: flowRows },
    ],
  };
}

module.exports = { getReport, getExport, resolvePeriod, toRecord, toBuFlow, toTotals, DETAIL_COLUMNS, detailColumnsFor, flowColumnsFor };
