'use strict';

const moment = require('moment-timezone');
const repository = require('../repositories/workLogSyncComparisonReportRepository');
const { resolvePeriod: resolveMonthOrRange, resolveScope } = require('./crossBuEmployeePoHoursReportService');
const { expandBusinessUnitIdsWithDescendants } = require('./companyAccessControlService');
const { parseIdList } = require('../utils/idListParser');
const { resolveApprovalStatuses } = require('../utils/approvalStatusFilter');
const { getPaginationMeta } = require('../utils/pagination');

/**
 * Work Log Sync Comparison Report — every Employee Work Log entry with its hours BEFORE sync (as logged)
 * and AFTER sync (the official timesheet hours after the monthly-cap adjustment).
 *
 * Who sees what is the Cross-BU report's existing RBAC, unchanged (resolveScope):
 *  - Admin / Entity Admin / BU Admin (rank <= 4): entries of employees in their BUs OR on POs of their BUs.
 *  - Project Manager (rank 6): entries on the Service POs they are the flagged PM of.
 *  - Team Lead / everyone else: the employees they are authorized to see (their mapped employees).
 * A caller with no scope gets an empty report, never an error and never someone else's data.
 * See workLogSyncComparisonReportRepository.js for the data rules (After-sync sharing, Module/Task, work type).
 */

const MAX_EXPORT_ROWS = 50000;
const WORK_TYPE_LABELS = { own: 'Own BU', cross: 'Cross BU', na: 'Not Applicable' };
const STATUS_LABELS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', synced: 'Synced' };

const num = (v) => Number.parseFloat(v) || 0;
const round2 = (v) => Math.round(v * 100) / 100;
const dateOnly = (d) => (typeof d === 'string' ? d.slice(0, 10) : moment.utc(d).format('YYYY-MM-DD'));

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** One date, an inclusive start_date/end_date range (max 366 days), or month + year; the current month when none. */
function resolvePeriod(query) {
  if (query.date) {
    return { startDate: query.date, endDate: query.date, period: { type: 'date', date: query.date, start_date: query.date, end_date: query.date } };
  }
  return resolveMonthOrRange(query);
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
  const after = row.after_sync_hours == null ? null : num(row.after_sync_hours);
  return {
    work_log_id: row.work_log_id,
    date: dateOnly(row.work_date),
    log_type: row.log_type,
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
    is_centralised: row.is_centralised === true,
    po_bu_id: row.po_bu_id,
    po_bu: row.po_bu,
    po_sub_bu_id: row.po_sub_bu_id,
    po_sub_bu: row.po_sub_bu,
    module_name: row.module_name || null,
    task_name: row.task_name || null,
    sub_project_name: row.sub_project_name || null,
    before_sync_hours: num(row.before_sync_hours),
    // null until the entry is synced
    after_sync_hours: after,
    hours_difference: after == null ? null : round2(after - num(row.before_sync_hours)),
    description: row.description,
    work_type: row.work_type,
    work_type_label: WORK_TYPE_LABELS[row.work_type] || row.work_type,
    status: row.status,
    status_label: STATUS_LABELS[row.status] || row.status,
    is_synced: row.status === 'synced',
    synced_at: row.synced_at || null,
    timesheet_import_id: row.timesheet_import_id || null,
  };
}

function toTotals(t) {
  return {
    total_entries: t.total_entries,
    total_employees: t.employee_count,
    synced_entries: t.synced_entries,
    not_synced_entries: t.total_entries - t.synced_entries,
    before_sync_hours: round2(num(t.before_sync_hours)),
    after_sync_hours: round2(num(t.after_sync_hours)),
    own_bu: { before_sync_hours: round2(num(t.own_before_hours)), after_sync_hours: round2(num(t.own_after_hours)) },
    cross_bu: { before_sync_hours: round2(num(t.cross_before_hours)), after_sync_hours: round2(num(t.cross_after_hours)) },
    not_applicable: { before_sync_hours: round2(num(t.na_before_hours)), after_sync_hours: round2(num(t.na_after_hours)) },
  };
}

const EMPTY_SUMMARY = {
  total_entries: 0, employee_count: 0, synced_entries: 0, before_sync_hours: 0, after_sync_hours: 0,
  own_before_hours: 0, own_after_hours: 0, cross_before_hours: 0, cross_after_hours: 0, na_before_hours: 0, na_after_hours: 0,
};

/**
 * Paged report. The page count comes from a dedicated COUNT over the whole filtered set (never from the page
 * rows), so an out-of-range page returns an empty list with the correct total/totalPages.
 */
async function getReport(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  const page = query.page || 1;
  const limit = query.limit || 50;
  if (!filters) {
    return { period, totals: toTotals(EMPTY_SUMMARY), records: [], meta: getPaginationMeta(0, page, limit) };
  }

  const [summary, rows] = await Promise.all([
    repository.getSummary(filters),
    repository.findPage(filters, { sortBy: query.sort_by, sortOrder: query.sort_order, limit, offset: (page - 1) * limit }),
  ]);
  return {
    period,
    totals: toTotals(summary),
    records: rows.map(toRecord),
    meta: getPaginationMeta(summary.total_entries, page, limit),
  };
}

