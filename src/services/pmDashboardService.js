'use strict';

const { Op } = require('sequelize');
const { Employee } = require('../models');
const employeeAccessControlService = require('./employeeAccessControlService');
const employeeRepository = require('../repositories/employeeRepository');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const employeeWorkLogComplianceService = require('./employeeWorkLogComplianceService');
const employeeServicePOMappingService = require('./employeeServicePOMappingService');
const pmDashboardRepository = require('../repositories/pmDashboardRepository');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');

// Project Manager (hierarchy_rank 6) — see resolvePendingApprovalScope()
// below. Deliberately does NOT touch resolveTeamEmployeeIds() (team_size,
// Team Capacity, Monthly Hours Trend) — only the approval-specific
// pending_approvals KPI/list is redefined for this tier; every other metric
// on this dashboard keeps its existing, wider team scope unchanged.
const PROJECT_MANAGER_RANK = 6;

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
 * Based on employeeWorkLogComplianceService.resolveAuthorizedEmployeeIds
 * (see that file's own doc comment for why this is copied, not imported),
 * PLUS the caller's direct manager_employee_mappings reports pulled in
 * UNSCOPED by Business Unit.
 *
 * Without that addition, this resolved down to
 * employeeAccessControlService.resolveEmployeeAccessWhere() alone, which
 * intersects every result (including a caller's own direct reports) against
 * `companyIds` — the caller's own BU reach. A Project Manager whose direct
 * reports span more than one BU (a real, confirmed case — see the "Team
 * Size doesn't match My Team" investigation) would then have their
 * cross-BU direct reports silently dropped from every PM Dashboard view
 * (team_size, Team Capacity, Work Log/Approvals, Action Required), while
 * the My Team screen (managerSelfServiceService.getMyEmployees, which calls
 * managerEmployeeMappingRepository.findByManager with no companyId — see
 * that repository's companyScopeOrNull()) shows all of them. Decision: PM
 * Dashboard's "my team" must match My Team's own definition of "my team"
 * exactly — a direct report counts regardless of which BU they sit in.
 *
 * The caller's OWN record is deliberately excluded from the return value —
 * resolveEmployeeAccessWhere() adds it for its other callers (Employee
 * Master/Work Log Compliance, where a PM legitimately needs to see/manage
 * their own row too), but "team_size"/Team Capacity/Action Required are
 * about the PM's REPORTS, not the PM themself.
 *
 * @param {object} authContext - { userId, employeeId, hierarchyRank, roleNames }
 * @param {number[]} companyIds
 * @returns {Promise<number[]>}
 */
async function resolveTeamEmployeeIds(authContext, companyIds) {
  if (!companyIds || companyIds.length === 0) return [];

  const { employeeId } = authContext;
  const employeeIds = new Set();

  if (employeeId) {
    const directReports = await managerEmployeeMappingRepository.findByManager(employeeId);
    directReports.forEach((m) => employeeIds.add(m.employee_id));
  }

  const accessScopes = await Promise.all(
    companyIds.map((companyId) =>
      employeeAccessControlService.resolveEmployeeAccessWhere({ ...authContext, companyId })
    )
  );
  const companyScope = await employeeRepository.employeeScope(companyIds);
  const scopedEmployees = await Employee.findAll({
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
  scopedEmployees.forEach((e) => employeeIds.add(e.id));

  if (employeeId) {
    employeeIds.delete(employeeId);
  }

  return [...employeeIds];
}

/**
 * The scope pmDashboardRepository.getPendingApprovals() should actually use
 * for the "pending_approvals" KPI/list — per the Timesheet Approval
 * redesign, a Project Manager's approval scope is now Service-PO-based
 * (managerSelfServiceService.assertOwnEmployeeForApproval), not the wider
 * team_mappings-aware `employeeIds` this dashboard's OTHER metrics use (see
 * resolveTeamEmployeeIds()'s own doc comment — that resolver is deliberately
 * left untouched). For every other caller reachable here (Admin/Entity
 * Admin/BU Admin/Project Admin — see pmDashboard.routes.js), pending
 * approvals keeps using the existing `employeeIds`, unchanged.
 *
 * @param {object} authContext - { hierarchyRank, employeeId, ... }
 * @param {number[]} employeeIds - this dashboard's own resolveTeamEmployeeIds() result
 * @returns {Promise<{ employeeIds: number[]|null, servicePoIds: number[]|null }>}
 */
async function resolvePendingApprovalScope(authContext, employeeIds) {
  if (authContext.hierarchyRank === PROJECT_MANAGER_RANK) {
    const servicePoIds = await employeeServicePOMappingService.getProjectManagerServicePOIds(authContext.employeeId);
    return { employeeIds: null, servicePoIds };
  }
  return { employeeIds, servicePoIds: null };
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

/**
 * The previous calendar month/year relative to (monthNum, yearNum), plus an
 * `asOfDate` for that period — the LAST calendar day of it — for re-running
 * the at-risk/overdue calculation as it would have read at that point in
 * time (see getSummary()'s doc comment on why `asOfDate` is shifted, not
 * just monthNum/yearNum).
 *
 * @param {number} monthNum
 * @param {number} yearNum
 * @returns {{ prevMonthNum: number, prevYearNum: number, prevAsOfDate: Date }}
 */
function resolvePreviousPeriod(monthNum, yearNum) {
  const prevMonthNum = monthNum === 1 ? 12 : monthNum - 1;
  const prevYearNum = monthNum === 1 ? yearNum - 1 : yearNum;
  // Date(year, month, 0) — "day 0" of prevMonthNum+1 — is the last calendar
  // day of prevMonthNum. prevMonthNum here is already 1-indexed, so passing
  // it straight as the Date constructor's (0-indexed) month arg lands on
  // the following month, and day 0 rolls back to the day before it.
  const prevAsOfDate = new Date(prevYearNum, prevMonthNum, 0);
  return { prevMonthNum, prevYearNum, prevAsOfDate };
}

/**
 * Tally a full (unpaginated) getProjectRollup() result into portfolio-wide
 * counts per PROJECT_HEALTH_STATUSES bucket — the Projects by Status donut/
 * pie chart. Always returns all 4 buckets, zero-filled, so the chart has a
 * stable shape even for an empty portfolio.
 *
 * @param {object[]} rows - pmDashboardRepository.getProjectRollup()'s rows,
 *   each carrying a `health_status` column
 * @returns {{status: string, count: number}[]}
 */
function tallyProjectStatusBreakdown(rows) {
  const counts = new Map(pmDashboardRepository.PROJECT_HEALTH_STATUSES.map((s) => [s, 0]));
  rows.forEach((r) => {
    const key = pmDashboardRepository.PROJECT_HEALTH_STATUSES.includes(r.health_status) ? r.health_status : 'on_track';
    counts.set(key, counts.get(key) + 1);
  });
  return pmDashboardRepository.PROJECT_HEALTH_STATUSES.map((status) => ({ status, count: counts.get(status) }));
}

function sumHealthBuckets(breakdown, statuses) {
  return breakdown
    .filter((b) => statuses.includes(b.status))
    .reduce((sum, b) => sum + b.count, 0);
}

// ---------------------------------------------------------------------------
// GET /pm-dashboard/summary — the KPI row.
// ---------------------------------------------------------------------------
const AT_RISK_HEALTH_STATUSES = ['at_risk', 'delayed'];

/**
 * Fields on the `previous` sibling object that CANNOT be reliably computed
 * for a past period — both are current-state snapshots in this schema, not
 * periodized data:
 *   - team_size: derived from manager_employee_mappings/team_mappings, which
 *     carry no effective-dated history — only "who reports to whom RIGHT
 *     NOW." There is no way to ask "who was on this PM's team last month."
 *   - active_projects: projects.status is a plain current-state column with
 *     no change history exposed to this module (an AuditLog table exists,
 *     but reconstructing historical status from it is a materially bigger
 *     change than this endpoint's scope).
 * Returned as `null` rather than a fabricated or always-unchanged number —
 * see the PM Dashboard audit's "if a metric can't be reliably calculated,
 * say so explicitly" principle.
 */
const PREVIOUS_PERIOD_UNAVAILABLE_FIELDS = ['team_size', 'active_projects'];

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
  const { prevMonthNum, prevYearNum, prevAsOfDate } = resolvePreviousPeriod(monthNum, yearNum);

  const employeeIds = await resolveTeamEmployeeIds(authContext, companyIds);
  const pendingApprovalScope = await resolvePendingApprovalScope(authContext, employeeIds);

  const [
    portfolio,
    loggedHours,
    budgetVsBilled,
    projectRollupAll,
    complianceReport,
    pendingApprovals,
    teamCapacity,
    prevLoggedHours,
    prevBudgetVsBilled,
    prevProjectRollupAll,
    prevComplianceReport,
    prevPendingApprovals,
    prevTeamCapacity,
  ] = await Promise.all([
    pmDashboardRepository.getPortfolioCounts({ companyIds }),
    pmDashboardRepository.getLoggedHoursMTD({ companyIds, monthNum, yearNum }),
    pmDashboardRepository.getBudgetVsBilled({ companyIds, monthNum, yearNum }),
    // Unpaginated — the full portfolio, not one page — this is both the
    // source for project_status_breakdown AND (summed) for at_risk_projects,
    // so the two numbers can never silently disagree on screen.
    pmDashboardRepository.getProjectRollup({
      monthNum, yearNum,
      asOfDate: asOfDate.toISOString().slice(0, 10),
      varianceThresholdPct,
      limit: 100000, offset: 0, companyIds,
    }),
    employeeWorkLogComplianceService.getReport({ month: monthNum, year: yearNum, limit: 1 }, authContext, companyIds),
    pmDashboardRepository.getPendingApprovals({ ...pendingApprovalScope, monthNum, yearNum, limit: 1, offset: 0 }),
    pmDashboardRepository.getTeamCapacity({
      employeeIds, monthNum, yearNum,
      benchThresholdHours: DEFAULT_BENCH_THRESHOLD_HOURS,
      limit: 10000, offset: 0,
    }),
    // --- Previous period, for the KPI trend deltas ---
    pmDashboardRepository.getLoggedHoursMTD({ companyIds, monthNum: prevMonthNum, yearNum: prevYearNum }),
    pmDashboardRepository.getBudgetVsBilled({ companyIds, monthNum: prevMonthNum, yearNum: prevYearNum }),
    pmDashboardRepository.getProjectRollup({
      monthNum: prevMonthNum, yearNum: prevYearNum,
      asOfDate: prevAsOfDate.toISOString().slice(0, 10),
      varianceThresholdPct,
      limit: 100000, offset: 0, companyIds,
    }),
    employeeWorkLogComplianceService.getReport({ month: prevMonthNum, year: prevYearNum, limit: 1 }, authContext, companyIds),
    // Same current pendingApprovalScope (team/PO roster has no history — see
    // PREVIOUS_PERIOD_UNAVAILABLE_FIELDS above) against the previous
    // period's pending/capacity data — "how did THIS scope's numbers look
    // last month," not "who was on the team/which POs were mapped last month."
    pmDashboardRepository.getPendingApprovals({ ...pendingApprovalScope, monthNum: prevMonthNum, yearNum: prevYearNum, limit: 1, offset: 0 }),
    pmDashboardRepository.getTeamCapacity({
      employeeIds, monthNum: prevMonthNum, yearNum: prevYearNum,
      benchThresholdHours: DEFAULT_BENCH_THRESHOLD_HOURS,
      limit: 10000, offset: 0,
    }),
  ]);

  const overallocatedCount = teamCapacity.rows.filter((r) => r.overallocation_flag).length;
  const benchCount = teamCapacity.rows.filter((r) => r.bench_flag).length;
  const prevOverallocatedCount = prevTeamCapacity.rows.filter((r) => r.overallocation_flag).length;
  const prevBenchCount = prevTeamCapacity.rows.filter((r) => r.bench_flag).length;

  const projectStatusBreakdown = tallyProjectStatusBreakdown(projectRollupAll.rows);
  const atRiskProjectCount = sumHealthBuckets(projectStatusBreakdown, AT_RISK_HEALTH_STATUSES);
  const prevProjectStatusBreakdown = tallyProjectStatusBreakdown(prevProjectRollupAll.rows);
  const prevAtRiskProjectCount = sumHealthBuckets(prevProjectStatusBreakdown, AT_RISK_HEALTH_STATUSES);

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
    // Portfolio-wide (not paginated) — see tallyProjectStatusBreakdown()'s
    // doc comment. Always all 4 PROJECT_HEALTH_STATUSES buckets, zero-filled.
    project_status_breakdown: projectStatusBreakdown,
    // Sibling object mirroring the periodized fields above, for the
    // frontend to compute its own delta/direction ("+2 vs last month").
    // team_size/active_projects are `null` — see
    // PREVIOUS_PERIOD_UNAVAILABLE_FIELDS's doc comment for why.
    previous: {
      period: { month: prevMonthNum, year: prevYearNum },
      team_size: null,
      active_projects: null,
      logged_hours_mtd: Math.round(prevLoggedHours * 100) / 100,
      budget: {
        invoiced_amount: Math.round(prevBudgetVsBilled.total_invoiced * 100) / 100,
        billed_amount: Math.round(prevBudgetVsBilled.total_billed * 100) / 100,
        variance: Math.round((prevBudgetVsBilled.total_invoiced - prevBudgetVsBilled.total_billed) * 100) / 100,
      },
      at_risk_projects: prevAtRiskProjectCount,
      missing_work_logs: prevComplianceReport.meta.total,
      pending_approvals: prevPendingApprovals.count,
      overallocated_employees: prevOverallocatedCount,
      bench_employees: prevBenchCount,
    },
    previous_period_unavailable_fields: PREVIOUS_PERIOD_UNAVAILABLE_FIELDS,
    previous_period_note: 'team_size and active_projects reflect current state only — this schema has no effective-dated history for team roster membership or Project status changes, so a reliable "as of last period" value cannot be computed for either field.',
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
    healthStatus: query.healthStatus || undefined,
    varianceThresholdPct,
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
  const pendingApprovalScope = await resolvePendingApprovalScope(authContext, employeeIds);

  const [complianceReport, pendingApprovals, projectRollup, teamCapacity] = await Promise.all([
    employeeWorkLogComplianceService.getReport({ month: monthNum, year: yearNum, limit: ACTION_REQUIRED_CAP }, authContext, companyIds),
    pmDashboardRepository.getPendingApprovals({ ...pendingApprovalScope, monthNum, yearNum, limit: ACTION_REQUIRED_CAP, offset: 0 }),
    pmDashboardRepository.getProjectRollup({
      monthNum, yearNum,
      asOfDate: asOfDate.toISOString().slice(0, 10),
      varianceThresholdPct,
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

// ---------------------------------------------------------------------------
// GET /pm-dashboard/monthly-hours-trend — Logged vs Required hours, by
// month, for a whole calendar year.
// ---------------------------------------------------------------------------
/**
 * "Required hours" per month is a FLAT figure — this team's current
 * headcount (employeeIds.length) x
 * employeeWorkLogComplianceService.MONTH_THRESHOLD (160h/employee/month,
 * the exact same threshold the Work Log Compliance widget already uses on
 * this dashboard) — applied identically to every month in the year. It is
 * NOT derived from a per-month historical headcount: as with
 * getSummary()'s `previous.team_size`, this schema has no effective-dated
 * roster history, so "how many people were on this team in March" can't be
 * reliably answered. If team composition changed materially during the
 * year, earlier months' required_hours will not reflect who was actually
 * on the team then — flagged here and in the route's own swagger doc.
 *
 * BU narrowing uses the SAME mechanism as every other endpoint in this
 * module — the `company_id` query param / `X-Company-Id` header, or the
 * multi-select `businessUnitIds` (+ `buId=all`) — all resolved into
 * `companyIds` by pmDashboardController.resolvePMDashboardCompanyIds()
 * before this function ever runs.
 *
 * @param {object} query - { year }
 * @param {object} authContext
 * @param {number[]} companyIds
 * @returns {Promise<object>}
 */
async function getMonthlyHoursTrend(query, authContext, companyIds) {
  const yearNum = query.year ? parseInt(query.year, 10) : new Date().getFullYear();

  const employeeIds = await resolveTeamEmployeeIds(authContext, companyIds);
  const rows = await pmDashboardRepository.getMonthlyHoursByEmployee({ employeeIds, yearNum });
  const loggedByMonth = new Map(rows.map((r) => [r.month, parseFloat(r.logged_hours) || 0]));

  const requiredHoursPerMonth = employeeIds.length * employeeWorkLogComplianceService.MONTH_THRESHOLD;

  const trend = [];
  for (let month = 1; month <= 12; month += 1) {
    trend.push({
      month,
      year: yearNum,
      logged_hours: Math.round((loggedByMonth.get(month) || 0) * 100) / 100,
      required_hours: requiredHoursPerMonth,
    });
  }

  return {
    year: yearNum,
    team_size: employeeIds.length,
    required_hours_per_employee_per_month: employeeWorkLogComplianceService.MONTH_THRESHOLD,
    required_hours_note: 'required_hours = current team headcount x required hours/employee/month, applied flat across every month shown — this schema has no historical team-roster data, so it does not reflect headcount changes that happened during the year.',
    trend,
  };
}

module.exports = {
  getSummary,
  getProjects,
  getTeam,
  getWorklog,
  getActionRequired,
  getMonthlyHoursTrend,
  // Exported for testing
  resolvePendingApprovalScope,
  resolvePeriod,
  resolvePreviousPeriod,
  computeRiskFlag,
  tallyProjectStatusBreakdown,
  sumHealthBuckets,
  DEFAULT_VARIANCE_THRESHOLD_PCT,
  DEFAULT_BENCH_THRESHOLD_HOURS,
  AT_RISK_HEALTH_STATUSES,
  PREVIOUS_PERIOD_UNAVAILABLE_FIELDS,
};
