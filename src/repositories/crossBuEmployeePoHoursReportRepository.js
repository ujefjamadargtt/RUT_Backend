'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Cross-BU Employee & Service PO Hours Report — raw SQL over employee_work_logs
 * (the same source the Project-Wise Timesheet / Work Log Hours Summary reports
 * use: it carries the Service PO hierarchy node and the approval status),
 * never the official `timesheets` table. Read-only.
 *
 * Employee BU and PO BU are two INDEPENDENT dimensions and nothing here ever
 * collapses them into one filter:
 *   Employee BU / Sub-BU  <- employee_business_units (active rows; the legacy
 *                            employees.company_id only when an employee has no
 *                            membership at all)
 *   PO BU                 <- service_pos.company_id
 * A Sub-BU rolls up to its Parent BU (companies.parent_business_unit_id) for
 * the Own/Cross comparison, so a Sub-BU employee working on a Parent-level PO
 * of the same BU family is Own BU work.
 *
 * Work type, derived per row:
 *   own  — the PO's BU is one of the employee's BUs
 *   cross — the PO has a BU and the employee has BUs, but it is none of them
 *   na   — not classifiable: Centralised PO (Leave/Bench/...), a PO with no BU,
 *          or an employee with no BU. Never silently dropped.
 *
 * One output row = Employee + Service PO + month (total hours on that PO; the Service PO's
 * Activity/Task hierarchy is deliberately NOT part of this report).
 */

const WORK_TYPE_SQL = `CASE
  WHEN sp.is_centralised IS TRUE THEN 'na'
  WHEN po_root.id IS NULL OR eb.bu_ids IS NULL THEN 'na'
  WHEN po_root.id = ANY(eb.bu_ids) THEN 'own'
  ELSE 'cross'
END`;

// The Employee BU a row's hours are attributed to in the BU -> BU matrix. An employee in several
// BUs must not be counted once per BU (that would multiply their hours), so: own work is
// attributed to the BU that owns the PO, anything else to the employee's primary BU.
const EMPLOYEE_HOME_BU_SQL = `CASE
  WHEN po_root.id IS NOT NULL AND eb.bu_ids IS NOT NULL AND po_root.id = ANY(eb.bu_ids) THEN po_root.id
  ELSE eb.primary_bu_id
END`;

// Static allow-list: sort_by only ever selects one of these literals, never reaches the SQL itself.
// `hours` follows the Hours basis: Original = the as-logged hours (`hours` / logged_hours), Adjusted = the
// after-cap `adjusted_hours` (NULL — unsynced — rows last).
const SORTS = {
  employee: 'e.full_name ASC, sp.service_po_name ASC',
  po: 'sp.service_po_name ASC, e.full_name ASC',
  hours: 'hours DESC, e.full_name ASC',
  hours_adjusted: 'adjusted_hours DESC NULLS LAST, e.full_name ASC',
  work_type: 'work_type ASC, e.full_name ASC, sp.service_po_name ASC',
};

/** ORDER BY literal for a sort_by key under the given Hours basis ('O' = Original, anything else = Adjusted). */
function resolveOrderBy(sortBy, hoursSource) {
  if (sortBy === 'hours') return hoursSource === 'O' ? SORTS.hours : SORTS.hours_adjusted;
  return SORTS[sortBy] || SORTS.employee;
}

// Employee -> set of BUs, rolled up to the top-level BU, plus the Sub-BUs they sit in.
const CTE_SQL = `
  WITH emp_membership AS (
    SELECT m.employee_id, m.business_unit_id
      FROM employee_business_units m
     WHERE m.status = 'active'
    UNION
    SELECT e0.id, e0.company_id
      FROM employees e0
     WHERE e0.company_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM employee_business_units x WHERE x.employee_id = e0.id AND x.status = 'active')
  ),
  emp_bu AS (
    SELECT em.employee_id,
           ARRAY_AGG(DISTINCT c.id) AS member_ids,
           ARRAY_AGG(DISTINCT COALESCE(c.parent_business_unit_id, c.id)) AS bu_ids,
           ARRAY_AGG(DISTINCT c.id) FILTER (WHERE c.parent_business_unit_id IS NOT NULL) AS sub_bu_ids,
           STRING_AGG(DISTINCT root.company_name, ', ') AS bu_names,
           STRING_AGG(DISTINCT c.company_name, ', ') FILTER (WHERE c.parent_business_unit_id IS NOT NULL) AS sub_bu_names,
           COALESCE(
             MIN(COALESCE(c.parent_business_unit_id, c.id)) FILTER (WHERE c.id = e1.company_id),
             MIN(COALESCE(c.parent_business_unit_id, c.id))
           ) AS primary_bu_id
      FROM emp_membership em
      JOIN employees e1 ON e1.id = em.employee_id
      JOIN companies c ON c.id = em.business_unit_id AND c.is_deleted = false
      JOIN companies root ON root.id = COALESCE(c.parent_business_unit_id, c.id)
     GROUP BY em.employee_id
  )`;

