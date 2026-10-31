'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { capForCompanyMonthSql } = require('../utils/monthlyCapSql');
const { countableEmployeeSql } = require('../utils/countableEmployeeSql');
const { AI_TS_SPO_SCOPE_SQL, BENCH_PO_NAMES, getSoleContributorRiskRows } = require('./aiInsightDataRepository');

/**
 * Data access for the monthly, sync-gated AI Insights (services/aiInsightMonthly.service.js).
 *
 * Hours only — no cost / resource budget. Capacity is headcount x the Monthly Cap Hours the BU's month was
 * synced with (the admin-set cap stamped on timesheet_import_history.cap_hours; the latest admin setting
 * only when that month has no import) — see utils/monthlyCapSql.js.
 *
 * A Business Unit / Sub-BU counts as SYNCED for a month when it has a completed (or partial) timesheet
 * import for that month: timesheet_import_history.company_id / import_month / import_year.
 */

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => parseFloat(v) || 0;

// Employees of a BU for the month: mapped to it (own company or active employee_business_units row).
const EMPLOYEE_IN_BU_SQL = `(e.company_id = :companyId OR e.id IN (
    SELECT ebu.employee_id FROM employee_business_units ebu
     WHERE ebu.business_unit_id = :companyId AND ebu.status = 'active'))`;

/**
 * The insight units (leaf BU / Sub-BU) with the Admin tenant each belongs to
 * (Company -> Entity -> entities.created_by).
 * @param {number[]} companyIds
 * @returns {Promise<{ id: number, name: string, tenantAdminId: number }[]>}
 */
async function getUnits(companyIds) {
  if (!companyIds.length) return [];
  const rows = await sequelize.query(
    `SELECT c.id, c.company_name, p.company_name AS parent_name, ent.created_by AS tenant_admin_id
       FROM companies c
       JOIN entities ent ON ent.id = c.entity_id AND ent.is_deleted = false
       LEFT JOIN companies p ON p.id = c.parent_business_unit_id
      WHERE c.id IN (:companyIds) AND ent.created_by IS NOT NULL
      ORDER BY c.id`,
    { replacements: { companyIds }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.parent_name ? `${r.parent_name} / ${r.company_name}` : r.company_name,
    tenantAdminId: r.tenant_admin_id,
  }));
}

/**
 * Number of Admin tenants that have at least one active Business Unit / Sub-BU.
 * @returns {Promise<number>}
 */
async function countTenants() {
  const [row] = await sequelize.query(
    `SELECT COUNT(DISTINCT ent.created_by) AS tenants
       FROM companies c JOIN entities ent ON ent.id = c.entity_id AND ent.is_deleted = false
      WHERE c.is_deleted = false AND c.status = 'active' AND ent.created_by IS NOT NULL`,
    { type: QueryTypes.SELECT }
  );
  return parseInt(row.tenants, 10) || 0;
}

/**
 * Which of the given units are synced for the month.
 * @returns {Promise<Set<number>>}
 */
async function getSyncedCompanyIds(companyIds, period) {
  if (!companyIds.length) return new Set();
  const rows = await sequelize.query(
    `SELECT DISTINCT company_id FROM timesheet_import_history
      WHERE import_month = :month AND import_year = :year AND status IN ('completed', 'partial')
        AND company_id IN (:companyIds)`,
    { replacements: { month: period.month, year: period.year, companyIds }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.company_id));
}

/**
 * Everything the BU-level and tenant-level jobs need about ONE unit for ONE month, in one place:
 * per-employee hours vs the admin-set cap, per-PO hours (with client), and totals.
 */
