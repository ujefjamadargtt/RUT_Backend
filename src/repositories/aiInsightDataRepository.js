'use strict';

const moment = require('moment-timezone');
const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * AI Insight Data Repository
 *
 * One collector function per insight job. Every function queries the
 * existing schema directly (via sequelize.query, same convention as
 * dashboardRepository.js) and returns a small, already-aggregated plain
 * object — never a raw table dump. This is the ONLY data Claude ever sees
 * for a given job (see utils/promptBuilder.js), so every collector is
 * responsible for keeping its output to business summaries: counts, top-N
 * lists, percentages — not full record sets.
 *
 * Bench / no-work detection reuses the same convention established in
 * dashboardRepository.js: an exact, case-insensitive match on the Service PO
 * name ("Idle" / "On Bench"), not a service type.
 */

const BENCH_PO_NAMES = ['idle', 'on bench'];
const DATE_FMT = 'YYYY-MM-DD';

// ── shared helpers ──────────────────────────────────────────────────────────

/**
 * Sole Contributor Risk rows for an arbitrary date window: every
 * in-progress Service PO where one employee logged >= 90% of the hours,
 * with at least 20 total hours in the window (filters out negligible/new
 * engagements that would otherwise look artificially "risky").
 * Shared by getSoleContributorRiskData() and getWeeklyResourceDigestData()
 * (as a simple count) so the >=90% rule is defined in exactly one place.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<object[]>} [{ service_po_id, service_po_name, client_name, employee_id, full_name, emp_hours, po_total_hours, contribution_pct }]
 */
async function getSoleContributorRiskRows(startDate, endDate, companyId) {
  const rows = await sequelize.query(
    `SELECT
       sp.id AS service_po_id,
       sp.service_po_name,
       c.client_name,
       t.employee_id,
       e.full_name,
       SUM(t.hours_logged) AS emp_hours,
       SUM(SUM(t.hours_logged)) OVER (PARTITION BY sp.id) AS po_total_hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id AND sp.status = 'in-progress' AND sp.is_deleted = false
     INNER JOIN clients c      ON c.id = sp.client_id
     INNER JOIN employees e    ON e.id = t.employee_id
     WHERE t.timesheet_date BETWEEN :startDate AND :endDate
       AND t.company_id = :companyId
     GROUP BY sp.id, sp.service_po_name, c.client_name, t.employee_id, e.full_name`,
    { replacements: { startDate, endDate, companyId }, type: QueryTypes.SELECT }
  );

  const byPo = new Map();
  for (const row of rows) {
    if (!byPo.has(row.service_po_id) || parseFloat(row.emp_hours) > parseFloat(byPo.get(row.service_po_id).emp_hours)) {
      byPo.set(row.service_po_id, row);
    }
  }

  return Array.from(byPo.values())
    .map((row) => ({
      service_po_id: row.service_po_id,
      service_po_name: row.service_po_name,
      client_name: row.client_name,
      employee_id: row.employee_id,
      full_name: row.full_name,
      emp_hours: parseFloat(row.emp_hours),
      po_total_hours: parseFloat(row.po_total_hours),
      contribution_pct: Math.round((parseFloat(row.emp_hours) / parseFloat(row.po_total_hours)) * 10000) / 100,
    }))
    .filter((row) => row.po_total_hours >= 20 && row.contribution_pct >= 90)
    .sort((a, b) => b.contribution_pct - a.contribution_pct);
}

/**
 * Bench % per active employee over a trailing window — hours logged
 * against a PO named "Idle"/"On Bench" as a share of all hours logged.
 * Only includes employees who logged at least 1 hour in the window (zero
 * activity entirely is a Timesheet Compliance concern, not bench).
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<object[]>} [{ employee_id, full_name, designation, total_hours, bench_hours, bench_pct }]
 */