// Adjusted (after monthly-cap) hours per Employee + PO + month. They only exist on the official
// `timesheets` rows a Sync creates, so an unsynced work log has none (NULL, never a guess).
const ADJUSTED_HOURS_CTE_SQL = `,
  ts_adj AS (
    SELECT t.employee_id, t.service_po_id,
           EXTRACT(MONTH FROM t.timesheet_date)::int AS m,
           EXTRACT(YEAR FROM t.timesheet_date)::int AS y,
           SUM(COALESCE(t.modified_hours, t.hours_logged)) AS adj_hours
      FROM timesheets t
     WHERE t.timesheet_date BETWEEN :startDate AND :endDate
     GROUP BY t.employee_id, t.service_po_id, EXTRACT(MONTH FROM t.timesheet_date), EXTRACT(YEAR FROM t.timesheet_date)
  )`;

const FROM_SQL = `
  FROM employee_work_logs wl
  JOIN employees e        ON e.id = wl.employee_id AND e.is_deleted = false
  JOIN service_pos sp     ON sp.id = wl.service_po_id
  LEFT JOIN emp_bu eb     ON eb.employee_id = e.id
  LEFT JOIN clients cl    ON cl.id = sp.client_id
  LEFT JOIN projects p    ON p.id = sp.project_id
  LEFT JOIN companies po_bu   ON po_bu.id = sp.company_id
  LEFT JOIN companies po_root ON po_root.id = COALESCE(po_bu.parent_business_unit_id, po_bu.id)`;

/**
 * @param {object} f
 * @param {string} f.startDate
 * @param {string} f.endDate
 * @param {{ kind: 'reach', reachIds: number[], includeTenantBuLessPOs: boolean }
 *   | { kind: 'servicePos', servicePoIds: number[] }
 *   | { kind: 'employees', employeeIds: number[] }} f.scope - the caller's hard visibility
 * @param {number[]|null} [f.employeeIds]
 * @param {number[]|null} [f.employeeBuIds] - already expanded to include Sub-BUs
 * @param {number[]|null} [f.employeeSubBuIds]
 * @param {number[]|null} [f.clientIds]
 * @param {number[]|null} [f.projectIds]
 * @param {number[]|null} [f.servicePoIds]
 * @param {number[]|null} [f.poBuIds] - already expanded to include Sub-BUs
 * @param {string[]|null} [f.statuses]
 * @param {'own'|'cross'|'na'|null} [f.workType]
 * @param {string|null} [f.search]
 */
