'use strict';

const moment = require('moment-timezone');
const repository = require('../repositories/teamLeadEmployeePoHoursReportRepository');
const { resolveDateRange } = require('./teamLeadEmployeeProjectHoursReportService');
const { parseIdList } = require('../utils/idListParser');
const logger = require('../utils/logger');

/**
 * Team Lead Employee PO Hours Report — Employees (rows) x Service POs (columns).
 *
 * Who is visible: the Employees mapped to the CALLER as Primary/Secondary manager, nothing else.
 * Which POs are columns: every PO any of those Employees is mapped to or has hours on in the period —
 * not restricted by BU (Cross-BU and Centralised POs included), one column per PO even when several
 * Employees share it. See teamLeadEmployeePoHoursReportRepository.js for the data rules.
 */

const HOURS_BASIS = { ORIGINAL: 'original', ADJUSTED: 'adjusted' };
const NO_SYNC_MESSAGE = 'No sync data available for this month for these employees. Please sync to view adjusted hours.';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** month+year or startDate/endDate as sent; the current month when neither was. */
function resolvePeriod(query) {
  const range = resolveDateRange(query);
  if (range.startDate || range.endDate) {
    const fmt = (d) => moment.utc(d).format('YYYY-MM-DD');
    return { startDate: fmt(range.startDate || range.endDate), endDate: fmt(range.endDate || range.startDate) };
  }
  const start = moment().startOf('month');
  return { startDate: start.format('YYYY-MM-DD'), endDate: start.clone().endOf('month').format('YYYY-MM-DD') };
}

function parseFilters(query) {
  return {
    employeeIds: parseIdList(query.employeeIds) || [],
    clientIds: parseIdList(query.clientIds) || [],
    projectIds: parseIdList(query.projectIds) || [],
    servicePoIds: parseIdList(query.servicePoIds) || [],
    entityIds: parseIdList(query.entityIds) || [],
    buIds: parseIdList(query.buIds) || [],
    subBuIds: parseIdList(query.subBuIds) || [],
    search: query.search || undefined,
  };
}

const hasPoLevelFilter = (f) => [f.clientIds, f.projectIds, f.servicePoIds, f.entityIds, f.buIds, f.subBuIds]
  .some((list) => list.length > 0);

/**
 * @param {object} query - validated req.query
 * @param {number} managerEmployeeId - req.employeeId (the authenticated caller, never a query value)
 * @returns {Promise<object>}
 */
async function getReport(query, managerEmployeeId) {
  const basis = query.hoursBasis === HOURS_BASIS.ADJUSTED ? HOURS_BASIS.ADJUSTED : HOURS_BASIS.ORIGINAL;
  const period = resolvePeriod(query);
  const filters = parseFilters(query);
  logger.info('Report: getTeamLeadEmployeePoHours', { managerEmployeeId, ...period, basis });

  const employees = await repository.findMappedEmployees({
    managerEmployeeId, employeeIds: filters.employeeIds, search: filters.search,
  });
  const employeeIds = employees.map((e) => e.employee_id);

  const syncAvailable = basis === HOURS_BASIS.ADJUSTED ? await repository.hasSyncedData(employeeIds, period) : null;
  const adjustedUnavailable = basis === HOURS_BASIS.ADJUSTED && !syncAvailable;

  const [mappedPairs, hourRows] = await Promise.all([
    repository.findMappedPos(employeeIds, filters),
    adjustedUnavailable
      ? Promise.resolve([])
      : (basis === HOURS_BASIS.ADJUSTED ? repository.findAdjustedHours : repository.findOriginalHours)(employeeIds, period, filters),
  ]);

  // employee -> { mapped: Set<poId>, hours: Map<poId, hours> }
  const byEmployee = new Map(employees.map((e) => [e.employee_id, { mapped: new Set(), hours: new Map() }]));
  mappedPairs.forEach((p) => byEmployee.get(p.employee_id)?.mapped.add(p.service_po_id));
  hourRows.forEach((h) => byEmployee.get(h.employee_id)?.hours.set(h.service_po_id, round2(h.hours)));

  // With a PO-level filter an Employee unrelated to every in-scope PO is noise — drop them.
  const visibleEmployees = hasPoLevelFilter(filters)
    ? employees.filter((e) => { const r = byEmployee.get(e.employee_id); return r.mapped.size > 0 || r.hours.size > 0; })
    : employees;

  const poIds = new Set();
  visibleEmployees.forEach((e) => {
    const r = byEmployee.get(e.employee_id);
    r.mapped.forEach((id) => poIds.add(id));
    r.hours.forEach((_h, id) => poIds.add(id));
  });
  const columnRows = await repository.findPoColumns([...poIds]);
  const columns = columnRows.map((c) => ({
    service_po_id: c.service_po_id,
    service_po_code: c.service_po_code,
    service_po_name: c.service_po_name,
    is_centralised: Boolean(c.is_centralised),
    client_id: c.client_id,
    client_name: c.client_name,
    project_id: c.project_id,
    project_name: c.project_name,
    bu_id: c.bu_id,
    bu_name: c.bu_name,
    sub_bu_id: c.sub_bu_id,
    sub_bu_name: c.sub_bu_name,
  }));

  const totalsByPo = {};
  let grandTotal = 0;
  const data = visibleEmployees.map((e) => {
    const r = byEmployee.get(e.employee_id);
    const hours = {};
    let total = 0;
    columns.forEach((c) => {
      const h = r.hours.get(c.service_po_id) || 0;
      hours[c.service_po_id] = h;
      total += h;
      totalsByPo[c.service_po_id] = round2((totalsByPo[c.service_po_id] || 0) + h);
    });
    grandTotal += total;
    return {
      employee_id: e.employee_id,
      employee_code: e.employee_code,
      employee_name: e.full_name,
      mapping_type: e.mapping_type,
      mapped_po_ids: [...r.mapped],
      hours,
      total_hours: round2(total),
    };
  });

  return {
    period: { start_date: period.startDate, end_date: period.endDate },
    hours_basis: basis,
    sync_available: syncAvailable,
    message: adjustedUnavailable ? NO_SYNC_MESSAGE : null,
    columns,
    data,
    totals: { by_po: totalsByPo, grand_total: round2(grandTotal), employee_count: data.length, po_count: columns.length },
  };
}

