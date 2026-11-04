'use strict';

const scopeRepository = require('../repositories/poHoursEmployeeScopeRepository');
const helper = require('./poHoursMatrixHelper');
const { parseIdList } = require('../utils/idListParser');
const { resolvePeriod, NO_SYNC_MESSAGE } = require('./teamLeadEmployeePoHoursReportService');

/**
 * BU Admin Employee PO Hours — Employees (rows) x Service POs (columns).
 * Rows: every active employee who is an active member of the caller's BU scope (req.companyIds, which
 * resolveReportCompanyScope already expands to Sub-BUs) — NOT manager mappings. Columns: every PO those
 * employees are mapped to or logged approved hours on, any BU (Cross-BU / Centralised included), each
 * flagged is_cross_bu when its BU is outside the scope. Allowed for hierarchyRank <= 4 only (controller).
 */

async function loadEmployees(query, companyIds, narrow = true) {
  return scopeRepository.findBuScopeEmployees({
    companyIds,
    employeeIds: narrow ? parseIdList(query.employeeIds) || [] : [],
    search: narrow ? query.search || undefined : undefined,
  });
}

async function getReport(query, companyIds) {
  const employees = await loadEmployees(query, companyIds);
  return helper.buildReport(query, { employees, companyIds });
}

async function getFilterOptions(query, companyIds) {
  const employees = await loadEmployees(query, companyIds, false);
  return helper.buildFilterOptions(query, { employees, companyIds });
}

async function getExport(query, companyIds) {
  return helper.buildExport(await getReport(query, companyIds));
}

module.exports = { getReport, getFilterOptions, getExport, resolvePeriod, NO_SYNC_MESSAGE };