async function getBenchPctRows(startDate, endDate, companyId) {
  const rows = await sequelize.query(
    `SELECT
       e.id AS employee_id,
       e.full_name,
       e.designation,
       SUM(t.hours_logged) AS total_hours,
       SUM(CASE WHEN LOWER(sp.service_po_name) IN (:benchNames) THEN t.hours_logged ELSE 0 END) AS bench_hours
     FROM timesheets t
     INNER JOIN employees e   ON e.id = t.employee_id AND e.is_deleted = false AND e.status = 'active'
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE t.timesheet_date BETWEEN :startDate AND :endDate
       AND t.company_id = :companyId
     GROUP BY e.id, e.full_name, e.designation
     HAVING SUM(t.hours_logged) > 0`,
    { replacements: { startDate, endDate, benchNames: BENCH_PO_NAMES, companyId }, type: QueryTypes.SELECT }
  );

  return rows.map((row) => {
    const totalHours = parseFloat(row.total_hours);
    const benchHours = parseFloat(row.bench_hours);
    return {
      employee_id: row.employee_id,
      full_name: row.full_name,
      designation: row.designation,
      total_hours: totalHours,
      bench_hours: benchHours,
      bench_pct: totalHours > 0 ? Math.round((benchHours / totalHours) * 10000) / 100 : 0,
    };
  });
}

/**
 * Active Service POs currently understaffed (fewer than 3 assigned
 * employees) — used as allocation candidates for Bench Escalation and PO
 * Ending Alerts.
 *
 * @param {number} [limit=10]
 * @returns {Promise<object[]>} [{ service_po_id, service_po_name, client_name, assigned_count }]
 */