const COLUMNS = [
  { key: 'employee_code', label: 'Employee Code', width: 14 },
  { key: 'employee_name', label: 'Employee Name', width: 26 },
  { key: 'date', label: 'Date', width: 12 },
  { key: 'client_name', label: 'Client', width: 26 },
  { key: 'project_name', label: 'Project', width: 28 },
  { key: 'service_po_code', label: 'Service PO No.', width: 16 },
  { key: 'service_po_name', label: 'Service PO', width: 30 },
  { key: 'module_name', label: 'Module', width: 24 },
  { key: 'task_name', label: 'Task', width: 24 },
  { key: 'before_sync_hours', label: 'Before Sync Hrs', width: 16, numFmt: '0.00' },
  { key: 'after_sync_hours', label: 'After Sync Hrs', width: 16, numFmt: '0.00' },
  { key: 'work_type_label', label: 'Work Type', width: 15 },
  { key: 'po_bu', label: 'PO BU', width: 22 },
  { key: 'po_sub_bu', label: 'PO Sub-BU', width: 22 },
  { key: 'status_label', label: 'Status', width: 12 },
  { key: 'description', label: 'Description', width: 50 },
];

/** Excel/CSV: the same filtered set, every row (guarded by MAX_EXPORT_ROWS). */
async function getExport(query, authContext, companyIds) {
  const { period, filters } = await buildFilters(query, authContext, companyIds);
  if (!filters) return { period, columns: COLUMNS, rows: [] };

  const summary = await repository.getSummary(filters);
  if (summary.total_entries > MAX_EXPORT_ROWS) {
    throw badRequest(`This download would contain ${summary.total_entries} rows (maximum ${MAX_EXPORT_ROWS}). Narrow the period or filters.`);
  }
  const rows = await repository.findAll(filters);
  return { period, columns: COLUMNS, rows: rows.map(toRecord) };
}

/** Dropdown options for the filters, scoped to the caller and the selected period (date / range / month). */
async function getFilterOptions(query, authContext, companyIds) {
  const { period, filters } = await buildFilters({ ...query, employee_bu_ids: undefined, po_bu_ids: undefined }, authContext, companyIds);
  const empty = {
    period, employees: [], clients: [], projects: [], servicePos: [], employeeBusinessUnits: [], employeeSubBusinessUnits: [],
    poBusinessUnits: [], poSubBusinessUnits: [],
  };
  if (!filters) return empty;

  const { rows, employeeBus } = await repository.getFilterOptions(filters);
  const unique = (items, keyOf) => {
    const map = new Map();
    items.forEach((item) => { const k = keyOf(item); if (k != null && !map.has(k)) map.set(k, item); });
    return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };
  const buName = new Map(employeeBus.map((b) => [b.id, b]));
  const employeeBuIds = new Set();
  const employeeSubBuIds = new Set();
  rows.forEach((r) => {
    (r.employee_bu_ids || []).forEach((id) => employeeBuIds.add(id));
    (r.employee_sub_bu_ids || []).forEach((id) => employeeSubBuIds.add(id));
  });
  const toBu = (id) => {
    const b = buName.get(id);
    return b ? { id, name: b.company_name, parent_business_unit_id: b.parent_business_unit_id || null } : null;
  };

  return {
    period,
    employees: unique(rows.map((r) => ({ id: r.employee_id, name: r.employee_name, employee_code: r.employee_code })), (e) => e.id),
    clients: unique(rows.map((r) => ({ id: r.client_id, name: r.client_name })), (c) => c.id),
    projects: unique(rows.map((r) => ({ id: r.project_id, name: r.project_name, client_id: r.client_id })), (p) => p.id),
    servicePos: unique(rows.map((r) => ({
      id: r.service_po_id, name: r.service_po_name, code: r.service_po_code, project_id: r.project_id, client_id: r.client_id,
      po_bu_id: r.po_bu_id, po_sub_bu_id: r.po_sub_bu_id, is_centralised: r.is_centralised === true,
    })), (s) => s.id),
    employeeBusinessUnits: [...employeeBuIds].map(toBu).filter((b) => b && !b.parent_business_unit_id).sort((a, b) => a.name.localeCompare(b.name)),
    employeeSubBusinessUnits: [...employeeSubBuIds].map(toBu).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
    poBusinessUnits: unique(rows.map((r) => ({ id: r.po_bu_id, name: r.po_bu })), (b) => b.id),
    poSubBusinessUnits: unique(rows.map((r) => ({ id: r.po_sub_bu_id, name: r.po_sub_bu, parent_business_unit_id: r.po_bu_id })), (b) => b.id),
  };
}

module.exports = { getReport, getExport, getFilterOptions, resolvePeriod, toRecord, toTotals, COLUMNS };