function buildWhere(f) {
  // Adjusted hours exist only for synced work, so a status filter that excludes 'synced' has none to show.
  const replacements = {
    startDate: f.startDate,
    endDate: f.endDate,
    includeSynced: !f.statuses || f.statuses.includes('synced'),
  };
  const conditions = ['wl.work_date BETWEEN :startDate AND :endDate'];

  // Visibility. For the BU-scoped tiers a row is visible when EITHER the employee belongs to one
  // of the caller's BUs (their own people, wherever they worked) OR the PO belongs to one of the
  // caller's BUs (anyone who worked on their POs) — the two halves are what make cross-BU work
  // visible from both sides.
  const { scope } = f;
  if (scope.kind === 'reach') {
    replacements.reachIds = scope.reachIds;
    const parts = ['eb.member_ids && ARRAY[:reachIds]::int[]', 'sp.company_id IN (:reachIds)'];
    if (scope.includeTenantBuLessPOs) {
      parts.push(`(sp.company_id IS NULL AND sp.created_by IN (
        SELECT tenant_e.created_by FROM companies tenant_c
          JOIN entities tenant_e ON tenant_e.id = tenant_c.entity_id AND tenant_e.is_deleted = false
         WHERE tenant_c.id IN (:reachIds) AND tenant_c.is_deleted = false AND tenant_e.created_by IS NOT NULL
        UNION
        SELECT tenant_e.entity_admin_employee_id FROM companies tenant_c
          JOIN entities tenant_e ON tenant_e.id = tenant_c.entity_id AND tenant_e.is_deleted = false
         WHERE tenant_c.id IN (:reachIds) AND tenant_c.is_deleted = false AND tenant_e.entity_admin_employee_id IS NOT NULL))`);
    }
    conditions.push(`(${parts.join(' OR ')})`);
  } else if (scope.kind === 'servicePos') {
    conditions.push('wl.service_po_id IN (:scopeServicePoIds)');
    replacements.scopeServicePoIds = scope.servicePoIds;
  } else {
    conditions.push('wl.employee_id IN (:scopeEmployeeIds)');
    replacements.scopeEmployeeIds = scope.employeeIds;
  }

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
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${f.search}%`;
  }

  return { whereSql: conditions.join(' AND '), replacements };
}

/**
 * One page (or, with no limit, every row) of Employee x PO x month rows, plus the
 * total row count of the whole filtered set (window COUNT, so a page query needs no second one).
 */
async function findRows(filters, { sortBy = 'employee', hoursSource, limit = null, offset = 0 } = {}) {
  const { whereSql, replacements } = buildWhere(filters);
  const orderBy = resolveOrderBy(sortBy, hoursSource);
  const paging = limit != null ? 'LIMIT :limit OFFSET :offset' : '';

  return sequelize.query(
    `${CTE_SQL}${ADJUSTED_HOURS_CTE_SQL}
     SELECT
       e.id AS employee_id,
       e.employee_code,
       e.full_name AS employee_name,
       eb.bu_names AS employee_bu,
       eb.sub_bu_names AS employee_sub_bu,
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
       CASE WHEN po_bu.parent_business_unit_id IS NOT NULL THEN po_bu.company_name END AS po_sub_bu,
       EXTRACT(MONTH FROM wl.work_date)::int AS month,
       EXTRACT(YEAR FROM wl.work_date)::int AS year,
       ROUND(SUM(wl.hours)::NUMERIC, 2) AS hours,
       CASE WHEN :includeSynced THEN ROUND(MAX(ta.adj_hours)::NUMERIC, 2) END AS adjusted_hours,
       COUNT(DISTINCT wl.work_date)::int AS days_logged,
       (${WORK_TYPE_SQL}) AS work_type,
       COUNT(*) OVER() AS total_rows
     ${FROM_SQL}
     LEFT JOIN ts_adj ta ON ta.employee_id = e.id AND ta.service_po_id = sp.id
                        AND ta.m = EXTRACT(MONTH FROM wl.work_date)::int AND ta.y = EXTRACT(YEAR FROM wl.work_date)::int
     WHERE ${whereSql}
     GROUP BY e.id, e.employee_code, e.full_name, eb.bu_names, eb.sub_bu_names, cl.id, cl.client_name,
              p.id, p.project_name, sp.id, sp.service_po_code, sp.service_po_name, sp.is_centralised,
              po_root.id, po_root.company_name, po_bu.parent_business_unit_id, po_bu.company_name,
              eb.bu_ids,
              EXTRACT(MONTH FROM wl.work_date), EXTRACT(YEAR FROM wl.work_date)
     ORDER BY ${orderBy}, year ASC, month ASC
     ${paging}`,
    { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
  );
}

/** Whole-filtered-set summary cards: hours by work type and unique employees. */
async function getTotals(filters) {
  const { whereSql, replacements } = buildWhere(filters);
  const adjusted = replacements.includeSynced
    ? await sequelize.query(
      `${CTE_SQL},
       keys AS (SELECT DISTINCT wl.employee_id, wl.service_po_id, wl.work_date, (${WORK_TYPE_SQL}) AS work_type ${FROM_SQL} WHERE ${whereSql})
       SELECT
         COALESCE(ROUND(SUM(COALESCE(t.modified_hours, t.hours_logged))::NUMERIC, 2), 0) AS adjusted_total_hours,
         COALESCE(ROUND(SUM(CASE WHEN k.work_type = 'own' THEN COALESCE(t.modified_hours, t.hours_logged) ELSE 0 END)::NUMERIC, 2), 0) AS adjusted_own_bu_hours,
         COALESCE(ROUND(SUM(CASE WHEN k.work_type = 'cross' THEN COALESCE(t.modified_hours, t.hours_logged) ELSE 0 END)::NUMERIC, 2), 0) AS adjusted_cross_bu_hours,
         COALESCE(ROUND(SUM(CASE WHEN k.work_type = 'na' THEN COALESCE(t.modified_hours, t.hours_logged) ELSE 0 END)::NUMERIC, 2), 0) AS adjusted_unclassified_hours
         FROM timesheets t
         JOIN keys k ON k.employee_id = t.employee_id AND k.service_po_id = t.service_po_id AND k.work_date = t.timesheet_date`,
      { replacements, type: QueryTypes.SELECT }
    )
    : [{ adjusted_total_hours: 0, adjusted_own_bu_hours: 0, adjusted_cross_bu_hours: 0, adjusted_unclassified_hours: 0 }];
  const [row] = await sequelize.query(
    `${CTE_SQL}
     SELECT
       COUNT(DISTINCT wl.employee_id)::int AS employee_count,
       COALESCE(ROUND(SUM(wl.hours)::NUMERIC, 2), 0) AS total_hours,
       COALESCE(ROUND(SUM(CASE WHEN (${WORK_TYPE_SQL}) = 'own' THEN wl.hours ELSE 0 END)::NUMERIC, 2), 0) AS own_bu_hours,
       COALESCE(ROUND(SUM(CASE WHEN (${WORK_TYPE_SQL}) = 'cross' THEN wl.hours ELSE 0 END)::NUMERIC, 2), 0) AS cross_bu_hours,
       COALESCE(ROUND(SUM(CASE WHEN (${WORK_TYPE_SQL}) = 'na' THEN wl.hours ELSE 0 END)::NUMERIC, 2), 0) AS unclassified_hours,
       COUNT(DISTINCT CASE WHEN (${WORK_TYPE_SQL}) = 'cross' THEN wl.employee_id END)::int AS cross_bu_employee_count
     ${FROM_SQL}
     WHERE ${whereSql}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return {
    ...row,
    adjusted_total_hours: adjusted[0].adjusted_total_hours,
    adjusted_own_bu_hours: adjusted[0].adjusted_own_bu_hours,
    adjusted_cross_bu_hours: adjusted[0].adjusted_cross_bu_hours,
    adjusted_unclassified_hours: adjusted[0].adjusted_unclassified_hours,
  };
}