async function getUnderstaffedActivePOs(limit = 10, companyId) {
  return sequelize.query(
    `SELECT
       sp.id AS service_po_id,
       sp.service_po_name,
       c.client_name,
       COUNT(spr.employee_id) AS assigned_count
     FROM service_pos sp
     INNER JOIN clients c ON c.id = sp.client_id
     LEFT JOIN service_po_resources spr ON spr.service_po_id = sp.id
     WHERE sp.status = 'in-progress' AND sp.is_deleted = false
       AND sp.company_id = :companyId
     GROUP BY sp.id, sp.service_po_name, c.client_name
     HAVING COUNT(spr.employee_id) < 3
     ORDER BY assigned_count ASC
     LIMIT :limit`,
    { replacements: { limit, companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Total hours / billable hours / cost for a date window (single row).
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<{ total_hours: number, billable_hours: number, total_cost: number }>}
 */
async function getUtilizationAndCostSummary(startDate, endDate, companyId) {
  const [row] = await sequelize.query(
    `SELECT
       COALESCE(SUM(t.hours_logged), 0) AS total_hours,
       COALESCE(SUM(CASE WHEN sp.is_billable THEN t.hours_logged END), 0) AS billable_hours,
       COALESCE(SUM(t.hours_logged * COALESCE(mc.total_cost, 0) / 176.0), 0) AS total_cost,
       COUNT(DISTINCT t.employee_id) AS active_employee_count
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     LEFT JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')
     WHERE t.timesheet_date BETWEEN :startDate AND :endDate
       AND t.company_id = :companyId`,
    { replacements: { startDate, endDate, companyId }, type: QueryTypes.SELECT }
  );

  const totalHours = parseFloat(row.total_hours);
  const billableHours = parseFloat(row.billable_hours);
  return {
    total_hours: Math.round(totalHours * 100) / 100,
    billable_hours: Math.round(billableHours * 100) / 100,
    utilization_pct: totalHours > 0 ? Math.round((billableHours / totalHours) * 10000) / 100 : 0,
    total_cost: Math.round(parseFloat(row.total_cost) * 100) / 100,
    active_employee_count: parseInt(row.active_employee_count, 10) || 0,
  };
}

/**
 * Total cost per client for a date window, sorted descending, capped to
 * the top N clients.
 * @param {string} startDate
 * @param {string} endDate
 * @param {number} [limit=5]
 * @returns {Promise<object[]>} [{ client_id, client_name, cost, hours }]
 */
async function getTopClientsByCostForPeriod(startDate, endDate, limit = 5, companyId) {
  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(SUM(t.hours_logged * COALESCE(mc.total_cost, 0) / 176.0)::NUMERIC, 2) AS cost,
       ROUND(SUM(t.hours_logged)::NUMERIC, 2) AS hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     INNER JOIN clients c      ON c.id  = sp.client_id
     LEFT JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')
     WHERE t.timesheet_date BETWEEN :startDate AND :endDate
       AND t.company_id = :companyId
     GROUP BY c.id, c.client_name
     ORDER BY cost DESC
     LIMIT :limit`,
    { replacements: { startDate, endDate, limit, companyId }, type: QueryTypes.SELECT }
  );
}

// ── 1. Weekly Resource Digest ───────────────────────────────────────────────

/**
 * Summary for the fiscal Mon-Sun week immediately before the run date.
 * @returns {Promise<object>}
 */
async function getWeeklyResourceDigestData(companyId) {
  const weekEnd = moment().subtract(1, 'week').endOf('isoWeek');
  const weekStart = weekEnd.clone().startOf('isoWeek');
  const startDate = weekStart.format(DATE_FMT);
  const endDate = weekEnd.format(DATE_FMT);

  const [utilization, benchRows, soleContributorRows, topClients, completedPos] = await Promise.all([
    getUtilizationAndCostSummary(startDate, endDate, companyId),
    getBenchPctRows(startDate, endDate, companyId),
    getSoleContributorRiskRows(startDate, endDate, companyId),
    getTopClientsByCostForPeriod(startDate, endDate, 5, companyId),
    sequelize.query(
      `SELECT COUNT(*) AS count FROM service_pos
       WHERE status IN ('completed', 'closed') AND updated_at::date BETWEEN :startDate AND :endDate
         AND company_id = :companyId`,
      { replacements: { startDate, endDate, companyId }, type: QueryTypes.SELECT }
    ),
  ]);

  return {
    period: { start: startDate, end: endDate },
    total_hours: utilization.total_hours,
    billable_hours: utilization.billable_hours,
    utilization_pct: utilization.utilization_pct,
    active_employee_count: utilization.active_employee_count,
    employees_on_bench_75plus: benchRows.filter((r) => r.bench_pct >= 75).length,
    sole_contributor_risk_count: soleContributorRows.length,
    completed_pos_count: parseInt(completedPos[0].count, 10) || 0,
    top_clients_by_cost: topClients.map((c) => ({ client_name: c.client_name, hours: parseFloat(c.hours), cost: parseFloat(c.cost) })),
  };
}

// ── 2. PO Ending Alerts ─────────────────────────────────────────────────────

/**
 * Service POs ending within 7/15/30 days, bucketed, plus the employees who
 * would become fully free (every one of their active PO assignments ends
 * within the alert window) and a short list of understaffed active POs to
 * suggest reallocating them to.
 * @returns {Promise<object>}
 */
async function getPoEndingAlertsData(companyId) {
  const today = moment().format(DATE_FMT);
  const in30 = moment().add(30, 'days').format(DATE_FMT);

  const endingPos = await sequelize.query(
    `SELECT sp.id AS service_po_id, sp.service_po_name, c.client_name, sp.end_date,
            (sp.end_date - CURRENT_DATE) AS days_remaining
     FROM service_pos sp
     INNER JOIN clients c ON c.id = sp.client_id
     WHERE sp.status = 'in-progress' AND sp.is_deleted = false
       AND sp.end_date BETWEEN :today AND :in30
       AND sp.company_id = :companyId
     ORDER BY sp.end_date`,
    { replacements: { today, in30, companyId }, type: QueryTypes.SELECT }
  );

  const bucket = (days) => (n) => n <= days;
  const toWindow = (rows) => rows.map((r) => ({
    service_po_id: r.service_po_id,
    service_po_name: r.service_po_name,
    client_name: r.client_name,
    end_date: r.end_date,
    days_remaining: parseInt(r.days_remaining, 10),
  }));

  const windows = {
    within_7_days: toWindow(endingPos.filter((r) => bucket(7)(parseInt(r.days_remaining, 10)))),
    within_15_days: toWindow(endingPos.filter((r) => bucket(15)(parseInt(r.days_remaining, 10)))),
    within_30_days: toWindow(endingPos.filter((r) => bucket(30)(parseInt(r.days_remaining, 10)))),
  };

  let employeesBecomingFree = [];
  if (endingPos.length > 0) {
    const endingPoIds = endingPos.map((r) => r.service_po_id);

    const [assignments, endingAssignees] = await Promise.all([
      sequelize.query(
        `SELECT spr.employee_id, spr.service_po_id
         FROM service_po_resources spr
         INNER JOIN service_pos sp ON sp.id = spr.service_po_id
         WHERE sp.status = 'in-progress' AND sp.is_deleted = false
           AND sp.company_id = :companyId`,
        { replacements: { companyId }, type: QueryTypes.SELECT }
      ),
      sequelize.query(
        `SELECT DISTINCT spr.employee_id, e.full_name, e.designation
         FROM service_po_resources spr
         INNER JOIN employees e ON e.id = spr.employee_id AND e.is_deleted = false AND e.status = 'active'
         WHERE spr.service_po_id IN (:endingPoIds)`,
        { replacements: { endingPoIds }, type: QueryTypes.SELECT }
      ),
    ]);

    const activePosByEmployee = new Map();
    for (const row of assignments) {
      if (!activePosByEmployee.has(row.employee_id)) activePosByEmployee.set(row.employee_id, new Set());
      activePosByEmployee.get(row.employee_id).add(row.service_po_id);
    }

    const endingPoIdSet = new Set(endingPoIds);
    employeesBecomingFree = endingAssignees
      .filter((emp) => {
        const activePos = activePosByEmployee.get(emp.employee_id) || new Set();
        return Array.from(activePos).every((poId) => endingPoIdSet.has(poId));
      })
      .map((emp) => ({ employee_id: emp.employee_id, full_name: emp.full_name, designation: emp.designation }));
  }

  const candidateOpenProjects = await getUnderstaffedActivePOs(10, companyId);

  return {
    generated_for_date: today,
    windows,
    employees_becoming_free: employeesBecomingFree,
    candidate_open_projects: candidateOpenProjects.map((p) => ({
      service_po_id: p.service_po_id,
      service_po_name: p.service_po_name,
      client_name: p.client_name,
      assigned_count: parseInt(p.assigned_count, 10),
    })),
  };
}

// ── 3. Bench Escalation ─────────────────────────────────────────────────────

/**
 * Employees with bench % >= 75 over the trailing 30 days, with their most
 * recent non-bench project as context and a short list of understaffed
 * active POs as allocation candidates.
 * @returns {Promise<object>}
 */
async function getBenchEscalationData(companyId) {
  const endDate = moment().format(DATE_FMT);
  const startDate = moment().subtract(30, 'days').format(DATE_FMT);

  const benchRows = (await getBenchPctRows(startDate, endDate, companyId)).filter((r) => r.bench_pct >= 75);

  let lastProjectByEmployee = new Map();
  if (benchRows.length > 0) {
    const employeeIds = benchRows.map((r) => r.employee_id);
    const lastProjectRows = await sequelize.query(
      `SELECT DISTINCT ON (t.employee_id) t.employee_id, sp.service_po_name, t.timesheet_date
       FROM timesheets t
       INNER JOIN service_pos sp ON sp.id = t.service_po_id
       WHERE t.employee_id IN (:employeeIds) AND LOWER(sp.service_po_name) NOT IN (:benchNames)
         AND t.company_id = :companyId
       ORDER BY t.employee_id, t.timesheet_date DESC`,
      { replacements: { employeeIds, benchNames: BENCH_PO_NAMES, companyId }, type: QueryTypes.SELECT }
    );
    lastProjectByEmployee = new Map(lastProjectRows.map((r) => [r.employee_id, r]));
  }

  const candidateOpenProjects = await getUnderstaffedActivePOs(10, companyId);

  return {
    as_of_date: endDate,
    window_days: 30,
    employees_on_bench: benchRows
      .sort((a, b) => b.bench_pct - a.bench_pct)
      .map((r) => {
        const lastProject = lastProjectByEmployee.get(r.employee_id);
        return {
          employee_id: r.employee_id,
          full_name: r.full_name,
          designation: r.designation,
          bench_pct: r.bench_pct,
          bench_hours: r.bench_hours,
          total_hours: r.total_hours,
          last_active_project: lastProject ? lastProject.service_po_name : null,
          last_active_date: lastProject ? lastProject.timesheet_date : null,
        };
      }),
    candidate_open_projects: candidateOpenProjects.map((p) => ({
      service_po_id: p.service_po_id,
      service_po_name: p.service_po_name,
      client_name: p.client_name,
      assigned_count: parseInt(p.assigned_count, 10),
    })),
  };
}

// ── 4. Sole Contributor Risk ────────────────────────────────────────────────

/**
 * In-progress Service POs where a single employee logged >= 90% of hours
 * over the trailing 90 days.
 * @returns {Promise<object>}
 */
async function getSoleContributorRiskData(companyId) {
  const endDate = moment().format(DATE_FMT);
  const startDate = moment().subtract(90, 'days').format(DATE_FMT);

  const rows = await getSoleContributorRiskRows(startDate, endDate, companyId);

  return {
    window: { start: startDate, end: endDate },
    at_risk_projects: rows.map((r) => ({
      service_po_id: r.service_po_id,
      service_po_name: r.service_po_name,
      client_name: r.client_name,
      dominant_employee: { employee_id: r.employee_id, full_name: r.full_name },
      contribution_pct: r.contribution_pct,
      total_hours: r.po_total_hours,
    })),
  };
}


// ── 6. Monthly Cost Commentary ──────────────────────────────────────────────

/**
 * Total cost for the just-ended calendar month vs the month before it, plus
 * the top 5 cost-driving clients for the just-ended month.
 * @returns {Promise<object>}
 */
async function getMonthlyCostCommentaryData(companyId) {
  const currentMonth = moment().subtract(1, 'month');
  const previousMonth = currentMonth.clone().subtract(1, 'month');

  const currentStart = currentMonth.clone().startOf('month').format(DATE_FMT);
  const currentEnd = currentMonth.clone().endOf('month').format(DATE_FMT);
  const previousStart = previousMonth.clone().startOf('month').format(DATE_FMT);
  const previousEnd = previousMonth.clone().endOf('month').format(DATE_FMT);

  const [currentSummary, previousSummary, topClients] = await Promise.all([
    getUtilizationAndCostSummary(currentStart, currentEnd, companyId),
    getUtilizationAndCostSummary(previousStart, previousEnd, companyId),
    getTopClientsByCostForPeriod(currentStart, currentEnd, 5, companyId),
  ]);

  const changePct = previousSummary.total_cost > 0
    ? Math.round(((currentSummary.total_cost - previousSummary.total_cost) / previousSummary.total_cost) * 10000) / 100
    : 0;

  return {
    current_month: currentMonth.format('MMM-YY'),
    previous_month: previousMonth.format('MMM-YY'),
    current_total_cost: currentSummary.total_cost,
    previous_total_cost: previousSummary.total_cost,
    change_pct: changePct,
    current_headcount: currentSummary.active_employee_count,
    previous_headcount: previousSummary.active_employee_count,
    top_cost_driving_clients: topClients.map((c) => ({ client_name: c.client_name, cost: parseFloat(c.cost) })),
  };
}

// ── 7. Client Concentration ─────────────────────────────────────────────────

/**
 * Top clients by cost over the trailing 90 days, each client's share of
 * total cost, and the trend vs the prior 90-day window.
 * @returns {Promise<object>}
 */
async function getClientConcentrationData(companyId) {
  const currentEnd = moment().format(DATE_FMT);
  const currentStart = moment().subtract(90, 'days').format(DATE_FMT);
  const previousEnd = moment().subtract(91, 'days').format(DATE_FMT);
  const previousStart = moment().subtract(180, 'days').format(DATE_FMT);

  const [currentClients, previousClients] = await Promise.all([
    getTopClientsByCostForPeriod(currentStart, currentEnd, 10, companyId),
    getTopClientsByCostForPeriod(previousStart, previousEnd, 10, companyId),
  ]);

  const totalCost = currentClients.reduce((sum, c) => sum + parseFloat(c.cost), 0);
  const previousCostByClient = new Map(previousClients.map((c) => [c.client_id, parseFloat(c.cost)]));

  return {
    current_window: { start: currentStart, end: currentEnd },
    previous_window: { start: previousStart, end: previousEnd },
    total_cost: Math.round(totalCost * 100) / 100,
    top_clients: currentClients.slice(0, 5).map((c) => {
      const cost = parseFloat(c.cost);
      const previousCost = previousCostByClient.get(c.client_id) || 0;
      return {
        client_name: c.client_name,
        cost,
        revenue_share_pct: totalCost > 0 ? Math.round((cost / totalCost) * 10000) / 100 : 0,
        previous_cost: previousCost,
        trend_pct: previousCost > 0 ? Math.round(((cost - previousCost) / previousCost) * 10000) / 100 : null,
      };
    }),
  };
}

// ── 8. Utilization Anomaly ──────────────────────────────────────────────────

/**
 * Current calendar month's utilization % vs the previous calendar month's,
 * plus the clients/employees with the largest hour swings between the two
 * months (to help explain the change).
 * @returns {Promise<object>}
 */
async function getUtilizationAnomalyData(companyId) {
  const currentMonth = moment();
  const previousMonth = currentMonth.clone().subtract(1, 'month');

  const currentStart = currentMonth.clone().startOf('month').format(DATE_FMT);
  const currentEnd = moment().format(DATE_FMT); // month-to-date if run mid-month
  const previousStart = previousMonth.clone().startOf('month').format(DATE_FMT);
  const previousEnd = previousMonth.clone().endOf('month').format(DATE_FMT);

  const [currentSummary, previousSummary, currentClients, previousClients] = await Promise.all([
    getUtilizationAndCostSummary(currentStart, currentEnd, companyId),
    getUtilizationAndCostSummary(previousStart, previousEnd, companyId),
    getTopClientsByCostForPeriod(currentStart, currentEnd, 10, companyId),
    getTopClientsByCostForPeriod(previousStart, previousEnd, 10, companyId),
  ]);

  const currentByClient = new Map(currentClients.map((c) => [c.client_name, parseFloat(c.hours)]));
  const previousByClient = new Map(previousClients.map((c) => [c.client_name, parseFloat(c.hours)]));
  const allClientNames = new Set([...currentByClient.keys(), ...previousByClient.keys()]);

  const deltas = Array.from(allClientNames)
    .map((name) => ({
      client_name: name,
      current_hours: currentByClient.get(name) || 0,
      previous_hours: previousByClient.get(name) || 0,
      delta_hours: (currentByClient.get(name) || 0) - (previousByClient.get(name) || 0),
    }))
    .sort((a, b) => Math.abs(b.delta_hours) - Math.abs(a.delta_hours))
    .slice(0, 5);

  return {
    current_month: currentMonth.format('MMM-YY'),
    previous_month: previousMonth.format('MMM-YY'),
    current_utilization_pct: currentSummary.utilization_pct,
    previous_utilization_pct: previousSummary.utilization_pct,
    utilization_change_pct: Math.round((currentSummary.utilization_pct - previousSummary.utilization_pct) * 100) / 100,
    current_total_hours: currentSummary.total_hours,
    previous_total_hours: previousSummary.total_hours,
    top_hour_swings_by_client: deltas,
  };
}

// ── 9. Quarter End Review ───────────────────────────────────────────────────

/**
 * Bounds of the fiscal quarter (Apr-Mar year) that just ended, based on the
 * current calendar month. Falls back to the trailing 90 days if called
 * outside the normal quarterly cron dates (e.g. a manual on-demand run).
 * @returns {{ start: string, end: string, label: string }}
 */
function getJustEndedQuarterBounds() {
  const now = moment();
  const month = now.month() + 1;
  const year = now.year();

  const quarters = {
    4: { start: `${year - 1}-01-01`, end: `${year - 1}-03-31`, label: `Jan-Mar ${year - 1}` },
    7: { start: `${year}-04-01`, end: `${year}-06-30`, label: `Apr-Jun ${year}` },
    10: { start: `${year}-07-01`, end: `${year}-09-30`, label: `Jul-Sep ${year}` },
    1: { start: `${year - 1}-10-01`, end: `${year - 1}-12-31`, label: `Oct-Dec ${year - 1}` },
  };

  if (quarters[month]) return quarters[month];

  return {
    start: now.clone().subtract(90, 'days').format(DATE_FMT),
    end: now.clone().subtract(1, 'day').format(DATE_FMT),
    label: 'Trailing 90 days',
  };
}

/**
 * Full quarter-end review: utilization, cost, top clients, resource risks,
 * and portfolio movement for the fiscal quarter that just ended.
 * @returns {Promise<object>}
 */
async function getQuarterEndReviewData(companyId) {
  const { start, end, label } = getJustEndedQuarterBounds();

  const [summary, topClients, soleContributorRows, benchRows, completedPos, newClients] = await Promise.all([
    getUtilizationAndCostSummary(start, end, companyId),
    getTopClientsByCostForPeriod(start, end, 5, companyId),
    getSoleContributorRiskRows(start, end, companyId),
    getBenchPctRows(start, end, companyId),
    sequelize.query(
      `SELECT COUNT(*) AS count FROM service_pos
       WHERE status IN ('completed', 'closed') AND updated_at::date BETWEEN :start AND :end
         AND company_id = :companyId`,
      { replacements: { start, end, companyId }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COUNT(*) AS count FROM clients WHERE created_at::date BETWEEN :start AND :end
         AND company_id = :companyId`,
      { replacements: { start, end, companyId }, type: QueryTypes.SELECT }
    ),
  ]);

  return {
    quarter_label: label,
    period: { start, end },
    total_hours: summary.total_hours,
    billable_hours: summary.billable_hours,
    utilization_pct: summary.utilization_pct,
    total_cost: summary.total_cost,
    active_employee_count: summary.active_employee_count,
    top_clients_by_cost: topClients.map((c) => ({ client_name: c.client_name, cost: parseFloat(c.cost) })),
    sole_contributor_risk_count: soleContributorRows.length,
    employees_on_bench_75plus: benchRows.filter((r) => r.bench_pct >= 75).length,
    completed_pos_count: parseInt(completedPos[0].count, 10) || 0,
    new_clients_count: parseInt(newClients[0].count, 10) || 0,
  };
}