async function getBuMonthSnapshot(companyId, period) {
  const replacements = {
    companyId, startDate: period.start, endDate: period.end, month: period.month, year: period.year, benchNames: BENCH_PO_NAMES,
  };

  const [capRow] = await sequelize.query(
    `SELECT ${capForCompanyMonthSql(':companyId', ':month', ':year')} AS cap_hours`,
    { replacements, type: QueryTypes.SELECT }
  );
  const capHours = num(capRow && capRow.cap_hours);

  const [employeeRows, poRows] = await Promise.all([
    sequelize.query(
      `SELECT e.id AS employee_id, e.full_name, e.designation,
              COALESCE(SUM(t.hours_logged), 0) AS logged_hours,
              COALESCE(SUM(CASE WHEN sp.is_billable THEN t.hours_logged END), 0) AS billable_hours,
              COALESCE(SUM(CASE WHEN LOWER(sp.service_po_name) IN (:benchNames) THEN t.hours_logged END), 0) AS bench_hours
         FROM employees e
         LEFT JOIN timesheets t ON t.employee_id = e.id AND t.timesheet_date BETWEEN :startDate AND :endDate
         LEFT JOIN service_pos sp ON sp.id = t.service_po_id
        WHERE e.is_deleted = false AND ${countableEmployeeSql('e')} AND ${EMPLOYEE_IN_BU_SQL}
        GROUP BY e.id, e.full_name, e.designation, e.status
       HAVING e.status = 'active' OR COALESCE(SUM(t.hours_logged), 0) > 0`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT sp.id AS service_po_id, sp.service_po_name, sp.is_billable, c.id AS client_id, c.client_name,
              SUM(t.hours_logged) AS hours, COUNT(DISTINCT t.employee_id) AS contributors
         FROM timesheets t
         JOIN service_pos sp ON sp.id = t.service_po_id
         LEFT JOIN clients c ON c.id = sp.client_id
        WHERE t.timesheet_date BETWEEN :startDate AND :endDate AND ${AI_TS_SPO_SCOPE_SQL}
        GROUP BY sp.id, sp.service_po_name, sp.is_billable, c.id, c.client_name`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  const employees = employeeRows.map((r) => {
    const logged = num(r.logged_hours);
    return {
      employee_id: r.employee_id,
      name: r.full_name,
      designation: r.designation,
      logged_hours: r2(logged),
      billable_hours: r2(num(r.billable_hours)),
      bench_hours: r2(num(r.bench_hours)),
      utilization_pct: capHours > 0 ? r1((logged / capHours) * 100) : 0,
    };
  });

  const pos = poRows.map((r) => ({
    service_po_id: r.service_po_id,
    po_name: r.service_po_name,
    is_billable: r.is_billable === true,
    client_id: r.client_id,
    client_name: r.client_name || 'No client',
    hours: r2(num(r.hours)),
    contributors: parseInt(r.contributors, 10) || 0,
  }));

  const sum = (key) => employees.reduce((s, e) => s + e[key], 0);
  const logged = sum('logged_hours');
  const billable = sum('billable_hours');
  const bench = sum('bench_hours');
  const capacity = employees.length * capHours;
  const totals = {
    headcount: employees.length,
    capacity_hours: r2(capacity),
    logged_hours: r2(logged),
    billable_hours: r2(billable),
    non_billable_hours: r2(logged - billable),
    bench_hours: r2(bench),
    utilization_pct: capacity > 0 ? r1((logged / capacity) * 100) : 0,
    billable_utilization_pct: capacity > 0 ? r1((billable / capacity) * 100) : 0,
  };

  return { company_id: companyId, cap_hours: capHours, totals, employees, pos };
}

/**
 * In-progress Service POs of the BU whose end date is on/before the month end (overdue) or within 30 days
 * after it. Dates are measured from the month end, not from "today", so the result is stable for the month.
 */
async function getPoTimelineRows(companyId, period) {
  return sequelize.query(
    `SELECT sp.id AS service_po_id, sp.service_po_name AS po_name, c.client_name, sp.end_date,
            (:endDate::date - sp.end_date) AS days_past_month_end
       FROM service_pos sp
       LEFT JOIN clients c ON c.id = sp.client_id
      WHERE sp.is_deleted = false AND sp.status = 'in-progress' AND sp.company_id = :companyId
        AND sp.end_date IS NOT NULL AND sp.end_date <= (:endDate::date + 30)
      ORDER BY sp.end_date`,
    { replacements: { companyId, endDate: period.end }, type: QueryTypes.SELECT }
  );
}

/**
 * Timesheet compliance (employee work logs) of the BU for the month — needs no sync.
 */
async function getComplianceData(companyId, period) {
  const replacements = { companyId, startDate: period.start, endDate: period.end };
  const scopeSql = `wl.employee_id IN (SELECT e.id FROM employees e WHERE e.is_deleted = false AND ${EMPLOYEE_IN_BU_SQL})`;

  const [byStatus, pendingByManager, missing] = await Promise.all([
    sequelize.query(
      `SELECT wl.status, COUNT(*) AS logs, COUNT(DISTINCT wl.employee_id) AS employees
         FROM employee_work_logs wl
        WHERE wl.work_date BETWEEN :startDate AND :endDate AND ${scopeSql}
        GROUP BY wl.status`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT COALESCE(m.full_name, 'No primary manager') AS manager_name,
              COUNT(*) AS pending_logs, COUNT(DISTINCT wl.employee_id) AS employees,
              TO_CHAR(MIN(wl.work_date), 'YYYY-MM-DD') AS oldest_pending_date
         FROM employee_work_logs wl
         LEFT JOIN manager_employee_mappings mm
           ON mm.employee_id = wl.employee_id AND mm.mapping_type = 'PRIMARY' AND mm.status = 'active'
         LEFT JOIN employees m ON m.id = mm.manager_employee_id
        WHERE wl.status = 'pending' AND wl.work_date BETWEEN :startDate AND :endDate AND ${scopeSql}
        GROUP BY COALESCE(m.full_name, 'No primary manager')
        ORDER BY pending_logs DESC LIMIT 10`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT e.full_name FROM employees e
        WHERE e.is_deleted = false AND e.status = 'active' AND ${countableEmployeeSql('e')} AND ${EMPLOYEE_IN_BU_SQL}
          AND NOT EXISTS (SELECT 1 FROM employee_work_logs wl
                           WHERE wl.employee_id = e.id AND wl.work_date BETWEEN :startDate AND :endDate)
        ORDER BY e.full_name`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  const logsByStatus = {};
  byStatus.forEach((r) => { logsByStatus[r.status] = parseInt(r.logs, 10); });
  const pending = byStatus.find((r) => r.status === 'pending');

  return {
    work_logs_by_status: logsByStatus,
    pending_approval_logs: pending ? parseInt(pending.logs, 10) : 0,
    employees_with_pending_logs: pending ? parseInt(pending.employees, 10) : 0,
    pending_by_primary_manager: pendingByManager.map((r) => ({
      manager: r.manager_name,
      pending_logs: parseInt(r.pending_logs, 10),
      employees: parseInt(r.employees, 10),
      oldest_pending_date: r.oldest_pending_date,
    })),
    employees_without_any_log_count: missing.length,
    employees_without_any_log: missing.slice(0, 10).map((r) => r.full_name),
  };
}

/**
 * Pending-approval work logs of one BU for the month (a single number, for the sync & compliance health report).
 */
async function getPendingApprovalCount(companyId, period) {
  const [row] = await sequelize.query(
    `SELECT COUNT(*) AS logs FROM employee_work_logs wl
      WHERE wl.status = 'pending' AND wl.work_date BETWEEN :startDate AND :endDate
        AND wl.employee_id IN (SELECT e.id FROM employees e WHERE e.is_deleted = false AND ${EMPLOYEE_IN_BU_SQL})`,
    { replacements: { companyId, startDate: period.start, endDate: period.end }, type: QueryTypes.SELECT }
  );
  return parseInt(row.logs, 10) || 0;
}

module.exports = {
  countTenants,
  getUnits,
  getSyncedCompanyIds,
  getBuMonthSnapshot,
  getPoTimelineRows,
  getComplianceData,
  getPendingApprovalCount,
  getSoleContributorRiskRows,
};
