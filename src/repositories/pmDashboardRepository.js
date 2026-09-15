'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Project Manager Dashboard Repository
 *
 * Raw SQL via sequelize.query — same convention as
 * managementReportRepository.js/dashboardRepository.js/reportRepository.js.
 *
 * Service PO / Project / Client visibility here is scoped by `companyIds`
 * alone: `(x.company_id IN (:companyIds) OR x.company_id IS NULL)`, the same
 * boundary every report in managementReportRepository.js already uses.
 * Deliberately NOT the stricter "Project Manager/Delivery Head see only
 * individually-mapped Service POs" rule servicePOService.getAll() applies to
 * the Service PO Master screen — dashboards/reports in this codebase are
 * BU-wide by established convention; only the PO Master CRUD screen itself
 * narrows further to an individual mapping. See the PM Dashboard audit, §9,
 * for the full reasoning — this can be tightened later if the business wants
 * the dashboard to mirror that narrower rule instead.
 *
 * Leave/no-work hours reuse the EXACT SAME service-type/PO-name heuristic
 * dashboardRepository.js's getLeaveHoursTrend()/getNoWorkTrend() already use
 * (LOWER(service_type_name) = 'leaves'; LOWER(service_po_name) IN ('idle',
 * 'on bench')) — there is no structured leave/absence model in this
 * codebase (confirmed by the audit), so this is the same convention-based
 * proxy the existing Dashboard already relies on, not a new business rule.
 */

const HOURS_COL = 'COALESCE(t.modified_hours, t.hours_logged)';

