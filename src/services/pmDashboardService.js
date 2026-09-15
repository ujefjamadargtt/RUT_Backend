'use strict';

const { Op } = require('sequelize');
const { Employee } = require('../models');
const employeeAccessControlService = require('./employeeAccessControlService');
const employeeRepository = require('../repositories/employeeRepository');
const employeeWorkLogComplianceService = require('./employeeWorkLogComplianceService');
const pmDashboardRepository = require('../repositories/pmDashboardRepository');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');

/**
 * Project Manager Dashboard Service
 *
 * Composes EXISTING scope/aggregation logic rather than inventing new
 * access rules — see the PM Dashboard audit (published as an Artifact
 * alongside this branch) §9 for the two conflicting "PM's own team"
 * resolvers already in this codebase before this module existed. This
 * service deliberately uses the SAME resolver Employee Master and the Work
 * Log Compliance report already use
 * (employeeAccessControlService.resolveEmployeeAccessWhere, which walks
 * team_mappings for a Project Manager) — NOT the narrower, direct-
 * manager_employee_mappings-only resolver the My-Team/Approval modules use,
 * which is empty for a normally-configured Project Manager (HR sets an
 * employee's PRIMARY manager to their immediate Team Lead, not the Project
 * Manager two levels up).
 *
 * resolveTeamEmployeeIds() below is copied (not imported) from
 * employeeWorkLogComplianceService.js's own resolveAuthorizedEmployeeIds,
 * per that file's stated rationale: keep each service self-contained rather
 * than create an implicit cross-service coupling that could break if that
 * service is ever refactored.
 *
 * Service PO / Project / Client visibility is scoped by `companyIds` alone
 * (the caller's Business-Unit reach, resolved by resolveReportCompanyScope
 * middleware) — the same BU-wide convention every report in
 * managementReportRepository.js already uses, NOT the stricter
 * "individually-mapped Service POs only" rule servicePOService.getAll()
 * applies to the Service PO Master screen. See pmDashboardRepository.js's
 * doc comment for the full reasoning.
 */

const DEFAULT_VARIANCE_THRESHOLD_PCT = 20;
const DEFAULT_BENCH_THRESHOLD_HOURS = 40;
const ACTION_REQUIRED_CAP = 20;

/**
 * @param {object} query
 * @returns {{ monthNum: number, yearNum: number }}
 */
function resolvePeriod(query) {
  const now = new Date();
  const monthNum = query.month ? parseInt(query.month, 10) : now.getMonth() + 1;
  const yearNum = query.year ? parseInt(query.year, 10) : now.getFullYear();
  if (monthNum < 1 || monthNum > 12) {
    const err = new Error('month must be between 1 and 12.');
    err.statusCode = 422;
    throw err;
  }
  return { monthNum, yearNum };
}

/**
 * Copied from employeeWorkLogComplianceService.resolveAuthorizedEmployeeIds
 * (see that file's own doc comment for why this is copied, not imported).
 *
 * @param {object} authContext - { userId, employeeId, hierarchyRank, roleNames }
 * @param {number[]} companyIds
 * @returns {Promise<number[]>}
 */
async function resolveTeamEmployeeIds(authContext, companyIds) {
  if (!companyIds || companyIds.length === 0) return [];

  const accessScopes = await Promise.all(
    companyIds.map((companyId) =>
      employeeAccessControlService.resolveEmployeeAccessWhere({ ...authContext, companyId })
    )
  );
  const companyScope = await employeeRepository.employeeScope(companyIds);
  const employees = await Employee.findAll({
    where: {
      [Op.and]: [
        { is_deleted: false },
        { [Op.or]: accessScopes },
        companyScope,
      ],
    },
    attributes: ['id'],
    raw: true,
  });
  return employees.map((e) => e.id);
}

function resolveAsOfDate(query) {
  return query.asOfDate ? new Date(query.asOfDate) : new Date();
}

function resolveVarianceThresholdPct(query) {
  return query.varianceThresholdPct !== undefined
    ? parseFloat(query.varianceThresholdPct)
    : DEFAULT_VARIANCE_THRESHOLD_PCT;
}

