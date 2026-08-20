'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Report Repository
 * All queries use raw SQL via sequelize.query for complex aggregations
 * and JOINs that are cumbersome to express cleanly through the ORM.
 */

const formatMonthYear = (month, year) => (
  `${parseInt(year, 10)}-${String(parseInt(month, 10)).padStart(2, '0')}`
);

const MONTH_YEAR_SQL = {
  year: "split_part(mc.month_year, '-', 1)::int",
  month: "split_part(mc.month_year, '-', 2)::int",
  monthName: "TO_CHAR(TO_DATE(split_part(mc.month_year, '-', 2), 'MM'), 'Month')",
};

/**
 * Get employee hourly rate by joining employees with monthly_costs.
 * per_hour_rate = total_cost / (standard working hours in the month)
 * We use 176 hrs/month (22 working days × 8 hrs) as the standard divisor.
 *
 * @param {object} filters
 * @param {number} filters.month
 * @param {number} filters.year
 * @param {number} [filters.employeeId]
 * @param {string} [filters.search]       - Searches employee name / code
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getEmployeeHourlyRate(filters) {
  const {
    month,
    year,
    employeeId,
    search,
    sortBy = 'e.full_name',
    sortOrder = 'ASC',
    limit,
    offset,
  } = filters;

  const STANDARD_HOURS = 176;
  const allowedSortColumns = [
    'e.full_name', 'e.employee_code', 'e.designation',
    'mc.salary_cost', 'mc.total_cost', 'per_hour_rate',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'e.full_name';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = {
    monthYear: formatMonthYear(month, year),
    limit,
    offset,
    stdHours: STANDARD_HOURS,
    companyId: filters.companyId,
  };
  const conditions = ["e.status = 'active'", "e.company_id = :companyId"];

  if (employeeId) {
    conditions.push('e.id = :employeeId');
    replacements.employeeId = employeeId;
  }
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      e.id                                          AS employee_id,
      e.employee_code,
      e.full_name,
      e.designation,
      e.total_experience,
      e.company_experience,
      :monthYear                                    AS month_year,
      mc.salary_cost,
      mc.ops_cost,
      mc.total_cost,
      mc.billable_cost,
      CASE
        WHEN mc.total_cost IS NOT NULL AND mc.total_cost > 0
          THEN ROUND((mc.total_cost / :stdHours)::numeric, 2)
        ELSE 0
      END                                           AS per_hour_rate
    FROM employees e
    LEFT JOIN monthly_costs mc
           ON mc.employee_id = e.id
          AND mc.month_year  = :monthYear
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM employees e
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Get monthly cost summary grouped by month/year.
 *
 * @param {object} filters
 * @param {number} [filters.year]
 * @param {number} [filters.month]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @returns {{ rows: object[], count: number }}
 */
