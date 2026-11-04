'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');

/**
 * Team Lead Employee PO Hours Report — raw data access (read-only).
 *
 * Matrix report: one row per Employee mapped to the calling Team Lead as PRIMARY or SECONDARY
 * manager (manager_employee_mappings, active rows) x one column per Service PO.
 *
 * Employee visibility is the manager mapping ONLY (same rule as the Team Lead Employee Project
 * Hours report). PO visibility is deliberately NOT restricted by BU: every PO an employee is mapped
 * to (employee_servicepo_mapping) or has approved hours on appears, Cross-BU and Centralised POs
 * included.
 *
 * Hours:
 *   original — employee_work_logs hours with status approved/synced (an entry that was approved and
 *              later synced is still "approved hours"), so the report works before any sync.
 *   adjusted — the official `timesheets` rows a Sync creates, COALESCE(modified_hours, hours_logged)
 *              (after the monthly cap). Only exists once a sync happened.
 *
 * PO-level filters (client / project / service PO / entity / BU / Sub-BU) are shared by the mapped-PO
 * lookup and both hour queries so the three always agree on which POs are in scope.
 */

/**
 * PO-level filter SQL. `companyExpr` is the BU column used for the Entity/BU/Sub-BU filters: for hour
 * rows it falls back to the entry's own company (a Centralised PO has none of its own), for the
 * mapped-PO lookup it is the PO's company only.
 */
function buildPoFilter(filters, { companyExpr, replacements }) {
  const conditions = [];
  const add = (sql, key, value) => { conditions.push(sql); replacements[key] = value; };
  const { clientIds, projectIds, servicePoIds, entityIds, buIds, subBuIds } = filters;

  if (clientIds && clientIds.length) add('sp.client_id IN (:clientIds)', 'clientIds', clientIds);
  if (projectIds && projectIds.length) add('sp.project_id IN (:projectIds)', 'projectIds', projectIds);
  if (servicePoIds && servicePoIds.length) add('sp.id IN (:servicePoIds)', 'servicePoIds', servicePoIds);

  const needsBu = (entityIds && entityIds.length) || (buIds && buIds.length) || (subBuIds && subBuIds.length);
  if (needsBu) {
    const buConditions = [];
    if (entityIds && entityIds.length) { buConditions.push('bu_unit.entity_id IN (:entityIds)'); replacements.entityIds = entityIds; }
    if (buIds && buIds.length) { buConditions.push('COALESCE(bu_parent.id, bu_unit.id) IN (:buIds)'); replacements.buIds = buIds; }
    if (subBuIds && subBuIds.length) { buConditions.push('bu_parent.id IS NOT NULL AND bu_unit.id IN (:subBuIds)'); replacements.subBuIds = subBuIds; }
    conditions.push(buConditions.join(' AND '));
  }
  return { sql: conditions.length ? `AND ${conditions.join(' AND ')}` : '', needsBu: Boolean(needsBu), companyExpr };
}

const BU_JOINS = (companyExpr) => `
    LEFT JOIN companies bu_unit   ON bu_unit.id = ${companyExpr}
    LEFT JOIN companies bu_parent ON bu_parent.id = bu_unit.parent_business_unit_id`;

/**
 * Employees mapped to the caller (PRIMARY/SECONDARY), optionally narrowed by employee ids / search.
 * @returns {Promise<object[]>} [{ employee_id, employee_code, full_name, mapping_type }]
 */
async function findMappedEmployees({ managerEmployeeId, employeeIds, search }) {
  const replacements = { managerEmployeeId };
  const conditions = [];
  if (employeeIds && employeeIds.length) { conditions.push('e.id IN (:employeeIds)'); replacements.employeeIds = employeeIds; }
  if (search && search.trim()) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search.trim()}%`;
  }
  return sequelize.query(
    `SELECT e.id AS employee_id, e.employee_code, e.full_name,
            STRING_AGG(DISTINCT mem.mapping_type, ', ' ORDER BY mem.mapping_type) AS mapping_type
       FROM manager_employee_mappings mem
       INNER JOIN employees e ON e.id = mem.employee_id AND e.is_deleted = false
      WHERE mem.manager_employee_id = :managerEmployeeId
        AND mem.status = 'active'
        AND mem.mapping_type IN ('PRIMARY', 'SECONDARY')
        AND mem.employee_id <> :managerEmployeeId
        ${conditions.length ? `AND ${conditions.join(' AND ')}` : ''}
      GROUP BY e.id, e.employee_code, e.full_name
      ORDER BY e.full_name ASC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * (employee, PO) pairs the employees are actively mapped to — any BU, Centralised included.
 * @returns {Promise<{ employee_id: number, service_po_id: number }[]>}
 */