/**
 * Filter dropdown options. Employees: every mapped Employee. Clients / Projects / Service POs /
 * BUs / Sub-BUs: those of every PO the mapped Employees are mapped to or logged approved hours on in
 * the period — Cross-BU and Centralised included — so a dropdown never offers a PO that can't appear.
 */
async function getFilterOptions(query, managerEmployeeId) {
  const period = resolvePeriod(query);
  const employees = await repository.findMappedEmployees({ managerEmployeeId });
  const employeeIds = employees.map((e) => e.employee_id);
  const [mappedPairs, hourRows] = await Promise.all([
    repository.findMappedPos(employeeIds, {}),
    repository.findOriginalHours(employeeIds, period, {}),
  ]);
  const poIds = [...new Set([...mappedPairs.map((p) => p.service_po_id), ...hourRows.map((h) => h.service_po_id)])];
  const pos = await repository.findPoColumns(poIds);

  const unique = (items, keyOf) => {
    const map = new Map();
    items.forEach((item) => { const k = keyOf(item); if (k != null && !map.has(k)) map.set(k, item); });
    return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };
  return {
    employees: employees.map((e) => ({ id: e.employee_id, employee_code: e.employee_code, full_name: e.full_name, mapping_type: e.mapping_type })),
    clients: unique(pos.map((c) => ({ id: c.client_id, name: c.client_name })), (c) => c.id),
    projects: unique(pos.map((c) => ({ id: c.project_id, name: c.project_name, client_id: c.client_id })), (c) => c.id),
    servicePos: unique(pos.map((c) => ({
      id: c.service_po_id, name: c.service_po_name, code: c.service_po_code, project_id: c.project_id,
      client_id: c.client_id, bu_id: c.bu_id, sub_bu_id: c.sub_bu_id, is_centralised: Boolean(c.is_centralised),
    })), (c) => c.id),
    businessUnits: unique(pos.map((c) => ({ id: c.bu_id, name: c.bu_name })), (c) => c.id),
    subBusinessUnits: unique(pos.map((c) => ({ id: c.sub_bu_id, name: c.sub_bu_name, parent_business_unit_id: c.bu_id })), (c) => c.id),
  };
}

/**
 * Excel export of the same matrix: Employee / Code / Mapping + one column per PO + Total.
 * @returns {Promise<{ rows: object[], columns: object[], period: object, basis: string }>}
 */
async function getExport(query, managerEmployeeId) {
  const report = await getReport(query, managerEmployeeId);
  const columns = [
    { key: 'employee', label: 'Employee', width: 32 },
    { key: 'mapping_type', label: 'Mapping', width: 18 },
    ...report.columns.map((c) => ({
      key: `po_${c.service_po_id}`,
      label: c.service_po_code ? `${c.service_po_name} (${c.service_po_code})` : c.service_po_name,
      width: 20,
      numFmt: '0.00',
    })),
    { key: 'total', label: 'Total', width: 12, numFmt: '0.00' },
  ];
  const rows = report.data.map((r) => {
    const row = {
      employee: r.employee_code ? `${r.employee_name} (${r.employee_code})` : r.employee_name,
      mapping_type: r.mapping_type || '',
      total: r.total_hours,
    };
    report.columns.forEach((c) => { row[`po_${c.service_po_id}`] = r.hours[c.service_po_id] || 0; });
    return row;
  });
  return { rows, columns, period: report.period, basis: report.hours_basis, message: report.message };
}

module.exports = { getReport, getFilterOptions, getExport, resolvePeriod, NO_SYNC_MESSAGE };