/**
 * Employee BU x PO BU hours (every pair that has hours, own pairs included) — the service
 * pivots this one result into both "Employee BU -> PO BU" and "PO BU -> Employee BU".
 */
async function getBuMatrix(filters) {
  const { whereSql, replacements } = buildWhere(filters);
  return sequelize.query(
    `${CTE_SQL}
     SELECT
       emp_home.id AS employee_bu_id,
       emp_home.company_name AS employee_bu,
       po_root.id AS po_bu_id,
       po_root.company_name AS po_bu,
       ROUND(SUM(wl.hours)::NUMERIC, 2) AS hours,
       COUNT(DISTINCT wl.employee_id)::int AS employee_count
     ${FROM_SQL}
     LEFT JOIN companies emp_home ON emp_home.id = (${EMPLOYEE_HOME_BU_SQL})
     WHERE ${whereSql} AND sp.is_centralised IS NOT TRUE
     GROUP BY emp_home.id, emp_home.company_name, po_root.id, po_root.company_name
     ORDER BY SUM(wl.hours) DESC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Same Employee BU x PO BU pairs as getBuMatrix(), but with the ADJUSTED (after-cap) hours of the synced
 * timesheets of those same Employee + PO + day keys — used by the Adjusted-basis export. A pair whose work is
 * not synced yet has no adjusted hours and does not appear (0, never a guess).
 */
async function getBuMatrixAdjusted(filters) {
  const { whereSql, replacements } = buildWhere(filters);
  if (!replacements.includeSynced) return [];
  return sequelize.query(
    `${CTE_SQL},
     keys AS (
       SELECT DISTINCT wl.employee_id, wl.service_po_id, wl.work_date,
              emp_home.id AS employee_bu_id, emp_home.company_name AS employee_bu,
              po_root.id AS po_bu_id, po_root.company_name AS po_bu
       ${FROM_SQL}
       LEFT JOIN companies emp_home ON emp_home.id = (${EMPLOYEE_HOME_BU_SQL})
       WHERE ${whereSql} AND sp.is_centralised IS NOT TRUE
     )
     SELECT
       k.employee_bu_id,
       k.employee_bu,
       k.po_bu_id,
       k.po_bu,
       ROUND(SUM(COALESCE(t.modified_hours, t.hours_logged))::NUMERIC, 2) AS hours,
       COUNT(DISTINCT k.employee_id)::int AS employee_count
     FROM timesheets t
     JOIN keys k ON k.employee_id = t.employee_id AND k.service_po_id = t.service_po_id AND k.work_date = t.timesheet_date
     GROUP BY k.employee_bu_id, k.employee_bu, k.po_bu_id, k.po_bu
     ORDER BY SUM(COALESCE(t.modified_hours, t.hours_logged)) DESC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

module.exports = { findRows, getTotals, getBuMatrix, getBuMatrixAdjusted, buildWhere, resolveOrderBy, WORK_TYPE_SQL };
