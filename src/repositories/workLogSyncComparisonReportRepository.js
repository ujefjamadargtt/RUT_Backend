'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const {
  CTE_SQL, FROM_SQL, WORK_TYPE_SQL, buildScopeConditions,
} = require('./crossBuEmployeePoHoursReportRepository');

/**
 * Work Log Sync Comparison Report — raw data access.
 *
 * One row per Employee Work Log entry (employee_work_logs, soft-deleted rows excluded), showing the hours the
 * employee logged BEFORE sync and the hours the official timesheet carries AFTER sync.
 *
 * Visibility is NOT decided here: the caller hands in the same resolved scope as the Cross-BU report
 * (Admin/BU Admin = BU reach, Project Manager = flagged POs, everyone else = their authorized employees) and
 * buildScopeConditions() turns it into WHERE conditions, so both reports show identical rows to the same role.
 *
 * AFTER-sync hours. `timesheets` holds ONE row per employee + Service PO + date, while an employee can log
 * several entries (different Module/Task, several time slots) on that same PO/date. The timesheet's adjusted
 * hours (COALESCE(modified_hours, hours_logged) — after the monthly cap and any later admin edit) are therefore
 * shared across the synced entries of that key in proportion to what each logged. The shares always add back up
 * to the timesheet row. Entries that are not synced yet have no after-sync hours (NULL, never a guess).
 * The key's total logged hours (`sync_sum`) is taken over ALL its synced entries — not just the filtered ones —
 * so filtering or paging never changes an entry's share.
 *
 * Work type (own / cross / na) is the same definition as the Cross-BU report (WORK_TYPE_SQL).
 */

// Static allow-list: sort_by only ever selects one of these literals, never reaches the SQL itself.
const SORTS = {
  date: 'work_date',
  employee: 'employee_name',
  client: 'client_name',
  project: 'project_name',
  po: 'service_po_name',
  module: 'module_name',
  before_hours: 'before_sync_hours',
  after_hours: 'after_sync_hours',
  work_type: 'work_type',
  status: 'status',
};

const escapeLike = (term) => term.replace(/[\\%_]/g, '\\$&');

/**
 * @param {object} f
 * @param {string} f.startDate
 * @param {string} f.endDate
 * @param {object} f.scope - resolved caller scope (see crossBuEmployeePoHoursReportRepository.buildScopeConditions)
 * @param {number[]|null} [f.employeeIds]
 * @param {number[]|null} [f.employeeBuIds] - already expanded to include Sub-BUs
 * @param {number[]|null} [f.employeeSubBuIds]
 * @param {number[]|null} [f.clientIds]
 * @param {number[]|null} [f.projectIds]
 * @param {number[]|null} [f.servicePoIds]
 * @param {number[]|null} [f.poBuIds] - already expanded to include Sub-BUs
 * @param {string[]|null} [f.statuses] - work-log statuses
 * @param {'own'|'cross'|'na'|null} [f.workType]
 * @param {string|null} [f.search]
 * @returns {{ selectSql: string, replacements: object }} the un-ordered, un-paged row query
 */