function computeRiskFlag(row, varianceThresholdPct) {
  const variancePct = row.variance_pct !== null && row.variance_pct !== undefined ? parseFloat(row.variance_pct) : null;
  return row.overdue_po_count > 0 || (variancePct !== null && Math.abs(variancePct) >= varianceThresholdPct);
}

// ---------------------------------------------------------------------------
// GET /pm-dashboard/summary — the KPI row.
// ---------------------------------------------------------------------------
/**
 * @param {object} query
 * @param {object} authContext - { userId, employeeId, hierarchyRank, roleNames }
 * @param {number[]} companyIds
 * @returns {Promise<object>}
 */
async function getSummary(query, authContext, companyIds) {
  const { monthNum, yearNum } = resolvePeriod(query);
  const asOfDate = resolveAsOfDate(query);
  const varianceThresholdPct = resolveVarianceThresholdPct(query);

  const employeeIds = await resolveTeamEmployeeIds(authContext, companyIds);

  const [
    portfolio,
    loggedHours,
    budgetVsBilled,
    atRiskProjectCount,
    complianceReport,
    pendingApprovals,
    teamCapacity,
  ] = await Promise.all([
    pmDashboardRepository.getPortfolioCounts({ companyIds }),
    pmDashboardRepository.getLoggedHoursMTD({ companyIds, monthNum, yearNum }),
    pmDashboardRepository.getBudgetVsBilled({ companyIds, monthNum, yearNum }),
    pmDashboardRepository.getAtRiskProjectCount({
      companyIds, monthNum, yearNum,
      asOfDate: asOfDate.toISOString().slice(0, 10),
      varianceThresholdPct,
    }),
    employeeWorkLogComplianceService.getReport({ month: monthNum, year: yearNum, limit: 1 }, authContext, companyIds),
    pmDashboardRepository.getPendingApprovals({ employeeIds, monthNum, yearNum, limit: 1, offset: 0 }),
    pmDashboardRepository.getTeamCapacity({
      employeeIds, monthNum, yearNum,
      benchThresholdHours: DEFAULT_BENCH_THRESHOLD_HOURS,
      limit: 10000, offset: 0,
    }),
  ]);

  const overallocatedCount = teamCapacity.rows.filter((r) => r.overallocation_flag).length;
  const benchCount = teamCapacity.rows.filter((r) => r.bench_flag).length;

  return {
    period: { month: monthNum, year: yearNum },
    team_size: employeeIds.length,
    active_projects: parseInt(portfolio.active_projects, 10) || 0,
    total_projects: parseInt(portfolio.total_projects, 10) || 0,
    active_service_pos: parseInt(portfolio.active_service_pos, 10) || 0,
    total_service_pos: parseInt(portfolio.total_service_pos, 10) || 0,
    total_clients: parseInt(portfolio.total_clients, 10) || 0,
    logged_hours_mtd: Math.round(loggedHours * 100) / 100,
    budget: {
      invoiced_amount: Math.round(budgetVsBilled.total_invoiced * 100) / 100,
      billed_amount: Math.round(budgetVsBilled.total_billed * 100) / 100,
      variance: Math.round((budgetVsBilled.total_invoiced - budgetVsBilled.total_billed) * 100) / 100,
    },
    at_risk_projects: atRiskProjectCount,
    missing_work_logs: complianceReport.meta.total,
    pending_approvals: pendingApprovals.count,
    overallocated_employees: overallocatedCount,
    bench_employees: benchCount,
  };
}

// ---------------------------------------------------------------------------
// GET /pm-dashboard/projects — the project rollup table.
// ---------------------------------------------------------------------------
/**
 * @param {object} query
 * @param {object} authContext
 * @param {number[]} companyIds
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getProjects(query, authContext, companyIds) {
  const { monthNum, yearNum } = resolvePeriod(query);
  const asOfDate = resolveAsOfDate(query);
  const varianceThresholdPct = resolveVarianceThresholdPct(query);
  const { page, limit, offset } = getPaginationParams(query);

  const { rows, count } = await pmDashboardRepository.getProjectRollup({
    monthNum, yearNum,
    asOfDate: asOfDate.toISOString().slice(0, 10),
    status: query.status || undefined,
    search: query.search || undefined,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit, offset, companyIds,
  });

  const data = rows.map((r) => ({ ...r, risk_flag: computeRiskFlag(r, varianceThresholdPct) }));

  return { data, meta: getPaginationMeta(count, page, limit) };
}

// ---------------------------------------------------------------------------
// GET /pm-dashboard/team — team capacity.
// ---------------------------------------------------------------------------
/**
 * @param {object} query
 * @param {object} authContext
 * @param {number[]} companyIds
 * @returns {Promise<{ data: object[], meta: object }>}
 */
