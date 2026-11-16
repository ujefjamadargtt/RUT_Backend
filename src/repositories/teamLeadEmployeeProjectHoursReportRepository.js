'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');

/**
 * Team Lead Employee Project Hours Report — raw data access.
 *
 * One row per Employee Work Log entry (employee_work_logs) of an Employee
 * mapped to the calling Team Lead as PRIMARY or SECONDARY manager
 * (manager_employee_mappings, active rows only). That mapping is the ONLY
 * access path: BU/company membership, Service PO membership and the Project
 * Manager relationship (employee_servicepo_mapping) are never consulted, so a
 * PM mapping can't make anyone visible here. The caller never sees their own
 * entries (same self-exclusion as managerSelfServiceService.getMyEmployees).
 *
 * Source is employee_work_logs, not `timesheets`: it is what the Team Lead
 * approves, and the only place that carries each entry's own description and
 * status (pending/approved/rejected/synced) — `timesheets` has no status and
 * merges several entries into one row per employee/PO/date.
 *
 * BU / Sub-BU come from the Service PO's own company: a company with a
 * parent is a Sub-BU (its parent is the BU). A Centralised PO has no BU of
 * its own, so the entry's own company_id (the employee's BU when logged) is
 * used instead.
 */

// Whitelisted ORDER BY expressions — never interpolate a caller value.
const SORT_SQL = {
  employee: 'employee_name',
  client: 'client_name',
  project: 'project_name',
  spo: 'spo_name',
  hours: 'logged_hours',
  status: 'status',
  date: 'work_date',
};

/**
 * @param {object} filters
 * @param {number} filters.managerEmployeeId - the authenticated caller (never client-supplied)
 * @param {string} [filters.startDate] - inclusive YYYY-MM-DD
 * @param {string} [filters.endDate] - inclusive YYYY-MM-DD
 * @param {number[]} [filters.employeeIds]
 * @param {number[]} [filters.clientIds]
 * @param {number[]} [filters.projectIds]
 * @param {number[]} [filters.servicePoIds]
 * @param {number[]} [filters.buIds] - top-level BU (matches its Sub-BUs' POs too)
 * @param {number[]} [filters.subBuIds]
 * @param {string[]} [filters.statuses]
 * @param {string} [filters.search] - employee name/code or entry description
 * @param {string} [filters.sortBy] - key of SORT_SQL
 * @param {'asc'|'desc'} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {Promise<{ rows: object[], total: number, totalHours: number }>}
 */
