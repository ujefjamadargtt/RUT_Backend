'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

const SUMMARY_SORTS = {
  employee_name: 'e.full_name',
  employee_code: 'e.employee_code',
  total_hours: 'total_hours',
};

function queryConditions({ employeeIds, startDate, endDate, search }) {
  const replacements = { employeeIds, startDate, endDate };
  const conditions = [
    'wl.employee_id IN (:employeeIds)',
    'wl.work_date BETWEEN :startDate AND :endDate',
    'e.is_deleted = false',
  ];

  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  return { conditions, replacements };
}

/**
 * One row per employee after PostgreSQL aggregates every matching parent
 * work-log row. `employee_work_logs.hours` is authoritative for all entry
 * modes, including TIME_BASED rows whose child time entries already sum into
 * that parent value.
 */
async function getSummary({ employeeIds, startDate, endDate, search, sortBy, sortOrder, limit, offset }) {
  if (!employeeIds.length) return { rows: [], count: 0 };

  const { conditions, replacements } = queryConditions({ employeeIds, startDate, endDate, search });
  const whereSql = conditions.join(' AND ');
  const orderBy = SUMMARY_SORTS[sortBy] || SUMMARY_SORTS.employee_name;
  const order = sortOrder === 'DESC' ? 'DESC' : 'ASC';

  const rows = await sequelize.query(
    `SELECT
       e.id AS employee_id,
       e.full_name AS employee_name,
       e.employee_code,
       ROUND(SUM(wl.hours)::NUMERIC, 2) AS total_hours
     FROM employee_work_logs wl
     INNER JOIN employees e ON e.id = wl.employee_id
     WHERE ${whereSql}
     GROUP BY e.id, e.full_name, e.employee_code
     ORDER BY ${orderBy} ${order}, e.id ASC
     LIMIT :limit OFFSET :offset`,
    { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
  );

  const countRows = await sequelize.query(
    `SELECT COUNT(*)::int AS count
     FROM (
       SELECT wl.employee_id
       FROM employee_work_logs wl
       INNER JOIN employees e ON e.id = wl.employee_id
       WHERE ${whereSql}
       GROUP BY wl.employee_id
     ) summary`,
    { replacements, type: QueryTypes.SELECT }
  );

  return { rows, count: countRows[0].count };
}

/**
 * Detail history expands TIME_BASED rows into their individual time slots.
 * Non-time-based rows remain one row. The separate total query always sums
 * parent work-log hours, preventing a multi-slot row from being counted more
 * than once.
 */
async function getDetails({ employeeId, startDate, endDate, limit, offset }) {
  const replacements = { employeeId, startDate, endDate, limit, offset };
  const entries = await sequelize.query(
    `SELECT
       wl.id AS work_log_id,
       wl.work_date AS date,
       sp.service_po_code,
       sp.service_po_name,
       p.project_code,
       p.project_name,
       CASE WHEN h.node_type = 'CHILD' THEN parent_h.node_name ELSE h.node_name END AS module,
       CASE WHEN h.node_type = 'CHILD' THEN h.node_name ELSE NULL END AS hierarchy_task,
       COALESCE(te.start_time::text, NULL) AS start_time,
       COALESCE(te.end_time::text, NULL) AS end_time,
       ROUND(COALESCE(te.duration_hours, wl.hours)::NUMERIC, 2) AS hours,
       COALESCE(te.description, wl.description) AS description,
       CASE
         WHEN te.id IS NOT NULL THEN 'TIME_BASED'
         WHEN wl.log_type = 'monthly' THEN 'MONTHLY'
         ELSE 'HOURLY'
       END AS entry_type,
       wl.status
     FROM employee_work_logs wl
     INNER JOIN service_pos sp ON sp.id = wl.service_po_id
     LEFT JOIN projects p ON p.id = sp.project_id
     LEFT JOIN service_po_hierarchy h ON h.id = wl.hierarchy_node_id
     LEFT JOIN service_po_hierarchy parent_h ON parent_h.id = h.parent_hierarchy_id
     LEFT JOIN employee_work_log_time_entries te ON te.employee_work_log_id = wl.id
     WHERE wl.employee_id = :employeeId
       AND wl.work_date BETWEEN :startDate AND :endDate
     ORDER BY wl.work_date DESC, wl.id ASC, te.start_time ASC NULLS LAST, te.id ASC
     LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT }
  );

  const [totals] = await sequelize.query(
    `SELECT
       COUNT(*)::int AS work_log_count,
       ROUND(COALESCE(SUM(hours), 0)::NUMERIC, 2) AS total_hours
     FROM employee_work_logs
     WHERE employee_id = :employeeId
       AND work_date BETWEEN :startDate AND :endDate`,
    { replacements, type: QueryTypes.SELECT }
  );

  const countRows = await sequelize.query(
    `SELECT COUNT(*)::int AS count
     FROM employee_work_logs wl
     LEFT JOIN employee_work_log_time_entries te ON te.employee_work_log_id = wl.id
     WHERE wl.employee_id = :employeeId
       AND wl.work_date BETWEEN :startDate AND :endDate`,
    { replacements, type: QueryTypes.SELECT }
  );

  return { entries, totalHours: totals.total_hours, workLogCount: totals.work_log_count, count: countRows[0].count };
}

module.exports = { getSummary, getDetails };