// ── 10. New PO Staffing Suggestion ──────────────────────────────────────────

/**
 * Details of a newly created Service PO plus a shortlist of candidate
 * employees (bench % >= 30 over the trailing 30 days) with their
 * designation and a resource-description snippet, for Claude to rank
 * against the PO's stated needs. This is a best-effort text heuristic
 * against free-text resource_description — there is no dedicated skills
 * taxonomy in the schema.
 *
 * @param {number} servicePoId
 * @returns {Promise<object|null>} null if the PO no longer exists
 */
async function getNewPoStaffingSuggestionData(servicePoId, companyId) {
  const [po] = await sequelize.query(
    `SELECT sp.id AS service_po_id, sp.service_po_name, sp.service_description,
            sp.start_date, sp.end_date,
            c.client_name, st.service_type_name, sc.name AS category_name
     FROM service_pos sp
     INNER JOIN clients c ON c.id = sp.client_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     LEFT JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE sp.id = :servicePoId AND sp.company_id = :companyId`,
    { replacements: { servicePoId, companyId }, type: QueryTypes.SELECT }
  );

  if (!po) return null;

  const endDate = moment().format(DATE_FMT);
  const startDate = moment().subtract(30, 'days').format(DATE_FMT);
  const benchRows = (await getBenchPctRows(startDate, endDate, companyId)).filter((r) => r.bench_pct >= 30);

  // Employees with no timesheet activity at all in the last 30 days are
  // also fully available candidates (distinct from the bench-hours query,
  // which only includes employees who logged at least one hour).
  const employeeIds = benchRows.map((r) => r.employee_id);
  const fullyIdleEmployees = await sequelize.query(
    `SELECT e.id AS employee_id, e.full_name, e.designation, e.resource_description
     FROM employees e
     WHERE e.is_deleted = false AND e.status = 'active'
       AND (e.company_id = :companyId OR EXISTS (
         SELECT 1 FROM employee_business_units ebu
         WHERE ebu.employee_id = e.id AND ebu.business_unit_id = :companyId AND ebu.status = 'active'
       ))
       AND e.id NOT IN (:employeeIds)
       AND NOT EXISTS (
         SELECT 1 FROM timesheets t
         WHERE t.employee_id = e.id AND t.timesheet_date BETWEEN :startDate AND :endDate
       )
     LIMIT 15`,
    { replacements: { employeeIds: employeeIds.length ? employeeIds : [0], startDate, endDate, companyId }, type: QueryTypes.SELECT }
  );

  let candidateDetails = [];
  if (benchRows.length > 0) {
    candidateDetails = await sequelize.query(
      `SELECT id AS employee_id, full_name, designation, resource_description
       FROM employees
       WHERE id IN (:employeeIds) AND company_id = :companyId`,
      { replacements: { employeeIds, companyId }, type: QueryTypes.SELECT }
    );
  }
  const detailsByEmployee = new Map(candidateDetails.map((d) => [d.employee_id, d]));

  const truncate = (text, max = 200) => (text ? String(text).slice(0, max) : null);

  const benchCandidates = benchRows
    .sort((a, b) => b.bench_pct - a.bench_pct)
    .slice(0, 15)
    .map((r) => {
      const detail = detailsByEmployee.get(r.employee_id);
      return {
        employee_id: r.employee_id,
        full_name: r.full_name,
        designation: r.designation,
        bench_pct: r.bench_pct,
        resource_description: truncate(detail?.resource_description),
      };
    });

  const idleCandidates = fullyIdleEmployees.map((e) => ({
    employee_id: e.employee_id,
    full_name: e.full_name,
    designation: e.designation,
    bench_pct: 100,
    resource_description: truncate(e.resource_description),
  }));

  return {
    new_po: {
      service_po_id: po.service_po_id,
      service_po_name: po.service_po_name,
      client_name: po.client_name,
      service_type_name: po.service_type_name,
      category_name: po.category_name || 'Uncategorized',
      service_description: truncate(po.service_description, 500),
      start_date: po.start_date,
      end_date: po.end_date,
    },
    candidate_employees: [...idleCandidates, ...benchCandidates].slice(0, 20),
  };
}

module.exports = {
  getWeeklyResourceDigestData,
  getPoEndingAlertsData,
  getBenchEscalationData,
  getSoleContributorRiskData,
  getMonthlyCostCommentaryData,
  getClientConcentrationData,
  getUtilizationAnomalyData,
  getQuarterEndReviewData,
  getNewPoStaffingSuggestionData,
};
