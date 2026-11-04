'use strict';

const tlRepository = require('../repositories/teamLeadEmployeePoHoursReportRepository');
const { resolvePeriod, NO_SYNC_MESSAGE } = require('./teamLeadEmployeePoHoursReportService');
const { parseIdList } = require('../utils/idListParser');

/**
 * Shared matrix builder for the BU Admin / Project Manager "Employee PO Hours" reports. Same response
 * shape as the Team Lead report (employees x Service PO columns) plus:
 *   columns[].is_cross_bu     the PO's BU lies outside the caller's BU scope
 *   data[].employee_bu_names  the employee's active BUs inside the caller's scope
 * Hours / mapped-PO / column lookups are the Team Lead repository's, reused as is.
 */

const HOURS_BASIS = { ORIGINAL: 'original', ADJUSTED: 'adjusted' };
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

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
 * Cross-BU: the PO has a BU, is not Centralised, and neither its BU/Sub-BU nor that Sub-BU's parent is
 * inside the caller's BU scope (companyIds already holds the Sub-BUs of a selected parent BU).
 * `bu_id` is the PO's top-level BU, `sub_bu_id` its Sub-BU (null when the PO sits on a top-level BU).
 */
function isCrossBu(col, scope) {
  if (col.is_centralised) return false;
  const ownCompanyId = col.sub_bu_id != null ? col.sub_bu_id : col.bu_id;
  if (ownCompanyId == null) return false;
  return !scope.has(ownCompanyId) && !(col.bu_id != null && scope.has(col.bu_id));
}

const mapColumn = (c, scope) => ({
  service_po_id: c.service_po_id,
  service_po_code: c.service_po_code,
  service_po_name: c.service_po_name,
  is_centralised: Boolean(c.is_centralised),
  is_cross_bu: isCrossBu(c, scope),
  client_id: c.client_id,
  client_name: c.client_name,
  project_id: c.project_id,
  project_name: c.project_name,
  bu_id: c.bu_id,
  bu_name: c.bu_name,
  sub_bu_id: c.sub_bu_id,
  sub_bu_name: c.sub_bu_name,
});

/**
 * @param {object} query validated req.query
 * @param {object} ctx { employees: [{employee_id, employee_code, full_name, employee_bu_names}],
 *                       companyIds: number[], poRestriction?: number[] (only these POs may be columns/hours) }
 */