async function getMonthlyCostSummary(filters) {
  const {
    year,
    month,
    sortBy = 'year',
    sortOrder = 'DESC',
    limit,
    offset,
  } = filters;

  const allowedSortColumns = ['year', 'month', 'month_year', 'total_salary_cost', 'total_ops_cost', 'total_cost', 'employee_count'];
  const sortColumnMap = {
    year: 'year',
    month: 'month',
    month_year: 'mc.month_year',
  };
  const safeSort = allowedSortColumns.includes(sortBy)
    ? (sortColumnMap[sortBy] || sortBy)
    : 'year';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyId: filters.companyId };
  const conditions = ['mc.company_id = :companyId'];

  if (year) {
    conditions.push('mc.month_year LIKE :yearPattern');
    replacements.year = year;
    replacements.yearPattern = `${parseInt(year, 10)}-%`;
  }
  if (month) {
    if (year) {
      conditions.push('mc.month_year = :monthYear');
      replacements.monthYear = formatMonthYear(month, year);
    } else {
      conditions.push('mc.month_year LIKE :monthPattern');
      replacements.monthPattern = `%-${String(parseInt(month, 10)).padStart(2, '0')}`;
    }
    replacements.month = month;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      ${MONTH_YEAR_SQL.year}                          AS year,
      ${MONTH_YEAR_SQL.month}                         AS month,
      ${MONTH_YEAR_SQL.monthName}                     AS month_name,
      COUNT(DISTINCT mc.employee_id)                   AS employee_count,
      ROUND(SUM(mc.salary_cost)::numeric, 2)           AS total_salary_cost,
      ROUND(SUM(mc.ops_cost)::numeric, 2)              AS total_ops_cost,
      ROUND(SUM(mc.total_cost)::numeric, 2)            AS total_cost,
      ROUND(SUM(mc.billable_cost)::numeric, 2)         AS total_billable_cost
    FROM monthly_costs mc
    ${whereClause}
    GROUP BY mc.month_year
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM (
      SELECT mc.month_year
      FROM monthly_costs mc
      ${whereClause}
      GROUP BY mc.month_year
    ) sub
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Get timesheet summary joined with employees and service POs.
 *
 * @param {object} filters
 * @param {string} [filters.startDate]    - ISO date string YYYY-MM-DD
 * @param {string} [filters.endDate]
 * @param {number} [filters.employeeId]
 * @param {number} [filters.poId]
 * @param {string} [filters.search]       - Employee name / code / PO name
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getTimesheetSummary(filters) {
  const {
    startDate,
    endDate,
    employeeId,
    poId,
    search,
    sortBy = 't.timesheet_date',
    sortOrder = 'DESC',
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const allowedSortColumns = [
    't.timesheet_date', 'e.full_name', 'e.employee_code',
    'sp.service_po_name', 'total_hours', 'entry_count',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 't.timesheet_date';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyId: filters.companyId };
  const conditions = ['t.company_id = :companyId'];

  if (startDate) {
    conditions.push('t.timesheet_date >= :startDate');
    replacements.startDate = startDate;
  }
  if (endDate) {
    conditions.push('t.timesheet_date <= :endDate');
    replacements.endDate = endDate;
  }
  if (employeeId) {
    conditions.push('t.employee_id = :employeeId');
    replacements.employeeId = employeeId;
  }
  if (poId) {
    conditions.push('t.service_po_id = :poId');
    replacements.poId = poId;
  }
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  // Role ID 5 only: exclude unpublished timesheet rows so a window spanning
  // several months still reflects whichever of those months ARE published,
  // instead of an all-or-nothing block on the whole window. A row with no
  // import batch at all is treated the same as unpublished (safe default).
  if (Number(roleId) === 5) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)'
    );
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      t.id                              AS timesheet_id,
      t.timesheet_date,
      ${hoursCol} AS hours_logged,
      e.id                              AS employee_id,
      e.employee_code,
      e.full_name,
      e.designation,
      sp.id                             AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.is_billable,
      c.client_name,
      subp.id                           AS sub_project_id,
      subp.sub_project_code,
      subp.sub_project_name,
      st.service_type_name
    FROM timesheets t
    INNER JOIN employees e  ON e.id  = t.employee_id
    INNER JOIN service_pos sp ON sp.id = t.service_po_id
    INNER JOIN clients c    ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    LEFT  JOIN sub_projects subp ON subp.id = t.sub_project_id
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM timesheets t
    INNER JOIN employees e    ON e.id  = t.employee_id
    INNER JOIN service_pos sp ON sp.id = t.service_po_id
    INNER JOIN clients c      ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    LEFT  JOIN sub_projects subp ON subp.id = t.sub_project_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Get Service PO utilisation — actual hours logged vs expected man hours.
 *
 * @param {object} filters
 * @param {string} [filters.startDate]
 * @param {string} [filters.endDate]
 * @param {number} [filters.poId]
 * @param {string} [filters.status]        - active | closed | all
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getServicePOUtilisation(filters) {
  const {
    startDate,
    endDate,
    poId,
    status,
    search,
    sortBy = 'utilisation_pct',
    sortOrder = 'DESC',
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const allowedSortColumns = [
    'sp.service_po_code', 'sp.service_po_name', 'actual_hours',
    'sp.expected_man_hours', 'utilisation_pct', 'sp.start_date', 'sp.end_date',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'utilisation_pct';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyId: filters.companyId };
  const conditions = ['sp.company_id = :companyId'];

  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (status && status !== 'all') {
    conditions.push('sp.status = :status');
    replacements.status = status;
  }
  if (search) {
    conditions.push('(sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search OR c.client_name ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  // Date filters apply to timesheet entries only (using a conditional SUM)
  const tsDateFilter = [];
  if (startDate) {
    tsDateFilter.push('t.timesheet_date >= :startDate');
    replacements.startDate = startDate;
  }
  if (endDate) {
    tsDateFilter.push('t.timesheet_date <= :endDate');
    replacements.endDate = endDate;
  }
  // Role ID 5 only: exclude unpublished timesheet rows from the counted
  // hours so a window spanning several months still reflects whichever of
  // those months ARE published, instead of an all-or-nothing block.
  if (Number(roleId) === 5) {
    tsDateFilter.push(
      'EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)'
    );
  }
  const tsDateCondition = tsDateFilter.length
    ? `AND ${tsDateFilter.join(' AND ')}`
    : '';

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      sp.id                                                     AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.status,
      sp.is_billable,
      sp.start_date,
      sp.end_date,
      sp.po_value,
      sp.expected_man_hours,
      c.id                                                      AS client_id,
      c.client_name,
      st.service_type_name,
      COALESCE(SUM(CASE WHEN t.id IS NOT NULL ${tsDateCondition} THEN ${hoursCol} ELSE 0 END), 0) AS actual_hours,
      CASE
        WHEN sp.expected_man_hours IS NOT NULL AND sp.expected_man_hours > 0
          THEN ROUND(
            (COALESCE(SUM(CASE WHEN t.id IS NOT NULL ${tsDateCondition} THEN ${hoursCol} ELSE 0 END), 0)
             / sp.expected_man_hours * 100)::numeric, 2)
        ELSE NULL
      END                                                       AS utilisation_pct,
      COUNT(DISTINCT t.employee_id)                             AS distinct_resources
    FROM service_pos sp
    INNER JOIN clients c       ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    LEFT  JOIN timesheets t    ON t.service_po_id = sp.id
    ${whereClause}
    GROUP BY sp.id, sp.service_po_code, sp.service_po_name, sp.status,
             sp.is_billable, sp.start_date, sp.end_date, sp.po_value,
             sp.expected_man_hours, c.id, c.client_name, st.service_type_name
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM service_pos sp
    INNER JOIN clients c       ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Get hours logged per sub-project.
 *
 * @param {object} filters
 * @param {number} [filters.poId]
 * @param {string} [filters.startDate]
 * @param {string} [filters.endDate]
 * @param {string} [filters.status]
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getSubProjectHours(filters) {
  const {
    poId,
    startDate,
    endDate,
    status,
    search,
    sortBy = 'total_hours',
    sortOrder = 'DESC',
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const allowedSortColumns = [
    'subp.sub_project_code', 'subp.sub_project_name', 'total_hours',
    'entry_count', 'subp.start_date', 'subp.end_date', 'sp.service_po_name',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'total_hours';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyId: filters.companyId };
  const conditions = ['subp.company_id = :companyId'];

  if (poId) {
    conditions.push('subp.service_po_id = :poId');
    replacements.poId = poId;
  }
  if (status && status !== 'all') {
    conditions.push('subp.status = :status');
    replacements.status = status;
  }
  if (search) {
    conditions.push('(subp.sub_project_name ILIKE :search OR subp.sub_project_code ILIKE :search OR sp.service_po_name ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  const tsConditions = [];
  if (startDate) {
    tsConditions.push('t.timesheet_date >= :startDate');
    replacements.startDate = startDate;
  }
  if (endDate) {
    tsConditions.push('t.timesheet_date <= :endDate');
    replacements.endDate = endDate;
  }
  // Role ID 5 only: exclude unpublished timesheet rows so a window spanning
  // several months still reflects whichever of those months ARE published,
  // instead of an all-or-nothing block on the whole window.
  if (Number(roleId) === 5) {
    tsConditions.push(
      'EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)'
    );
  }
  const tsWhere = tsConditions.length ? `AND ${tsConditions.join(' AND ')}` : '';

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      subp.id                                                  AS sub_project_id,
      subp.sub_project_code,
      subp.sub_project_name,
      subp.description,
      subp.status,
      subp.start_date,
      subp.end_date,
      sp.id                                                    AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      c.client_name,
      COALESCE(SUM(CASE WHEN t.id IS NOT NULL ${tsWhere} THEN ${hoursCol} ELSE 0 END), 0) AS total_hours,
      COUNT(CASE WHEN t.id IS NOT NULL ${tsWhere} THEN 1 END) AS entry_count,
      COUNT(DISTINCT CASE WHEN t.id IS NOT NULL ${tsWhere} THEN t.employee_id END) AS distinct_resources
    FROM sub_projects subp
    INNER JOIN service_pos sp ON sp.id = subp.service_po_id
    INNER JOIN clients c      ON c.id  = sp.client_id
    LEFT  JOIN timesheets t   ON t.sub_project_id = subp.id
    ${whereClause}
    GROUP BY subp.id, subp.sub_project_code, subp.sub_project_name,
             subp.description, subp.status, subp.start_date, subp.end_date,
             sp.id, sp.service_po_code, sp.service_po_name, c.client_name
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM sub_projects subp
    INNER JOIN service_pos sp ON sp.id = subp.service_po_id
    INNER JOIN clients c      ON c.id  = sp.client_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Get resource allocation — employee-PO pairs derived from actual timesheet entries.
 * Derives allocations from timesheets (distinct employee+PO combinations) so that
 * data appears even when service_po_resources has not been separately populated.
 * month/year filter the timesheet date range; omitting them returns all-time totals.
 *
 * @param {object} filters
 * @param {number} [filters.employeeId]
 * @param {number} [filters.poId]              - Service PO (project) filter
 * @param {number} [filters.month]        - Filter timesheet entries to this month
 * @param {number} [filters.year]         - Filter timesheet entries to this year
 * @param {string} [filters.status]       - PO status filter
 * @param {number} [filters.serviceCategoryId] - Service category filter
 * @param {number} [filters.serviceTypeId]     - Service type filter
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getResourceAllocation(filters) {
  const {
    employeeId,
    poId,
    clientId,
    month,
    year,
    status,
    isBillable,
    serviceCategoryId,
    serviceTypeId,
    search,
    sortBy = 'e.full_name',
    sortOrder = 'ASC',
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const allowedSortColumns = [
    'e.full_name', 'e.employee_code', 'e.designation',
    'sp.service_po_name', 'sp.start_date', 'sp.end_date',
    'c.client_name', 'total_hours_logged', 'sc.name', 'st.service_type_name',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'e.full_name';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyId: filters.companyId };
  const conditions = ["e.status = 'active'", 'e.company_id = :companyId'];

  if (employeeId) {
    conditions.push('e.id = :employeeId');
    replacements.employeeId = employeeId;
  }
  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (clientId) {
    conditions.push('c.id = :clientId');
    replacements.clientId = clientId;
  }
  if (status && status !== 'all') {
    conditions.push('sp.status = :status');
    replacements.status = status;
  }
  if (isBillable !== undefined) {
    conditions.push('sp.is_billable = :isBillable');
    replacements.isBillable = isBillable;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }
  if (serviceCategoryId) {
    conditions.push('sc.id = :serviceCategoryId');
    replacements.serviceCategoryId = serviceCategoryId;
  }
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search OR sp.service_po_name ILIKE :search OR c.client_name ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  if (month) {
    conditions.push('EXTRACT(MONTH FROM t.timesheet_date) = :month');
    replacements.month = parseInt(month, 10);
  }
  if (year) {
    conditions.push('EXTRACT(YEAR FROM t.timesheet_date) = :year');
    replacements.year = parseInt(year, 10);
  }
  // Role ID 5 only: exclude unpublished timesheet rows so a window spanning
  // several months still reflects whichever of those months ARE published,
  // instead of an all-or-nothing block on the whole window.
  if (Number(roleId) === 5) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)'
    );
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      e.id                                     AS employee_id,
      e.employee_code,
      e.full_name,
      e.designation,
      e.total_experience,
      e.company_experience,
      e.status                                 AS employee_status,
      sp.id                                    AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.status                                AS po_status,
      sp.is_billable,
      sp.start_date                            AS po_start_date,
      sp.end_date                              AS po_end_date,
      c.id                                     AS client_id,
      c.client_name,
      sc.id                                    AS service_category_id,
      sc.name                                  AS service_category_name,
      st.id                                    AS service_type_id,
      st.service_type_name,
      COALESCE(SUM(${hoursCol}), 0) AS total_hours_logged
    FROM timesheets t
    INNER JOIN employees e      ON e.id  = t.employee_id
    INNER JOIN service_pos sp   ON sp.id = t.service_po_id
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    ${whereClause}
    GROUP BY e.id, e.employee_code, e.full_name,
             e.designation, e.total_experience, e.company_experience, e.status,
             sp.id, sp.service_po_code, sp.service_po_name, sp.status, sp.is_billable,
             sp.start_date, sp.end_date, c.id, c.client_name,
             sc.id, sc.name, st.id, st.service_type_name
    HAVING COALESCE(SUM(${hoursCol}), 0) > 0
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM (
      SELECT t.employee_id, t.service_po_id
      FROM timesheets t
      INNER JOIN employees e      ON e.id  = t.employee_id
      INNER JOIN service_pos sp   ON sp.id = t.service_po_id
      INNER JOIN clients c        ON c.id  = sp.client_id
      INNER JOIN service_types st ON st.id = sp.service_type_id
      INNER JOIN service_categories sc ON sc.id = st.service_category_id
      ${whereClause}
      GROUP BY t.employee_id, t.service_po_id
      HAVING COALESCE(SUM(${hoursCol}), 0) > 0
    ) sub
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Get operational cost breakdown per employee per month.
 *
 * @param {object} filters
 * @param {number} [filters.year]
 * @param {number} [filters.month]
 * @param {number} [filters.employeeId]
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getOperationalCostBreakdown(filters) {
  const {
    year,
    month,
    employeeId,
    search,
    sortBy = 'mc.month_year',
    sortOrder = 'DESC',
    limit,
    offset,
  } = filters;

  const allowedSortColumns = [
    'mc.month_year', 'year', 'month', 'e.full_name', 'e.employee_code',
    'mc.salary_cost', 'mc.ops_cost', 'mc.total_cost', 'mc.billable_cost',
  ];
  const sortColumnMap = {
    year: 'year',
    month: 'month',
    'mc.year': 'year',
    'mc.month': 'month',
  };
  const safeSort = allowedSortColumns.includes(sortBy)
    ? (sortColumnMap[sortBy] || sortBy)
    : 'mc.month_year';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyId: filters.companyId };
  const conditions = ['mc.company_id = :companyId'];

  if (year) {
    conditions.push('mc.month_year LIKE :yearPattern');
    replacements.year = year;
    replacements.yearPattern = `${parseInt(year, 10)}-%`;
  }
  if (month) {
    if (year) {
      conditions.push('mc.month_year = :monthYear');
      replacements.monthYear = formatMonthYear(month, year);
    } else {
      conditions.push('mc.month_year LIKE :monthPattern');
      replacements.monthPattern = `%-${String(parseInt(month, 10)).padStart(2, '0')}`;
    }
    replacements.month = month;
  }
  if (employeeId) {
    conditions.push('e.id = :employeeId');
    replacements.employeeId = employeeId;
  }
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      mc.id                                  AS cost_id,
      ${MONTH_YEAR_SQL.year}              AS year,
      ${MONTH_YEAR_SQL.month}             AS month,
      ${MONTH_YEAR_SQL.monthName}         AS month_name,
      e.id                                   AS employee_id,
      e.employee_code,
      e.full_name,
      e.designation,
      mc.salary_cost,
      mc.ops_cost,
      mc.total_cost,
      mc.billable_cost,
      CASE
        WHEN mc.total_cost > 0
          THEN ROUND((mc.salary_cost / mc.total_cost * 100)::numeric, 2)
        ELSE 0
      END AS salary_pct_of_total,
      CASE
        WHEN mc.total_cost > 0
          THEN ROUND((mc.ops_cost / mc.total_cost * 100)::numeric, 2)
        ELSE 0
      END AS ops_pct_of_total,
      CASE
        WHEN mc.total_cost > 0
          THEN ROUND((mc.billable_cost / mc.total_cost * 100)::numeric, 2)
        ELSE 0
      END AS billable_pct_of_total
    FROM monthly_costs mc
    INNER JOIN employees e ON e.id = mc.employee_id
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}, mc.month_year ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM monthly_costs mc
    INNER JOIN employees e ON e.id = mc.employee_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Employee Utilization Summary Report
 *
 * One row per active employee for the given month/year.
 * Non-billable hours are pivoted into five category columns derived from
 * service_types.service_type_name (case-insensitive keyword matching with
 * priority ordering so no hours are double-counted):
 *   leaves → team_management → lnd → internal_support → others
 *
 * @param {object} filters
 * @param {number} filters.month
 * @param {number} filters.year
 * @param {number} [filters.employeeId]
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getEmployeeUtilizationSummary(filters) {
  const {
    month,
    year,
    employeeId,
    search,
    sortBy = 'full_name',
    sortOrder = 'ASC',
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const MONTHLY_CAPACITY = 176;

  const allowedSortColumns = [
    'full_name', 'designation', 'total_experience', 'company_experience',
    'billable_total', 'non_billable_total', 'total_utilization_excl_leaves_pct',
    'leaves_hours', 'lnd_hours', 'internal_support_hours', 'team_management_hours',
    'others_hours',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'full_name';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = {
    month: parseInt(month, 10),
    year: parseInt(year, 10),
    limit,
    offset,
    monthlyCapacity: MONTHLY_CAPACITY,
    companyId: filters.companyId,
  };

  const empConditions = ["e.status = 'active'", 'e.company_id = :companyId'];
  if (employeeId) {
    empConditions.push('e.id = :employeeId');
    replacements.employeeId = employeeId;
  }
  if (search) {
    empConditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const empWhere = `WHERE ${empConditions.join(' AND ')}`;
  // Role ID 5 only: exclude unpublished timesheet rows from the join.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  const dataQuery = `
    WITH categorized AS (
      SELECT
        e.id              AS employee_id,
        e.full_name,
        e.designation,
        e.total_experience,
        e.company_experience,
        ${hoursCol} AS hours_logged,
        sp.is_billable,
        c.client_name,
        CASE
          WHEN t.id IS NULL                                              THEN NULL
          WHEN sp.is_billable = true                                     THEN 'billable'
          WHEN st.service_type_name ILIKE '%leave%'
            OR st.service_type_name ILIKE '%vacation%'
            OR st.service_type_name ILIKE '%holiday%'                  THEN 'leaves'
          WHEN st.service_type_name ILIKE '%team management%'
            OR st.service_type_name ILIKE '%management%'               THEN 'team_management'
          WHEN st.service_type_name ILIKE '%l&d%'
            OR st.service_type_name ILIKE '%learning%'
            OR st.service_type_name ILIKE '%training%'
            OR st.service_type_name ILIKE '%development%'              THEN 'lnd'
          WHEN st.service_type_name ILIKE '%internal support%'
            OR st.service_type_name ILIKE '%internal%'
            OR st.service_type_name ILIKE '%hr%'
            OR st.service_type_name ILIKE '%marketing%'
            OR st.service_type_name ILIKE '%finance%'
            OR st.service_type_name ILIKE '%admin%'                    THEN 'internal_support'
          ELSE 'others'
        END AS nb_category
      FROM employees e
      LEFT JOIN timesheets t
            ON  t.employee_id = e.id
           AND  EXTRACT(MONTH FROM t.timesheet_date) = :month
           AND  EXTRACT(YEAR  FROM t.timesheet_date) = :year
           ${publishGuard}
      LEFT JOIN service_pos sp   ON sp.id = t.service_po_id
      LEFT JOIN service_types st ON st.id = sp.service_type_id
      LEFT JOIN clients c        ON c.id  = sp.client_id
      ${empWhere}
    )
    SELECT
      employee_id,
      full_name,
      designation,
      total_experience,
      company_experience,
      :monthlyCapacity                                                                   AS monthly_capacity,
      :monthlyCapacity                                                                   AS monthly_billing_capacity,
      NULLIF(STRING_AGG(DISTINCT CASE WHEN is_billable = true AND client_name IS NOT NULL
                                      THEN client_name END, ', '), '')                  AS clients,
      COALESCE(SUM(CASE WHEN nb_category = 'internal_support' THEN hours_logged END), 0) AS internal_support_hours,
      COALESCE(SUM(CASE WHEN nb_category = 'team_management'  THEN hours_logged END), 0) AS team_management_hours,
      COALESCE(SUM(CASE WHEN nb_category = 'leaves'           THEN hours_logged END), 0) AS leaves_hours,
      COALESCE(SUM(CASE WHEN nb_category = 'lnd'              THEN hours_logged END), 0) AS lnd_hours,
      COALESCE(SUM(CASE WHEN nb_category = 'others'           THEN hours_logged END), 0) AS others_hours,
      COALESCE(SUM(CASE WHEN is_billable = true               THEN hours_logged END), 0) AS billable_total,
      COALESCE(SUM(CASE WHEN is_billable = false              THEN hours_logged END), 0) AS non_billable_total,
      COALESCE(SUM(CASE WHEN is_billable = true               THEN hours_logged END), 0)
        + COALESCE(SUM(CASE WHEN is_billable = false          THEN hours_logged END), 0)
        - COALESCE(SUM(CASE WHEN nb_category = 'leaves'       THEN hours_logged END), 0) AS total_utilization_excl_leaves_pct
    FROM categorized
    GROUP BY employee_id, full_name, designation, total_experience, company_experience
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM employees e
    ${empWhere}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Service PO Summary Report
 *
 * One row per Service PO showing client info, PO details, hours delivered
 * before the selected month, available hours, and monthly billable amount
 * (hours logged this month × employee hourly rate) for billable POs.
 *
 * @param {object} filters
 * @param {number} filters.month           - required
 * @param {number} filters.year            - required
 * @param {string} [filters.status]        - PO status filter (active|closed|all)
 * @param {number} [filters.clientId]
 * @param {boolean} [filters.isBillable]
 * @param {number} [filters.serviceCategoryId] - Service category filter
 * @param {number} [filters.serviceTypeId]
 * @param {number} [filters.poId]          - Filter to a specific Service PO
 * @param {string} [filters.search]        - client_name or service_po_name
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getServicePOSummary(filters) {
  const {
    month,
    year,
    status,
    clientId,
    isBillable,
    serviceCategoryId,
    serviceTypeId,
    poId,
    startDate,
    endDate,
    search,
    sortBy = 'c.client_name',
    sortOrder = 'ASC',
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const STANDARD_HOURS = 176;

  const allowedSortColumns = [
    'c.client_name', 'sp.service_po_name', 'sp.start_date', 'sp.end_date',
    'sp.po_value', 'sp.expected_man_hours', 'hours_delivered_before_month',
    'available_hours', 'monthly_billable_amount', 'sp.status', 'sc.name',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'c.client_name';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);

  const replacements = { monthNum, yearNum, monthYear, stdHours: STANDARD_HOURS, limit, offset, companyId: filters.companyId };
  const conditions = ['sp.company_id = :companyId'];

  if (status && status !== 'all') {
    conditions.push('sp.status = :status');
    replacements.status = status;
  }
  if (clientId) {
    conditions.push('sp.client_id = :clientId');
    replacements.clientId = clientId;
  }
  if (isBillable !== undefined) {
    conditions.push('sp.is_billable = :isBillable');
    replacements.isBillable = isBillable;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }
  if (serviceCategoryId) {
    conditions.push('sc.id = :serviceCategoryId');
    replacements.serviceCategoryId = serviceCategoryId;
  }
  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (startDate) {
    conditions.push('sp.start_date >= :startDate');
    replacements.startDate = startDate;
  }
  if (endDate) {
    conditions.push('sp.end_date <= :endDate');
    replacements.endDate = endDate;
  }
  if (search) {
    conditions.push('(c.client_name ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  // Role ID 5 only: exclude unpublished timesheet rows from every subquery
  // below that reads timesheets, so a window spanning several months still
  // reflects whichever of those months ARE published.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  const dataQuery = `
    SELECT
      sp.id                                                              AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.service_description,
      sp.start_date,
      sp.end_date,
      sp.status,
      sp.is_billable,
      sp.invoice_frequency,
      sp.po_value,
      sp.account_manager,
      sp.expected_man_hours,
      c.id                                                               AS client_id,
      c.client_name,
      sc.id                                                              AS service_category_id,
      sc.name                                                            AS service_category_name,
      st.id                                                              AS service_type_id,
      st.service_type_name                                               AS service_type,
      COALESCE(prev.hours_delivered, 0)                                  AS hours_delivered_before_month,
      COALESCE(sp.expected_man_hours, 0) - COALESCE(prev.hours_delivered, 0) AS available_hours,
      CASE
        WHEN sp.is_billable = true
          THEN ROUND(COALESCE(curr.billable_amount, 0)::numeric, 2)
        ELSE NULL
      END                                                                AS monthly_billable_amount,
      CASE
        WHEN sp.is_billable = true
          THEN ROUND(COALESCE(sp.invoice_amount, 0)::numeric, 2)
        ELSE NULL
      END                                                                AS invoiced_amount,
      CASE
        WHEN sp.is_billable = true
          THEN ROUND(
            (COALESCE(prev_bill.prev_billable_amount, 0) + COALESCE(curr.billable_amount, 0)
            - COALESCE(sp.invoice_amount, 0))::numeric, 2)
        ELSE NULL
      END                                                                AS unbilled_amount
    FROM service_pos sp
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    LEFT JOIN (
      SELECT service_po_id, SUM(${hoursCol}) AS hours_delivered
      FROM timesheets t
      WHERE timesheet_date < MAKE_DATE(:yearNum, :monthNum, 1)
        ${publishGuard}
      GROUP BY service_po_id
    ) prev ON prev.service_po_id = sp.id
    LEFT JOIN (
      SELECT
        t.service_po_id,
        SUM(${hoursCol} * COALESCE(mc.total_cost, 0)) AS prev_billable_amount
      FROM timesheets t
      LEFT JOIN monthly_costs mc
             ON mc.employee_id = t.employee_id
            AND mc.month_year  = TO_CHAR(t.timesheet_date, 'YYYY-MM')
      WHERE t.timesheet_date < MAKE_DATE(:yearNum, :monthNum, 1)
        ${publishGuard}
      GROUP BY t.service_po_id
    ) prev_bill ON prev_bill.service_po_id = sp.id
    INNER JOIN (
      SELECT
        t.service_po_id,
        SUM(${hoursCol} * COALESCE(mc.total_cost, 0)) AS billable_amount
      FROM timesheets t
      LEFT JOIN monthly_costs mc
             ON mc.employee_id = t.employee_id
            AND mc.month_year  = :monthYear
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
        ${publishGuard}
      GROUP BY t.service_po_id
    ) curr ON curr.service_po_id = sp.id
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}, sp.service_po_name ASC
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM service_pos sp
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    INNER JOIN (
      SELECT DISTINCT service_po_id
      FROM timesheets t
      WHERE EXTRACT(MONTH FROM timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM timesheet_date) = :yearNum
        ${publishGuard}
    ) curr ON curr.service_po_id = sp.id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Invoice PO Summary Report
 *
 * Same shape as getServicePOSummary (client info, PO details, hours
 * delivered before the selected month, available hours, monthly billable
 * amount), but invoiced_amount, billed_amount and unbilled_amount are read
 * from the Service PO Monthly Budget master (service_po_monthly_budgets,
 * matched on service_po_id + the report's month/year) instead of being
 * computed from sp.invoice_amount / timesheets / monthly_costs — see
 * database/migrations/20260853_create_service_po_monthly_budgets.sql.
 * Missing budget data for a PO/month defaults invoiced_amount and
 * billed_amount to 0. unbilled_amount = invoiced_amount - billed_amount.
 *
 * This report does not modify or share query logic with
 * getServicePOSummary's billing calculation — it is a separate, isolated
 * implementation.
 *
 * @param {object} filters
 * @param {number} filters.month           - required
 * @param {number} filters.year            - required
 * @param {string} [filters.status]        - PO status filter (active|closed|all)
 * @param {number} [filters.clientId]
 * @param {boolean} [filters.isBillable]
 * @param {number} [filters.serviceCategoryId] - Service category filter
 * @param {number} [filters.serviceTypeId]
 * @param {number} [filters.poId]          - Filter to a specific Service PO
 * @param {string} [filters.search]        - client_name or service_po_name
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ rows: object[], count: number }}
 */
async function getInvoicePOSummary(filters) {
  const {
    month,
    year,
    status,
    clientId,
    isBillable,
    serviceCategoryId,
    serviceTypeId,
    poId,
    startDate,
    endDate,
    search,
    sortBy = 'c.client_name',
    sortOrder = 'ASC',
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const allowedSortColumns = [
    'c.client_name', 'sp.service_po_name', 'sp.start_date', 'sp.end_date',
    'sp.po_value', 'sp.expected_man_hours', 'hours_delivered_before_month',
    'available_hours', 'monthly_billable_amount', 'sp.status', 'sc.name',
  ];
  const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'c.client_name';
  const safeOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);

  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyId: filters.companyId };
  const conditions = ['sp.company_id = :companyId'];

  if (status && status !== 'all') {
    conditions.push('sp.status = :status');
    replacements.status = status;
  }
  if (clientId) {
    conditions.push('sp.client_id = :clientId');
    replacements.clientId = clientId;
  }
  if (isBillable !== undefined) {
    conditions.push('sp.is_billable = :isBillable');
    replacements.isBillable = isBillable;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }
  if (serviceCategoryId) {
    conditions.push('sc.id = :serviceCategoryId');
    replacements.serviceCategoryId = serviceCategoryId;
  }
  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (startDate) {
    conditions.push('sp.start_date >= :startDate');
    replacements.startDate = startDate;
  }
  if (endDate) {
    conditions.push('sp.end_date <= :endDate');
    replacements.endDate = endDate;
  }
  if (search) {
    conditions.push('(c.client_name ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  // Role ID 5 only: exclude unpublished timesheet rows from every subquery
  // below that reads timesheets, so a window spanning several months still
  // reflects whichever of those months ARE published.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  const dataQuery = `
    SELECT
      sp.id                                                              AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.service_description,
      sp.start_date,
      sp.end_date,
      sp.status,
      sp.is_billable,
      sp.invoice_frequency,
      sp.po_value,
      sp.account_manager,
      sp.expected_man_hours,
      c.id                                                               AS client_id,
      c.client_name,
      sc.id                                                              AS service_category_id,
      sc.name                                                            AS service_category_name,
      st.id                                                              AS service_type_id,
      st.service_type_name                                               AS service_type,
      COALESCE(prev.hours_delivered, 0)                                  AS hours_delivered_before_month,
      COALESCE(sp.expected_man_hours, 0) - COALESCE(prev.hours_delivered, 0) AS available_hours,
      CASE
        WHEN sp.is_billable = true
          THEN ROUND(COALESCE(curr.billable_amount, 0)::numeric, 2)
        ELSE NULL
      END                                                                AS monthly_billable_amount,
      -- Invoice/Billed Amount come from the Service PO Monthly Budget
      -- master (spmb) for the report's selected month/year, per
      -- database/migrations/20260853_create_service_po_monthly_budgets.sql.
      -- Missing budget data for a PO/month defaults to 0.
      CASE
        WHEN sp.is_billable = true
          THEN ROUND(COALESCE(spmb.invoice_amount, 0)::numeric, 2)
        ELSE NULL
      END                                                                AS invoiced_amount,
      CASE
        WHEN sp.is_billable = true
          THEN ROUND(COALESCE(spmb.billed_amount, 0)::numeric, 2)
        ELSE NULL
      END                                                                AS billed_amount,
      CASE
        WHEN sp.is_billable = true
          THEN ROUND(
            (COALESCE(spmb.invoice_amount, 0) - COALESCE(spmb.billed_amount, 0))::numeric, 2)
        ELSE NULL
      END                                                                AS unbilled_amount
    FROM service_pos sp
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    LEFT JOIN service_po_monthly_budgets spmb
           ON spmb.service_po_id = sp.id
          AND spmb.month = :monthNum
          AND spmb.year  = :yearNum
    LEFT JOIN (
      SELECT service_po_id, SUM(${hoursCol}) AS hours_delivered
      FROM timesheets t
      WHERE timesheet_date < MAKE_DATE(:yearNum, :monthNum, 1)
        ${publishGuard}
      GROUP BY service_po_id
    ) prev ON prev.service_po_id = sp.id
    INNER JOIN (
      SELECT
        t.service_po_id,
        SUM(${hoursCol} * COALESCE(mc.total_cost, 0)) AS billable_amount
      FROM timesheets t
      LEFT JOIN monthly_costs mc
             ON mc.employee_id = t.employee_id
            AND mc.month_year  = :monthYear
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
        ${publishGuard}
      GROUP BY t.service_po_id
    ) curr ON curr.service_po_id = sp.id
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}, sp.service_po_name ASC
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM service_pos sp
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    INNER JOIN (
      SELECT DISTINCT service_po_id
      FROM timesheets t
      WHERE EXTRACT(MONTH FROM timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM timesheet_date) = :yearNum
        ${publishGuard}
    ) curr ON curr.service_po_id = sp.id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Resource Utilization Report
 * Returns employee × service-type hours pivoted by service category for a given month/year.
 *
 * Two result sets are returned:
 *  - columns: distinct service categories + their service types that have timesheet data in the period
 *  - rows:    flat employee × service_type hour records (service layer does the pivot)
 *
 * @param {object} filters
 * @param {number} filters.month
 * @param {number} filters.year
 * @param {number} [filters.employeeId]
 * @param {string} [filters.search]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ columns: object[], rows: object[], count: number }}
 */
async function getResourceUtilization(filters) {
  const { month, year, employeeId, search, limit, offset, hoursSource, roleId } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const replacements = {
    month: parseInt(month, 10),
    year: parseInt(year, 10),
    limit,
    offset,
    companyId: filters.companyId,
  };

  const empConditions = [];
  if (employeeId) {
    empConditions.push('e.id = :employeeId');
    replacements.employeeId = parseInt(employeeId, 10);
  }
  if (search) {
    empConditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const empFilter = empConditions.length ? `AND ${empConditions.join(' AND ')}` : '';
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  // Service categories + types that actually have timesheet data in the period
  const columnsQuery = `
    SELECT DISTINCT
      sc.id               AS category_id,
      sc.name             AS category_name,
      st.id               AS service_type_id,
      st.service_type_name
    FROM timesheets t
    JOIN service_pos sp        ON sp.id  = t.service_po_id
    JOIN service_types st      ON st.id  = sp.service_type_id  AND st.is_deleted = false
    JOIN service_categories sc ON sc.id  = st.service_category_id AND sc.is_deleted = false
    WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
      AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
      AND t.company_id = :companyId
      ${publishGuard}
    ORDER BY sc.name, st.service_type_name
  `;

  // Total distinct employees matching the filters
  const countQuery = `
    SELECT COUNT(DISTINCT t.employee_id) AS total
    FROM timesheets t
    JOIN employees e           ON e.id  = t.employee_id  AND e.is_deleted = false
    JOIN service_pos sp        ON sp.id = t.service_po_id AND sp.is_deleted = false
    JOIN service_types st      ON st.id = sp.service_type_id AND st.is_deleted = false
    JOIN service_categories sc ON sc.id = st.service_category_id AND sc.is_deleted = false
    WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
      AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
      AND t.company_id = :companyId
      ${empFilter}
      ${publishGuard}
  `;

  // Paginated data: one row per employee × service_type, paged at the employee level via CTE
  const dataQuery = `
    WITH emp_page AS (
      SELECT DISTINCT e.id AS employee_id, e.full_name
      FROM timesheets t
      JOIN employees e           ON e.id  = t.employee_id  AND e.is_deleted = false
      JOIN service_pos sp        ON sp.id = t.service_po_id AND sp.is_deleted = false
      JOIN service_types st      ON st.id = sp.service_type_id AND st.is_deleted = false
      JOIN service_categories sc ON sc.id = st.service_category_id AND sc.is_deleted = false
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
        AND t.company_id = :companyId
        ${empFilter}
        ${publishGuard}
      ORDER BY e.full_name
      LIMIT :limit OFFSET :offset
    )
    SELECT
      e.id             AS employee_id,
      e.employee_code,
      e.full_name,
      e.designation,
      st.id            AS service_type_id,
      st.service_type_name,
      sc.id            AS category_id,
      sc.name          AS category_name,
      ROUND(SUM(${hoursCol})::NUMERIC, 4) AS hours
    FROM timesheets t
    JOIN employees e           ON e.id  = t.employee_id  AND e.is_deleted = false
    JOIN service_pos sp        ON sp.id = t.service_po_id AND sp.is_deleted = false
    JOIN service_types st      ON st.id = sp.service_type_id AND st.is_deleted = false
    JOIN service_categories sc ON sc.id = st.service_category_id AND sc.is_deleted = false
    JOIN emp_page ep           ON ep.employee_id = e.id
    WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
      AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
      AND t.company_id = :companyId
      ${publishGuard}
    GROUP BY e.id, e.employee_code, e.full_name, e.designation, st.id, st.service_type_name, sc.id, sc.name
    ORDER BY e.full_name, sc.name, st.service_type_name
  `;

  const [columns, countResult, rows] = await Promise.all([
    sequelize.query(columnsQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return {
    columns,
    rows,
    count: parseInt(countResult[0].total, 10),
  };
}

/**
 * Monthly Resource Utilization Report
 * Full employee detail (experience, resource description, client, capacity) × service-type hours.
 * Only active employees with timesheet entries in the selected month/year appear.
 * Paged at the employee level.
 *
 * @param {object} filters
 * @param {number} filters.month       - required
 * @param {number} filters.year        - required
 * @param {number} [filters.employeeId]
 * @param {string} [filters.search]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {{ columns: object[], rows: object[], count: number }}
 */
async function getMonthlyResourceUtilization(filters) {
  const { month, year, employeeId, search, limit, offset, hoursSource, roleId } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const replacements = {
    month: parseInt(month, 10),
    year: parseInt(year, 10),
    limit,
    offset,
    companyId: filters.companyId,
  };

  const conditions = [
    "EXTRACT(MONTH FROM t.timesheet_date) = :month",
    "EXTRACT(YEAR  FROM t.timesheet_date) = :year",
    "t.company_id = :companyId",
    "e.is_deleted = false",
    "e.status = 'active'",
    "sp.is_deleted = false",
    "st.is_deleted = false",
    "sc.is_deleted = false",
  ];

  if (employeeId) {
    conditions.push('e.id = :employeeId');
    replacements.employeeId = parseInt(employeeId, 10);
  }
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';
  if (publishGuard) conditions.push(publishGuard);

  const baseFrom = `
    FROM timesheets t
    JOIN employees e           ON e.id  = t.employee_id
    JOIN service_pos sp        ON sp.id = t.service_po_id
    JOIN service_types st      ON st.id = sp.service_type_id
    JOIN service_categories sc ON sc.id = st.service_category_id
  `;
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Dynamic column headers: categories + service types with data in the period
  const columnsQuery = `
    SELECT DISTINCT
      sc.id               AS category_id,
      sc.name             AS category_name,
      st.id               AS service_type_id,
      st.service_type_name
    ${baseFrom}
    ${whereClause}
    ORDER BY sc.name, st.service_type_name
  `;

  // Count distinct employees
  const countQuery = `
    SELECT COUNT(DISTINCT t.employee_id) AS total
    ${baseFrom}
    ${whereClause}
  `;

  // CTE 1: paged employee list
  // CTE 2: aggregated client names per employee for the period
  // Main SELECT: employee × service_type hours with full employee detail
  const dataQuery = `
    WITH emp_page AS (
      SELECT DISTINCT e.id AS employee_id, e.full_name
      ${baseFrom}
      ${whereClause}
      ORDER BY e.full_name
      LIMIT :limit OFFSET :offset
    ),
    emp_clients AS (
      SELECT
        t.employee_id,
        STRING_AGG(DISTINCT c.client_name, ', ' ORDER BY c.client_name) AS clients
      FROM timesheets t
      JOIN service_pos sp ON sp.id = t.service_po_id AND sp.is_deleted = false
      JOIN clients c      ON c.id  = sp.client_id
      WHERE t.employee_id IN (SELECT employee_id FROM emp_page)
        AND EXTRACT(MONTH FROM t.timesheet_date) = :month
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
        AND t.hours_logged > 0
        ${publishGuard ? `AND ${publishGuard}` : ''}
      GROUP BY t.employee_id
    )
    SELECT
      e.id                      AS employee_id,
      e.employee_code,
      e.full_name,
      e.designation,
      e.total_experience,
      e.company_experience,
      e.resource_description,
      176                       AS monthly_capacity,
      176                       AS monthly_billing_capacity,
      COALESCE(ec.clients, '')  AS clients,
      st.id                     AS service_type_id,
      st.service_type_name,
      sc.id                     AS category_id,
      sc.name                   AS category_name,
      ROUND(SUM(${hoursCol})::NUMERIC, 4) AS hours
    ${baseFrom}
    JOIN emp_page ep  ON ep.employee_id = e.id
    LEFT JOIN emp_clients ec ON ec.employee_id = e.id
    ${whereClause}
    GROUP BY
      e.id, e.employee_code, e.full_name, e.designation,
      e.total_experience, e.company_experience, e.resource_description,
      ec.clients, st.id, st.service_type_name, sc.id, sc.name
    ORDER BY e.full_name, sc.name, st.service_type_name
  `;

  const [columns, countResult, rows] = await Promise.all([
    sequelize.query(columnsQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return {
    columns,
    rows,
    count: parseInt(countResult[0].total, 10),
  };
}

async function getResourseProjectUtilizationReport(filters) {
  const {
    month,
    year,
    search,
    employeeIds,
    employeeName,
    clientIds,
    clientName,
    projectIds,
    projectName,
    serviceTypeId,
    serviceTypeIds,
    projectType,
    categoryId,
    category,
    subProjectId,
    projectSubType,
    limit,
    offset,
    hoursSource,
    roleId,
  } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const monthYear = `${year}-${String(month).padStart(2, '0')}`;

  const replacements = {
    month,
    year,
    monthYear,
    search: search || null,
    employeeName: employeeName || null,
    clientName: clientName || null,
    projectName: projectName || null,
    serviceTypeId: serviceTypeId || null,
    projectType: projectType || null,
    categoryId: categoryId || null,
    category: category || null,
    subProjectId: subProjectId || null,
    projectSubType: projectSubType || null,
    limit,
    offset,
    companyId: filters.companyId,
  };

  // employeeIds / clientIds / projectIds / serviceTypeIds are multi-select —
  // the IN (:param) clause is only appended when a non-empty array is
  // provided, since `IN ()` is invalid SQL and there is no "match everything"
  // array value.
  const multiSelectConditions = [];
  if (employeeIds && employeeIds.length > 0) {
    multiSelectConditions.push('e.id IN (:employeeIds)');
    replacements.employeeIds = employeeIds;
  }
  if (clientIds && clientIds.length > 0) {
    multiSelectConditions.push('c.id IN (:clientIds)');
    replacements.clientIds = clientIds;
  }
  if (projectIds && projectIds.length > 0) {
    multiSelectConditions.push('sp.id IN (:projectIds)');
    replacements.projectIds = projectIds;
  }
  if (serviceTypeIds && serviceTypeIds.length > 0) {
    multiSelectConditions.push('st.id IN (:serviceTypeIds)');
    replacements.serviceTypeIds = serviceTypeIds;
  }
  const multiSelectBlock = multiSelectConditions.map((c) => `AND ${c}`).join('\n    ');

  const filterBlock = `
    AND (
      :search::text IS NULL
      OR e.full_name ILIKE '%' || :search || '%'
      OR c.client_name ILIKE '%' || :search || '%'
      OR sp.service_po_name ILIKE '%' || :search || '%'
      OR st.service_type_name ILIKE '%' || :search || '%'
      OR sc.name ILIKE '%' || :search || '%'
      OR COALESCE(subp.sub_project_name, '') ILIKE '%' || :search || '%'
    )

    ${multiSelectBlock}

    AND (:employeeName::text IS NULL OR e.full_name ILIKE '%' || :employeeName || '%')
    AND (:clientName::text IS NULL OR c.client_name ILIKE '%' || :clientName || '%')
    AND (:projectName::text IS NULL OR sp.service_po_name ILIKE '%' || :projectName || '%')

    AND (:serviceTypeId::int IS NULL OR st.id = :serviceTypeId)
    AND (:projectType::text IS NULL OR st.service_type_name ILIKE '%' || :projectType || '%')

    AND (:categoryId::int IS NULL OR sc.id = :categoryId)
    AND (:category::text IS NULL OR sc.name ILIKE '%' || :category || '%')

    AND (:subProjectId::int IS NULL OR subp.id = :subProjectId)
    AND (:projectSubType::text IS NULL OR subp.sub_project_name ILIKE '%' || :projectSubType || '%')
  `;

  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  const monthYearBlock = `
    AND EXTRACT(MONTH FROM t.timesheet_date) = :month
    AND EXTRACT(YEAR FROM t.timesheet_date) = :year
    AND t.company_id = :companyId
    ${publishGuard}
  `;

  const empPageQuery = `
    SELECT DISTINCT e.id AS employee_id
    FROM timesheets t
    INNER JOIN employees e
      ON e.id = t.employee_id
     AND e.is_deleted = false
    INNER JOIN service_pos sp
      ON sp.id = t.service_po_id
     AND sp.is_deleted = false
    INNER JOIN clients c
      ON c.id = sp.client_id
    INNER JOIN service_types st
      ON st.id = sp.service_type_id
     AND st.is_deleted = false
    INNER JOIN service_categories sc
      ON sc.id = st.service_category_id
     AND sc.is_deleted = false
    LEFT JOIN sub_projects subp
      ON subp.id = t.sub_project_id
    WHERE t.hours_logged > 0
    ${monthYearBlock}
    ${filterBlock}
    ORDER BY e.id
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(DISTINCT t.employee_id) AS total
    FROM timesheets t
    INNER JOIN employees e
      ON e.id = t.employee_id
     AND e.is_deleted = false
    INNER JOIN service_pos sp
      ON sp.id = t.service_po_id
     AND sp.is_deleted = false
    INNER JOIN clients c
      ON c.id = sp.client_id
    INNER JOIN service_types st
      ON st.id = sp.service_type_id
     AND st.is_deleted = false
    INNER JOIN service_categories sc
      ON sc.id = st.service_category_id
     AND sc.is_deleted = false
    LEFT JOIN sub_projects subp
      ON subp.id = t.sub_project_id
    WHERE t.hours_logged > 0
    ${monthYearBlock}
    ${filterBlock}
  `;

  const dataQuery = `
    WITH emp_page AS (${empPageQuery})
    SELECT
      e.id AS employee_id,
      e.full_name AS employee_name,
      sp.id AS project_id,
      sp.service_po_name AS project_name,
      sp.is_billable AS is_billable,
      st.service_type_name AS project_type,
      subp.sub_project_name AS project_sub_type,
      sc.name AS category,
      c.client_name AS client,
      ROUND(SUM(${hoursCol})::numeric, 2) AS project_hours
    FROM timesheets t
    INNER JOIN emp_page ep
      ON ep.employee_id = t.employee_id
    INNER JOIN employees e
      ON e.id = t.employee_id
    INNER JOIN service_pos sp
      ON sp.id = t.service_po_id
    INNER JOIN clients c
      ON c.id = sp.client_id
    INNER JOIN service_types st
      ON st.id = sp.service_type_id
    INNER JOIN service_categories sc
      ON sc.id = st.service_category_id
    LEFT JOIN sub_projects subp
      ON subp.id = t.sub_project_id
    WHERE t.hours_logged > 0
    ${monthYearBlock}
    ${filterBlock}
    GROUP BY
      e.id,
      e.full_name,
      sp.id,
      sp.service_po_name,
      sp.is_billable,
      st.service_type_name,
      subp.sub_project_name,
      sc.name,
      c.client_name
    ORDER BY
      e.full_name,
      sp.service_po_name
  `;

  const costQuery = `
    WITH emp_page AS (${empPageQuery})
    SELECT
      mc.employee_id,
      mc.total_cost
    FROM monthly_costs mc
    INNER JOIN emp_page ep
      ON ep.employee_id = mc.employee_id
    WHERE mc.month_year = :monthYear
  `;

  const [rows, countResult, costs] = await Promise.all([
    sequelize.query(dataQuery, {
      replacements,
      type: QueryTypes.SELECT,
    }),
    sequelize.query(countQuery, {
      replacements,
      type: QueryTypes.SELECT,
    }),
    sequelize.query(costQuery, {
      replacements,
      type: QueryTypes.SELECT,
    }),
  ]);

  return {
    rows,
    costs,
    count: parseInt(countResult[0].total, 10),
  };
}

/**
 * Client Service PO Hours Report — one row per (client, Service PO) with
 * summed hours for the given filters. Independent of getAnalyticsClientByPO
 * (dashboardRepository.js) — not called by/from it, does not modify it.
 *
 * Hierarchy note: `timesheets` has no hierarchy_node_id column at all —
 * Parent/Child hierarchy tagging only exists in `employee_work_logs` (draft
 * data) and is dropped once synced into `timesheets`, where only
 * service_po_id survives. So SUM(hours) GROUP BY service_po_id here is
 * already Main + Parent + Child combined; there is no separate hierarchy
 * row to exclude or roll up.
 *
 * @param {object} filters
 * @param {number} filters.companyId
 * @param {string} filters.startDate - "YYYY-MM-DD"
 * @param {string} filters.endDate - "YYYY-MM-DD"
 * @param {number} [filters.clientId]
 * @param {number} [filters.poId]
 * @param {number} [filters.serviceTypeId]
 * @param {number} [filters.employeeId]
 * @param {string} [filters.status] - Service PO status; 'all' means no filter
 * @param {string} [filters.hoursSource] - 'O' = hours_logged; default = COALESCE(modified_hours, hours_logged)
 * @param {number|string} [filters.roleId] - 5 = exclude unpublished timesheet rows
 * @returns {Promise<Array<{ client_id, client_name, service_po_id, service_po_code, service_po_name, hours }>>}
 */
async function getClientServicePOHours(filters) {
  const {
    companyId,
    startDate,
    endDate,
    clientId,
    poId,
    serviceTypeId,
    employeeId,
    status,
    hoursSource,
    roleId,
  } = filters;

  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours falling back to
  // hours_logged. Same convention used throughout this file.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const replacements = { companyId, startDate, endDate };
  const conditions = [
    't.company_id = :companyId',
    't.timesheet_date >= :startDate',
    't.timesheet_date <= :endDate',
  ];

  if (clientId) {
    conditions.push('sp.client_id = :clientId');
    replacements.clientId = clientId;
  }
  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }
  if (employeeId) {
    conditions.push('t.employee_id = :employeeId');
    replacements.employeeId = employeeId;
  }
  if (status && status !== 'all') {
    conditions.push('sp.status = :status');
    replacements.status = status;
  }
  // Role ID 5 only: exclude unpublished timesheet rows — same guard used
  // throughout this file.
  if (Number(roleId) === 5) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)'
    );
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const query = `
    SELECT
      c.id                                AS client_id,
      c.client_name,
      sp.id                               AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      ROUND(SUM(${hoursCol})::NUMERIC, 2) AS hours
    FROM timesheets t
    INNER JOIN service_pos sp   ON sp.id = t.service_po_id
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    ${whereClause}
    GROUP BY c.id, c.client_name, sp.id, sp.service_po_code, sp.service_po_name
    ORDER BY c.client_name ASC, sp.service_po_name ASC
  `;

  return sequelize.query(query, { replacements, type: QueryTypes.SELECT });
}

/**
 * Convert a "YYYY-MM-DD" date string to a single comparable integer
 * (year*12 + month) — the same encoding dashboardRepository.js uses to
 * compare an arbitrary date range against service_po_monthly_budgets/
 * cost_budget_master rows, which only ever store a whole calendar month
 * (year, month), never a specific day.
 * @param {string} dateStr - "YYYY-MM-DD"
 * @returns {number}
 */
function periodKey(dateStr) {
  const d = new Date(dateStr);
  return d.getUTCFullYear() * 12 + (d.getUTCMonth() + 1);
}

/**
 * Shared WHERE-clause builder for the trend/bench reports below (Monthly
 * Hours Trend, Monthly Utilization Trend, Leave/No-Work Hours Trend,
 * Employee Bench %) — all read `timesheets t` joined to `service_pos sp`
 * (+ `service_types st` where a category is needed) over an explicit
 * startDate/endDate window. Mirrors dashboardRepository.js's
 * buildAnalyticsFilters() so these Reports reproduce the exact same
 * business meaning as the Dashboard analytics they're based on.
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId, hoursSource, roleId }
 * @param {object} replacements - mutated in place with the bind values this clause needs
 * @returns {string} SQL WHERE clause (without the WHERE keyword)
 */
function buildTrendFilters(filters, replacements) {
  const { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId, roleId } = filters;
  const conditions = [
    't.company_id = :companyId',
    't.timesheet_date >= :startDate',
    't.timesheet_date <= :endDate',
  ];
  replacements.companyId = companyId;
  replacements.startDate = startDate;
  replacements.endDate = endDate;

  if (employeeId) {
    conditions.push('t.employee_id = :employeeId');
    replacements.employeeId = employeeId;
  }
  if (clientId) {
    conditions.push('sp.client_id = :clientId');
    replacements.clientId = clientId;
  }
  if (poId) {
    conditions.push('t.service_po_id = :poId');
    replacements.poId = poId;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }
  // Role ID 5 only: exclude unpublished timesheet rows — same guard used
  // throughout this file and dashboardRepository.js.
  if (Number(roleId) === 5) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)'
    );
  }

  return conditions.join(' AND ');
}

/**
 * Client Cost Analytics Report — Part A: total hours per client, entire
 * dataset, unfiltered (matches the Dashboard analytics2 report this is
 * based on — client_wise_cost_analytics is deliberately never scoped by
 * period/employee/client/PO). Merged with getClientCostAnalyticsCost() by
 * the service layer, same two-query-then-merge approach
 * dashboardRepository.js's getClientWiseCostAnalytics() uses (a client with
 * hours but no cost, or vice versa, must still appear).
 *
 * @param {object} filters - { companyId, hoursSource }
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_hours }
 */
async function getClientCostAnalyticsHours(filters) {
  const { companyId, hoursSource } = filters;
  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS total_hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     INNER JOIN clients c      ON c.id  = sp.client_id
     WHERE t.company_id = :companyId
     GROUP BY c.id, c.client_name`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Client Cost Analytics Report — Part B: total cost (Invoice Master —
 * service_po_monthly_budgets.billed_amount) per client, entire dataset,
 * unfiltered. See getClientCostAnalyticsHours() above.
 *
 * @param {object} filters - { companyId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_cost }
 */
async function getClientCostAnalyticsCost(filters) {
  const { companyId } = filters;

  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(COALESCE(SUM(spmb.billed_amount), 0)::NUMERIC, 2) AS total_cost
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp ON sp.id = spmb.service_po_id
     INNER JOIN clients c      ON c.id  = sp.client_id
     WHERE sp.company_id = :companyId
     GROUP BY c.id, c.client_name`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Client Cost Analytics Report — Part C: per client, total cost broken down
 * by service-type category (Invoice Master basis), entire dataset,
 * unfiltered — same shape/scope as dashboardRepository.js's
 * getClientCategoryCostMatrix().
 *
 * @param {object} filters - { companyId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, category_name, cost }
 */
async function getClientCategoryCostMatrixReport(filters) {
  const { companyId } = filters;

  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       COALESCE(sc.name, 'Uncategorized') AS category_name,
       ROUND(COALESCE(SUM(spmb.billed_amount), 0)::NUMERIC, 2) AS cost
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp        ON sp.id = spmb.service_po_id
     INNER JOIN clients c             ON c.id  = sp.client_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE sp.company_id = :companyId
     GROUP BY c.id, c.client_name, category_name
     ORDER BY c.client_name, category_name`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Client Wise Analytics Report — Part A: total hours + distinct project
 * (Service PO) count per client, for the given period/filters. Merged with
 * getClientWiseAnalyticsCost() by the service layer — mirrors
 * dashboardRepository.js's getClientWiseAnalytics().
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId, hoursSource, roleId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_hours, total_projects }
 */
async function getClientWiseAnalyticsHours(filters) {
  const replacements = {};
  const whereClause = buildTrendFilters(filters, replacements);
  const hoursCol = (filters.hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS total_hours,
       COUNT(DISTINCT sp.id) AS total_projects
     FROM timesheets t
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN clients c        ON c.id  = sp.client_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     WHERE ${whereClause}
     GROUP BY c.id, c.client_name`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Client Wise Analytics Report — Part B: total cost (Invoice Master) per
 * client, for the given period/filters. See getClientWiseAnalyticsHours()
 * above. employeeId (no direct equivalent on Invoice Master) narrows to
 * Service POs that employee actually logged hours against in the period,
 * while still summing that PO's full billed_amount — same documented
 * interpretation as dashboardRepository.js's buildInvoiceMasterFilters().
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_cost }
 */
async function getClientWiseAnalyticsCost(filters) {
  const { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId } = filters;
  const replacements = { companyId, startPeriodKey: periodKey(startDate), endPeriodKey: periodKey(endDate) };
  const conditions = [
    'sp.company_id = :companyId',
    '(spmb.year * 12 + spmb.month) BETWEEN :startPeriodKey AND :endPeriodKey',
  ];

  if (clientId) {
    conditions.push('sp.client_id = :clientId');
    replacements.clientId = clientId;
  }
  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }
  if (employeeId) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheets et WHERE et.service_po_id = sp.id AND et.employee_id = :employeeId ' +
      'AND et.timesheet_date >= :empStartDate AND et.timesheet_date <= :empEndDate)'
    );
    replacements.employeeId = employeeId;
    replacements.empStartDate = startDate;
    replacements.empEndDate = endDate;
  }

  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(COALESCE(SUM(spmb.billed_amount), 0)::NUMERIC, 2) AS total_cost
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp   ON sp.id = spmb.service_po_id
     INNER JOIN clients c        ON c.id  = sp.client_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY c.id, c.client_name`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Monthly Hours Trend Report — Cost by Category series: total cost per
 * month (Invoice Master — service_po_monthly_budgets.billed_amount) broken
 * down by service-type category — same business rule as
 * dashboardRepository.js's getCostTrendByType(). No timesheets join —
 * Invoice Master rows are already at the (Service PO, month, year)
 * granularity, so no aggregation-inflation risk.
 *
 * @param {object} filters - { companyId, startDate, endDate, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { year, month, category_name, cost }
 */
async function getMonthlyCostByCategory(filters) {
  const { companyId, startDate, endDate, clientId, poId, serviceTypeId } = filters;
  const replacements = { companyId, startPeriodKey: periodKey(startDate), endPeriodKey: periodKey(endDate) };
  const conditions = [
    'sp.company_id = :companyId',
    '(spmb.year * 12 + spmb.month) BETWEEN :startPeriodKey AND :endPeriodKey',
  ];

  if (clientId) {
    conditions.push('sp.client_id = :clientId');
    replacements.clientId = clientId;
  }
  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }

  return sequelize.query(
    `SELECT
       spmb.year,
       spmb.month,
       COALESCE(sc.name, 'Uncategorized') AS category_name,
       ROUND(COALESCE(SUM(spmb.billed_amount), 0)::NUMERIC, 2) AS cost
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp        ON sp.id = spmb.service_po_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY spmb.year, spmb.month, category_name
     ORDER BY spmb.year, spmb.month, category_name`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Monthly Hours Trend Report — total hours per month, broken down by
 * service-type category (via service_categories.report_bucket_key, same
 * data-driven classification as dashboardRepository.js's
 * getAnalyticsMonthlyTrend() — never a hardcoded category-name comparison).
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId, hoursSource, roleId }
 * @returns {Promise<object[]>} rows: { year, month, category_name, report_bucket_key, hours }
 */
async function getMonthlyHoursByCategory(filters) {
  const replacements = {};
  const whereClause = buildTrendFilters(filters, replacements);
  const hoursCol = (filters.hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       COALESCE(sc.name, 'Uncategorized')         AS category_name,
       sc.report_bucket_key,
       ROUND(SUM(${hoursCol})::NUMERIC, 2)     AS hours
     FROM timesheets t
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     LEFT JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${whereClause}
     GROUP BY year, month, category_name, sc.report_bucket_key
     ORDER BY year, month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Monthly Hours Trend Report — Utilization series: total hours logged per
 * month and the subset logged against a Billable-category Service PO
 * (service_categories.report_bucket_key = 'billable'), same business rule
 * as dashboardRepository.js's getMonthlyBillableUtilization().
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId, hoursSource, roleId }
 * @returns {Promise<object[]>} rows: { year, month, total_hours, billable_hours }
 */
async function getMonthlyUtilizationTrend(filters) {
  const replacements = {};
  const whereClause = buildTrendFilters(filters, replacements);
  const hoursCol = (filters.hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS total_hours,
       ROUND(COALESCE(SUM(CASE WHEN sc.report_bucket_key = 'billable' THEN ${hoursCol} END), 0)::NUMERIC, 2) AS billable_hours
     FROM timesheets t
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     LEFT JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${whereClause}
     GROUP BY year, month
     ORDER BY year, month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Monthly Hours Trend Report — Leave Hours series: total hours per month
 * logged against the "Leaves" service type only — same rule as
 * dashboardRepository.js's getLeaveHoursTrend().
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId, hoursSource, roleId }
 * @returns {Promise<object[]>} rows: { year, month, leave_hours }
 */
async function getLeaveHoursTrendReport(filters) {
  const replacements = {};
  const whereClause = buildTrendFilters(filters, replacements);
  const hoursCol = (filters.hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS leave_hours
     FROM timesheets t
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     WHERE ${whereClause}
       AND LOWER(st.service_type_name) = 'leaves'
     GROUP BY year, month
     ORDER BY year, month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Monthly Hours Trend Report — No Work Hours series: total hours per month
 * logged against Service POs named exactly "Idle" or "On Bench"
 * (case-insensitive) — same rule as dashboardRepository.js's getNoWorkTrend().
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, serviceTypeId, hoursSource, roleId }
 * @returns {Promise<object[]>} rows: { year, month, no_work_hours }
 */
async function getNoWorkTrendReport(filters) {
  const replacements = {};
  const whereClause = buildTrendFilters(filters, replacements);
  const hoursCol = (filters.hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS no_work_hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE ${whereClause}
       AND LOWER(sp.service_po_name) IN ('idle', 'on bench')
     GROUP BY year, month
     ORDER BY year, month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Employee Bench Percentage Report — hours per (employee, Service PO) pair
 * for the given period/filters, the same raw shape
 * dashboardRepository.js's getAnalyticsBenchDetail() returns; the service
 * layer applies the same "Idle"/"Bench" keyword match (on the Service PO
 * name) to split each employee's hours into bench vs total.
 *
 * @param {object} filters - { companyId, startDate, endDate, employeeId, clientId, poId, hoursSource, roleId }
 * @returns {Promise<object[]>} rows: { employee_id, employee_code, full_name, service_po_name, hours }
 */
async function getEmployeeBenchDetailReport(filters) {
  const replacements = {};
  const whereClause = buildTrendFilters(filters, replacements);
  const hoursCol = (filters.hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       e.id AS employee_id,
       e.employee_code,
       e.full_name,
       sp.service_po_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS hours
     FROM timesheets t
     INNER JOIN employees e    ON e.id  = t.employee_id
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE ${whereClause}
     GROUP BY e.id, e.employee_code, e.full_name, sp.service_po_name`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Budget vs Billed Report — Budget Cost (cost_budget_master.invoice_amount)
 * vs Actual Billed Amount (service_po_monthly_budgets.billed_amount), one
 * row per (service_po_id, month, year) present in EITHER table for the
 * given period/filters — same FULL OUTER JOIN business logic as
 * dashboardRepository.js's getBudgetVsBilled(), reproduced here (not
 * called directly) so this Report stays independently correct even if the
 * Dashboard's own implementation changes shape later. Only 'active'
 * cost_budget_master rows count as budget. employeeId has no meaning here
 * (both source tables are Service-PO-level, never per-employee) and is
 * intentionally not a supported filter.
 *
 * @param {object} filters - { companyId, startDate, endDate, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { service_po_id, service_po_code, service_po_name, client_id, client_name, year, month, budget_cost, billed_amount }
 */
async function getBudgetVsBilled(filters) {
  const { companyId, startDate, endDate, clientId, poId, serviceTypeId } = filters;
  const replacements = { companyId, startPeriodKey: periodKey(startDate), endPeriodKey: periodKey(endDate) };
  const conditions = [
    'sp.company_id = :companyId',
    "(cbm.id IS NULL OR cbm.status = 'active')",
    '(COALESCE(cbm.year, spmb.year) * 12 + COALESCE(cbm.month, spmb.month)) BETWEEN :startPeriodKey AND :endPeriodKey',
  ];

  if (clientId) {
    conditions.push('sp.client_id = :clientId');
    replacements.clientId = clientId;
  }
  if (poId) {
    conditions.push('sp.id = :poId');
    replacements.poId = poId;
  }
  if (serviceTypeId) {
    conditions.push('st.id = :serviceTypeId');
    replacements.serviceTypeId = serviceTypeId;
  }

  return sequelize.query(
    `SELECT
       COALESCE(cbm.service_po_id, spmb.service_po_id) AS service_po_id,
       sp.service_po_code,
       sp.service_po_name,
       sp.client_id,
       c.client_name,
       COALESCE(cbm.year, spmb.year)   AS year,
       COALESCE(cbm.month, spmb.month) AS month,
       ROUND(COALESCE(cbm.invoice_amount, 0)::NUMERIC, 2) AS budget_cost,
       ROUND(COALESCE(spmb.billed_amount, 0)::NUMERIC, 2) AS billed_amount
     FROM cost_budget_master cbm
     FULL OUTER JOIN service_po_monthly_budgets spmb
       ON spmb.service_po_id = cbm.service_po_id
      AND spmb.month = cbm.month
      AND spmb.year = cbm.year
     INNER JOIN service_pos sp   ON sp.id = COALESCE(cbm.service_po_id, spmb.service_po_id)
     INNER JOIN service_types st ON st.id = sp.service_type_id
     INNER JOIN clients c        ON c.id  = sp.client_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sp.id, year, month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

module.exports = {
  getEmployeeHourlyRate,
  getMonthlyCostSummary,
  getTimesheetSummary,
  getServicePOUtilisation,
  getSubProjectHours,
  getResourceAllocation,
  getOperationalCostBreakdown,
  getEmployeeUtilizationSummary,
  getServicePOSummary,
  getInvoicePOSummary,
  getResourceUtilization,
  getMonthlyResourceUtilization,
  getClientCostAnalyticsHours,
  getClientCostAnalyticsCost,
  getClientCategoryCostMatrixReport,
  getClientWiseAnalyticsHours,
  getClientWiseAnalyticsCost,
  getMonthlyHoursByCategory,
  getMonthlyCostByCategory,
  getMonthlyUtilizationTrend,
  getLeaveHoursTrendReport,
  getNoWorkTrendReport,
  getEmployeeBenchDetailReport,
  getBudgetVsBilled,
  getResourseProjectUtilizationReport,
  getClientServicePOHours,
};