async function getTeam(query, authContext, companyIds) {
  const { monthNum, yearNum } = resolvePeriod(query);
  const { page, limit, offset } = getPaginationParams(query);
  const benchThresholdHours = query.benchThresholdHours !== undefined
    ? parseFloat(query.benchThresholdHours)
    : DEFAULT_BENCH_THRESHOLD_HOURS;

  const employeeIds = await resolveTeamEmployeeIds(authContext, companyIds);
  const { rows, count } = await pmDashboardRepository.getTeamCapacity({
    employeeIds, monthNum, yearNum, benchThresholdHours,
    search: query.search || undefined,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit, offset,
  });

  return { data: rows, meta: getPaginationMeta(count, page, limit) };
}

// ---------------------------------------------------------------------------
// GET /pm-dashboard/worklog — thin wrapper, full reuse of the existing,
// already-correctly-team-scoped Work Log Compliance service (no new logic).
// ---------------------------------------------------------------------------
/**
 * @param {object} query
 * @param {object} authContext
 * @param {number[]} companyIds
 * @returns {Promise<object>}
 */
async function getWorklog(query, authContext, companyIds) {
  return employeeWorkLogComplianceService.getReport(query, authContext, companyIds);
}

// ---------------------------------------------------------------------------
// GET /pm-dashboard/action-required — merged exception feed.
// ---------------------------------------------------------------------------
/**
 * @param {object} query
 * @param {object} authContext
 * @param {number[]} companyIds
 * @returns {Promise<object>}
 */
async function getActionRequired(query, authContext, companyIds) {
  const { monthNum, yearNum } = resolvePeriod(query);
  const asOfDate = resolveAsOfDate(query);
  const varianceThresholdPct = resolveVarianceThresholdPct(query);

  const employeeIds = await resolveTeamEmployeeIds(authContext, companyIds);

  const [complianceReport, pendingApprovals, projectRollup, teamCapacity] = await Promise.all([
    employeeWorkLogComplianceService.getReport({ month: monthNum, year: yearNum, limit: ACTION_REQUIRED_CAP }, authContext, companyIds),
    pmDashboardRepository.getPendingApprovals({ employeeIds, monthNum, yearNum, limit: ACTION_REQUIRED_CAP, offset: 0 }),
    pmDashboardRepository.getProjectRollup({
      monthNum, yearNum,
      asOfDate: asOfDate.toISOString().slice(0, 10),
      limit: 200, offset: 0, companyIds,
    }),
    pmDashboardRepository.getTeamCapacity({
      employeeIds, monthNum, yearNum,
      benchThresholdHours: DEFAULT_BENCH_THRESHOLD_HOURS,
      limit: 10000, offset: 0,
    }),
  ]);

  const atRiskProjects = projectRollup.rows
    .map((r) => ({ ...r, risk_flag: computeRiskFlag(r, varianceThresholdPct) }))
    .filter((r) => r.risk_flag)
    .slice(0, ACTION_REQUIRED_CAP);

  const overallocatedEmployees = teamCapacity.rows.filter((r) => r.overallocation_flag).slice(0, ACTION_REQUIRED_CAP);
  const benchEmployees = teamCapacity.rows.filter((r) => r.bench_flag).slice(0, ACTION_REQUIRED_CAP);

  return {
    period: { month: monthNum, year: yearNum },
    missing_work_logs: complianceReport.data,
    pending_approvals: pendingApprovals.rows,
    at_risk_projects: atRiskProjects,
    overallocated_employees: overallocatedEmployees,
    bench_employees: benchEmployees,
  };
}

module.exports = {
  getSummary,
  getProjects,
  getTeam,
  getWorklog,
  getActionRequired,
  // Exported for testing
  resolvePeriod,
  computeRiskFlag,
  DEFAULT_VARIANCE_THRESHOLD_PCT,
  DEFAULT_BENCH_THRESHOLD_HOURS,
};
