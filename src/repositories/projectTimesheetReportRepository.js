'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Project-Wise Timesheet Report — raw SQL over employee_work_logs (what
 * employees enter, incl. the mandatory activity description), never the
 * official `timesheets` table. Read-only.
 *
 * One row per work-log entry (Employee + Date + Service PO + Module/Task).
 * Leave = an entry whose Service PO's Service Type is "Leave"/"Leaves" — the
 * same convention dashboardRepository/pmDashboardRepository/reportRepository
 * already use (there is no structured leave model on work logs).
 *
 * When the caller narrows by Project / Service PO / Client, `includeLeave`
 * additionally brings in the SAME employees' leave entries in the period, so
 * a project review still shows who was on leave (effort validation), without
 * pulling in unrelated employees' leave.
 */

const IS_LEAVE_SQL = "LOWER(TRIM(COALESCE(st.service_type_name, ''))) IN ('leave', 'leaves')";

const SORTS = {
  project: 'p.project_name ASC NULLS LAST, sp.service_po_name ASC, e.full_name ASC, wl.work_date ASC, wl.id ASC',
  employee: 'e.full_name ASC, wl.work_date ASC, p.project_name ASC NULLS LAST, wl.id ASC',
  date: 'wl.work_date ASC, e.full_name ASC, p.project_name ASC NULLS LAST, wl.id ASC',
};

/**
 * @param {object} f
 * @param {number[]|null} f.employeeIds - already-authorized employees (the hard scope), or null when servicePoIds is the scope
 * @param {string} f.startDate
 * @param {string} f.endDate
 * @param {number[]|null} [f.projectIds]
 * @param {number[]|null} [f.servicePoIds]
 * @param {number[]|null} [f.clientIds]
 * @param {number[]|null} [f.filterEmployeeIds] - optional user-chosen narrowing within employeeIds
 * @param {string[]|null} [f.statuses] - work-log statuses to include
 * @param {boolean} [f.includeLeave]
 * @param {string|null} [f.search] - employee name / code
 */
