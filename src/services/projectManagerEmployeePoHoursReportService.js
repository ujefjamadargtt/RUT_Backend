'use strict';

const scopeRepository = require('../repositories/poHoursEmployeeScopeRepository');
const employeeServicePOMappingRepository = require('../repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const helper = require('./poHoursMatrixHelper');
const { parseIdList } = require('../utils/idListParser');
const { resolvePeriod, NO_SYNC_MESSAGE } = require('./teamLeadEmployeePoHoursReportService');

/**
 * Project Manager Employee PO Hours — Employees (rows) x Service POs (columns).
 * Rows: the same roster every other report loads for a PM (findEmployeeIdsOnProjectManagerPOs): everyone
 * actively mapped to a non-centralised PO the CALLER is flagged PM on. Columns: ONLY the PM's own
 * flagged POs, each with is_cross_bu relative to the caller's BU scope. No rank gate.
 */

async function loadScope(pmEmployeeId) {
  const [flaggedPoIds, rosterIds] = await Promise.all([
    employeeServicePOMappingService.getProjectManagerServicePOIds(pmEmployeeId),
    employeeServicePOMappingRepository.findEmployeeIdsOnProjectManagerPOs(pmEmployeeId),
  ]);
  return { poRestriction: [...new Set(flaggedPoIds)], rosterIds };
}

async function loadEmployees(query, rosterIds, companyIds, narrow = true) {
  return scopeRepository.findActiveEmployeesByIds({
    ids: rosterIds,
    companyIds,
    employeeIds: narrow ? parseIdList(query.employeeIds) || [] : [],
    search: narrow ? query.search || undefined : undefined,
  });
}

async function getReport(query, pmEmployeeId, companyIds) {
  const { poRestriction, rosterIds } = await loadScope(pmEmployeeId);
  const employees = await loadEmployees(query, rosterIds, companyIds);
  return helper.buildReport(query, { employees, companyIds, poRestriction });
}

async function getFilterOptions(query, pmEmployeeId, companyIds) {
  const { poRestriction, rosterIds } = await loadScope(pmEmployeeId);
  const employees = await loadEmployees(query, rosterIds, companyIds, false);
  return helper.buildFilterOptions(query, { employees, companyIds, poRestriction });
}

async function getExport(query, pmEmployeeId, companyIds) {
  return helper.buildExport(await getReport(query, pmEmployeeId, companyIds));
}

module.exports = { getReport, getFilterOptions, getExport, resolvePeriod, NO_SYNC_MESSAGE };