function buildSelect(f) {
  const replacements = { startDate: f.startDate, endDate: f.endDate };
  const conditions = ['wl.work_date BETWEEN :startDate AND :endDate'];
  conditions.push(...buildScopeConditions(f.scope, replacements));

  const inList = (cond, key, values) => {
    if (values && values.length) { conditions.push(cond); replacements[key] = values; }
  };
  inList('wl.employee_id IN (:employeeIds)', 'employeeIds', f.employeeIds);
  inList('eb.member_ids && ARRAY[:employeeBuIds]::int[]', 'employeeBuIds', f.employeeBuIds);
  inList('eb.sub_bu_ids && ARRAY[:employeeSubBuIds]::int[]', 'employeeSubBuIds', f.employeeSubBuIds);
  inList('sp.client_id IN (:clientIds)', 'clientIds', f.clientIds);
  inList('sp.project_id IN (:projectIds)', 'projectIds', f.projectIds);
  inList('wl.service_po_id IN (:servicePoIds)', 'servicePoIds', f.servicePoIds);
  inList('sp.company_id IN (:poBuIds)', 'poBuIds', f.poBuIds);
  inList('wl.status IN (:statuses)', 'statuses', f.statuses);
  if (f.workType) {
    conditions.push(`(${WORK_TYPE_SQL}) = :workType`);
    replacements.workType = f.workType;
  }
  if (f.search) {
    conditions.push(`(e.full_name ILIKE :search OR e.employee_code ILIKE :search
      OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search
      OR cl.client_name ILIKE :search OR p.project_name ILIKE :search
      OR hn.node_name ILIKE :search OR hp.node_name ILIKE :search OR wl.description ILIKE :search)`);
    replacements.search = `%${escapeLike(f.search)}%`;
  }

  const selectSql = `${CTE_SQL},
  sync_sum AS (
    SELECT employee_id, service_po_id, work_date, timesheet_import_id, SUM(hours) AS sum_hours
      FROM employee_work_logs
     WHERE deleted_at IS NULL AND status = 'synced' AND work_date BETWEEN :startDate AND :endDate
     GROUP BY employee_id, service_po_id, work_date, timesheet_import_id
  )
  SELECT
    wl.id AS work_log_id,
    wl.work_date,
    wl.log_type,
    wl.status,
    wl.synced_at,
    wl.timesheet_import_id,
    e.id AS employee_id,
    e.employee_code,
    e.full_name AS employee_name,
    eb.bu_names AS employee_bu,
    eb.sub_bu_names AS employee_sub_bu,
    eb.bu_ids AS employee_bu_ids,
    eb.sub_bu_ids AS employee_sub_bu_ids,
    cl.id AS client_id,
    cl.client_name,
    p.id AS project_id,
    p.project_name,
    sp.id AS service_po_id,
    sp.service_po_code,
    sp.service_po_name,
    sp.is_centralised,
    po_root.id AS po_bu_id,
    po_root.company_name AS po_bu,
    CASE WHEN po_bu.parent_business_unit_id IS NOT NULL THEN po_bu.id END AS po_sub_bu_id,
    CASE WHEN po_bu.parent_business_unit_id IS NOT NULL THEN po_bu.company_name END AS po_sub_bu,
    -- Module = the PARENT node, Task = the CHILD node of the Service PO hierarchy. Hours logged straight on a
    -- PARENT node have a Module and no Task; hours logged on the PO itself have neither.
    CASE WHEN hn.node_type = 'CHILD' THEN hp.node_name WHEN hn.id IS NOT NULL THEN hn.node_name END AS module_name,
    CASE WHEN hn.node_type = 'CHILD' THEN hn.node_name END AS task_name,
    sub.sub_project_name,
    wl.hours AS before_sync_hours,
    CASE
      WHEN wl.status = 'synced' AND t.id IS NOT NULL AND ss.sum_hours > 0
        THEN ROUND((COALESCE(t.modified_hours, t.hours_logged) * wl.hours / ss.sum_hours)::NUMERIC, 2)
    END AS after_sync_hours,
    wl.description,
    (${WORK_TYPE_SQL}) AS work_type
  ${FROM_SQL}
  LEFT JOIN service_po_hierarchy hn ON hn.id = wl.hierarchy_node_id
  LEFT JOIN service_po_hierarchy hp ON hp.id = hn.parent_hierarchy_id
  LEFT JOIN sub_projects sub ON sub.id = wl.sub_project_id
  LEFT JOIN sync_sum ss ON ss.employee_id = wl.employee_id AND ss.service_po_id = wl.service_po_id
                       AND ss.work_date = wl.work_date AND ss.timesheet_import_id IS NOT DISTINCT FROM wl.timesheet_import_id
  LEFT JOIN timesheets t ON t.employee_id = wl.employee_id AND t.service_po_id = wl.service_po_id
                        AND t.timesheet_date = wl.work_date AND t.timesheet_import_id = wl.timesheet_import_id
  WHERE ${conditions.join(' AND ')}`;

  return { selectSql, replacements };
}

