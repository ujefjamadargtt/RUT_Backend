'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Dashboard Repository
 * Individual focused queries — each returns a single scalar or a small result set.
 * Designed to be called in parallel by the service layer (Promise.all).
 */

/**
 * Total employees ever registered (regardless of status).
 * @returns {Promise<number>}
 */
async function getTotalEmployees(companyId) {
  const [result] = await sequelize.query(
    'SELECT COUNT(*) AS total FROM employees WHERE company_id = :companyId',
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return parseInt(result.total, 10);
}

/**
 * Active employees count.
 * @returns {Promise<number>}
 */
async function getActiveEmployees(companyId) {
  const [result] = await sequelize.query(
    "SELECT COUNT(*) AS total FROM employees WHERE status = 'active' AND company_id = :companyId",
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return parseInt(result.total, 10);
}

/**
 * Total clients (all statuses).
 * @returns {Promise<number>}
 */
async function getTotalClients(companyId) {
  const [result] = await sequelize.query(
    'SELECT COUNT(*) AS total FROM clients WHERE company_id = :companyId',
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return parseInt(result.total, 10);
}

/**
 * Active Service POs count.
 * "Active" = not yet closed out: in-progress, on-hold, or pending
 * (service_pos.status has no literal 'active' value — see ServicePO model).
 * @returns {Promise<number>}
 */
async function getActivePOs(companyId) {
  const [result] = await sequelize.query(
    "SELECT COUNT(*) AS total FROM service_pos WHERE status IN ('in-progress', 'on-hold', 'pending') AND company_id = :companyId",
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return parseInt(result.total, 10);
}

/**
 * Closed Service POs count.
 * @returns {Promise<number>}
 */
async function getClosedPOs(companyId) {
  const [result] = await sequelize.query(
    "SELECT COUNT(*) AS total FROM service_pos WHERE status = 'closed' AND company_id = :companyId",
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
  return parseInt(result.total, 10);
}

/**
 * Total hours logged in the given calendar month.
 *
 * @param {number} month - 1-12
 * @param {number} year
 * @returns {Promise<number>}
 */
async function getCurrentMonthHours(month, year, hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  const [result] = await sequelize.query(
    `SELECT COALESCE(SUM(${hoursCol}), 0) AS total_hours
     FROM timesheets t
     WHERE EXTRACT(MONTH FROM timesheet_date) = :month
       AND EXTRACT(YEAR  FROM timesheet_date) = :year
       AND t.company_id = :companyId
       ${publishGuard}`,
    {
      replacements: { month, year, companyId },
      type: QueryTypes.SELECT,
    }
  );
  return parseFloat(result.total_hours) || 0;
}

/**
 * Billable vs non-billable hours logged in the given calendar month,
 * classified by the Service PO's is_billable flag.
 *
 * @param {number} month - 1-12
 * @param {number} year
 * @returns {Promise<{ billable_hours: number, non_billable_hours: number }>}
 */
async function getCurrentMonthBillableSplit(month, year, hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  const [result] = await sequelize.query(
    `SELECT
       COALESCE(SUM(CASE WHEN sp.is_billable = true  THEN ${hoursCol} END), 0) AS billable_hours,
       COALESCE(SUM(CASE WHEN sp.is_billable = false THEN ${hoursCol} END), 0) AS non_billable_hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
       AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
       AND t.company_id = :companyId
       ${publishGuard}`,
    {
      replacements: { month, year, companyId },
      type: QueryTypes.SELECT,
    }
  );
  return {
    billable_hours: parseFloat(result.billable_hours) || 0,
    non_billable_hours: parseFloat(result.non_billable_hours) || 0,
  };
}

/**
 * Overall utilisation percentage for the given month/year:
 *   SUM(actual hours logged on active POs) / SUM(expected_man_hours of those POs) * 100
 *
 * Only POs that have expected_man_hours set are included in the denominator.
 *
 * @param {number} month
 * @param {number} year
 * @returns {Promise<number|null>} Rounded to 2 decimal places, or null if no data
 */
async function getOverallUtilisation(month, year, hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: exclude unpublished timesheet rows from the join.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  const [result] = await sequelize.query(
    `SELECT
       COALESCE(SUM(${hoursCol}), 0)         AS actual_hours,
       COALESCE(SUM(sp.expected_man_hours), 0)  AS expected_hours
     FROM service_pos sp
     LEFT JOIN timesheets t
       ON  t.service_po_id = sp.id
       AND EXTRACT(MONTH FROM t.timesheet_date) = :month
       AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
       ${publishGuard}
     WHERE sp.status IN ('in-progress', 'on-hold', 'pending')
       AND sp.expected_man_hours IS NOT NULL
       AND sp.expected_man_hours > 0
       AND sp.company_id = :companyId`,
    {
      replacements: { month, year, companyId },
      type: QueryTypes.SELECT,
    }
  );

  const actual = parseFloat(result.actual_hours) || 0;
  const expected = parseFloat(result.expected_hours) || 0;

  if (expected === 0) return null;
  return Math.round((actual / expected) * 100 * 100) / 100;
}

/**
 * Same as getOverallUtilisation() above (actual hours logged vs. each
 * in-progress PO's total expected_man_hours), scoped to an arbitrary date
 * window instead of a single calendar month. This is a distinct metric from
 * the Analytics Dashboard's existing tiles.utilization_pct (billable hours /
 * total hours logged) — this one measures capacity usage against contracted
 * PO hours.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<number|null>} Rounded to 2 decimal places, or null if no data
 */
async function getOverallUtilisationForPeriod(startDate, endDate, hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: exclude unpublished timesheet rows from the join so a
  // window spanning several months still reflects whichever of those months
  // ARE published, instead of an all-or-nothing block on the whole window.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  const [result] = await sequelize.query(
    `SELECT
       COALESCE(SUM(${hoursCol}), 0)         AS actual_hours,
       COALESCE(SUM(sp.expected_man_hours), 0)  AS expected_hours
     FROM service_pos sp
     LEFT JOIN timesheets t
       ON  t.service_po_id = sp.id
       AND t.timesheet_date >= :startDate
       AND t.timesheet_date <= :endDate
       ${publishGuard}
     WHERE sp.status IN ('in-progress', 'on-hold', 'pending')
       AND sp.expected_man_hours IS NOT NULL
       AND sp.expected_man_hours > 0
       AND sp.company_id = :companyId`,
    {
      replacements: { startDate, endDate, companyId },
      type: QueryTypes.SELECT,
    }
  );

  const actual = parseFloat(result.actual_hours) || 0;
  const expected = parseFloat(result.expected_hours) || 0;

  if (expected === 0) return null;
  return Math.round((actual / expected) * 100 * 100) / 100;
}

/**
 * Total PO value (revenue) across active and closed POs, scoped by either a
 * plain calendar year (year) or an explicit date window (startDate/endDate —
 * used by the Analytics Dashboard to pass its resolved period: an explicit
 * startDate/endDate, else month+year, else fiscal quarter, else the whole
 * fiscal year — the exact same scopedFilters every other Analytics Dashboard
 * tile uses, rather than always the full fiscal year regardless of the
 * caller's requested period). startDate/endDate take precedence over year
 * when both are given.
 *
 * The startDate/endDate window is matched by overlap (sp.start_date <= endDate
 * AND (sp.end_date IS NULL OR sp.end_date >= startDate)), not by requiring
 * sp.start_date itself to fall inside the window — a PO that started before
 * the window and is still running (or has no end_date) is still "active" PO
 * value for that period. Matching only on sp.start_date BETWEEN would drop a
 * long-running PO's value from every period after the one it started in,
 * showing 0 for any month/quarter with no newly-started POs even though
 * plenty of PO value is actively in play.
 *
 * employeeId/clientId/poId/serviceTypeId/serviceCategoryId are all optional
 * and, when given, scope the sum to only the matching POs — employeeId is
 * applied via an EXISTS against timesheets (the only one of these filters
 * that isn't a direct attribute of service_pos/service_types/service_categories),
 * so a PO is counted once regardless of how many matching timesheet rows it has.
 *
 * @param {object} filters
 * @param {number} [filters.year]        - calendar year (legacy/simple callers)
 * @param {string} [filters.startDate]   - YYYY-MM-DD, period window start
 * @param {string} [filters.endDate]     - YYYY-MM-DD, period window end
 * @param {number} [filters.employeeId]
 * @param {number} [filters.clientId]
 * @param {number} [filters.poId]
 * @param {number} [filters.serviceTypeId]
 * @param {number} [filters.serviceCategoryId]
 * @returns {Promise<number>}
 */
async function getTotalRevenue(filters = {}) {
  const { year, startDate, endDate, employeeId, clientId, poId, serviceTypeId, serviceCategoryId, companyId } = filters;

  const conditions = ["sp.status IN ('in-progress', 'on-hold', 'pending', 'completed', 'closed')", 'sp.company_id = :companyId'];
  const replacements = { companyId };

  if (startDate && endDate) {
    conditions.push('sp.start_date <= :endDate AND (sp.end_date IS NULL OR sp.end_date >= :startDate)');
    replacements.startDate = startDate;
    replacements.endDate = endDate;
  } else if (year) {
    conditions.push('EXTRACT(YEAR FROM sp.start_date) = :year');
    replacements.year = year;
  }

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
  if (serviceCategoryId) {
    conditions.push('sc.id = :serviceCategoryId');
    replacements.serviceCategoryId = serviceCategoryId;
  }
  if (employeeId) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheets t WHERE t.service_po_id = sp.id AND t.employee_id = :employeeId)'
    );
    replacements.employeeId = employeeId;
  }

  const [result] = await sequelize.query(
    `SELECT COALESCE(SUM(sp.po_value), 0) AS total_revenue
     FROM service_pos sp
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${conditions.join(' AND ')}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return parseFloat(result.total_revenue) || 0;
}

/**
 * Total Budget Cost for the resolved period + filters, from
 * cost_budget_master.invoice_amount — used by getAnalyticsDashboard() (the
 * /analytics route) for financials.total_po_value_fiscal_year, replacing
 * getTotalRevenue()'s SUM(service_pos.po_value). getTotalRevenue() itself is
 * intentionally left untouched above: /dashboard/stats still calls it for
 * financials.total_po_value_current_year, which is out of scope for this
 * change.
 *
 * Only 'active' cost_budget_master rows count (a deactivated budget entry
 * is treated the same as "no budget"). startDate/endDate are matched
 * against cost_budget_master's own month/year columns via periodKey() (see
 * the "NEW IMPLEMENTATION" block below) — a Service PO's start_date/end_date
 * (what getTotalRevenue() uses) is unrelated to which months actually have a
 * budget entry, so budget-year matching is intentionally month/year-exact
 * instead.
 *
 * @param {object} filters - { startDate, endDate, year, employeeId, clientId, poId, serviceTypeId, serviceCategoryId, companyId }
 * @returns {Promise<number>}
 */
async function getTotalBudgetCost(filters = {}) {
  const { startDate, endDate, year, employeeId, clientId, poId, serviceTypeId, serviceCategoryId, companyId } = filters;

  const conditions = ["cbm.status = 'active'", 'sp.company_id = :companyId'];
  const replacements = { companyId };

  if (startDate && endDate) {
    replacements.startPeriodKey = periodKey(startDate);
    replacements.endPeriodKey = periodKey(endDate);
    conditions.push('(cbm.year * 12 + cbm.month) BETWEEN :startPeriodKey AND :endPeriodKey');
  } else if (year) {
    conditions.push('cbm.year = :year');
    replacements.year = year;
  }

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
  if (serviceCategoryId) {
    conditions.push('sc.id = :serviceCategoryId');
    replacements.serviceCategoryId = serviceCategoryId;
  }
  if (employeeId) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheets t WHERE t.service_po_id = sp.id AND t.employee_id = :employeeId)'
    );
    replacements.employeeId = employeeId;
  }

  const [result] = await sequelize.query(
    `SELECT COALESCE(SUM(cbm.invoice_amount), 0) AS total_budget_cost
     FROM cost_budget_master cbm
     INNER JOIN service_pos sp        ON sp.id = cbm.service_po_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${conditions.join(' AND ')}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return parseFloat(result.total_budget_cost) || 0;
}

/**
 * Recent timesheet activity — last 5 distinct employees who logged hours.
 * Used by dashboard to show a live "activity feed".
 *
 * @returns {Promise<object[]>}
 */
async function getRecentTimesheetActivity(hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: this feed has no month/year of its own to gate as a
  // whole (it's "whatever is most recent"), so unpublished rows are excluded
  // at the row level instead — a row only counts if its import batch has
  // been published. A row with no import batch at all (timesheet_import_id
  // IS NULL) is treated the same as unpublished, matching
  // arePeriodsFullyPublished()'s "no completed import = not published" default.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  return sequelize.query(
    `SELECT DISTINCT ON (t.employee_id)
       e.employee_code,
       e.full_name,
       e.designation,
       t.timesheet_date,
       ${hoursCol} AS hours_logged,
       sp.service_po_name
     FROM timesheets t
     INNER JOIN employees e    ON e.id  = t.employee_id
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE t.company_id = :companyId
       ${publishGuard}
     ORDER BY t.employee_id, t.timesheet_date DESC
     LIMIT 5`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Same as getRecentTimesheetActivity() above, scoped to an arbitrary date
 * window (used by the Analytics Dashboard's fiscalYear/quarter/month/
 * startDate-endDate filters) instead of all time.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<object[]>}
 */
async function getRecentTimesheetActivityForPeriod(startDate, endDate, hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: exclude unpublished timesheet rows so a window spanning
  // several months still reflects whichever of those months ARE published,
  // instead of an all-or-nothing block on the whole window.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  return sequelize.query(
    `SELECT DISTINCT ON (t.employee_id)
       e.employee_code,
       e.full_name,
       e.designation,
       t.timesheet_date,
       ${hoursCol} AS hours_logged,
       sp.service_po_name
     FROM timesheets t
     INNER JOIN employees e    ON e.id  = t.employee_id
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE t.timesheet_date >= :startDate
       AND t.timesheet_date <= :endDate
       AND t.company_id = :companyId
       ${publishGuard}
     ORDER BY t.employee_id, t.timesheet_date DESC
     LIMIT 5`,
    { replacements: { startDate, endDate, companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Top 5 POs by hours logged (all time), per service category.
 * Returns a flat list (already capped to the top 5 within each category via
 * ROW_NUMBER) — grouping into billable/non-billable/customer-non-billable
 * buckets happens in the service layer.
 * @returns {Promise<object[]>}
 */
async function getTopPOsByHours(hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: no single month/year to gate the whole query against
  // (it's an all-time ranking), so unpublished timesheet rows are excluded
  // via the join condition instead — an excluded row just contributes 0
  // hours (LEFT JOIN keeps the PO row itself), rather than an all-or-nothing
  // block. A row with no import batch at all is treated the same as
  // unpublished, matching arePeriodsFullyPublished()'s safe default.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  return sequelize.query(
    `SELECT id, service_po_code, service_po_name, client_name, expected_man_hours,
            category_name, total_hours_logged
     FROM (
       SELECT
         sp.id,
         sp.service_po_code,
         sp.service_po_name,
         c.client_name,
         sp.expected_man_hours,
         sc.name AS category_name,
         COALESCE(SUM(${hoursCol}), 0) AS total_hours_logged,
         ROW_NUMBER() OVER (
           PARTITION BY sc.name
           ORDER BY COALESCE(SUM(${hoursCol}), 0) DESC
         ) AS rn
       FROM service_pos sp
       INNER JOIN clients c            ON c.id  = sp.client_id
       INNER JOIN service_types st     ON st.id = sp.service_type_id
       INNER JOIN service_categories sc ON sc.id = st.service_category_id
       LEFT  JOIN timesheets t         ON t.service_po_id = sp.id
                                       ${publishGuard}
       WHERE sp.company_id = :companyId
       GROUP BY sp.id, sp.service_po_code, sp.service_po_name, c.client_name, sp.expected_man_hours, sc.name
     ) ranked
     WHERE rn <= 5
     ORDER BY category_name, total_hours_logged DESC`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Top 5 POs by hours logged within an arbitrary date window, per service
 * category. Same shape as getTopPOsByHours() above, just scoped to a period
 * (used by the Analytics Dashboard's fiscalYear/quarter/month/startDate-endDate
 * filters) instead of all time.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<object[]>}
 */
async function getTopPOsByHoursForPeriod(startDate, endDate, hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: exclude unpublished timesheet rows from the join so a
  // window spanning several months still reflects whichever of those months
  // ARE published, instead of an all-or-nothing block on the whole window.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  return sequelize.query(
    `SELECT id, service_po_code, service_po_name, client_name, expected_man_hours,
            category_name, report_bucket_key, total_hours_logged
     FROM (
       SELECT
         sp.id,
         sp.service_po_code,
         sp.service_po_name,
         c.client_name,
         sp.expected_man_hours,
         sc.name AS category_name,
         sc.report_bucket_key,
         COALESCE(SUM(${hoursCol}), 0) AS total_hours_logged,
         ROW_NUMBER() OVER (
           PARTITION BY sc.name
           ORDER BY COALESCE(SUM(${hoursCol}), 0) DESC
         ) AS rn
       FROM service_pos sp
       INNER JOIN clients c            ON c.id  = sp.client_id
       INNER JOIN service_types st     ON st.id = sp.service_type_id
       INNER JOIN service_categories sc ON sc.id = st.service_category_id
       LEFT  JOIN timesheets t         ON t.service_po_id = sp.id
                                       AND t.timesheet_date >= :startDate
                                       AND t.timesheet_date <= :endDate
                                       ${publishGuard}
       WHERE sp.company_id = :companyId
       GROUP BY sp.id, sp.service_po_code, sp.service_po_name, c.client_name, sp.expected_man_hours, sc.name, sc.report_bucket_key
     ) ranked
     WHERE rn <= 5
     ORDER BY category_name, total_hours_logged DESC`,
    { replacements: { startDate, endDate, companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Distinct employee count per service category, for a given month/year.
 * An employee who logged hours against more than one category in the month
 * is counted once in each category they contributed to (categories are not
 * mutually exclusive per employee).
 *
 * @param {number} month
 * @param {number} year
 * @returns {Promise<object[]>} rows: { category_name, employee_count }
 */
async function getEmployeeCountByCategory(month, year, roleId, companyId) {
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  return sequelize.query(
    `SELECT sc.name AS category_name, COUNT(DISTINCT t.employee_id) AS employee_count
     FROM timesheets t
     INNER JOIN service_pos sp        ON sp.id = t.service_po_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     INNER JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
       AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
       AND t.hours_logged > 0
       AND t.company_id = :companyId
       ${publishGuard}
     GROUP BY sc.name`,
    { replacements: { month, year, companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Distinct employee count per service category, for an arbitrary date window
 * (used by the Analytics Dashboard's fiscalYear/quarter/month/startDate-endDate
 * filters). Same semantics as getEmployeeCountByCategory() above, just scoped
 * by a date range instead of a single calendar month.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<object[]>} rows: { category_name, employee_count }
 */
async function getEmployeeCountByCategoryForPeriod(startDate, endDate, roleId, companyId) {
  // Role ID 5 only: exclude unpublished timesheet rows so a window spanning
  // several months still reflects whichever of those months ARE published,
  // instead of an all-or-nothing block on the whole window.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  return sequelize.query(
    `SELECT sc.name AS category_name, sc.report_bucket_key, COUNT(DISTINCT t.employee_id) AS employee_count
     FROM timesheets t
     INNER JOIN service_pos sp        ON sp.id = t.service_po_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     INNER JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE t.timesheet_date >= :startDate
       AND t.timesheet_date <= :endDate
       AND t.hours_logged > 0
       AND t.company_id = :companyId
       ${publishGuard}
     GROUP BY sc.name, sc.report_bucket_key`,
    { replacements: { startDate, endDate, companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Distinct active employee/client counts with actual timesheet activity in a
 * given month/year — mirrors the activity-based counting used by
 * getAnalyticsTiles() (quarter/fiscal-year view) so the two can be compared
 * like-for-like, unlike getActiveEmployees()/getTotalClients() which are
 * global, all-time headcounts unaffected by any period filter.
 *
 * @param {number} month
 * @param {number} year
 * @returns {Promise<{ active_employees: number, active_clients: number }>}
 */
async function getActiveCountsForPeriod(month, year, roleId, companyId) {
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  const [result] = await sequelize.query(
    `SELECT
       COUNT(DISTINCT CASE WHEN e.status = 'active' AND e.is_deleted = 'f' THEN e.id END) AS active_employees,
       COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.id END) AS active_clients
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     INNER JOIN employees e    ON e.id  = t.employee_id
     INNER JOIN clients c      ON c.id  = sp.client_id
     WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
       AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
       AND t.company_id = :companyId
       ${publishGuard}`,
    { replacements: { month, year, companyId }, type: QueryTypes.SELECT }
  );

  return {
    active_employees: parseInt(result.active_employees, 10),
    active_clients: parseInt(result.active_clients, 10),
  };
}

/**
 * Monthly hours trend for the last 6 months (for sparkline / chart).
 * @returns {Promise<object[]>}
 */
async function getMonthlyHoursTrend(hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: this trend spans a 6-month rolling window rather than a
  // single selected period, so a whole-query block doesn't fit — unpublished
  // months are excluded row-by-row instead, leaving published months in the
  // window intact. A row with no import batch at all is treated the same as
  // unpublished, matching arePeriodsFullyPublished()'s safe default.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';
  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM timesheet_date)::int AS year,
       EXTRACT(MONTH FROM timesheet_date)::int AS month,
       TO_CHAR(timesheet_date, 'Mon YYYY')     AS label,
       ROUND(SUM(${hoursCol})::numeric, 2)   AS total_hours
     FROM timesheets t
     WHERE timesheet_date >= (CURRENT_DATE - INTERVAL '6 months')
       AND t.company_id = :companyId
       ${publishGuard}
     GROUP BY year, month, label
     ORDER BY year ASC, month ASC`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Per-employee billable/non-billable hour breakdown for a given month/year,
 * plus the per-Service-PO detail rows that explain WHY each employee's hours
 * landed in each bucket (each PO's is_billable flag + hours contributed).
 * Paginated at the employee level.
 *
 * @param {object} filters
 * @param {number} filters.month
 * @param {number} filters.year
 * @param {string} [filters.search]   - matches employee full_name or employee_code
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getEmployeeBillableBreakdown(filters) {
  const { month, year, search, limit, offset, hoursSource, roleId, companyId } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const replacements = { month: parseInt(month, 10), year: parseInt(year, 10), limit, offset, companyId };
  const searchCondition = search ? 'AND (e.full_name ILIKE :search OR e.employee_code ILIKE :search)' : '';
  if (search) replacements.search = `%${search}%`;
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  const countQuery = `
    SELECT COUNT(DISTINCT e.id) AS total
    FROM timesheets t
    INNER JOIN employees e ON e.id = t.employee_id
    WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
      AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
      AND e.is_deleted = false
      AND e.status = 'active'
      AND t.company_id = :companyId
      ${searchCondition}
      ${publishGuard}
  `;

  const dataQuery = `
    WITH emp_page AS (
      SELECT DISTINCT e.id AS employee_id, e.full_name
      FROM timesheets t
      INNER JOIN employees e ON e.id = t.employee_id
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
        AND e.is_deleted = false
        AND e.status = 'active'
        AND t.company_id = :companyId
        ${searchCondition}
        ${publishGuard}
      ORDER BY e.full_name
      LIMIT :limit OFFSET :offset
    )
    SELECT
      e.id                AS employee_id,
      e.employee_code,
      e.full_name,
      e.designation,
      sp.id               AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.is_billable,
      st.service_type_name,
      sc.name AS category_name,
      sc.report_bucket_key,
      ROUND(SUM(${hoursCol})::NUMERIC, 2) AS hours
    FROM timesheets t
    INNER JOIN employees e      ON e.id  = t.employee_id
    INNER JOIN emp_page ep      ON ep.employee_id = e.id
    INNER JOIN service_pos sp   ON sp.id = t.service_po_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
    WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
      AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
      AND t.company_id = :companyId
      ${publishGuard}
    GROUP BY e.id, e.employee_code, e.full_name, e.designation,
             sp.id, sp.service_po_code, sp.service_po_name, sp.is_billable, st.service_type_name, sc.name, sc.report_bucket_key
    ORDER BY e.full_name, hours DESC
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Per-Service-PO billable/non-billable classification for a given month/year,
 * with the service type/category context that explains the classification,
 * and the hours actually logged against that PO in the period.
 *
 * @param {object} filters
 * @param {number} filters.month
 * @param {number} filters.year
 * @param {string} [filters.search]      - matches PO name, PO code, or client name
 * @param {boolean} [filters.isBillable]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getPOBillableBreakdown(filters) {
  const { month, year, search, isBillable, limit, offset, hoursSource, roleId, companyId } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const replacements = { month: parseInt(month, 10), year: parseInt(year, 10), limit, offset, companyId };
  const conditions = ["sp.is_deleted = false", "sp.company_id = :companyId"];

  if (search) {
    conditions.push('(sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search OR c.client_name ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  if (isBillable !== undefined) {
    conditions.push('sp.is_billable = :isBillable');
    replacements.isBillable = isBillable;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  // Role ID 5 only: exclude unpublished timesheet rows from the join.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM service_pos sp
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    ${whereClause}
  `;

  const dataQuery = `
    SELECT
      sp.id                AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.is_billable,
      sp.status,
      c.id                 AS client_id,
      c.client_name,
      st.service_type_name,
      sc.name              AS category_name,
      COALESCE(ROUND(SUM(${hoursCol})::NUMERIC, 2), 0) AS hours_logged
    FROM service_pos sp
    INNER JOIN clients c         ON c.id  = sp.client_id
    INNER JOIN service_types st  ON st.id = sp.service_type_id
    LEFT JOIN service_categories sc ON sc.id = st.service_category_id
    LEFT JOIN timesheets t
      ON  t.service_po_id = sp.id
      AND EXTRACT(MONTH FROM t.timesheet_date) = :month
      AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
      ${publishGuard}
    ${whereClause}
    GROUP BY sp.id, sp.service_po_code, sp.service_po_name, sp.is_billable, sp.status,
             c.id, c.client_name, st.service_type_name, sc.name
    ORDER BY sp.service_po_name ASC
    LIMIT :limit OFFSET :offset
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * All contributing employees by hours logged, per Service PO, for a given
 * month/year. Paginated at the Service-PO level.
 *
 * @param {object} filters
 * @param {number} filters.month
 * @param {number} filters.year
 * @param {string} [filters.search]      - matches PO name, PO code, or client name
 * @param {boolean} [filters.isBillable]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getTopEmployeesByPO(filters) {
  const { month, year, search, isBillable, serviceTypeId, serviceCategoryId, limit, offset, hoursSource, roleId, companyId } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const replacements = { month: parseInt(month, 10), year: parseInt(year, 10), limit, offset, companyId };
  const conditions = [
    'EXTRACT(MONTH FROM t.timesheet_date) = :month',
    'EXTRACT(YEAR  FROM t.timesheet_date) = :year',
    't.company_id = :companyId',
  ];

  if (search) {
    conditions.push('(sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search OR c.client_name ILIKE :search)');
    replacements.search = `%${search}%`;
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
  // Role ID 5 only: exclude unpublished timesheet rows.
  const publishGuard = Number(roleId) === 5
    ? `EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';
  if (publishGuard) conditions.push(publishGuard);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM (
      SELECT sp.id
      FROM timesheets t
      INNER JOIN service_pos sp    ON sp.id = t.service_po_id
      INNER JOIN clients c         ON c.id  = sp.client_id
      INNER JOIN service_types st  ON st.id = sp.service_type_id
      LEFT JOIN service_categories sc ON sc.id = st.service_category_id
      ${whereClause}
      GROUP BY sp.id
      HAVING COALESCE(SUM(${hoursCol}), 0) > 0
    ) sub
  `;

  const dataQuery = `
    WITH po_page AS (
      SELECT sp.id AS service_po_id
      FROM timesheets t
      INNER JOIN service_pos sp    ON sp.id = t.service_po_id
      INNER JOIN clients c         ON c.id  = sp.client_id
      INNER JOIN service_types st  ON st.id = sp.service_type_id
      LEFT JOIN service_categories sc ON sc.id = st.service_category_id
      ${whereClause}
      GROUP BY sp.id
      HAVING COALESCE(SUM(${hoursCol}), 0) > 0
      ORDER BY sp.id
      LIMIT :limit OFFSET :offset
    ),
    ranked AS (
      SELECT
        sp.id                AS service_po_id,
        sp.service_po_code,
        sp.service_po_name,
        sp.is_billable,
        c.client_name,
        st.service_type_name,
        sc.name              AS category_name,
        e.id                 AS employee_id,
        e.employee_code,
        e.full_name,
        ROUND(SUM(${hoursCol})::NUMERIC, 2) AS hours,
        ROW_NUMBER() OVER (
          PARTITION BY sp.id ORDER BY SUM(${hoursCol}) DESC
        ) AS rn
      FROM timesheets t
      INNER JOIN po_page pp        ON pp.service_po_id = t.service_po_id
      INNER JOIN service_pos sp    ON sp.id = t.service_po_id
      INNER JOIN clients c         ON c.id  = sp.client_id
      INNER JOIN service_types st  ON st.id = sp.service_type_id
      LEFT JOIN service_categories sc ON sc.id = st.service_category_id
      INNER JOIN employees e       ON e.id  = t.employee_id
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :month
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :year
        AND t.company_id = :companyId
        ${publishGuard ? `AND ${publishGuard}` : ''}
      GROUP BY sp.id, sp.service_po_code, sp.service_po_name, sp.is_billable, c.client_name,
               st.service_type_name, sc.name, e.id, e.employee_code, e.full_name
      HAVING COALESCE(SUM(${hoursCol}), 0) > 0
    )
    SELECT * FROM ranked
    ORDER BY service_po_name ASC, rn ASC
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

/**
 * Billable vs non-billable hours per Service PO, per calendar month, across a
 * date window. Used to build the billable/non-billable trend chart and to
 * diff consecutive months to explain WHY the totals moved (which POs/service
 * types gained or lost hours).
 *
 * @param {object} filters
 * @param {string} filters.windowStart - YYYY-MM-DD, first day of the earliest month
 * @param {string} filters.windowEnd   - YYYY-MM-DD, last day of the latest month
 * @returns {Promise<object[]>} rows: { year, month, service_po_id, service_po_name, is_billable, service_type_name, hours }
 */
async function getBillableTrendDetail(filters) {
  const { windowStart, windowEnd, hoursSource, roleId, companyId } = filters;
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Role ID 5 only: exclude unpublished timesheet rows so a window spanning
  // several months still reflects whichever of those months ARE published.
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (
         SELECT 1 FROM timesheet_import_history h
         WHERE h.id = t.timesheet_import_id AND h.is_publish = true
       )`
    : '';

  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       sp.id                as service_po_id,
       sp.service_po_name,
       sp.is_billable,
       st.service_type_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS hours
     FROM timesheets t
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     WHERE t.timesheet_date >= :windowStart
       AND t.timesheet_date <= :windowEnd
       AND t.company_id = :companyId
       ${publishGuard}
     GROUP BY year, month, sp.id, sp.service_po_name, sp.is_billable, st.service_type_name
     ORDER BY year, month`,
    {
      replacements: { windowStart, windowEnd, companyId },
      type: QueryTypes.SELECT,
    }
  );
}

// ── Analytics Dashboard (Monthly Hours Trend / Hours by Client / Hours by
// Employee / Client x Service PO / Employee Bench %) ──────────────────────
// All functions below share the same filter shape:
//   { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
// startDate/endDate bound t.timesheet_date; employeeId/clientId/poId/
// serviceTypeId are optional equality filters. Callers build the shared
// WHERE clause via buildAnalyticsFilters() so every widget applies filters
// identically. serviceTypeId requires the caller's query to have joined
// service_types AS st (not every caller does).
function buildAnalyticsFilters(filters, replacements) {
  const { startDate, endDate, employeeId, clientId, poId, serviceTypeId, roleId, companyId } = filters;
  const conditions = [
    't.timesheet_date >= :startDate',
    't.timesheet_date <= :endDate',
    't.company_id = :companyId',
  ];
  replacements.startDate = startDate;
  replacements.endDate = endDate;
  replacements.companyId = companyId;

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
  // Role ID 5 only: exclude rows whose import batch isn't published yet, so
  // a window spanning several months (a quarter, a fiscal year) shows real
  // data for whichever of those months ARE published instead of blocking
  // the whole window because one sibling month isn't. A row with no import
  // batch at all is treated the same as unpublished (safe default).
  if (Number(roleId) === 5) {
    conditions.push(
      'EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)'
    );
  }

  return conditions.join(' AND ');
}

// =============================================================================
// OLD IMPLEMENTATION — WITH MONTHLY COST
// BACKUP / REFERENCE ONLY — DO NOT MODIFY
// Cost-bearing Dashboard queries as they were before Monthly Cost / Actual
// Billed Amount moved to Invoice Master (service_po_monthly_budgets.billed_amount).
// Every function below computed "cost" as hours_logged x monthly_costs.total_cost
// (an employee-level cost rate), joined via mc.employee_id + mc.month_year.
// Kept verbatim, unused by production code, purely for reference/rollback.
// =============================================================================

/**
 * Top-level analytics tiles: total hours, total cost, billable hours (for
 * utilisation %), and distinct counts of employees/clients/service POs with
 * activity in the given window.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object>} single row of aggregates
 */
async function getAnalyticsTiles_oldWithMonthlyCost(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const [result] = await sequelize.query(
    `SELECT
        COALESCE(SUM(${hoursCol}), 0) AS total_hours,

        COALESCE(
          SUM(
            CASE
              WHEN sp.is_billable THEN ${hoursCol}
            END
          ), 0
        ) AS billable_hours,

        COALESCE(
          SUM(
            ${hoursCol} * COALESCE(mc.total_cost, 0) / 176.0
          ), 0
        ) AS total_cost,

        -- Employee Counts
        COUNT(DISTINCT CASE WHEN e.status = 'active' AND e.is_deleted = 'f' THEN e.id END) AS active_employees,
        COUNT(DISTINCT CASE WHEN e.status = 'inactive' THEN e.id END) AS inactive_employees,

        -- Client Counts
        COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.id END) AS active_clients,
        COUNT(DISTINCT CASE WHEN c.status = 'inactive' THEN c.id END) AS inactive_clients,

        -- Service PO Counts
        COUNT(DISTINCT CASE WHEN sp.status IN('in-progress', 'on-hold') AND sp.is_deleted = 'f' THEN sp.id END) AS active_service_pos,
        COUNT(DISTINCT CASE WHEN sp.status = 'inactive' THEN sp.id END) AS inactive_service_pos

     FROM timesheets t
     INNER JOIN service_pos sp
       ON sp.id = t.service_po_id

     INNER JOIN employees e
       ON e.id = t.employee_id

     INNER JOIN clients c
       ON c.id = sp.client_id

     LEFT JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')

     WHERE ${whereClause}`,
    {
      replacements,
      type: QueryTypes.SELECT,
    }
  );

  return result;
}

/**
 * Monthly hours trend across a fixed date window (typically a full fiscal
 * year), grouped by service category name (Billable / Non-Billable /
 * Customer Non-Billable / etc.) so the chart can stack by category.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { year, month, category_name, hours }
 */
async function getAnalyticsMonthlyTrend(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

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
 * Total hours per client for the given window.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, hours }
 */
async function getAnalyticsHoursByClient(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       c.id                                    AS client_id,
       c.client_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2)  AS hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     INNER JOIN clients c      ON c.id  = sp.client_id
     WHERE ${whereClause}
     GROUP BY c.id, c.client_name
     ORDER BY hours DESC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Total hours per employee for the given window.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { employee_id, employee_code, full_name, hours }
 */
async function getAnalyticsHoursByEmployee(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       e.id                                                                          AS employee_id,
       e.employee_code,
       e.full_name,
       COALESCE(ROUND(SUM(CASE WHEN sp.is_billable THEN ${hoursCol} END)::NUMERIC, 2), 0)  AS billable_hours,
       COALESCE(ROUND(SUM(CASE WHEN NOT sp.is_billable THEN ${hoursCol} END)::NUMERIC, 2), 0) AS non_billable_hours,
       ROUND(SUM(${hoursCol})::NUMERIC, 2)                                        AS hours
     FROM timesheets t
     INNER JOIN employees e   ON e.id  = t.employee_id
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE ${whereClause}
     GROUP BY e.id, e.employee_code, e.full_name
     ORDER BY billable_hours DESC, non_billable_hours DESC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Hours per (client, Service PO) pair for the given window — the raw rows
 * for a Client x Service PO cross-tab.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, service_po_id, service_po_name, hours }
 */
async function getAnalyticsClientByPO(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       c.id                                    AS client_id,
       c.client_name,
       sp.id                                   AS service_po_id,
       sp.service_po_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2)  AS hours
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     INNER JOIN clients c      ON c.id  = sp.client_id
     WHERE ${whereClause}
     GROUP BY c.id, c.client_name, sp.id, sp.service_po_name
     ORDER BY c.client_name ASC, hours DESC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Hours per (employee, service type) pair for the given window — used to
 * compute each employee's bench % (Leave + NoWork/Idle + L&D hours as a
 * share of their total hours).
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { employee_id, employee_code, full_name, service_type_name, hours }
 */
async function getAnalyticsBenchDetail(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       e.id                                    AS employee_id,
       e.employee_code,
       e.full_name,
       sp.service_po_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2)  AS hours
     FROM timesheets t
     INNER JOIN employees e    ON e.id  = t.employee_id
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     WHERE ${whereClause}
     GROUP BY e.id, e.employee_code, e.full_name, sp.service_po_name`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Monthly Resource Utilization Percentage report (Analytics module, separate
 * from getAnalyticsDashboard()'s own widgets): per month in the given window,
 * the total hours logged and the subset of those hours logged against a
 * Service PO whose service-type category is flagged as the billable bucket
 * (service_categories.report_bucket_key = 'billable') — Non-Billable,
 * Customer Non-Billable, and any other/uncategorized POs are excluded from
 * the billable figure. Matched by this data-driven flag rather than the
 * sp.is_billable column, since is_billable is only guaranteed to track the
 * category for imported rows (see servicePOImportService.js) and can
 * otherwise be set independently via the manual create/update API. Reuses
 * buildAnalyticsFilters() so employeeId/clientId/poId behave identically to
 * every other Analytics Dashboard widget. Only months with at least one
 * timesheet entry in the window are returned.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { year, month, total_hours, billable_hours }
 */
async function getMonthlyBillableUtilization(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS total_hours,
       ROUND(SUM(CASE WHEN sc.report_bucket_key = 'billable' THEN ${hoursCol} ELSE 0 END)::NUMERIC, 2) AS billable_hours
     FROM timesheets t
     INNER JOIN service_pos sp        ON sp.id = t.service_po_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${whereClause}
     GROUP BY year, month
     ORDER BY year, month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Cost Trend by Type report (Analytics module, separate from
 * getAnalyticsDashboard()'s own widgets): total cost per month per
 * service-type category (Billable / Non-Billable / Customer Non-Billable /
 * any other category present in service_categories, or "Uncategorized" for
 * a service type with no category assigned). Category names are read
 * entirely from the joined service_categories row — nothing is hardcoded,
 * so a newly added category shows up automatically the next time it has
 * any cost against it. Cost per hour is computed the same way as
 * reportRepository.js's getServicePOSummary() Billable Cost
 * (monthly_billable_amount = hours_logged x employee's monthly total_cost,
 * with NO /176 division) — this must stay identical to that formula so the
 * Dashboard's Billable Cost always matches the Reports module for the same
 * filters. Reuses buildAnalyticsFilters() so
 * employeeId/clientId/poId/serviceTypeId behave identically to every other
 * Analytics Dashboard widget. Only (month, category) combinations with at
 * least one timesheet entry in the window are returned — the service layer
 * is responsible for zero-filling months/categories with no data.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { year, month, category_name, cost }
 */
async function getCostTrendByType_oldWithMonthlyCost(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       COALESCE(sc.name, 'Uncategorized') AS category_name,
       ROUND(SUM(${hoursCol} * COALESCE(mc.total_cost, 0))::NUMERIC, 2) AS cost
     FROM timesheets t
     INNER JOIN service_pos sp        ON sp.id = t.service_po_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     LEFT  JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')
     WHERE ${whereClause}
     GROUP BY year, month, category_name
     ORDER BY year, month, category_name`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Client Wise Cost Analytics: total hours and total cost per client across
 * the ENTIRE dataset, sorted by total cost descending. Deliberately does NOT
 * use buildAnalyticsFilters() and takes no filter arguments — this report
 * always considers the complete, unfiltered dataset (fiscal year, quarter,
 * month/year, employeeId, clientId, poId, serviceTypeId all intentionally do
 * not apply). Client names are read entirely from the clients table (joined
 * by id) — nothing is hardcoded. Cost is computed identically to
 * reportRepository.js's getServicePOSummary() Billable Cost (hours_logged x
 * employee's monthly total_cost, NO /176 division) and to this file's own
 * getClientCategoryCostMatrix() — all three must stay in lockstep so a given
 * PO/client/month reconciles across Reports and every Dashboard section.
 *
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_hours, total_cost }
 */
async function getClientWiseCostAnalytics_oldWithMonthlyCost(hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS total_hours,
       ROUND(SUM(${hoursCol} * COALESCE(mc.total_cost, 0))::NUMERIC, 2) AS total_cost
     FROM timesheets t
     INNER JOIN service_pos sp ON sp.id = t.service_po_id
     INNER JOIN clients c      ON c.id  = sp.client_id
     LEFT  JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')
     WHERE t.company_id = :companyId
     GROUP BY c.id, c.client_name
     ORDER BY total_cost DESC`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Client x Category Cost Matrix: total cost per (client, service-type
 * category) pair across the ENTIRE dataset — intentionally does not use
 * buildAnalyticsFilters() and takes no filter arguments, since this report
 * always considers the complete, unfiltered dataset. Category names are read
 * entirely from the joined service_categories row (or "Uncategorized" for a
 * service type with no category) — nothing is hardcoded; the service layer
 * is responsible for turning this flat list into a per-client category map.
 * Cost is computed identically to reportRepository.js's getServicePOSummary()
 * Billable Cost (hours_logged x employee's monthly total_cost, NO /176
 * division) so this client's "Billable" figure always matches the Reports
 * module for the same data.
 *
 * @returns {Promise<object[]>} rows: { client_id, client_name, category_name, cost }
 */
async function getClientCategoryCostMatrix_oldWithMonthlyCost(hoursSource, roleId, companyId) {
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';
  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       COALESCE(sc.name, 'Uncategorized') AS category_name,
       ROUND(SUM(${hoursCol} * COALESCE(mc.total_cost, 0))::NUMERIC, 2) AS cost
     FROM timesheets t
     INNER JOIN service_pos sp        ON sp.id = t.service_po_id
     INNER JOIN clients c             ON c.id  = sp.client_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     LEFT  JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')
     WHERE t.company_id = :companyId
     GROUP BY c.id, c.client_name, category_name
     ORDER BY c.client_name, category_name`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );
}

/**
 * Client Wise Analytics: total hours, total cost, and distinct Service PO
 * (project) count per client for the resolved period. Reuses
 * buildAnalyticsFilters() so employeeId/clientId/poId/serviceTypeId behave
 * identically to every other Analytics Dashboard widget. Cost is computed
 * identically to reportRepository.js's getServicePOSummary() Billable Cost
 * (hours_logged x employee's monthly total_cost, NO /176 division) and to
 * this file's own getClientCategoryCostMatrix()/getProjectWiseAnalytics()/
 * getClientWiseCostAnalytics() — all must stay in lockstep so a given
 * PO/client/month reconciles across Reports and every Dashboard section.
 * average_cost_per_hour and percentage_of_total_cost are derived in the
 * service layer.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_hours, total_cost, total_projects }
 */
async function getClientWiseAnalytics_oldWithMonthlyCost(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS total_hours,
       ROUND(SUM(${hoursCol} * COALESCE(mc.total_cost, 0))::NUMERIC, 2) AS total_cost,
       COUNT(DISTINCT sp.id) AS total_projects
     FROM timesheets t
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN clients c        ON c.id  = sp.client_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     LEFT  JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')
     WHERE ${whereClause}
     GROUP BY c.id, c.client_name
     ORDER BY total_cost DESC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Leave Hours Trend: total hours logged per month against the "Leaves"
 * service type only (st.service_type_name, case-insensitive exact match —
 * not the Service PO name). Reuses buildAnalyticsFilters() so the Analytics
 * Dashboard's employeeId/clientId/poId/serviceTypeId filters behave
 * identically. Only months with at least one matching timesheet entry in
 * the window are returned — the service layer is responsible for
 * zero-filling months with no Leave hours.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { year, month, leave_hours }
 */
async function getLeaveHoursTrend(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

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
 * No Work Trend: total hours logged per month against Service POs named
 * exactly "Idle" or "On Bench" (case-insensitive exact match on
 * sp.service_po_name). Reuses buildAnalyticsFilters() so the Analytics
 * Dashboard's employeeId/clientId/poId/serviceTypeId filters behave
 * identically. Only months with at least one matching timesheet entry in
 * the window are returned — the service layer is responsible for
 * zero-filling months with no No Work hours.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { year, month, no_work_hours }
 */
async function getNoWorkTrend(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

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
 * Project Wise Analytics: total cost per (Service PO, month) for the
 * resolved period, one flat row per project per month with any cost. Reuses
 * buildAnalyticsFilters() so employeeId/clientId/poId/serviceTypeId behave
 * identically to every other Analytics Dashboard widget. Category name is
 * read entirely from the joined service_categories row (or "Uncategorized"
 * for a service type with no category) — nothing is hardcoded. Ordered by
 * sp.id so the service layer's per-project grouping preserves a stable,
 * predictable order; the service layer is responsible for zero-filling
 * months with no cost for a given project. Cost is computed identically to
 * reportRepository.js's getServicePOSummary() Billable Cost (hours_logged x
 * employee's monthly total_cost, NO /176 division) and to this file's own
 * getClientCategoryCostMatrix() — all three must stay in lockstep so a given
 * PO/client/month reconciles across Reports and every Dashboard section.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId }
 * @returns {Promise<object[]>} rows: { service_po_id, project_name, client_name, category_name, year, month, cost }
 */
async function getProjectWiseAnalytics_oldWithMonthlyCost(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       sp.id AS service_po_id,
       sp.service_po_name AS project_name,
       c.client_name,
       COALESCE(sc.name, 'Uncategorized') AS category_name,
       EXTRACT(YEAR  FROM t.timesheet_date)::int AS year,
       EXTRACT(MONTH FROM t.timesheet_date)::int AS month,
       ROUND(SUM(${hoursCol} * COALESCE(mc.total_cost, 0))::NUMERIC, 2) AS cost
     FROM timesheets t
     INNER JOIN service_pos sp        ON sp.id = t.service_po_id
     INNER JOIN clients c             ON c.id  = sp.client_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     LEFT  JOIN monthly_costs mc
       ON mc.employee_id = t.employee_id
      AND mc.month_year = TO_CHAR(t.timesheet_date, 'YYYY-MM')
     WHERE ${whereClause}
     GROUP BY sp.id, sp.service_po_name, c.client_name, category_name, year, month
     ORDER BY sp.id, year, month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

// =============================================================================
// NEW IMPLEMENTATION — INVOICE MASTER
// ACTIVE IMPLEMENTATION
// "Monthly Cost" / "Actual Billed Amount" now comes from Invoice Master
// (service_po_monthly_budgets.billed_amount) — a per-Service-PO-per-month
// figure — instead of monthly_costs (an employee-level hours x rate figure).
// "PO Value / Budget Cost" is unrelated and untouched: getTotalRevenue()
// above still reads service_pos.po_value; the NEW getBudgetVsBilled() below
// additionally reads cost_budget_master.invoice_amount for the new
// Budget-vs-Billed comparison analytics only.
//
// Every hours-only figure (total_hours, billable_hours, active/inactive
// counts, total_projects) is left exactly as it was — only the "cost"/
// "billed amount" expression moved off monthly_costs. Where a function's
// response shape mixes hours and cost (getAnalyticsTiles, getClientWiseCostAnalytics,
// getClientWiseAnalytics), the hours side still queries timesheets unchanged
// and is merged in JS with a separate Invoice-Master cost query — this keeps
// the hours calculation completely untouched while swapping only the cost
// source, and callers (dashboardService.js's build* helpers) see the exact
// same row shape as before, so no caller needed to change.
// =============================================================================

/**
 * Convert a "YYYY-MM-DD" date string into a single comparable integer
 * (year*12 + month), so a date-range filter (startDate/endDate) can be
 * compared against service_po_monthly_budgets'/cost_budget_master's separate
 * month/year INT columns without constructing a synthetic date. Parsed via
 * UTC accessors so a date-only string is never shifted a day backward by a
 * local timezone offset.
 *
 * @param {string} dateStr - "YYYY-MM-DD"
 * @returns {number}
 */
function periodKey(dateStr) {
  const d = new Date(dateStr);
  return d.getUTCFullYear() * 12 + (d.getUTCMonth() + 1);
}

/**
 * Filter builder for cost queries sourced from service_po_monthly_budgets
 * (Invoice Master) instead of timesheets — mirrors buildAnalyticsFilters()'s
 * filter set (startDate/endDate/employeeId/clientId/poId/serviceTypeId/
 * companyId) so every existing Analytics Dashboard filter keeps working, but
 * expressed against sp/st/spmb columns since there is no `timesheets t`
 * table in these queries. startDate/endDate (an arbitrary date range) are
 * converted to an inclusive (year*12+month) comparison against
 * spmb.year/spmb.month via periodKey(), since Invoice Master only stores
 * whole calendar months, never a specific day — do NOT combine year and
 * month into a synthetic date instead, that would misalign against a
 * startDate/endDate that falls mid-month.
 *
 * employeeId has no direct equivalent on Invoice Master — billed_amount is
 * a whole-Service-PO figure, never split per employee. When employeeId is
 * given, this narrows to Service POs that employee actually logged hours
 * against in the period (via an EXISTS against timesheets), while still
 * summing that PO's FULL billed_amount rather than inventing a per-employee
 * share of it. This is a deliberate, documented interpretation of an
 * otherwise-meaningless filter combination, not an oversight.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId, companyId }
 * @param {object} replacements - mutated in place with the bind values this clause needs
 * @returns {string} SQL WHERE clause (without the WHERE keyword) — assumes aliases sp/st/spmb are joined
 */
function buildInvoiceMasterFilters(filters, replacements) {
  const { startDate, endDate, employeeId, clientId, poId, serviceTypeId, companyId } = filters;

  const conditions = ['sp.company_id = :companyId'];
  replacements.companyId = companyId;

  replacements.startPeriodKey = periodKey(startDate);
  replacements.endPeriodKey = periodKey(endDate);
  conditions.push('(spmb.year * 12 + spmb.month) BETWEEN :startPeriodKey AND :endPeriodKey');

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

  return conditions.join(' AND ');
}

/**
 * Top-level analytics tiles — same as getAnalyticsTiles_oldWithMonthlyCost()
 * for every hours/count figure (unchanged query against timesheets), but
 * total_cost is now a separate query summing service_po_monthly_budgets.billed_amount
 * (Invoice Master) instead of hours x monthly_costs.total_cost / 176.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object>} single row of aggregates
 */
async function getAnalyticsTiles(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const [result] = await sequelize.query(
    `SELECT
        COALESCE(SUM(${hoursCol}), 0) AS total_hours,

        COALESCE(
          SUM(
            CASE
              WHEN sp.is_billable THEN ${hoursCol}
            END
          ), 0
        ) AS billable_hours,

        -- Employee Counts
        COUNT(DISTINCT CASE WHEN e.status = 'active' AND e.is_deleted = 'f' THEN e.id END) AS active_employees,
        COUNT(DISTINCT CASE WHEN e.status = 'inactive' THEN e.id END) AS inactive_employees,

        -- Client Counts
        COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.id END) AS active_clients,
        COUNT(DISTINCT CASE WHEN c.status = 'inactive' THEN c.id END) AS inactive_clients,

        -- Service PO Counts
        COUNT(DISTINCT CASE WHEN sp.status IN('in-progress', 'on-hold') AND sp.is_deleted = 'f' THEN sp.id END) AS active_service_pos,
        COUNT(DISTINCT CASE WHEN sp.status = 'inactive' THEN sp.id END) AS inactive_service_pos

     FROM timesheets t
     INNER JOIN service_pos sp
       ON sp.id = t.service_po_id

     INNER JOIN employees e
       ON e.id = t.employee_id

     INNER JOIN clients c
       ON c.id = sp.client_id

     WHERE ${whereClause}`,
    {
      replacements,
      type: QueryTypes.SELECT,
    }
  );

  const costReplacements = {};
  const costWhereClause = buildInvoiceMasterFilters(filters, costReplacements);
  const [costResult] = await sequelize.query(
    `SELECT COALESCE(SUM(spmb.billed_amount), 0) AS total_cost
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp   ON sp.id = spmb.service_po_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     WHERE ${costWhereClause}`,
    { replacements: costReplacements, type: QueryTypes.SELECT }
  );

  return { ...result, total_cost: costResult.total_cost };
}

/**
 * Cost Trend by Type — same shape as getCostTrendByType_oldWithMonthlyCost()
 * ({ year, month, category_name, cost }), but cost now sums
 * service_po_monthly_budgets.billed_amount (Invoice Master) per (month,
 * category) instead of hours x monthly_costs.total_cost. No timesheets join
 * at all — Invoice Master rows are already at the (Service PO, month, year)
 * granularity, so no aggregation-inflation risk.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId, companyId }
 * @returns {Promise<object[]>} rows: { year, month, category_name, cost }
 */
async function getCostTrendByType(filters) {
  const replacements = {};
  const whereClause = buildInvoiceMasterFilters(filters, replacements);

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
     WHERE ${whereClause}
     GROUP BY spmb.year, spmb.month, category_name
     ORDER BY spmb.year, spmb.month, category_name`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Client Wise Cost Analytics — same shape as
 * getClientWiseCostAnalytics_oldWithMonthlyCost() ({ client_id, client_name,
 * total_hours, total_cost }), entire dataset, unfiltered (no period/filters,
 * matching the old function's own documented scope). total_hours is still
 * queried from timesheets, unchanged; total_cost now sums
 * service_po_monthly_budgets.billed_amount per client instead of hours x
 * monthly_costs.total_cost. The two are run as separate queries and merged
 * by client_id here, so a client with cost but no hours (or vice versa)
 * still appears instead of being dropped by an inner join.
 *
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_hours, total_cost }
 */
async function getClientWiseCostAnalytics(hoursSource, roleId, companyId) {
  const hoursCol = (hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const hoursRows = await sequelize.query(
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

  const costRows = await sequelize.query(
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

  const clientMap = new Map();
  for (const row of hoursRows) {
    clientMap.set(row.client_id, {
      client_id: row.client_id,
      client_name: row.client_name,
      total_hours: row.total_hours,
      total_cost: 0,
    });
  }
  for (const row of costRows) {
    if (!clientMap.has(row.client_id)) {
      clientMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        total_hours: 0,
        total_cost: row.total_cost,
      });
    } else {
      clientMap.get(row.client_id).total_cost = row.total_cost;
    }
  }

  return Array.from(clientMap.values()).sort((a, b) => parseFloat(b.total_cost) - parseFloat(a.total_cost));
}

/**
 * Client x Category Cost Matrix — same shape as
 * getClientCategoryCostMatrix_oldWithMonthlyCost() ({ client_id, client_name,
 * category_name, cost }), entire dataset, unfiltered. cost now sums
 * service_po_monthly_budgets.billed_amount (Invoice Master) per (client,
 * category) instead of hours x monthly_costs.total_cost. No hours in this
 * response shape, so no merge needed — a single query suffices.
 *
 * @returns {Promise<object[]>} rows: { client_id, client_name, category_name, cost }
 */
async function getClientCategoryCostMatrix(hoursSource, roleId, companyId) {
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
 * Client Wise Analytics — same shape as getClientWiseAnalytics_oldWithMonthlyCost()
 * ({ client_id, client_name, total_hours, total_cost, total_projects }), for
 * the resolved period. total_hours/total_projects are still queried from
 * timesheets, unchanged; total_cost now sums
 * service_po_monthly_budgets.billed_amount per client for the same period
 * instead of hours x monthly_costs.total_cost. The two are run as separate
 * queries and merged by client_id, so a client with cost but no hours (or
 * vice versa) in this period still appears.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId, companyId }
 * @returns {Promise<object[]>} rows: { client_id, client_name, total_hours, total_cost, total_projects }
 */
async function getClientWiseAnalytics(filters) {
  const hoursReplacements = {};
  const hoursWhereClause = buildAnalyticsFilters(filters, hoursReplacements);
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  const hoursRows = await sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS total_hours,
       COUNT(DISTINCT sp.id) AS total_projects
     FROM timesheets t
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN clients c        ON c.id  = sp.client_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     WHERE ${hoursWhereClause}
     GROUP BY c.id, c.client_name`,
    { replacements: hoursReplacements, type: QueryTypes.SELECT }
  );

  const costReplacements = {};
  const costWhereClause = buildInvoiceMasterFilters(filters, costReplacements);
  const costRows = await sequelize.query(
    `SELECT
       c.id AS client_id,
       c.client_name,
       ROUND(COALESCE(SUM(spmb.billed_amount), 0)::NUMERIC, 2) AS total_cost
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp   ON sp.id = spmb.service_po_id
     INNER JOIN clients c        ON c.id  = sp.client_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     WHERE ${costWhereClause}
     GROUP BY c.id, c.client_name`,
    { replacements: costReplacements, type: QueryTypes.SELECT }
  );

  const clientMap = new Map();
  for (const row of hoursRows) {
    clientMap.set(row.client_id, {
      client_id: row.client_id,
      client_name: row.client_name,
      total_hours: row.total_hours,
      total_projects: row.total_projects,
      total_cost: 0,
    });
  }
  for (const row of costRows) {
    if (!clientMap.has(row.client_id)) {
      clientMap.set(row.client_id, {
        client_id: row.client_id,
        client_name: row.client_name,
        total_hours: 0,
        total_projects: 0,
        total_cost: row.total_cost,
      });
    } else {
      clientMap.get(row.client_id).total_cost = row.total_cost;
    }
  }

  return Array.from(clientMap.values());
}

/**
 * Project Wise Analytics — same shape as getProjectWiseAnalytics_oldWithMonthlyCost()
 * ({ service_po_id, project_name, client_name, category_name, year, month,
 * cost }), for the resolved period, but cost now comes directly from
 * service_po_monthly_budgets.billed_amount (Invoice Master) instead of hours
 * x monthly_costs.total_cost. No hours in this response shape and Invoice
 * Master is already unique per (service_po_id, month, year), so this needs
 * no GROUP BY/SUM at all — one Invoice Master row IS one output row,
 * eliminating any risk of duplicate-row inflation.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId, serviceTypeId, companyId }
 * @returns {Promise<object[]>} rows: { service_po_id, project_name, client_name, category_name, year, month, cost }
 */
async function getProjectWiseAnalytics(filters) {
  const replacements = {};
  const whereClause = buildInvoiceMasterFilters(filters, replacements);

  return sequelize.query(
    `SELECT
       sp.id AS service_po_id,
       sp.service_po_name AS project_name,
       c.client_name,
       COALESCE(sc.name, 'Uncategorized') AS category_name,
       spmb.year,
       spmb.month,
       ROUND(COALESCE(spmb.billed_amount, 0)::NUMERIC, 2) AS cost
     FROM service_po_monthly_budgets spmb
     INNER JOIN service_pos sp        ON sp.id = spmb.service_po_id
     INNER JOIN clients c             ON c.id  = sp.client_id
     INNER JOIN service_types st      ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${whereClause}
     ORDER BY sp.id, spmb.year, spmb.month`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * NEW analytics (not a replacement of any old function): Budget Cost
 * (cost_budget_master.invoice_amount) vs Actual Billed Amount
 * (service_po_monthly_budgets.billed_amount), one row per (service_po_id,
 * month, year) present in EITHER table for the resolved period/filters — a
 * FULL OUTER JOIN on the shared (service_po_id, month, year) key so a
 * Service PO with only a budget entered, or only an invoice/billed entry,
 * still appears (0 on whichever side has no data) instead of being silently
 * dropped. Only 'active' cost_budget_master rows count as budget — a
 * deactivated budget entry is treated the same as "no budget". Both tables
 * are already unique on (service_po_id, month, year), so this is a strict
 * 1:1 join — no aggregation/fan-out risk of inflating totals.
 *
 * employeeId has no meaning here (both tables are Service-PO-level, never
 * per-employee) and is intentionally NOT applied — every other filter
 * (period, clientId, poId, serviceTypeId, company scope) behaves the same
 * as buildInvoiceMasterFilters().
 *
 * @param {object} filters - { startDate, endDate, clientId, poId, serviceTypeId, companyId }
 * @returns {Promise<object[]>} rows: { service_po_id, service_po_code, service_po_name, client_id, client_name, year, month, budget_cost, billed_amount }
 */
async function getBudgetVsBilled(filters) {
  const { startDate, endDate, clientId, poId, serviceTypeId, companyId } = filters;
  const replacements = { companyId };
  const conditions = ['sp.company_id = :companyId', "(cbm.id IS NULL OR cbm.status = 'active')"];

  replacements.startPeriodKey = periodKey(startDate);
  replacements.endPeriodKey = periodKey(endDate);
  conditions.push(
    '(COALESCE(cbm.year, spmb.year) * 12 + COALESCE(cbm.month, spmb.month)) BETWEEN :startPeriodKey AND :endPeriodKey'
  );

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

/**
 * All contributing employees by hours logged, per Service PO, for the
 * Analytics Dashboard's shared filter set (startDate/endDate/employeeId/
 * clientId/poId). Same shape as getTopEmployeesByPO() above but unpaginated
 * (every PO with activity in the window is returned) and scoped by an
 * arbitrary date range instead of a single calendar month.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { service_po_id, service_po_code, service_po_name, is_billable, client_name, service_type_name, category_name, employee_id, employee_code, full_name, hours, rn }
 */
async function getEmployeesByPOForPeriod(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       sp.id                AS service_po_id,
       sp.service_po_code,
       sp.service_po_name,
       sp.is_billable,
       c.client_name,
       st.service_type_name,
       sc.name              AS category_name,
       e.id                 AS employee_id,
       e.employee_code,
       e.full_name,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS hours,
       ROW_NUMBER() OVER (
         PARTITION BY sp.id ORDER BY SUM(${hoursCol}) DESC
       ) AS rn
     FROM timesheets t
     INNER JOIN service_pos sp    ON sp.id = t.service_po_id
     INNER JOIN clients c         ON c.id  = sp.client_id
     INNER JOIN service_types st  ON st.id = sp.service_type_id
     LEFT JOIN service_categories sc ON sc.id = st.service_category_id
     INNER JOIN employees e       ON e.id  = t.employee_id
     WHERE ${whereClause}
     GROUP BY sp.id, sp.service_po_code, sp.service_po_name, sp.is_billable, c.client_name,
              st.service_type_name, sc.name, e.id, e.employee_code, e.full_name
     HAVING COALESCE(SUM(${hoursCol}), 0) > 0
     ORDER BY sp.service_po_name ASC, rn ASC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

/**
 * Per-employee billable/non-billable hour breakdown, with the contributing
 * Service POs as the "reason" for the split, for the Analytics Dashboard's
 * shared filter set (startDate/endDate/employeeId/clientId/poId). Same shape
 * as getEmployeeBillableBreakdown() above but unpaginated (every active
 * employee with activity in the window is returned) and scoped by an
 * arbitrary date range instead of a single calendar month.
 *
 * @param {object} filters - { startDate, endDate, employeeId, clientId, poId }
 * @returns {Promise<object[]>} rows: { employee_id, employee_code, full_name, designation, service_po_id, service_po_code, service_po_name, is_billable, service_type_name, category_name, hours }
 */
async function getEmployeeBillableBreakdownForPeriod(filters) {
  const replacements = {};
  const whereClause = buildAnalyticsFilters(filters, replacements);
  // hoursSource = 'O' -> original hours_logged. Anything else/default
  // (including no roleId, or roleId != 5) -> modified_hours. roleId plays no
  // part in this selection — only hoursSource does.
  const hoursCol = (filters.hoursSource === 'O')
    ? 't.hours_logged'
    : 'COALESCE(t.modified_hours, t.hours_logged)';

  return sequelize.query(
    `SELECT
       e.id                AS employee_id,
       e.employee_code,
       e.full_name,
       e.designation,
       sp.id               AS service_po_id,
       sp.service_po_code,
       sp.service_po_name,
       sp.is_billable,
       st.service_type_name,
       sc.name AS category_name,
       sc.report_bucket_key,
       ROUND(SUM(${hoursCol})::NUMERIC, 2) AS hours
     FROM timesheets t
     INNER JOIN employees e      ON e.id  = t.employee_id
     INNER JOIN service_pos sp   ON sp.id = t.service_po_id
     INNER JOIN service_types st ON st.id = sp.service_type_id
     LEFT  JOIN service_categories sc ON sc.id = st.service_category_id
     WHERE ${whereClause}
       AND e.is_deleted = false
       AND e.status = 'active'
     GROUP BY e.id, e.employee_code, e.full_name, e.designation,
              sp.id, sp.service_po_code, sp.service_po_name, sp.is_billable, st.service_type_name, sc.name, sc.report_bucket_key
     ORDER BY e.full_name, hours DESC`,
    { replacements, type: QueryTypes.SELECT }
  );
}

module.exports = {
  getTotalEmployees,
  getActiveEmployees,
  getTotalClients,
  getActivePOs,
  getClosedPOs,
  getCurrentMonthHours,
  getCurrentMonthBillableSplit,
  getEmployeeBillableBreakdown,
  getPOBillableBreakdown,
  getTopEmployeesByPO,
  getBillableTrendDetail,
  getAnalyticsTiles,
  getAnalyticsMonthlyTrend,
  getAnalyticsHoursByClient,
  getAnalyticsHoursByEmployee,
  getAnalyticsClientByPO,
  getAnalyticsBenchDetail,
  getEmployeesByPOForPeriod,
  getEmployeeBillableBreakdownForPeriod,
  getOverallUtilisation,
  getOverallUtilisationForPeriod,
  getTotalRevenue,
  getTotalBudgetCost,
  getRecentTimesheetActivity,
  getRecentTimesheetActivityForPeriod,
  getTopPOsByHours,
  getTopPOsByHoursForPeriod,
  getEmployeeCountByCategory,
  getEmployeeCountByCategoryForPeriod,
  getActiveCountsForPeriod,
  getMonthlyHoursTrend,
  getMonthlyBillableUtilization,
  getCostTrendByType,
  getClientWiseCostAnalytics,
  getClientCategoryCostMatrix,
  getClientWiseAnalytics,
  getLeaveHoursTrend,
  getNoWorkTrend,
  getProjectWiseAnalytics,
  getBudgetVsBilled,

  // Old (monthly_costs-based) cost implementations — backup/reference only,
  // NOT called by production code. See "OLD IMPLEMENTATION" banner above.
  getAnalyticsTiles_oldWithMonthlyCost,
  getCostTrendByType_oldWithMonthlyCost,
  getClientWiseCostAnalytics_oldWithMonthlyCost,
  getClientCategoryCostMatrix_oldWithMonthlyCost,
  getClientWiseAnalytics_oldWithMonthlyCost,
  getProjectWiseAnalytics_oldWithMonthlyCost,
};
