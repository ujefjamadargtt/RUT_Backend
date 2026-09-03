'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Employee Work Log Compliance Repository
 *
 * Provides the two database operations needed by the compliance report:
 *
 * 1. getComplianceReport — aggregate total hours per employee for a date or
 *    month range, LEFT JOIN so employees with ZERO work-log rows are still
 *    returned (logged_hours = 0). Filters to only employees below the
 *    threshold AFTER aggregation, so pagination is always applied to the
 *    already-filtered employee set.
 *
 * 2. getEmployeeTotalHours — single-employee hours recalculation used by the
 *    reminder endpoint to re-verify that the employee is still below the
 *    threshold before sending the email. This prevents a reminder from being
 *    dispatched to an employee who has since completed their hours.
 *
 * Hour source: employee_work_logs.hours is the authoritative, pre-computed
 * total for every entry type (HOURLY, MONTHLY, and TIME_BASED — for the last
 * type the service layer already sums all time-entry segments into the parent
 * `hours` column at save time). We never touch employee_work_log_time_entries
 * here — that would double-count TIME_BASED hours.
 *
 * Status filtering: all statuses are counted (pending, approved, rejected,
 * synced) — the same convention used by the Employee Work Log Hours Summary
 * report (employeeWorkLogHoursSummaryRepository). This ensures the report
 * reflects the employee's full logged intent for the period, not just the
 * approved subset.
 */

const COMPLIANCE_SORTS = {
  employee_name: 'e.full_name',
  employee_code: 'e.employee_code',
  total_hours: 'logged_hours',
  shortfall_hours: 'shortfall_hours',
};

/**
 * Returns a paginated list of employees whose total logged hours for the
 * given period are STRICTLY LESS THAN the threshold.
 *
 * Employees with zero work-log rows are included (their logged_hours = 0).
 * Pagination is applied to the already-filtered, per-employee aggregate —
 * never to raw work-log rows.
 *
 * @param {object} params
 * @param {number[]} params.employeeIds   - Pre-authorised employee ID list.
 * @param {string}  params.startDate      - 'YYYY-MM-DD'
 * @param {string}  params.endDate        - 'YYYY-MM-DD'
 * @param {number}  params.threshold      - 8 (date mode) or 160 (month mode)
 * @param {string}  [params.search]       - Optional name/code search.
 * @param {string}  [params.sortBy]       - Column key from COMPLIANCE_SORTS.
 * @param {string}  [params.sortOrder]    - 'ASC' | 'DESC'
 * @param {number}  params.limit
 * @param {number}  params.offset
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getComplianceReport({
  employeeIds,
  startDate,
  endDate,
  threshold,
  search,
  sortBy,
  sortOrder,
  limit,
  offset,
}) {
  if (!employeeIds.length) return { rows: [], count: 0 };

  const replacements = { employeeIds, startDate, endDate, threshold, limit, offset };
  const searchCondition = search
    ? '(e.full_name ILIKE :search OR e.employee_code ILIKE :search)'
    : null;
  if (search) replacements.search = `%${search}%`;

  const whereEmployee = [
    'e.id IN (:employeeIds)',
    'e.is_deleted = false',
    searchCondition,
  ]
    .filter(Boolean)
    .join(' AND ');

  const orderCol = COMPLIANCE_SORTS[sortBy] || COMPLIANCE_SORTS.employee_name;
  const order = sortOrder === 'DESC' ? 'DESC' : 'ASC';

  /*
   * LEFT JOIN so employees who logged nothing appear with 0 hours.
   * The HAVING clause is evaluated AFTER the GROUP BY aggregation, so the
   * threshold filter is applied to the per-employee total, not to
   * individual work-log rows.
   *
   * bu subquery: resolves the primary Business Unit name for display.
   * We use the first active BU mapping (ORDER BY ebu.id ASC LIMIT 1) to
   * keep this a single-row subquery without a lateral join — consistent
   * with how other reports in this codebase surface BU names.
   */
  const rows = await sequelize.query(
    `SELECT
       e.id            AS employee_id,
       e.full_name     AS employee_name,
       e.employee_code,
       e.email         AS employee_email,
       (
         SELECT c.company_name
         FROM   employee_business_units ebu
         JOIN   companies c ON c.id = ebu.business_unit_id
         WHERE  ebu.employee_id = e.id
           AND  ebu.status = 'active'
         ORDER  BY ebu.id ASC
         LIMIT  1
       )               AS business_unit,
       ROUND(COALESCE(SUM(wl.hours), 0)::NUMERIC, 2)      AS logged_hours,
       :threshold::NUMERIC                                  AS required_hours,
       ROUND((:threshold::NUMERIC - COALESCE(SUM(wl.hours), 0))::NUMERIC, 2)
                                                            AS shortfall_hours
     FROM   employees e
     LEFT JOIN employee_work_logs wl
            ON wl.employee_id = e.id
           AND wl.work_date BETWEEN :startDate AND :endDate
     WHERE  ${whereEmployee}
     GROUP  BY e.id, e.full_name, e.employee_code, e.email
     HAVING COALESCE(SUM(wl.hours), 0) < :threshold
     ORDER  BY ${orderCol} ${order}, e.id ASC
     LIMIT  :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT }
  );

  /* Count query mirrors the same WHERE + HAVING but no ORDER/LIMIT. */
  const countRows = await sequelize.query(
    `SELECT COUNT(*)::int AS count
     FROM (
       SELECT e.id
       FROM   employees e
       LEFT JOIN employee_work_logs wl
              ON wl.employee_id = e.id
             AND wl.work_date BETWEEN :startDate AND :endDate
       WHERE  ${whereEmployee}
       GROUP  BY e.id
       HAVING COALESCE(SUM(wl.hours), 0) < :threshold
     ) sub`,
    { replacements, type: QueryTypes.SELECT }
  );

  return { rows, count: countRows[0].count };
}

/**
 * Returns the total logged hours for a single employee over the given period.
 * Used by the reminder endpoint to re-verify the employee is still below the
 * threshold before sending an email.
 *
 * @param {object} params
 * @param {number} params.employeeId
 * @param {string} params.startDate - 'YYYY-MM-DD'
 * @param {string} params.endDate   - 'YYYY-MM-DD'
 * @returns {Promise<number>} total hours (0 if no rows)
 */
async function getEmployeeTotalHours({ employeeId, startDate, endDate }) {
  const [result] = await sequelize.query(
    `SELECT ROUND(COALESCE(SUM(hours), 0)::NUMERIC, 2) AS total_hours
     FROM   employee_work_logs
     WHERE  employee_id = :employeeId
       AND  work_date BETWEEN :startDate AND :endDate`,
    { replacements: { employeeId, startDate, endDate }, type: QueryTypes.SELECT }
  );
  return parseFloat(result.total_hours) || 0;
}

module.exports = {
  getComplianceReport,
  getEmployeeTotalHours,
};