/** Stable tie-breakers so a page boundary never shifts between two requests. */
function orderBySql(sortBy, sortOrder) {
  const direction = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const column = SORTS[sortBy] || SORTS.date;
  return `${column} ${direction} NULLS LAST, work_date DESC, employee_name ASC, work_log_id ASC`;
}

/**
 * One page of entries.
 * @param {object} filters - see buildSelect()
 * @param {{ sortBy?: string, sortOrder?: 'asc'|'desc', limit: number, offset: number }} paging
 * @returns {Promise<object[]>}
 */
async function findPage(filters, { sortBy, sortOrder, limit, offset }) {
  const { selectSql, replacements } = buildSelect(filters);
  return sequelize.query(
    `SELECT * FROM (${selectSql}) rows ORDER BY ${orderBySql(sortBy, sortOrder)} LIMIT :limit OFFSET :offset`,
    { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
  );
}

/** Every entry matching the filters (no paging) for the Excel/CSV export, in the report's default order. */
async function findAll(filters) {
  const { selectSql, replacements } = buildSelect(filters);
  return sequelize.query(
    `SELECT * FROM (${selectSql}) rows ORDER BY work_date DESC, employee_name ASC, work_log_id ASC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Summary of the WHOLE filtered set (not just the current page): the exact row count that drives pagination,
 * plus hour totals — overall and per work type.
 */
async function getSummary(filters) {
  const { selectSql, replacements } = buildSelect(filters);
  const [row] = await sequelize.query(
    `SELECT
       COUNT(*)::int AS total_entries,
       COUNT(DISTINCT employee_id)::int AS employee_count,
       COUNT(*) FILTER (WHERE status = 'synced')::int AS synced_entries,
       COALESCE(SUM(before_sync_hours), 0) AS before_sync_hours,
       COALESCE(SUM(after_sync_hours), 0) AS after_sync_hours,
       COALESCE(SUM(before_sync_hours) FILTER (WHERE work_type = 'own'), 0) AS own_before_hours,
       COALESCE(SUM(after_sync_hours) FILTER (WHERE work_type = 'own'), 0) AS own_after_hours,
       COALESCE(SUM(before_sync_hours) FILTER (WHERE work_type = 'cross'), 0) AS cross_before_hours,
       COALESCE(SUM(after_sync_hours) FILTER (WHERE work_type = 'cross'), 0) AS cross_after_hours,
       COALESCE(SUM(before_sync_hours) FILTER (WHERE work_type = 'na'), 0) AS na_before_hours,
       COALESCE(SUM(after_sync_hours) FILTER (WHERE work_type = 'na'), 0) AS na_after_hours
     FROM (${selectSql}) rows`,
    { replacements, type: QueryTypes.SELECT }
  );
  return row;
}

/**
 * Dropdown options built from the SAME authorized rows (scope + period only), so a dropdown never offers a
 * value the caller could not see in the report.
 * @param {object} filters - { startDate, endDate, scope }
 */
async function getFilterOptions(filters) {
  const { selectSql, replacements } = buildSelect({ startDate: filters.startDate, endDate: filters.endDate, scope: filters.scope });
  const rows = await sequelize.query(
    `SELECT DISTINCT employee_id, employee_code, employee_name, employee_bu_ids, employee_sub_bu_ids,
            client_id, client_name, project_id, project_name,
            service_po_id, service_po_code, service_po_name, is_centralised,
            po_bu_id, po_bu, po_sub_bu_id, po_sub_bu
       FROM (${selectSql}) rows`,
    { replacements, type: QueryTypes.SELECT }
  );

  const buIds = new Set();
  rows.forEach((r) => {
    (r.employee_bu_ids || []).forEach((id) => buIds.add(id));
    (r.employee_sub_bu_ids || []).forEach((id) => buIds.add(id));
  });
  const employeeBus = buIds.size
    ? await sequelize.query(
      'SELECT id, company_name, parent_business_unit_id FROM companies WHERE id IN (:ids) AND is_deleted = false',
      { replacements: { ids: [...buIds] }, type: QueryTypes.SELECT }
    )
    : [];
  return { rows, employeeBus };
}

module.exports = { findPage, findAll, getSummary, getFilterOptions, buildSelect, SORTS };