async function findMappedPos(employeeIds, filters) {
  if (!employeeIds.length) return [];
  const replacements = { employeeIds };
  const po = buildPoFilter(filters, { companyExpr: 'sp.company_id', replacements });
  return sequelize.query(
    `SELECT DISTINCT esm.employee_id, esm.service_po_id
       FROM employee_servicepo_mapping esm
       INNER JOIN service_pos sp ON sp.id = esm.service_po_id AND sp.is_deleted = false
       ${po.needsBu ? BU_JOINS('sp.company_id') : ''}
      WHERE esm.employee_id IN (:employeeIds)
        AND esm.status = 'active'
        ${po.sql}`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Original (approved) hours per employee x PO in the period.
 * @returns {Promise<{ employee_id: number, service_po_id: number, hours: string }[]>}
 */
async function findOriginalHours(employeeIds, { startDate, endDate }, filters) {
  if (!employeeIds.length) return [];
  const replacements = { employeeIds, startDate, endDate };
  const po = buildPoFilter(filters, { companyExpr: 'COALESCE(sp.company_id, wl.company_id)', replacements });
  return sequelize.query(
    `SELECT wl.employee_id, wl.service_po_id, ROUND(SUM(wl.hours)::numeric, 2) AS hours
       FROM employee_work_logs wl
       INNER JOIN service_pos sp ON sp.id = wl.service_po_id AND sp.is_deleted = false
       ${po.needsBu ? BU_JOINS('COALESCE(sp.company_id, wl.company_id)') : ''}
      WHERE wl.employee_id IN (:employeeIds)
        AND wl.status IN ('approved', 'synced')
        AND wl.work_date BETWEEN :startDate AND :endDate
        ${po.sql}
      GROUP BY wl.employee_id, wl.service_po_id`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Adjusted (post-sync) hours per employee x PO in the period, from the official timesheets.
 * @returns {Promise<{ employee_id: number, service_po_id: number, hours: string }[]>}
 */
async function findAdjustedHours(employeeIds, { startDate, endDate }, filters) {
  if (!employeeIds.length) return [];
  const replacements = { employeeIds, startDate, endDate };
  const po = buildPoFilter(filters, { companyExpr: 'COALESCE(sp.company_id, t.company_id)', replacements });
  return sequelize.query(
    `SELECT t.employee_id, t.service_po_id,
            ROUND(SUM(COALESCE(t.modified_hours, t.hours_logged))::numeric, 2) AS hours
       FROM timesheets t
       INNER JOIN service_pos sp ON sp.id = t.service_po_id AND sp.is_deleted = false
       ${po.needsBu ? BU_JOINS('COALESCE(sp.company_id, t.company_id)') : ''}
      WHERE t.employee_id IN (:employeeIds)
        AND t.timesheet_date BETWEEN :startDate AND :endDate
        ${po.sql}
      GROUP BY t.employee_id, t.service_po_id`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Whether ANY synced timesheet row exists for these employees in the period (ignoring PO filters):
 * the "has this month been synced for them" check behind the Adjusted view's message.
 * @returns {Promise<boolean>}
 */
async function hasSyncedData(employeeIds, { startDate, endDate }) {
  if (!employeeIds.length) return false;
  const [row] = await sequelize.query(
    `SELECT EXISTS (
       SELECT 1 FROM timesheets t
        WHERE t.employee_id IN (:employeeIds)
          AND t.timesheet_date BETWEEN :startDate AND :endDate) AS has_sync`,
    { replacements: { employeeIds, startDate, endDate }, type: QueryTypes.SELECT }
  );
  return Boolean(row && row.has_sync);
}

/**
 * Column metadata for a set of Service POs (the same PO is one column no matter how many employees
 * share it). BU / Sub-BU are the PO's own; a Sub-BU's parent is its BU.
 * @returns {Promise<object[]>}
 */
async function findPoColumns(servicePoIds) {
  if (!servicePoIds.length) return [];
  return sequelize.query(
    `SELECT sp.id AS service_po_id, sp.service_po_code, sp.service_po_name, sp.is_centralised,
            c.id AS client_id, c.client_name,
            p.id AS project_id, p.project_name,
            COALESCE(bu_parent.id, bu_unit.id)                              AS bu_id,
            COALESCE(bu_parent.company_name, bu_unit.company_name)          AS bu_name,
            CASE WHEN bu_parent.id IS NOT NULL THEN bu_unit.id END           AS sub_bu_id,
            CASE WHEN bu_parent.id IS NOT NULL THEN bu_unit.company_name END AS sub_bu_name
       FROM service_pos sp
       LEFT JOIN clients c           ON c.id = sp.client_id
       LEFT JOIN projects p          ON p.id = sp.project_id
       LEFT JOIN companies bu_unit   ON bu_unit.id = sp.company_id
       LEFT JOIN companies bu_parent ON bu_parent.id = bu_unit.parent_business_unit_id
      WHERE sp.id IN (:servicePoIds)
      ORDER BY sp.service_po_name ASC, sp.service_po_code ASC`,
    { replacements: { servicePoIds }, type: QueryTypes.SELECT }
  );
}

module.exports = {
  findMappedEmployees,
  findMappedPos,
  findOriginalHours,
  findAdjustedHours,
  hasSyncedData,
  findPoColumns,
};