function buildWhere(f) {
  const replacements = { startDate: f.startDate, endDate: f.endDate };
  const conditions = [
    'wl.work_date BETWEEN :startDate AND :endDate',
    'e.is_deleted = false',
  ];
  // null = the caller is scoped by Service PO instead (a Project Manager's
  // own PM Service POs, passed as servicePoIds) — see the service's
  // buildFilters(). Never both absent: the service guarantees one scope.
  if (f.employeeIds != null) {
    conditions.push('wl.employee_id IN (:employeeIds)');
    replacements.employeeIds = f.employeeIds;
  }

  if (f.filterEmployeeIds && f.filterEmployeeIds.length) {
    conditions.push('wl.employee_id IN (:filterEmployeeIds)');
    replacements.filterEmployeeIds = f.filterEmployeeIds;
  }
  if (f.statuses && f.statuses.length) {
    conditions.push('wl.status IN (:statuses)');
    replacements.statuses = f.statuses;
  }
  if (f.search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${f.search}%`;
  }

  // Project / Service PO / Client narrowing, written against a given alias
  // pair so the leave EXISTS sub-query can reuse it.
  const projectCond = (wlAlias, spAlias) => {
    const parts = [];
    if (f.projectIds && f.projectIds.length) { parts.push(`${spAlias}.project_id IN (:projectIds)`); replacements.projectIds = f.projectIds; }
    if (f.servicePoIds && f.servicePoIds.length) { parts.push(`${wlAlias}.service_po_id IN (:servicePoIds)`); replacements.servicePoIds = f.servicePoIds; }
    if (f.clientIds && f.clientIds.length) { parts.push(`${spAlias}.client_id IN (:clientIds)`); replacements.clientIds = f.clientIds; }
    return parts.length ? parts.join(' AND ') : null;
  };

  const projectFilter = projectCond('wl', 'sp');
  if (projectFilter) {
    if (f.includeLeave) {
      conditions.push(`(
        (${projectFilter})
        OR (${IS_LEAVE_SQL} AND EXISTS (
          SELECT 1 FROM employee_work_logs wl2
          JOIN service_pos sp2 ON sp2.id = wl2.service_po_id
          WHERE wl2.employee_id = wl.employee_id
            AND wl2.work_date BETWEEN :startDate AND :endDate
            AND ${projectCond('wl2', 'sp2')}
        ))
      )`);
    } else {
      conditions.push(`(${projectFilter})`);
    }
  } else if (!f.includeLeave) {
    conditions.push(`NOT (${IS_LEAVE_SQL})`);
  }

  return { whereSql: conditions.join(' AND '), replacements };
}

const FROM_SQL = `
  FROM employee_work_logs wl
  JOIN employees e        ON e.id = wl.employee_id
  JOIN service_pos sp     ON sp.id = wl.service_po_id
  LEFT JOIN service_types st ON st.id = sp.service_type_id
  LEFT JOIN projects p    ON p.id = sp.project_id
  LEFT JOIN clients c     ON c.id = sp.client_id
  LEFT JOIN companies bu  ON bu.id = sp.company_id
  LEFT JOIN sub_projects sub ON sub.id = wl.sub_project_id
  LEFT JOIN service_po_hierarchy node   ON node.id = wl.hierarchy_node_id
  LEFT JOIN service_po_hierarchy parent ON parent.id = node.parent_hierarchy_id`;

/**
 * Detail rows (paged when limit is given — the Excel/CSV download passes no
 * limit and gets every row, capped by the caller).
 */
async function findRows(filters, { sortBy = 'project', limit = null, offset = 0 } = {}) {
  const { whereSql, replacements } = buildWhere(filters);
  const orderBy = SORTS[sortBy] || SORTS.project;
  const paging = limit != null ? 'LIMIT :limit OFFSET :offset' : '';

  return sequelize.query(
    `SELECT
       wl.id,
       e.id AS employee_id,
       e.employee_code,
       e.full_name AS employee_name,
       TO_CHAR(wl.work_date, 'YYYY-MM-DD') AS work_date,
       TRIM(TO_CHAR(wl.work_date, 'Day')) AS day_name,
       wl.log_type,
       c.id AS client_id,
       c.client_name,
       p.id AS project_id,
       p.project_code,
       p.project_name,
       sp.id AS service_po_id,
       sp.service_po_code,
       sp.service_po_name,
       bu.company_name AS business_unit,
       sub.sub_project_name,
       CASE WHEN parent.id IS NOT NULL THEN parent.node_name ELSE node.node_name END AS module_name,
       CASE WHEN parent.id IS NOT NULL THEN node.node_name ELSE NULL END AS task_name,
       (${IS_LEAVE_SQL}) AS is_leave,
       ROUND(wl.hours::NUMERIC, 2) AS hours,
       wl.description,
       slots.time_slots,
       pm.project_managers,
       wl.status,
       wl.rejection_remark
     ${FROM_SQL}
     LEFT JOIN LATERAL (
       SELECT STRING_AGG(
                TO_CHAR(te.start_time, 'HH24:MI') || '-' || TO_CHAR(te.end_time, 'HH24:MI')
                  || COALESCE(' ' || NULLIF(TRIM(te.description), ''), ''),
                '; ' ORDER BY te.start_time) AS time_slots
       FROM employee_work_log_time_entries te
       WHERE te.employee_work_log_id = wl.id
     ) slots ON true
     LEFT JOIN LATERAL (
       SELECT STRING_AGG(DISTINCT pme.full_name, ', ') AS project_managers
       FROM employee_servicepo_mapping m
       JOIN employees pme ON pme.id = m.employee_id AND pme.is_deleted = false
       WHERE m.service_po_id = wl.service_po_id AND m.is_project_manager = true AND m.status = 'active'
     ) pm ON true
     WHERE ${whereSql}
     ORDER BY ${orderBy}
     ${paging}`,
    { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
  );
}

/** Row count + hour totals for the whole filtered set (not just one page). */
async function getTotals(filters) {
  const { whereSql, replacements } = buildWhere(filters);
  const [row] = await sequelize.query(
    `SELECT
       COUNT(*)::int AS entry_count,
       COUNT(DISTINCT wl.employee_id)::int AS employee_count,
       COALESCE(ROUND(SUM(CASE WHEN ${IS_LEAVE_SQL} THEN 0 ELSE wl.hours END)::NUMERIC, 2), 0) AS logged_hours,
       COALESCE(ROUND(SUM(CASE WHEN ${IS_LEAVE_SQL} THEN wl.hours ELSE 0 END)::NUMERIC, 2), 0) AS leave_hours,
       COALESCE(ROUND(SUM(CASE WHEN wl.status IN ('approved', 'synced') THEN wl.hours ELSE 0 END)::NUMERIC, 2), 0) AS approved_hours,
       COALESCE(ROUND(SUM(CASE WHEN wl.status = 'pending' THEN wl.hours ELSE 0 END)::NUMERIC, 2), 0) AS pending_hours,
       COALESCE(ROUND(SUM(CASE WHEN wl.status = 'rejected' THEN wl.hours ELSE 0 END)::NUMERIC, 2), 0) AS rejected_hours
     ${FROM_SQL}
     WHERE ${whereSql}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return row;
}

/** Project -> Service PO -> Employee summary (project leave rows excluded). */
async function getProjectSummary(filters) {
  const { whereSql, replacements } = buildWhere(filters);
  return sequelize.query(
    `SELECT
       c.client_name,
       p.project_name,
       sp.service_po_code,
       sp.service_po_name,
       e.employee_code,
       e.full_name AS employee_name,
       COUNT(DISTINCT wl.work_date)::int AS days_logged,
       ROUND(SUM(wl.hours)::NUMERIC, 2) AS logged_hours,
       ROUND(SUM(CASE WHEN wl.status IN ('approved', 'synced') THEN wl.hours ELSE 0 END)::NUMERIC, 2) AS approved_hours,
       ROUND(SUM(CASE WHEN wl.status = 'pending' THEN wl.hours ELSE 0 END)::NUMERIC, 2) AS pending_hours,
       ROUND(SUM(CASE WHEN wl.status = 'rejected' THEN wl.hours ELSE 0 END)::NUMERIC, 2) AS rejected_hours
     ${FROM_SQL}
     WHERE ${whereSql} AND NOT (${IS_LEAVE_SQL})
     GROUP BY c.client_name, p.project_name, sp.id, sp.service_po_code, sp.service_po_name, e.id, e.employee_code, e.full_name
     ORDER BY p.project_name ASC NULLS LAST, sp.service_po_name ASC, e.full_name ASC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/** Employee summary: project hours vs leave hours, by approval status. */
async function getEmployeeSummary(filters) {
  const { whereSql, replacements } = buildWhere(filters);
  return sequelize.query(
    `SELECT
       e.employee_code,
       e.full_name AS employee_name,
       COUNT(DISTINCT wl.work_date)::int AS days_logged,
       COUNT(DISTINCT CASE WHEN ${IS_LEAVE_SQL} THEN NULL ELSE sp.id END)::int AS service_po_count,
       ROUND(SUM(CASE WHEN ${IS_LEAVE_SQL} THEN 0 ELSE wl.hours END)::NUMERIC, 2) AS logged_hours,
       ROUND(SUM(CASE WHEN ${IS_LEAVE_SQL} THEN wl.hours ELSE 0 END)::NUMERIC, 2) AS leave_hours,
       ROUND(SUM(wl.hours)::NUMERIC, 2) AS total_hours,
       ROUND(SUM(CASE WHEN wl.status IN ('approved', 'synced') THEN wl.hours ELSE 0 END)::NUMERIC, 2) AS approved_hours,
       ROUND(SUM(CASE WHEN wl.status = 'pending' THEN wl.hours ELSE 0 END)::NUMERIC, 2) AS pending_hours,
       ROUND(SUM(CASE WHEN wl.status = 'rejected' THEN wl.hours ELSE 0 END)::NUMERIC, 2) AS rejected_hours
     ${FROM_SQL}
     WHERE ${whereSql}
     GROUP BY e.id, e.employee_code, e.full_name
     ORDER BY e.full_name ASC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

module.exports = { findRows, getTotals, getProjectSummary, getEmployeeSummary, buildWhere };
