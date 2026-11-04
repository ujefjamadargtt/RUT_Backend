'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');

/**
 * Employee-scope queries for the BU Admin / Project Manager "Employee PO Hours" matrix reports
 * (read-only). The PO / hour lookups themselves are reused from teamLeadEmployeePoHoursReportRepository.
 *
 * Both queries return ACTIVE, non-deleted employees plus `employee_bu_names`: the names of the
 * employee's active Business Units that fall inside the caller's BU scope (active
 * employee_business_units rows, plus the legacy employees.company_id).
 */

function narrowing({ employeeIds, search }, replacements) {
  const conditions = [];
  if (employeeIds && employeeIds.length) { conditions.push('e.id IN (:employeeIds)'); replacements.employeeIds = employeeIds; }
  if (search && search.trim()) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search.trim()}%`;
  }
  return conditions.length ? `AND ${conditions.join(' AND ')}` : '';
}

const BU_NAMES_SQL = `
  COALESCE((
    SELECT ARRAY_AGG(DISTINCT c.company_name ORDER BY c.company_name)
      FROM companies c
     WHERE c.is_deleted = false
       AND c.id IN (:companyIds)
       AND (c.id = e.company_id
            OR EXISTS (SELECT 1 FROM employee_business_units ebu
                        WHERE ebu.employee_id = e.id AND ebu.business_unit_id = c.id AND ebu.status = 'active'))
  ), ARRAY[]::text[]) AS employee_bu_names`;

/**
 * Every active, non-deleted employee who is an active member of the BU scope: an active
 * employee_business_units row in companyIds, or the legacy employees.company_id in companyIds.
 * @returns {Promise<{ employee_id: number, employee_code: string, full_name: string, employee_bu_names: string[] }[]>}
 */
async function findBuScopeEmployees({ companyIds, employeeIds, search }) {
  if (!companyIds || !companyIds.length) return [];
  const replacements = { companyIds };
  const extra = narrowing({ employeeIds, search }, replacements);
  return sequelize.query(
    `SELECT e.id AS employee_id, e.employee_code, e.full_name, ${BU_NAMES_SQL}
       FROM employees e
      WHERE e.is_deleted = false
        AND e.status = 'active'
        AND (e.company_id IN (:companyIds)
             OR EXISTS (SELECT 1 FROM employee_business_units ebu
                         WHERE ebu.employee_id = e.id AND ebu.status = 'active'
                           AND ebu.business_unit_id IN (:companyIds)))
        ${extra}
      ORDER BY e.full_name ASC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * The given roster (already resolved elsewhere) narrowed to active, non-deleted employees, with their
 * in-scope BU names. companyIds may be empty (then employee_bu_names is []).
 */
async function findActiveEmployeesByIds({ ids, companyIds, employeeIds, search }) {
  if (!ids || !ids.length) return [];
  const replacements = { ids, companyIds: companyIds && companyIds.length ? companyIds : [0] };
  const extra = narrowing({ employeeIds, search }, replacements);
  return sequelize.query(
    `SELECT e.id AS employee_id, e.employee_code, e.full_name, ${BU_NAMES_SQL}
       FROM employees e
      WHERE e.id IN (:ids)
        AND e.is_deleted = false
        AND e.status = 'active'
        ${extra}
      ORDER BY e.full_name ASC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

module.exports = { findBuScopeEmployees, findActiveEmployeesByIds };