async function buildReport(query, { employees, companyIds, poRestriction = null }) {
  const basis = query.hoursBasis === HOURS_BASIS.ADJUSTED ? HOURS_BASIS.ADJUSTED : HOURS_BASIS.ORIGINAL;
  const period = resolvePeriod(query);
  const filters = parseFilters(query);
  const scope = new Set(companyIds || []);

  let restrictedToNothing = false;
  if (poRestriction) {
    const allowed = filters.servicePoIds.length
      ? poRestriction.filter((id) => filters.servicePoIds.includes(id))
      : poRestriction;
    if (allowed.length === 0) restrictedToNothing = true;
    filters.servicePoIds = allowed;
  }

  const employeeIds = employees.map((e) => e.employee_id);
  const syncAvailable = basis === HOURS_BASIS.ADJUSTED ? await tlRepository.hasSyncedData(employeeIds, period) : null;
  const adjustedUnavailable = basis === HOURS_BASIS.ADJUSTED && !syncAvailable;

  const noLookups = restrictedToNothing || employeeIds.length === 0;
  const [mappedPairs, hourRows] = noLookups
    ? [[], []]
    : await Promise.all([
      tlRepository.findMappedPos(employeeIds, filters),
      adjustedUnavailable
        ? Promise.resolve([])
        : (basis === HOURS_BASIS.ADJUSTED ? tlRepository.findAdjustedHours : tlRepository.findOriginalHours)(employeeIds, period, filters),
    ]);

  const byEmployee = new Map(employees.map((e) => [e.employee_id, { mapped: new Set(), hours: new Map() }]));
  mappedPairs.forEach((p) => byEmployee.get(p.employee_id)?.mapped.add(p.service_po_id));
  hourRows.forEach((h) => byEmployee.get(h.employee_id)?.hours.set(h.service_po_id, round2(h.hours)));

  const visibleEmployees = hasPoLevelFilter(filters)
    ? employees.filter((e) => { const r = byEmployee.get(e.employee_id); return r.mapped.size > 0 || r.hours.size > 0; })
    : employees;

  const poIds = new Set();
  visibleEmployees.forEach((e) => {
    const r = byEmployee.get(e.employee_id);
    r.mapped.forEach((id) => poIds.add(id));
    r.hours.forEach((_h, id) => poIds.add(id));
  });
  const columns = (await tlRepository.findPoColumns([...poIds])).map((c) => mapColumn(c, scope));

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
      mapping_type: null,
      employee_bu_names: e.employee_bu_names || [],
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

/** Filter dropdowns from the roster's mapped / worked POs (optionally limited to poRestriction). */
async function buildFilterOptions(query, { employees, companyIds, poRestriction = null }) {
  const period = resolvePeriod(query);
  const scope = new Set(companyIds || []);
  const employeeIds = employees.map((e) => e.employee_id);
  let pos = [];
  const restrictedToNothing = poRestriction && poRestriction.length === 0;
  if (employeeIds.length && !restrictedToNothing) {
    const filters = poRestriction ? { servicePoIds: poRestriction } : {};
    const [mappedPairs, hourRows] = await Promise.all([
      tlRepository.findMappedPos(employeeIds, filters),
      tlRepository.findOriginalHours(employeeIds, period, filters),
    ]);
    const poIds = [...new Set([...mappedPairs.map((p) => p.service_po_id), ...hourRows.map((h) => h.service_po_id)])];
    pos = await tlRepository.findPoColumns(poIds);
  }

  const unique = (items, keyOf) => {
    const map = new Map();
    items.forEach((item) => { const k = keyOf(item); if (k != null && !map.has(k)) map.set(k, item); });
    return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };
  return {
    employees: employees.map((e) => ({
      id: e.employee_id, employee_code: e.employee_code, full_name: e.full_name,
      mapping_type: null, employee_bu_names: e.employee_bu_names || [],
    })),
    clients: unique(pos.map((c) => ({ id: c.client_id, name: c.client_name })), (c) => c.id),
    projects: unique(pos.map((c) => ({ id: c.project_id, name: c.project_name, client_id: c.client_id })), (c) => c.id),
    servicePos: unique(pos.map((c) => ({
      id: c.service_po_id, name: c.service_po_name, code: c.service_po_code, project_id: c.project_id,
      client_id: c.client_id, bu_id: c.bu_id, sub_bu_id: c.sub_bu_id, is_centralised: Boolean(c.is_centralised),
      is_cross_bu: isCrossBu(c, scope),
    })), (c) => c.id),
    businessUnits: unique(pos.map((c) => ({ id: c.bu_id, name: c.bu_name })), (c) => c.id),
    subBusinessUnits: unique(pos.map((c) => ({ id: c.sub_bu_id, name: c.sub_bu_name, parent_business_unit_id: c.bu_id })), (c) => c.id),
  };
}

/** Excel rows: Employee / Business Unit / one column per PO / Total. */
function buildExport(report) {
  const columns = [
    { key: 'employee', label: 'Employee', width: 32 },
    { key: 'business_unit', label: 'Business Unit', width: 24 },
    ...report.columns.map((c) => {
      const base = c.service_po_code ? `${c.service_po_name} (${c.service_po_code})` : c.service_po_name;
      return { key: `po_${c.service_po_id}`, label: c.is_cross_bu ? `${base} [Cross-BU]` : base, width: 20, numFmt: '0.00' };
    }),
    { key: 'total', label: 'Total', width: 12, numFmt: '0.00' },
  ];
  const rows = report.data.map((r) => {
    const row = {
      employee: r.employee_code ? `${r.employee_name} (${r.employee_code})` : r.employee_name,
      business_unit: (r.employee_bu_names || []).join(', '),
      total: r.total_hours,
    };
    report.columns.forEach((c) => { row[`po_${c.service_po_id}`] = r.hours[c.service_po_id] || 0; });
    return row;
  });
  return { rows, columns, period: report.period, basis: report.hours_basis, message: report.message };
}

module.exports = { buildReport, buildFilterOptions, buildExport, isCrossBu, parseFilters };