async function getTeamLeadEmployeeProjectHours(filters) {
  const { sortBy, sortOrder = 'desc', limit, offset } = filters;
  const { base, replacements } = buildBaseQuery(filters);

  const direction = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sortColumn = SORT_SQL[sortBy] || 'work_date';
  // Stable tie-breakers so page boundaries never shift between requests.
  const orderBy = `${sortColumn} ${direction} NULLS LAST, work_date DESC, employee_name ASC, work_log_id ASC`;

  const [rows, [agg]] = await Promise.all([
    sequelize.query(`${base} ORDER BY ${orderBy} LIMIT :limit OFFSET :offset`, {
      replacements: { ...replacements, limit, offset },
      type: QueryTypes.SELECT,
    }),
    sequelize.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(logged_hours), 0) AS total_hours FROM (${base}) filtered`, {
      replacements,
      type: QueryTypes.SELECT,
    }),
  ]);

  return { rows, total: agg ? agg.total : 0, totalHours: agg ? parseFloat(agg.total_hours) || 0 : 0 };
}

/**
 * Every row matching the same filters (no LIMIT, no count query) for the
 * Excel export — same authorized buildBaseQuery() as the paged report, in the
 * report's default order (newest first, then employee).
 * @param {object} filters - as getTeamLeadEmployeeProjectHours(), minus sort/limit/offset
 * @returns {Promise<object[]>}
 */
async function getAllTeamLeadEmployeeProjectHours(filters) {
  const { base, replacements } = buildBaseQuery(filters);
  return sequelize.query(`${base} ORDER BY work_date DESC, employee_name ASC, work_log_id ASC`, {
    replacements,
    type: QueryTypes.SELECT,
  });
}

/**
 * Filter dropdown options for the report, built from the SAME authorized
 * data (the caller's own Primary/Secondary-mapped Employees and their work
 * logs) — the generic master lists don't fit here: GET /companies is closed
 * to Team Leads, and the Client/Project/SPO lists are limited to the caller's
 * OWN Business Units, while a mapped Employee may log time on another BU's
 * Service PO.
 *
 * Employees: every mapped Employee (even with no entries yet). Clients /
 * Projects / SPOs / BUs / Sub-BUs: only those actually present in the mapped
 * Employees' entries within the optional date range.
 *
 * entityIds / buIds / subBuIds (all optional) narrow the Clients/Projects/SPOs/BUs (rows whose Service PO
 * belongs to them) and, through `employeeBusinessUnitIds`, the Employees (those mapped to any of those BUs).
 *
 * @param {{ managerEmployeeId: number, startDate?: string, endDate?: string, entityIds?: number[], buIds?: number[], subBuIds?: number[], employeeBusinessUnitIds?: number[]|null }} filters
 * @returns {Promise<{ employees: object[], clients: object[], projects: object[], servicePos: object[], businessUnits: object[], subBusinessUnits: object[] }>}
 */
async function getFilterOptions({ managerEmployeeId, startDate, endDate, entityIds, buIds, subBuIds, employeeBusinessUnitIds = null }) {
  const { base, replacements } = buildBaseQuery({ managerEmployeeId, startDate, endDate, entityIds, buIds, subBuIds });

  // Employees stay "every mapped Employee" unless a BU/Entity filter is sent — then only those
  // actively mapped to one of the resulting BUs (an empty resulting set matches nobody).
  let employeeBuFilter = '';
  const employeeReplacements = { managerEmployeeId };
  if (employeeBusinessUnitIds !== null) {
    if (employeeBusinessUnitIds.length === 0) {
      employeeBuFilter = 'AND 1 = 0';
    } else {
      employeeBuFilter = "AND e.id IN (SELECT ebu.employee_id FROM employee_business_units ebu WHERE ebu.status = 'active' AND ebu.business_unit_id IN (:employeeBusinessUnitIds))";
      employeeReplacements.employeeBusinessUnitIds = employeeBusinessUnitIds;
    }
  }

  const [employees, combos] = await Promise.all([
    sequelize.query(`
      SELECT e.id, e.employee_code, e.full_name,
             STRING_AGG(DISTINCT mem.mapping_type, ', ' ORDER BY mem.mapping_type) AS mapping_type
      FROM manager_employee_mappings mem
      INNER JOIN employees e ON e.id = mem.employee_id AND e.is_deleted = false
      WHERE mem.manager_employee_id = :managerEmployeeId
        AND mem.status = 'active'
        AND mem.mapping_type IN ('PRIMARY', 'SECONDARY')
        AND mem.employee_id <> :managerEmployeeId
        ${employeeBuFilter}
      GROUP BY e.id, e.employee_code, e.full_name
      ORDER BY e.full_name`, { replacements: employeeReplacements, type: QueryTypes.SELECT }),
    sequelize.query(`
      SELECT DISTINCT client_id, client_name, project_id, project_name, service_po_id, service_po_code, spo_name,
                      bu_id, bu_name, sub_bu_id, sub_bu_name
      FROM (${base}) scoped`, { replacements, type: QueryTypes.SELECT }),
  ]);

  const unique = (items, keyOf) => {
    const map = new Map();
    items.forEach((item) => { const k = keyOf(item); if (k != null && !map.has(k)) map.set(k, item); });
    return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };

  return {
    employees,
    clients: unique(combos.map((c) => ({ id: c.client_id, name: c.client_name })), (c) => c.id),
    projects: unique(combos.map((c) => ({ id: c.project_id, name: c.project_name, client_id: c.client_id })), (c) => c.id),
    servicePos: unique(combos.map((c) => ({
      id: c.service_po_id, name: c.spo_name, code: c.service_po_code, project_id: c.project_id, client_id: c.client_id,
      bu_id: c.bu_id, sub_bu_id: c.sub_bu_id,
    })), (c) => c.id),
    businessUnits: unique(combos.map((c) => ({ id: c.bu_id, name: c.bu_name })), (c) => c.id),
    subBusinessUnits: unique(combos.map((c) => ({ id: c.sub_bu_id, name: c.sub_bu_name, parent_business_unit_id: c.bu_id })), (c) => c.id),
  };
}

/**
 * The shared, fully authorized + filtered row set (see the file doc comment)
 * — everything but ORDER BY / LIMIT, so the page query, the count/total-hours
 * query and the filter options all read exactly the same rows.
 * @returns {{ base: string, replacements: object }}
 */
function buildBaseQuery(filters) {
  const {
    managerEmployeeId, startDate, endDate, employeeIds, clientIds, projectIds, servicePoIds,
    entityIds, buIds, subBuIds, statuses, search,
  } = filters;

  const replacements = { managerEmployeeId };
  const conditions = [];
  const add = (sql, key, value) => { conditions.push(sql); replacements[key] = value; };

  if (startDate) add('wl.work_date >= :startDate', 'startDate', startDate);
  if (endDate) add('wl.work_date <= :endDate', 'endDate', endDate);
  if (employeeIds && employeeIds.length) add('wl.employee_id IN (:employeeIds)', 'employeeIds', employeeIds);
  if (clientIds && clientIds.length) add('sp.client_id IN (:clientIds)', 'clientIds', clientIds);
  if (projectIds && projectIds.length) add('sp.project_id IN (:projectIds)', 'projectIds', projectIds);
  if (servicePoIds && servicePoIds.length) add('wl.service_po_id IN (:servicePoIds)', 'servicePoIds', servicePoIds);
  if (entityIds && entityIds.length) add('bu_unit.entity_id IN (:entityIds)', 'entityIds', entityIds);
  if (buIds && buIds.length) add('COALESCE(bu_parent.id, bu_unit.id) IN (:buIds)', 'buIds', buIds);
  if (subBuIds && subBuIds.length) add('bu_parent.id IS NOT NULL AND bu_unit.id IN (:subBuIds)', 'subBuIds', subBuIds);
  if (statuses && statuses.length) add('wl.status IN (:statuses)', 'statuses', statuses);
  if (search && search.trim()) {
    add('(e.full_name ILIKE :search OR e.employee_code ILIKE :search OR wl.description ILIKE :search)', 'search', `%${search.trim()}%`);
  }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const base = `
    WITH my_employees AS (
      SELECT mem.employee_id,
             STRING_AGG(DISTINCT mem.mapping_type, ', ' ORDER BY mem.mapping_type) AS mapping_type
      FROM manager_employee_mappings mem
      WHERE mem.manager_employee_id = :managerEmployeeId
        AND mem.status = 'active'
        AND mem.mapping_type IN ('PRIMARY', 'SECONDARY')
        AND mem.employee_id <> :managerEmployeeId
      GROUP BY mem.employee_id
    )
    SELECT
      wl.id                                                      AS work_log_id,
      wl.work_date,
      e.id                                                       AS employee_id,
      e.employee_code,
      e.full_name                                                AS employee_name,
      me.mapping_type,
      c.id                                                       AS client_id,
      c.client_name,
      p.id                                                       AS project_id,
      p.project_name,
      sp.id                                                      AS service_po_id,
      sp.service_po_code,
      sp.service_po_name                                         AS spo_name,
      -- "Module / Task" (hours_name): the Module/Task (hierarchy node) the hours were logged
      -- against, as "Parent > Child"; NULL when logged on the SPO directly.
      CASE
        WHEN hp.id IS NOT NULL THEN hp.node_name || ' > ' || hn.node_name
        ELSE hn.node_name
      END                                                        AS hours_name,
      COALESCE(bu_parent.id, bu_unit.id)                         AS bu_id,
      COALESCE(bu_parent.company_name, bu_unit.company_name)     AS bu_name,
      CASE WHEN bu_parent.id IS NOT NULL THEN bu_unit.id END           AS sub_bu_id,
      CASE WHEN bu_parent.id IS NOT NULL THEN bu_unit.company_name END AS sub_bu_name,
      wl.hours                                                   AS logged_hours,
      wl.description,
      wl.status
    FROM (SELECT * FROM employee_work_logs WHERE deleted_at IS NULL) wl
    INNER JOIN my_employees me          ON me.employee_id = wl.employee_id
    INNER JOIN employees e              ON e.id = wl.employee_id AND e.is_deleted = false
    INNER JOIN service_pos sp           ON sp.id = wl.service_po_id
    LEFT JOIN clients c                 ON c.id = sp.client_id
    LEFT JOIN projects p                ON p.id = sp.project_id
    LEFT JOIN service_po_hierarchy hn   ON hn.id = wl.hierarchy_node_id
    LEFT JOIN service_po_hierarchy hp   ON hp.id = hn.parent_hierarchy_id
    LEFT JOIN companies bu_unit         ON bu_unit.id = COALESCE(sp.company_id, wl.company_id)
    LEFT JOIN companies bu_parent       ON bu_parent.id = bu_unit.parent_business_unit_id
    WHERE 1 = 1 ${where}`;

  return { base, replacements };
}

module.exports = { getTeamLeadEmployeeProjectHours, getAllTeamLeadEmployeeProjectHours, getFilterOptions, SORT_SQL };