// ---------------------------------------------------------------------------
// Project rollup — one row per Project, aggregating its Service POs.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number} filters.monthNum
 * @param {number} filters.yearNum
 * @param {string} filters.asOfDate - 'YYYY-MM-DD', for overdue/timeline risk
 * @param {string} [filters.status] - Project status filter
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @param {number[]} filters.companyIds
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getProjectRollup(filters) {
  const {
    monthNum, yearNum, asOfDate, status, search,
    sortBy = 'project_name', sortOrder = 'ASC', limit, offset, companyIds,
  } = filters;

  const allowedSort = ['project_name', 'team_size', 'planned_hours', 'actual_hours', 'variance_pct', 'overdue_po_count', 'nearest_end_date'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'project_name';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { monthNum, yearNum, asOfDate, limit, offset, companyIds };
  const conditions = ['p.is_deleted = false', '(p.company_id IN (:companyIds) OR p.company_id IS NULL)'];
  if (status && status !== 'all') { conditions.push('p.status = :status'); replacements.status = status; }
  if (search) {
    conditions.push('(p.project_name ILIKE :search OR p.project_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const cte = `
    WITH in_scope_projects AS (
      SELECT p.id, p.project_code, p.project_name, p.status AS project_status, p.client_id
      FROM projects p
      ${whereClause}
    ),
    po_scope AS (
      SELECT sp.id AS service_po_id, sp.project_id, sp.status, sp.end_date
      FROM service_pos sp
      WHERE sp.project_id IN (SELECT id FROM in_scope_projects) AND sp.is_deleted = false
    ),
    team AS (
      SELECT po_scope.project_id, COUNT(DISTINCT esm.employee_id) AS team_size
      FROM po_scope
      INNER JOIN employee_servicepo_mapping esm
              ON esm.service_po_id = po_scope.service_po_id AND esm.status = 'active'
      GROUP BY po_scope.project_id
    ),
    planned AS (
      SELECT po_scope.project_id, SUM(rbm.hours) AS planned_hours
      FROM po_scope
      INNER JOIN resource_budget_master rbm
              ON rbm.service_po_id = po_scope.service_po_id AND rbm.status = 'active'
             AND rbm.month = :monthNum AND rbm.year = :yearNum
      GROUP BY po_scope.project_id
    ),
    actual AS (
      SELECT po_scope.project_id, SUM(${HOURS_COL}) AS actual_hours
      FROM po_scope
      INNER JOIN timesheets t ON t.service_po_id = po_scope.service_po_id
        AND EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
        AND EXTRACT(YEAR FROM t.timesheet_date) = :yearNum
      GROUP BY po_scope.project_id
    ),
    risk AS (
      SELECT
        project_id,
        COUNT(*) AS service_po_count,
        COUNT(*) FILTER (WHERE status IN ('in-progress', 'pending')) AS active_po_count,
        COUNT(*) FILTER (
          WHERE end_date IS NOT NULL AND end_date < :asOfDate
            AND status NOT IN ('completed', 'closed', 'cancelled')
        ) AS overdue_po_count,
        MIN(end_date) FILTER (WHERE status NOT IN ('completed', 'closed', 'cancelled')) AS nearest_end_date
      FROM po_scope
      GROUP BY project_id
    )
  `;

  const dataQuery = `
    ${cte}
    SELECT
      isp.id AS project_id, isp.project_code, isp.project_name, isp.project_status,
      c.id AS client_id, c.client_name,
      COALESCE(risk.service_po_count, 0)  AS service_po_count,
      COALESCE(risk.active_po_count, 0)   AS active_po_count,
      COALESCE(team.team_size, 0)         AS team_size,
      ROUND(COALESCE(planned.planned_hours, 0)::numeric, 2) AS planned_hours,
      ROUND(COALESCE(actual.actual_hours, 0)::numeric, 2)   AS actual_hours,
      CASE
        WHEN COALESCE(planned.planned_hours, 0) > 0
          THEN ROUND(((COALESCE(actual.actual_hours, 0) - planned.planned_hours) / planned.planned_hours * 100)::numeric, 2)
        ELSE NULL
      END AS variance_pct,
      COALESCE(risk.overdue_po_count, 0)  AS overdue_po_count,
      risk.nearest_end_date
    FROM in_scope_projects isp
    LEFT JOIN clients c ON c.id = isp.client_id
    LEFT JOIN team    ON team.project_id = isp.id
    LEFT JOIN planned ON planned.project_id = isp.id
    LEFT JOIN actual  ON actual.project_id = isp.id
    LEFT JOIN risk    ON risk.project_id = isp.id
    ORDER BY ${safeSort} ${safeOrder} NULLS LAST
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `${cte} SELECT COUNT(*) AS total FROM in_scope_projects`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// Team capacity — one row per employee (a pre-resolved employeeIds list —
// the caller's team, per employeeAccessControlService.resolveEmployeeAccessWhere).
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number[]} filters.employeeIds - pre-resolved, already-authorized team
 * @param {number} filters.monthNum
 * @param {number} filters.yearNum
 * @param {number} [filters.benchThresholdHours=40]
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getTeamCapacity(filters) {
  const {
    employeeIds, monthNum, yearNum, benchThresholdHours = 40,
    sortBy = 'capacity_used_pct', sortOrder = 'DESC', limit, offset, search,
  } = filters;

  if (!employeeIds || employeeIds.length === 0) {
    return { rows: [], count: 0 };
  }

  const allowedSort = ['full_name', 'planned_hours', 'actual_hours', 'capacity_used_pct', 'leave_hours', 'no_work_hours'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'capacity_used_pct';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const MONTHLY_CAP = 176;
  const replacements = {
    monthNum, yearNum, employeeIds, limit, offset,
    monthlyCap: MONTHLY_CAP, benchThreshold: parseFloat(benchThresholdHours),
  };

  const conditions = ['e.id IN (:employeeIds)', 'e.is_deleted = false'];
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const cte = `
    WITH planned AS (
      SELECT emp_id, SUM(hours) AS planned_hours
      FROM resource_budget_master
      WHERE status = 'active' AND month = :monthNum AND year = :yearNum AND emp_id IN (:employeeIds)
      GROUP BY emp_id
    ),
    actual AS (
      SELECT t.employee_id AS emp_id, SUM(${HOURS_COL}) AS actual_hours
      FROM timesheets t
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum AND EXTRACT(YEAR FROM t.timesheet_date) = :yearNum
        AND t.employee_id IN (:employeeIds)
      GROUP BY t.employee_id
    ),
    leave_hrs AS (
      SELECT t.employee_id AS emp_id, SUM(${HOURS_COL}) AS leave_hours
      FROM timesheets t
      INNER JOIN service_pos sp   ON sp.id = t.service_po_id
      INNER JOIN service_types st ON st.id = sp.service_type_id
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum AND EXTRACT(YEAR FROM t.timesheet_date) = :yearNum
        AND t.employee_id IN (:employeeIds)
        AND LOWER(st.service_type_name) = 'leaves'
      GROUP BY t.employee_id
    ),
    no_work AS (
      SELECT t.employee_id AS emp_id, SUM(${HOURS_COL}) AS no_work_hours
      FROM timesheets t
      INNER JOIN service_pos sp ON sp.id = t.service_po_id
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum AND EXTRACT(YEAR FROM t.timesheet_date) = :yearNum
        AND t.employee_id IN (:employeeIds)
        AND LOWER(sp.service_po_name) IN ('idle', 'on bench')
      GROUP BY t.employee_id
    )
  `;

  const dataQuery = `
    ${cte}
    SELECT * FROM (
      SELECT
        e.id AS employee_id, e.employee_code, e.full_name, e.designation,
        :monthlyCap AS monthly_capacity_hours,
        ROUND(COALESCE(planned.planned_hours, 0)::numeric, 2)   AS planned_hours,
        ROUND(COALESCE(actual.actual_hours, 0)::numeric, 2)     AS actual_hours,
        ROUND(COALESCE(leave_hrs.leave_hours, 0)::numeric, 2)   AS leave_hours,
        ROUND(COALESCE(no_work.no_work_hours, 0)::numeric, 2)   AS no_work_hours,
        ROUND((COALESCE(planned.planned_hours, 0) / :monthlyCap * 100)::numeric, 2) AS capacity_used_pct,
        (COALESCE(planned.planned_hours, 0) > :monthlyCap)      AS overallocation_flag,
        (COALESCE(planned.planned_hours, 0) < :benchThreshold)  AS bench_flag
      FROM employees e
      LEFT JOIN planned   ON planned.emp_id = e.id
      LEFT JOIN actual    ON actual.emp_id = e.id
      LEFT JOIN leave_hrs ON leave_hrs.emp_id = e.id
      LEFT JOIN no_work   ON no_work.emp_id = e.id
      ${whereClause}
    ) filtered
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `SELECT COUNT(*) AS total FROM employees e ${whereClause}`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// Pending work-log approvals — status = 'pending' rows for the caller's team.
// Deliberately a fresh query against employee_work_logs, rather than the
// existing My-Team Approval Summary endpoint — that endpoint's employee
// scope only ever includes a caller's DIRECT manager_employee_mappings rows,
// which is empty for a normally-configured Project Manager (see the PM
// Dashboard audit, §9.3). This query instead takes the already-resolved
// `employeeIds` list (the same team_mappings-aware resolution Employee
// Master itself uses), so a Project Manager's pending-approvals count is
// correct here regardless of that separate, unfixed gap.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number[]} filters.employeeIds
 * @param {number} filters.monthNum
 * @param {number} filters.yearNum
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getPendingApprovals(filters) {
  const { employeeIds, monthNum, yearNum, limit, offset } = filters;
  if (!employeeIds || employeeIds.length === 0) {
    return { rows: [], count: 0 };
  }

  const replacements = { employeeIds, monthNum, yearNum, limit, offset };
  const whereClause = `
    WHERE ewl.employee_id IN (:employeeIds) AND ewl.status = 'pending'
      AND EXTRACT(MONTH FROM ewl.work_date) = :monthNum AND EXTRACT(YEAR FROM ewl.work_date) = :yearNum
  `;

  const dataQuery = `
    SELECT
      ewl.id AS work_log_id, ewl.employee_id, e.full_name, e.employee_code,
      ewl.service_po_id, sp.service_po_name, ewl.work_date, ewl.hours, ewl.log_type
    FROM employee_work_logs ewl
    INNER JOIN employees e ON e.id = ewl.employee_id
    LEFT JOIN service_pos sp ON sp.id = ewl.service_po_id
    ${whereClause}
    ORDER BY ewl.work_date ASC
    LIMIT :limit OFFSET :offset
  `;
  const countQuery = `SELECT COUNT(*) AS total FROM employee_work_logs ewl ${whereClause}`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);
  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// Portfolio counts (KPI row) — Client/Project/Service PO counts within scope.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number[]} filters.companyIds
 * @returns {Promise<object>}
 */
async function getPortfolioCounts({ companyIds }) {
  const replacements = { companyIds };
  const [row] = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM clients c
          WHERE c.is_deleted = false AND (c.company_id IN (:companyIds) OR c.company_id IS NULL)) AS total_clients,
       (SELECT COUNT(*) FROM projects p
          WHERE p.is_deleted = false AND (p.company_id IN (:companyIds) OR p.company_id IS NULL)) AS total_projects,
       (SELECT COUNT(*) FROM projects p
          WHERE p.is_deleted = false AND p.status = 'active' AND (p.company_id IN (:companyIds) OR p.company_id IS NULL)) AS active_projects,
       (SELECT COUNT(*) FROM service_pos sp
          WHERE sp.is_deleted = false AND (sp.company_id IN (:companyIds) OR sp.company_id IS NULL)) AS total_service_pos,
       (SELECT COUNT(*) FROM service_pos sp
          WHERE sp.is_deleted = false AND sp.status IN ('in-progress', 'pending')
            AND (sp.company_id IN (:companyIds) OR sp.company_id IS NULL)) AS active_service_pos
    `,
    { replacements, type: QueryTypes.SELECT }
  );
  return row;
}

// ---------------------------------------------------------------------------
// Logged hours (KPI row) — total hours across every in-scope Service PO for
// the period.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @returns {Promise<number>}
 */
async function getLoggedHoursMTD({ companyIds, monthNum, yearNum }) {
  const replacements = { companyIds, monthNum, yearNum };
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(${HOURS_COL}), 0) AS total_hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE (sp.company_id IN (:companyIds) OR sp.company_id IS NULL)
       AND EXTRACT(MONTH FROM t.timesheet_date) = :monthNum AND EXTRACT(YEAR FROM t.timesheet_date) = :yearNum
    `,
    { replacements, type: QueryTypes.SELECT }
  );
  return parseFloat(row.total_hours) || 0;
}

// ---------------------------------------------------------------------------
// Budget vs billed (KPI row) — service_po_monthly_budgets totals for the period.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @returns {Promise<{ total_invoiced: number, total_billed: number }>}
 */
async function getBudgetVsBilled({ companyIds, monthNum, yearNum }) {
  const replacements = { companyIds, monthNum, yearNum };
  const [row] = await sequelize.query(
    `SELECT
       COALESCE(SUM(spmb.invoice_amount), 0) AS total_invoiced,
       COALESCE(SUM(spmb.billed_amount), 0) AS total_billed
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp ON sp.id = spmb.service_po_id
     WHERE (sp.company_id IN (:companyIds) OR sp.company_id IS NULL)
       AND spmb.month = :monthNum AND spmb.year = :yearNum
    `,
    { replacements, type: QueryTypes.SELECT }
  );
  return { total_invoiced: parseFloat(row.total_invoiced) || 0, total_billed: parseFloat(row.total_billed) || 0 };
}

// ---------------------------------------------------------------------------
// At-risk project count (KPI row) — distinct Projects with >=1 Service PO
// either overdue (past end_date, not completed/closed/cancelled) or over the
// staffing-variance threshold — the same two ingredients
// managementReportService's service-po-timeline-risk and
// resource-staffing-plan-accuracy reports already compute individually,
// combined here at Project grain (nothing in this codebase does that today
// — see the PM Dashboard audit, §4B).
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @returns {Promise<number>}
 */
async function getAtRiskProjectCount({ companyIds, monthNum, yearNum, asOfDate, varianceThresholdPct }) {
  const replacements = { companyIds, monthNum, yearNum, asOfDate, varianceThresholdPct };
  const [row] = await sequelize.query(
    `WITH po_scope AS (
       SELECT sp.id, sp.project_id, sp.status, sp.end_date
       FROM service_pos sp
       WHERE sp.is_deleted = false AND (sp.company_id IN (:companyIds) OR sp.company_id IS NULL)
         AND sp.project_id IS NOT NULL
     ),
     planned AS (
       SELECT service_po_id, SUM(hours) AS planned_hours
       FROM resource_budget_master
       WHERE status = 'active' AND month = :monthNum AND year = :yearNum
         AND service_po_id IN (SELECT id FROM po_scope)
       GROUP BY service_po_id
     ),
     actual AS (
       SELECT t.service_po_id, SUM(${HOURS_COL}) AS actual_hours
       FROM timesheets t
       WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum AND EXTRACT(YEAR FROM t.timesheet_date) = :yearNum
         AND t.service_po_id IN (SELECT id FROM po_scope)
       GROUP BY t.service_po_id
     ),
     flagged AS (
       SELECT DISTINCT po_scope.project_id
       FROM po_scope
       LEFT JOIN planned ON planned.service_po_id = po_scope.id
       LEFT JOIN actual  ON actual.service_po_id = po_scope.id
       WHERE
         (po_scope.end_date IS NOT NULL AND po_scope.end_date < :asOfDate AND po_scope.status NOT IN ('completed', 'closed', 'cancelled'))
         OR (
           COALESCE(planned.planned_hours, 0) > 0
           AND ABS((COALESCE(actual.actual_hours, 0) - planned.planned_hours) / planned.planned_hours * 100) >= :varianceThresholdPct
         )
     )
     SELECT COUNT(*) AS total FROM flagged`,
    { replacements, type: QueryTypes.SELECT }
  );
  return parseInt(row.total, 10);
}

module.exports = {
  getProjectRollup,
  getTeamCapacity,
  getPendingApprovals,
  getPortfolioCounts,
  getLoggedHoursMTD,
  getBudgetVsBilled,
  getAtRiskProjectCount,
};
