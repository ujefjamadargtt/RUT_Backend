'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

// An Employee created after the Employee-Business-Unit redesign
// (database/migrations/20260866_create_employee_business_units.sql) never
// gets its own `employees.company_id` populated; its Company/BU membership
// lives exclusively in `employee_business_units`. Matching on `e.company_id`
// alone silently drops such employees from these reports. Same OR-with-
// legacy-column pattern as employeeRepository.js's employeeScope().
// IN(:companyIds)-aware — this constant's sole consumer,
// getEmployeeCapacityForecast(), was converted to the "no X-Company-Id ->
// role reach" array scope (see resolveReportCompanyScope.js).
const EMPLOYEE_COMPANY_SCOPE_SQL = `(
  e.company_id IN (:companyIds)
  OR EXISTS (
    SELECT 1 FROM employee_business_units ebu
    WHERE ebu.employee_id = e.id
      AND ebu.business_unit_id IN (:companyIds)
      AND ebu.status = 'active'
  )
)`;

/**
 * Management Report Repository
 *
 * The 10 new management/business reports approved on top of the existing
 * Report module (reportRepository.js, left untouched). Combined into one
 * file per layer (repository/service/controller/routes) rather than one
 * file per report, matching this project's existing convention for the
 * Report module.
 *
 * These reports are the first consumers of cost_budget_master (planned
 * monthly Invoice Amount per Service PO) and resource_budget_master
 * (planned monthly hours per Employee + Service PO) — every other report/
 * dashboard query in this codebase only reads timesheets/monthly_costs/
 * service_po_monthly_budgets (actuals), never the two new "future budget"
 * tables. All queries use raw SQL via sequelize.query, same as
 * reportRepository.js and dashboardRepository.js.
 */

const formatMonthYear = (month, year) => (
  `${parseInt(year, 10)}-${String(parseInt(month, 10)).padStart(2, '0')}`
);

// ---------------------------------------------------------------------------
// 1. Service PO Profitability (Margin) Report — ACTUAL basis
// ---------------------------------------------------------------------------
/**
 * One row per billable Service PO for the given month/year:
 * invoiced_amount minus delivery_cost = margin. Both invoiced_amount and
 * delivery_cost are read from service_po_monthly_budgets (invoice_amount /
 * billed_amount respectively) for the report's month/year — delivery_cost
 * is NOT computed from timesheets x monthly_costs (that data is too sparse
 * per-employee to be a reliable cost basis; billed_amount is the
 * finance-entered actual instead).
 *
 * @param {object} filters
 * @param {number} filters.month
 * @param {number} filters.year
 * @param {number} [filters.clientId]
 * @param {number} [filters.poId]
 * @param {string} [filters.status]
 * @param {boolean} [filters.isBillable]
 * @param {number} [filters.serviceCategoryId]
 * @param {number} [filters.serviceTypeId]
 * @param {string} [filters.search]
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @param {number[]} filters.companyIds
 * @returns {{ rows: object[], count: number }}
 */
async function getServicePOProfitability(filters) {
  const {
    month, year, clientId, poId, status, isBillable,
    serviceCategoryId, serviceTypeId, search,
    sortBy = 'margin', sortOrder = 'DESC', limit, offset, hoursSource, roleId, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['c.client_name', 'sp.service_po_name', 'invoiced_amount', 'delivery_cost', 'margin', 'margin_pct', 'hours_delivered'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);

  const replacements = { monthNum, yearNum, limit, offset, companyIds };
  const conditions = ['(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)', 'sp.is_billable = true'];

  if (clientId) { conditions.push('sp.client_id = :clientId'); replacements.clientId = clientId; }
  if (poId) { conditions.push('sp.id = :poId'); replacements.poId = poId; }
  if (status && status !== 'all') { conditions.push('sp.status = :status'); replacements.status = status; }
  if (isBillable !== undefined) { conditions.push('sp.is_billable = :isBillable'); replacements.isBillable = isBillable; }
  if (serviceTypeId) { conditions.push('st.id = :serviceTypeId'); replacements.serviceTypeId = serviceTypeId; }
  if (serviceCategoryId) { conditions.push('sc.id = :serviceCategoryId'); replacements.serviceCategoryId = serviceCategoryId; }
  if (search) {
    conditions.push('(c.client_name ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      sp.id                                          AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.status,
      c.id                                            AS client_id,
      c.client_name,
      st.service_type_name                            AS service_type,
      sc.name                                         AS service_category_name,
      COALESCE(cur.hours_delivered, 0)                AS hours_delivered,
      ROUND(COALESCE(spmb.invoice_amount, 0)::numeric, 2)  AS invoiced_amount,
      ROUND(COALESCE(spmb.billed_amount, 0)::numeric, 2)   AS delivery_cost,
      ROUND((COALESCE(spmb.invoice_amount, 0) - COALESCE(spmb.billed_amount, 0))::numeric, 2) AS margin,
      CASE
        WHEN COALESCE(spmb.invoice_amount, 0) > 0
          THEN ROUND(((COALESCE(spmb.invoice_amount, 0) - COALESCE(spmb.billed_amount, 0)) / spmb.invoice_amount * 100)::numeric, 2)
        ELSE NULL
      END                                              AS margin_pct
    FROM service_pos sp
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    LEFT JOIN service_po_monthly_budgets spmb
           ON spmb.service_po_id = sp.id AND spmb.month = :monthNum AND spmb.year = :yearNum
    LEFT JOIN (
      SELECT
        t.service_po_id,
        SUM(${hoursCol})                                AS hours_delivered
      FROM timesheets t
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
        ${publishGuard}
      GROUP BY t.service_po_id
    ) cur ON cur.service_po_id = sp.id
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM service_pos sp
    INNER JOIN clients c        ON c.id  = sp.client_id
    INNER JOIN service_types st ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 2. Budgeted Margin Forecast Report — PLANNED basis
// ---------------------------------------------------------------------------
/**
 * One row per Service PO with an active cost_budget_master entry for the
 * given month/year: budgeted_revenue (cost_budget_master.invoice_amount)
 * minus budgeted_cost (resource_budget_master.hours x monthly_costs.total_cost
 * for that same employee/month) = forecasted_margin.
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getBudgetedMarginForecast(filters) {
  const {
    month, year, clientId, poId, status, search,
    sortBy = 'forecasted_margin', sortOrder = 'DESC', limit, offset, companyIds,
  } = filters;

  const allowedSort = ['c.client_name', 'sp.service_po_name', 'budgeted_revenue', 'budgeted_cost', 'forecasted_margin', 'forecasted_margin_pct', 'budgeted_hours'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'forecasted_margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);

  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyIds };
  const conditions = ["(cbm.company_id IN (:companyIds) OR cbm.company_id IS NULL)", "cbm.status = 'active'", 'cbm.month = :monthNum', 'cbm.year = :yearNum'];

  if (clientId) { conditions.push('sp.client_id = :clientId'); replacements.clientId = clientId; }
  if (poId) { conditions.push('sp.id = :poId'); replacements.poId = poId; }
  if (status && status !== 'all') { conditions.push('sp.status = :status'); replacements.status = status; }
  if (search) {
    conditions.push('(c.client_name ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      sp.id                                     AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.status,
      c.id                                       AS client_id,
      c.client_name,
      cbm.description                            AS budget_description,
      ROUND(cbm.invoice_amount::numeric, 2)      AS budgeted_revenue,
      COALESCE(rb.budgeted_hours, 0)              AS budgeted_hours,
      ROUND(COALESCE(rb.budgeted_cost, 0)::numeric, 2) AS budgeted_cost,
      ROUND((cbm.invoice_amount - COALESCE(rb.budgeted_cost, 0))::numeric, 2) AS forecasted_margin,
      CASE
        WHEN cbm.invoice_amount > 0
          THEN ROUND(((cbm.invoice_amount - COALESCE(rb.budgeted_cost, 0)) / cbm.invoice_amount * 100)::numeric, 2)
        ELSE NULL
      END                                        AS forecasted_margin_pct
    FROM cost_budget_master cbm
    INNER JOIN service_pos sp ON sp.id = cbm.service_po_id
    INNER JOIN clients c      ON c.id  = sp.client_id
    LEFT JOIN (
      SELECT
        rbm.service_po_id,
        SUM(rbm.hours)                             AS budgeted_hours,
        SUM(rbm.hours * COALESCE(mc.total_cost, 0)) AS budgeted_cost
      FROM resource_budget_master rbm
      LEFT JOIN monthly_costs mc
             ON mc.employee_id = rbm.emp_id AND mc.month_year = :monthYear
      WHERE rbm.status = 'active' AND rbm.month = :monthNum AND rbm.year = :yearNum
      GROUP BY rbm.service_po_id
    ) rb ON rb.service_po_id = sp.id
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM cost_budget_master cbm
    INNER JOIN service_pos sp ON sp.id = cbm.service_po_id
    INNER JOIN clients c      ON c.id  = sp.client_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 3. Resource Staffing Plan Accuracy Report
// ---------------------------------------------------------------------------
/**
 * Planned (resource_budget_master) vs actual (timesheets) hours per
 * employee + Service PO for the given month/year. FULL OUTER JOIN so rows
 * with a plan but no actuals, and rows with actuals but no plan, both
 * surface.
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getResourceStaffingPlanAccuracy(filters) {
  const {
    month, year, employeeId, poId, search, varianceThresholdPct,
    sortBy = 'variance', sortOrder = 'DESC', limit, offset, hoursSource, roleId, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  // Bare output-column names (no `e.`/`sp.` qualifier) — sortBy is applied
  // in the OUTER wrapping query below (after the threshold filter), where
  // only the inner SELECT's exposed column names are visible, not its
  // table aliases.
  const allowedSort = ['full_name', 'service_po_name', 'planned_hours', 'actual_hours', 'variance', 'variance_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'variance';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  // undefined -> no threshold filtering at all (existing behavior: every
  // row returned, service-layer `at_risk` flag only). A real number
  // (including 0) -> only rows meeting the threshold are returned, applied
  // BEFORE pagination (see the wrapping SELECT below), so both the
  // returned page and the count query's total reflect the filtered set.
  const varianceThresholdPctValue = varianceThresholdPct !== undefined && varianceThresholdPct !== null
    ? parseFloat(varianceThresholdPct)
    : null;
  const replacements = { monthNum, yearNum, limit, offset, companyIds, varianceThresholdPct: varianceThresholdPctValue };

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  let employeeFilter = '';
  let poFilter = '';
  if (employeeId) { employeeFilter = 'AND emp_id = :employeeId'; replacements.employeeId = employeeId; }
  if (poId) { poFilter = 'AND po_id = :poId'; replacements.poId = poId; }

  const searchFilter = search
    ? `AND (e.full_name ILIKE :search OR e.employee_code ILIKE :search OR sp.service_po_name ILIKE :search)`
    : '';
  if (search) replacements.search = `%${search}%`;

  // planned (resource_budget_master.company_id) and actual (timesheets.company_id)
  // are stamped with two DIFFERENT semantics — the PO's own owning company vs.
  // the acting/logging session's company (cross-BU staffing is allowed; see
  // resourceBudgetService.js/timesheetService.js's doc comments) — and were
  // previously each filtered independently by :companyId with no join
  // condition tying them to the same Service PO's ownership. Anchoring both
  // CTEs on a single in_scope_pos set (this BU's own POs, plus Centralised
  // BU-less POs) instead fixes both the Centralised-PO omission and the
  // cross-BU-mapped-employee actual-hours undercount, and guarantees planned
  // vs actual are compared for the SAME set of POs.
  const cteBlock = `
    WITH in_scope_pos AS (
      SELECT id FROM service_pos WHERE (company_id IN (:companyIds) OR company_id IS NULL)
    ),
    planned AS (
      SELECT emp_id, service_po_id AS po_id, SUM(hours) AS planned_hours
      FROM resource_budget_master
      WHERE status = 'active' AND month = :monthNum AND year = :yearNum
        AND service_po_id IN (SELECT id FROM in_scope_pos)
      GROUP BY emp_id, service_po_id
    ),
    actual AS (
      SELECT t.employee_id AS emp_id, t.service_po_id AS po_id, SUM(${hoursCol}) AS actual_hours
      FROM timesheets t
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
        AND t.service_po_id IN (SELECT id FROM in_scope_pos)
        ${publishGuard}
      GROUP BY t.employee_id, t.service_po_id
    ),
    combined AS (
      SELECT
        COALESCE(planned.emp_id, actual.emp_id) AS emp_id,
        COALESCE(planned.po_id, actual.po_id)   AS po_id,
        COALESCE(planned.planned_hours, 0)      AS planned_hours,
        COALESCE(actual.actual_hours, 0)        AS actual_hours
      FROM planned
      FULL OUTER JOIN actual ON actual.emp_id = planned.emp_id AND actual.po_id = planned.po_id
    )
  `;

  // variance_pct is a per-row computed value (no GROUP BY at this level —
  // `combined` already pre-aggregates planned/actual per emp+PO), so the
  // threshold is applied with a plain WHERE — but on an OUTER query, since
  // Postgres can't reference a SELECT-list alias (variance_pct) from the
  // WHERE clause of the same query it's defined in. Wrapping in a
  // subquery is what lets both the threshold check AND the ORDER BY below
  // refer to `variance_pct` by name instead of repeating the CASE
  // expression. NULL variance_pct (planned_hours = 0) never satisfies a
  // threshold — same as the service layer's existing `at_risk` formula.
  const varianceFilterClause = `
    WHERE :varianceThresholdPct::numeric IS NULL
       OR (filtered.variance_pct IS NOT NULL AND ABS(filtered.variance_pct) >= :varianceThresholdPct)
  `;

  const dataQuery = `
    ${cteBlock}
    SELECT * FROM (
      SELECT
        e.id                    AS employee_id,
        e.employee_code,
        e.full_name,
        sp.id                   AS service_po_id,
        sp.service_po_code,
        sp.service_po_name,
        combined.planned_hours,
        combined.actual_hours,
        ROUND((combined.actual_hours - combined.planned_hours)::numeric, 2) AS variance,
        CASE
          WHEN combined.planned_hours > 0
            THEN ROUND(((combined.actual_hours - combined.planned_hours) / combined.planned_hours * 100)::numeric, 2)
          ELSE NULL
        END                       AS variance_pct
      FROM combined
      INNER JOIN employees e   ON e.id  = combined.emp_id
      INNER JOIN service_pos sp ON sp.id = combined.po_id
      WHERE 1=1 ${employeeFilter} ${poFilter} ${searchFilter}
    ) filtered
    ${varianceFilterClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    ${cteBlock}
    SELECT COUNT(*) AS total FROM (
      SELECT
        combined.planned_hours,
        CASE
          WHEN combined.planned_hours > 0
            THEN ROUND(((combined.actual_hours - combined.planned_hours) / combined.planned_hours * 100)::numeric, 2)
          ELSE NULL
        END AS variance_pct
      FROM combined
      INNER JOIN employees e   ON e.id  = combined.emp_id
      INNER JOIN service_pos sp ON sp.id = combined.po_id
      WHERE 1=1 ${employeeFilter} ${poFilter} ${searchFilter}
    ) filtered
    ${varianceFilterClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 4. Client Profitability & Revenue Concentration Report
// ---------------------------------------------------------------------------
/**
 * Per-client rollup of Priority-1's margin calc, plus each client's share
 * of total company revenue for the same period (concentration risk).
 * total_delivery_cost is service_po_monthly_budgets.billed_amount summed
 * across the client's POs for the period — not a timesheet/monthly_costs
 * calculation, same basis as getServicePOProfitability.
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getClientProfitabilityConcentration(filters) {
  const {
    month, year, search, sortBy = 'total_margin', sortOrder = 'DESC',
    limit, offset, companyIds,
  } = filters;

  const allowedSort = ['client_name', 'total_invoiced', 'total_delivery_cost', 'total_margin', 'margin_pct', 'revenue_concentration_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'total_margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const replacements = { monthNum, yearNum, limit, offset, companyIds };

  const searchFilter = search ? 'AND c.client_name ILIKE :search' : '';
  if (search) replacements.search = `%${search}%`;

  const perClientCte = `
    WITH per_client AS (
      SELECT
        c.id   AS client_id,
        c.client_name,
        COALESCE(SUM(spmb.invoice_amount), 0)                     AS total_invoiced,
        COALESCE(SUM(spmb.billed_amount), 0)                      AS total_delivery_cost
      FROM clients c
      INNER JOIN service_pos sp ON sp.client_id = c.id AND sp.is_billable = true
      LEFT JOIN service_po_monthly_budgets spmb
             ON spmb.service_po_id = sp.id AND spmb.month = :monthNum AND spmb.year = :yearNum
      WHERE c.company_id IN (:companyIds)
      GROUP BY c.id, c.client_name
      HAVING COALESCE(SUM(spmb.invoice_amount), 0) > 0 OR COALESCE(SUM(spmb.billed_amount), 0) > 0
    ),
    company_total AS (
      SELECT SUM(total_invoiced) AS grand_total FROM per_client
    )
  `;

  const dataQuery = `
    ${perClientCte}
    SELECT
      per_client.client_id,
      per_client.client_name,
      ROUND(per_client.total_invoiced::numeric, 2)      AS total_invoiced,
      ROUND(per_client.total_delivery_cost::numeric, 2) AS total_delivery_cost,
      ROUND((per_client.total_invoiced - per_client.total_delivery_cost)::numeric, 2) AS total_margin,
      CASE
        WHEN per_client.total_invoiced > 0
          THEN ROUND(((per_client.total_invoiced - per_client.total_delivery_cost) / per_client.total_invoiced * 100)::numeric, 2)
        ELSE NULL
      END AS margin_pct,
      CASE
        WHEN company_total.grand_total > 0
          THEN ROUND((per_client.total_invoiced / company_total.grand_total * 100)::numeric, 2)
        ELSE 0
      END AS revenue_concentration_pct
    FROM per_client, company_total
    WHERE 1=1 ${searchFilter}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    ${perClientCte}
    SELECT COUNT(*) AS total FROM per_client WHERE 1=1 ${searchFilter}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 5. BU (Company) Performance Scorecard — Entity Admin / Admin only
// ---------------------------------------------------------------------------
/**
 * One row per Company (BU) within the caller's allowed Entities.
 *
 * @param {object} filters
 * @param {number[]} filters.companyIds - every company_id under the caller's entityIds
 * @returns {{ rows: object[], count: number }}
 */
async function getBUPerformanceScorecard(filters) {
  const {
    month, year, companyIds, search,
    sortBy = 'total_margin', sortOrder = 'DESC', limit, offset, hoursSource, roleId,
  } = filters;

  if (!companyIds || companyIds.length === 0) {
    return { rows: [], count: 0 };
  }

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['company_name', 'active_employees', 'active_pos', 'total_invoiced', 'total_delivery_cost', 'total_margin', 'avg_utilization_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'total_margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const replacements = { monthNum, yearNum, limit, offset, companyIds };

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const searchFilter = search ? 'AND co.company_name ILIKE :search' : '';
  if (search) replacements.search = `%${search}%`;

  const cte = `
    WITH bu AS (
      SELECT
        co.id AS company_id, co.company_code, co.company_name, co.entity_id,
        (SELECT COUNT(*) FROM employees e WHERE e.status = 'active' AND (
          e.company_id = co.id
          OR EXISTS (
            SELECT 1 FROM employee_business_units ebu
            WHERE ebu.employee_id = e.id AND ebu.business_unit_id = co.id AND ebu.status = 'active'
          )
        )) AS active_employees,
        (SELECT COUNT(*) FROM service_pos sp WHERE sp.company_id = co.id AND sp.status IN ('in-progress','pending')) AS active_pos,
        COALESCE((
          SELECT SUM(spmb.invoice_amount)
          FROM service_po_monthly_budgets spmb
          INNER JOIN service_pos sp ON sp.id = spmb.service_po_id
          WHERE sp.company_id = co.id AND spmb.month = :monthNum AND spmb.year = :yearNum
        ), 0) AS total_invoiced,
        -- Anchored on sp.company_id (the PO's own owner), matching
        -- total_invoiced above — same basis as getServicePOProfitability:
        -- service_po_monthly_budgets.billed_amount, not a timesheet/
        -- monthly_costs calculation.
        COALESCE((
          SELECT SUM(spmb.billed_amount)
          FROM service_po_monthly_budgets spmb
          INNER JOIN service_pos sp ON sp.id = spmb.service_po_id
          WHERE sp.company_id = co.id AND spmb.month = :monthNum AND spmb.year = :yearNum
        ), 0) AS total_delivery_cost,
        COALESCE((
          SELECT SUM(${hoursCol})
          FROM timesheets t
          INNER JOIN service_pos sp ON sp.id = t.service_po_id
          WHERE sp.company_id = co.id
            AND EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
            AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
            ${publishGuard}
        ), 0) AS total_hours_logged
      FROM companies co
      WHERE co.id IN (:companyIds) AND co.is_deleted = false
      ${searchFilter}
    )
  `;

  const dataQuery = `
    ${cte}
    SELECT
      company_id, company_code, company_name, entity_id,
      active_employees, active_pos,
      ROUND(total_invoiced::numeric, 2)      AS total_invoiced,
      ROUND(total_delivery_cost::numeric, 2) AS total_delivery_cost,
      ROUND((total_invoiced - total_delivery_cost)::numeric, 2) AS total_margin,
      CASE
        WHEN active_employees > 0
          THEN ROUND((total_hours_logged / (active_employees * 176.0) * 100)::numeric, 2)
        ELSE NULL
      END AS avg_utilization_pct
    FROM bu
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `${cte} SELECT COUNT(*) AS total FROM bu`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 6. Employee Capacity & Bench Forecast Report
// ---------------------------------------------------------------------------
/**
 * Per active employee: total PLANNED hours (resource_budget_master) across
 * every Service PO for the given month/year, vs the 176-hour cap, plus a
 * bench flag driven by active employee_servicepo_mapping rows with little/
 * no planned work.
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getEmployeeCapacityForecast(filters) {
  const {
    month, year, employeeId, designation, search, benchThresholdHours,
    sortBy = 'capacity_used_pct', sortOrder = 'DESC', limit, offset, companyIds,
  } = filters;

  const MONTHLY_CAP = 176;
  // undefined -> no bench filtering (existing behavior: every row
  // returned, each merely annotated with bench_flag computed against the
  // display default of 40). A real number (including 0) -> the caller
  // explicitly asked to filter, so only bench_flag = true rows (at THAT
  // threshold) are returned — applied before pagination, see
  // benchFilterClause below.
  const benchThresholdFilterRequested = benchThresholdHours !== undefined;
  const benchThreshold = benchThresholdFilterRequested ? parseFloat(benchThresholdHours) : 40;

  const allowedSort = ['full_name', 'designation', 'total_planned_hours', 'capacity_used_pct', 'active_po_mappings_count'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'capacity_used_pct';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const replacements = {
    monthNum, yearNum, limit, offset, companyIds,
    monthlyCap: MONTHLY_CAP, benchThreshold, benchThresholdFilterRequested,
  };

  const conditions = ["e.status = 'active'", EMPLOYEE_COMPANY_SCOPE_SQL];
  if (employeeId) { conditions.push('e.id = :employeeId'); replacements.employeeId = employeeId; }
  if (designation) { conditions.push('e.designation ILIKE :designation'); replacements.designation = `%${designation}%`; }
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // bench_flag is a per-row computed value (active_po_mappings_count > 0
  // AND total_planned_hours < threshold) — filtering on it requires an
  // OUTER query, same reasoning as getResourceStaffingPlanAccuracy's
  // variance_pct filter above: Postgres can't reference a SELECT-list
  // alias from that same query's WHERE clause. When no threshold was
  // explicitly requested, this clause is a no-op (every row passes).
  const benchFilterClause = `
    WHERE :benchThresholdFilterRequested = false OR filtered.bench_flag = true
  `;

  const dataQuery = `
    SELECT * FROM (
      SELECT
        e.id                                  AS employee_id,
        e.employee_code,
        e.full_name,
        e.designation,
        :monthlyCap                           AS monthly_capacity_hours,
        COALESCE(rb.total_planned_hours, 0)    AS total_planned_hours,
        ROUND((COALESCE(rb.total_planned_hours, 0) / :monthlyCap * 100)::numeric, 2) AS capacity_used_pct,
        COALESCE(map.active_po_mappings_count, 0) AS active_po_mappings_count,
        (COALESCE(rb.total_planned_hours, 0) > :monthlyCap)                          AS overallocation_flag,
        (COALESCE(map.active_po_mappings_count, 0) > 0 AND COALESCE(rb.total_planned_hours, 0) < :benchThreshold) AS bench_flag
      FROM employees e
      LEFT JOIN (
        SELECT emp_id, SUM(hours) AS total_planned_hours
        FROM resource_budget_master
        WHERE status = 'active' AND month = :monthNum AND year = :yearNum AND company_id IN (:companyIds)
        GROUP BY emp_id
      ) rb ON rb.emp_id = e.id
      LEFT JOIN (
        SELECT employee_id, COUNT(*) AS active_po_mappings_count
        FROM employee_servicepo_mapping
        WHERE status = 'active' AND company_id IN (:companyIds)
        GROUP BY employee_id
      ) map ON map.employee_id = e.id
      ${whereClause}
    ) filtered
    ${benchFilterClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total FROM (
      SELECT
        (COALESCE(map.active_po_mappings_count, 0) > 0 AND COALESCE(rb.total_planned_hours, 0) < :benchThreshold) AS bench_flag
      FROM employees e
      LEFT JOIN (
        SELECT emp_id, SUM(hours) AS total_planned_hours
        FROM resource_budget_master
        WHERE status = 'active' AND month = :monthNum AND year = :yearNum AND company_id IN (:companyIds)
        GROUP BY emp_id
      ) rb ON rb.emp_id = e.id
      LEFT JOIN (
        SELECT employee_id, COUNT(*) AS active_po_mappings_count
        FROM employee_servicepo_mapping
        WHERE status = 'active' AND company_id IN (:companyIds)
        GROUP BY employee_id
      ) map ON map.employee_id = e.id
      ${whereClause}
    ) filtered
    ${benchFilterClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 7. Service PO Timeline Risk Report (date-elapsed risk only — see
//    computeTimelineRisk() in managementReportService.js)
// ---------------------------------------------------------------------------
/**
 * Raw hours-delivered-to-date + PO date range, for the service layer to
 * derive elapsed %, consumed %, and a projected exhaustion date.
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getServicePOTimelineRiskRaw(filters) {
  const {
    status, clientId, poId, search,
    sortBy = 'sp.end_date', sortOrder = 'ASC', limit, offset, hoursSource, roleId, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['sp.service_po_name', 'sp.start_date', 'sp.end_date', 'hours_delivered_to_date'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'sp.end_date';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyIds };
  const conditions = [
    '(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)',
    'sp.start_date IS NOT NULL',
    'sp.end_date IS NOT NULL',
  ];

  if (status && status !== 'all') { conditions.push('sp.status = :status'); replacements.status = status; }
  if (clientId) { conditions.push('sp.client_id = :clientId'); replacements.clientId = clientId; }
  if (poId) { conditions.push('sp.id = :poId'); replacements.poId = poId; }
  if (search) {
    conditions.push('(c.client_name ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
    SELECT
      sp.id                                AS service_po_id,
      sp.service_po_code,
      sp.service_po_name,
      sp.status,
      sp.start_date,
      sp.end_date,
      sp.po_value,
      c.id                                  AS client_id,
      c.client_name,
      COALESCE(hrs.hours_delivered_to_date, 0) AS hours_delivered_to_date
    FROM service_pos sp
    INNER JOIN clients c ON c.id = sp.client_id
    LEFT JOIN (
      SELECT t.service_po_id, SUM(${hoursCol}) AS hours_delivered_to_date
      FROM timesheets t
      WHERE 1=1
        ${publishGuard}
      GROUP BY t.service_po_id
    ) hrs ON hrs.service_po_id = sp.id
    ${whereClause}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM service_pos sp
    INNER JOIN clients c ON c.id = sp.client_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 8. Delivery Head / Account Owner Performance Report
// ---------------------------------------------------------------------------
/**
 * Rollup of Priority-1's margin calc grouped by ServicePO.delivery_head_employee_id.
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getDeliveryHeadPerformance(filters) {
  const {
    month, year, deliveryHeadEmployeeId, search,
    sortBy = 'total_margin', sortOrder = 'DESC', limit, offset, hoursSource, roleId, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['full_name', 'po_count', 'total_hours_delivered', 'total_invoiced', 'total_delivery_cost', 'total_margin'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'total_margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);
  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyIds };

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const conditions = ['(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)', 'sp.delivery_head_employee_id IS NOT NULL'];
  if (deliveryHeadEmployeeId) {
    conditions.push('sp.delivery_head_employee_id = :deliveryHeadEmployeeId');
    replacements.deliveryHeadEmployeeId = deliveryHeadEmployeeId;
  }
  if (search) {
    conditions.push('e.full_name ILIKE :search');
    replacements.search = `%${search}%`;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const perPoCte = `
    WITH per_po AS (
      SELECT
        sp.id AS service_po_id,
        sp.delivery_head_employee_id,
        COALESCE(spmb.invoice_amount, 0)        AS invoiced_amount,
        COALESCE(cur.delivery_cost, 0)          AS delivery_cost,
        COALESCE(cur.hours_delivered, 0)        AS hours_delivered,
        COALESCE(prev.hours_delivered_before, 0) AS hours_delivered_before
      FROM service_pos sp
      LEFT JOIN service_po_monthly_budgets spmb
             ON spmb.service_po_id = sp.id AND spmb.month = :monthNum AND spmb.year = :yearNum
      LEFT JOIN (
        SELECT t.service_po_id, SUM(${hoursCol}) AS hours_delivered,
               SUM(${hoursCol} * COALESCE(mc.total_cost, 0)) AS delivery_cost
        FROM timesheets t
        LEFT JOIN monthly_costs mc ON mc.employee_id = t.employee_id AND mc.month_year = :monthYear
        WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
          AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
          ${publishGuard}
        GROUP BY t.service_po_id
      ) cur ON cur.service_po_id = sp.id
      LEFT JOIN (
        SELECT service_po_id, SUM(${hoursCol}) AS hours_delivered_before
        FROM timesheets t
        WHERE timesheet_date < MAKE_DATE(:yearNum, :monthNum, 1)
          ${publishGuard}
        GROUP BY service_po_id
      ) prev ON prev.service_po_id = sp.id
      WHERE (sp.company_id IN (:companyIds) OR sp.company_id IS NULL) AND sp.delivery_head_employee_id IS NOT NULL
    )
  `;

  const dataQuery = `
    ${perPoCte}
    SELECT
      e.id                                    AS employee_id,
      e.employee_code,
      e.full_name,
      COUNT(per_po.service_po_id)              AS po_count,
      ROUND(SUM(per_po.hours_delivered)::numeric, 2)   AS total_hours_delivered,
      ROUND(SUM(per_po.invoiced_amount)::numeric, 2)   AS total_invoiced,
      ROUND(SUM(per_po.delivery_cost)::numeric, 2)     AS total_delivery_cost,
      ROUND((SUM(per_po.invoiced_amount) - SUM(per_po.delivery_cost))::numeric, 2) AS total_margin
    FROM per_po
    INNER JOIN employees e ON e.id = per_po.delivery_head_employee_id
    INNER JOIN service_pos sp ON sp.id = per_po.service_po_id
    ${whereClause}
    GROUP BY e.id, e.employee_code, e.full_name
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    ${perPoCte}
    SELECT COUNT(DISTINCT per_po.delivery_head_employee_id) AS total
    FROM per_po
    INNER JOIN employees e ON e.id = per_po.delivery_head_employee_id
    INNER JOIN service_pos sp ON sp.id = per_po.service_po_id
    ${whereClause}
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 9. Invoice Realization / Billing Efficiency Report
// ---------------------------------------------------------------------------
/**
 * Trended invoiced vs billed amounts per Service PO across a month/year
 * range, from service_po_monthly_budgets. months_outstanding is a
 * simplified proxy — the count of months IN THE SELECTED RANGE where
 * unbilled > 0, not a true consecutive-run or payment-terms-aware figure
 * (no due-date/payment-date field exists in the schema).
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getInvoiceRealizationTrend(filters) {
  const {
    startYear, startMonth, endYear, endMonth, clientId, poId, search,
    sortBy = 'total_unbilled', sortOrder = 'DESC', limit, offset, companyIds,
  } = filters;

  const allowedSort = ['service_po_name', 'total_invoiced', 'total_billed', 'total_unbilled', 'months_outstanding'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'total_unbilled';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const replacements = {
    startPeriod: startYear * 100 + startMonth,
    endPeriod: endYear * 100 + endMonth,
    limit, offset, companyIds,
  };

  const conditions = ['(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)', '(spmb.year * 100 + spmb.month) BETWEEN :startPeriod AND :endPeriod'];
  if (clientId) { conditions.push('sp.client_id = :clientId'); replacements.clientId = clientId; }
  if (poId) { conditions.push('sp.id = :poId'); replacements.poId = poId; }
  if (search) {
    conditions.push('(c.client_name ILIKE :search OR sp.service_po_name ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const cte = `
    WITH months AS (
      SELECT
        sp.id AS service_po_id, sp.service_po_code, sp.service_po_name,
        c.id AS client_id, c.client_name,
        spmb.month, spmb.year,
        spmb.invoice_amount, spmb.billed_amount,
        (spmb.invoice_amount - spmb.billed_amount) AS unbilled
      FROM service_po_monthly_budgets spmb
      INNER JOIN service_pos sp ON sp.id = spmb.service_po_id
      INNER JOIN clients c ON c.id = sp.client_id
      ${whereClause}
    )
  `;

  const dataQuery = `
    ${cte}
    SELECT
      service_po_id, service_po_code, service_po_name, client_id, client_name,
      ROUND(SUM(invoice_amount)::numeric, 2)                                AS total_invoiced,
      ROUND(SUM(billed_amount)::numeric, 2)                                 AS total_billed,
      ROUND(SUM(unbilled)::numeric, 2)                                      AS total_unbilled,
      COUNT(*) FILTER (WHERE unbilled > 0)                                  AS months_outstanding,
      json_agg(json_build_object(
        'month', month, 'year', year,
        'invoice_amount', invoice_amount, 'billed_amount', billed_amount, 'unbilled', unbilled
      ) ORDER BY year, month)                                               AS monthly_trend
    FROM months
    GROUP BY service_po_id, service_po_code, service_po_name, client_id, client_name
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    ${cte}
    SELECT COUNT(*) AS total FROM (
      SELECT service_po_id FROM months GROUP BY service_po_id
    ) sub
  `;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 10. Service Line (Category/Type) Business Mix Report
// ---------------------------------------------------------------------------
/**
 * Aggregates hours/cost/revenue by ServiceCategory + ServiceType for a
 * given month/year, with an optional prior period for MoM growth %.
 *
 * @param {object} filters
 * @returns {object[]}
 */
async function getServiceLineBusinessMix(filters) {
  const {
    month, year, compareMonth, compareYear,
    serviceCategoryId, serviceTypeId, hoursSource, roleId, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);

  const replacements = { monthNum, yearNum, monthYear, companyIds };
  // Anchored on sp.company_id (the PO's own owner), matching invoiceQuery
  // below — NOT t.company_id (the acting/logging session's company). The two
  // result sets are merged purely by service_type_id (see fetchPeriod()), so
  // using a different anchor per side previously let a cross-BU-mapped
  // employee's hours/cost land under one BU's row while the matching PO's
  // invoice landed under a different BU's row for the same service type,
  // producing a numerically wrong (not just missing) margin.
  const conditions = ['(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)', 'EXTRACT(MONTH FROM t.timesheet_date) = :monthNum', 'EXTRACT(YEAR FROM t.timesheet_date) = :yearNum'];

  if (serviceCategoryId) { conditions.push('sc.id = :serviceCategoryId'); replacements.serviceCategoryId = serviceCategoryId; }
  if (serviceTypeId) { conditions.push('st.id = :serviceTypeId'); replacements.serviceTypeId = serviceTypeId; }

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const whereClause = `WHERE ${conditions.join(' AND ')} ${publishGuard}`;

  // Hours + delivery cost from timesheets, grouped by category/type.
  const hoursCostQuery = `
    SELECT
      sc.id                                AS service_category_id,
      sc.name                              AS service_category_name,
      st.id                                AS service_type_id,
      st.service_type_name,
      ROUND(SUM(${hoursCol})::numeric, 2)  AS hours_delivered,
      ROUND(SUM(${hoursCol} * COALESCE(mc.total_cost, 0))::numeric, 2) AS delivery_cost
    FROM timesheets t
    INNER JOIN service_pos sp        ON sp.id = t.service_po_id
    INNER JOIN service_types st      ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    LEFT JOIN monthly_costs mc       ON mc.employee_id = t.employee_id AND mc.month_year = :monthYear
    ${whereClause}
    GROUP BY sc.id, sc.name, st.id, st.service_type_name
  `;

  // Invoice amount aggregated independently by category/type — driven from
  // service_pos + service_po_monthly_budgets directly, NOT joined through
  // timesheets (a PO with N timesheet rows would otherwise have its single
  // monthly invoice_amount counted N times).
  const invoiceQuery = `
    SELECT
      sc.id      AS service_category_id,
      st.id      AS service_type_id,
      ROUND(COALESCE(SUM(spmb.invoice_amount), 0)::numeric, 2) AS invoiced_amount
    FROM service_pos sp
    INNER JOIN service_types st      ON st.id = sp.service_type_id
    INNER JOIN service_categories sc ON sc.id = st.service_category_id
    LEFT JOIN service_po_monthly_budgets spmb
           ON spmb.service_po_id = sp.id AND spmb.month = :monthNum AND spmb.year = :yearNum
    WHERE (sp.company_id IN (:companyIds) OR sp.company_id IS NULL)
      ${serviceCategoryId ? 'AND sc.id = :serviceCategoryId' : ''}
      ${serviceTypeId ? 'AND st.id = :serviceTypeId' : ''}
    GROUP BY sc.id, st.id
  `;

  async function fetchPeriod(monthNumVal, yearNumVal, monthYearVal) {
    const periodReplacements = { ...replacements, monthNum: monthNumVal, yearNum: yearNumVal, monthYear: monthYearVal };
    const [hoursCostRows, invoiceRows] = await Promise.all([
      sequelize.query(hoursCostQuery, { replacements: periodReplacements, type: QueryTypes.SELECT }),
      sequelize.query(invoiceQuery, { replacements: periodReplacements, type: QueryTypes.SELECT }),
    ]);

    const invoiceByType = new Map(invoiceRows.map((r) => [r.service_type_id, parseFloat(r.invoiced_amount) || 0]));

    return hoursCostRows.map((row) => {
      const invoiced = invoiceByType.get(row.service_type_id) || 0;
      const cost = parseFloat(row.delivery_cost) || 0;
      const hours = parseFloat(row.hours_delivered) || 0;
      const margin = Math.round((invoiced - cost) * 100) / 100;
      return {
        ...row,
        invoiced_amount: Math.round(invoiced * 100) / 100,
        margin,
        margin_per_hour: hours > 0 ? Math.round((margin / hours) * 100) / 100 : null,
      };
    });
  }

  const rows = await fetchPeriod(monthNum, yearNum, monthYear);

  let priorRows = [];
  if (compareMonth && compareYear) {
    priorRows = await fetchPeriod(parseInt(compareMonth, 10), parseInt(compareYear, 10), formatMonthYear(compareMonth, compareYear));
  }

  return { rows, priorRows };
}

// A Project Manager's resolved team roster, for EVERY Project Manager at
// once (not per-caller). There is no direct project_manager_id column
// anywhere in this schema (only service_pos.delivery_head_employee_id exists
// as a direct FK, for a different role) — so this mirrors the same two-hop,
// data-driven path employeeAccessControlService.resolveEmployeeAccessWhere()
// already walks for a single caller: PM -> Team Lead (team_mappings) ->
// Employee (manager_employee_mappings), PLUS employees mapped directly to
// the PM. `roster_distinct` is (pm_id, employee_id) — an employee mapped to
// two Team Leads (PRIMARY+SECONDARY) can appear under two PMs; harmless here
// since PM-wise rollups are meant to reflect that dual reporting line.
const PM_ROSTER_CTE = `
  pms AS (
    SELECT DISTINCT e.id AS pm_id, e.full_name AS pm_name, e.employee_code AS pm_code
    FROM employees e
    INNER JOIN employee_roles er ON er.employee_id = e.id AND er.status = 'active'
    INNER JOIN roles r ON r.id = er.role_id AND r.role_name = 'Project Manager'
    WHERE e.is_deleted = false AND e.status = 'active' AND ${EMPLOYEE_COMPANY_SCOPE_SQL}
  ),
  team_leads AS (
    SELECT tm.service_po_admin_employee_id AS pm_id, tm.manager_employee_id AS tl_id
    FROM team_mappings tm
    WHERE tm.status = 'active'
  ),
  roster AS (
    SELECT pm_id, pm_id AS employee_id FROM pms
    UNION
    SELECT pms.pm_id, mem.employee_id
    FROM manager_employee_mappings mem
    INNER JOIN pms ON pms.pm_id = mem.manager_employee_id
    WHERE mem.status = 'active'
    UNION
    SELECT tl.pm_id, tl.tl_id AS employee_id FROM team_leads tl
    UNION
    SELECT tl.pm_id, mem.employee_id
    FROM manager_employee_mappings mem
    INNER JOIN team_leads tl ON tl.tl_id = mem.manager_employee_id
    WHERE mem.status = 'active'
  ),
  roster_distinct AS (
    SELECT DISTINCT pm_id, employee_id FROM roster
  )
`;

// The flat per-employee-per-month capacity figure already used everywhere
// else in this codebase for an "available hours" concept (see
// getEmployeeCapacityForecast above and pmDashboardRepository.getTeamCapacity)
// — reused here for consistency rather than a calendar-working-days figure,
// which this schema has no holiday/working-day-calendar table to compute.
const MONTHLY_CAP = 176;

// A billable-hours WHERE fragment for getPMWiseUtilization/
// getProjectWiseUtilization below. `service_pos.is_billable` (a real column,
// not a name-matching heuristic) is the authoritative flag for this — it
// correctly covers every non-project overhead Service PO this schema
// actually has (confirmed against real data: "On Bench", "Leaves",
// "Training & Upskilling", "HR and Admin Activity" are ALL is_billable=false)
// without needing to enumerate their names. An earlier name-based version of
// this filter (LOWER(service_po_name) NOT IN ('idle','on bench')) MISSED
// "HR and Admin Activity" — a shared, org-wide catch-all PO nearly every
// employee is mapped to — which silently inflated every PM's resource_count
// to the entire company headcount. is_billable=false also means "Training"
// IS excludable after all, contrary to this file's earlier assumption.
const BILLABLE_ENTRY_FILTER_SQL = `sp.is_billable = true`;

const PERIOD_EXPR_SQL = `(EXTRACT(YEAR FROM t.timesheet_date)::int * 100 + EXTRACT(MONTH FROM t.timesheet_date)::int)`;

// BU scope for the 2 Bench reports below — deliberately NOT the usual
// "(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)" idiom used
// everywhere else in this file (getProjectWiseUtilization included): the
// "Idle"/"On Bench" Service PO is a single shared, org-wide utility PO with
// sp.company_id = NULL BY DESIGN (confirmed against real data — every Bench-
// tagged timesheet row joins to the same PO row regardless of which BU
// logged it), so "OR sp.company_id IS NULL" would make every Bench entry
// pass every BU's filter — defeating scoping entirely for this report only
// (this is the bug reported against resource-wise-bench/month-wise-bench).
// t.company_id (the timesheet row's own company, stamped from the actor who
// logged it — confirmed populated with real, differentiated values even
// when sp.company_id is null) is the reliable per-row BU signal here,
// matching dashboardRepository.js's buildAnalyticsFilters() convention for
// this exact same getNoWorkTrend/getLeaveHoursTrend bench/leave scenario —
// except without ITS "OR sp.company_id IS NULL" clause, which would
// reintroduce the same bug.
const BENCH_COMPANY_SCOPE_SQL = `(t.company_id IN (:companyIds) OR sp.company_id IN (:companyIds))`;

// The bare Project Manager roster (id/name/code) — reused by
// getPMWiseUtilization below (which needs ONLY this, not the org-hierarchy
// walk PM_ROSTER_CTE further down builds on top of it for the Bench
// reports' PM-attribution column).
const PMS_ONLY_CTE_SQL = `
  pms AS (
    SELECT DISTINCT e.id AS pm_id, e.full_name AS pm_name, e.employee_code AS pm_code
    FROM employees e
    INNER JOIN employee_roles er ON er.employee_id = e.id AND er.status = 'active'
    INNER JOIN roles r ON r.id = er.role_id AND r.role_name = 'Project Manager'
    WHERE e.is_deleted = false AND e.status = 'active' AND ${EMPLOYEE_COMPANY_SCOPE_SQL}
  )
`;

// ---------------------------------------------------------------------------
// 11. Project Manager-wise Utilization Report — one row per Project Manager.
//
// A PM's "team" here is driven ENTIRELY by Service PO staffing, not the
// org hierarchy (team_mappings/manager_employee_mappings) getResourceWiseBench
// uses for its PM column — matching the already-established "Project
// Manager sees only individually-mapped Service POs" rule
// (servicePOService.js's resolveIndividuallyMappedServicePOIds() /
// employee_servicepo_mapping, capability servicepo.view_mapped_employees):
//   1. Find every Service PO the PM is THEMSELVES individually mapped to
//      (employee_servicepo_mapping, active row, employee_id = PM's id).
//   2. `resource_count` = COUNT(DISTINCT employee_id) of every employee
//      individually mapped to any of those Service POs (any employee, not
//      just direct reports) — an employee mapped to 2 of the PM's Service
//      POs is counted ONCE, not twice.
//   3. `project_count` = COUNT(DISTINCT project_id) across those same
//      Service POs — a static staffing/master-data count, not an
//      hours-logged-activity count.
//   4. `total_logged_hours` = actual timesheet hours (billable only —
//      Bench/Leave excluded) logged by each mapped employee AGAINST THE
//      SPECIFIC Service PO they're mapped to under this PM.
//   5. `total_available_hours` = the PLANNED/BUDGETED hours for those same
//      (employee, Service PO) pairs, read from resource_budget_master (the
//      "PO Master") for the requested month range — NOT a flat capacity
//      constant. This is the authoritative source of "available hours";
//      a pair with no budget row for a given month simply contributes 0.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number} filters.startMonth
 * @param {number} filters.startYear
 * @param {number} filters.endMonth
 * @param {number} filters.endYear
 * @param {string} [filters.search] - matches PM name/employee code
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @param {number[]} filters.companyIds
 * @param {string} [filters.hoursSource]
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getPMWiseUtilization(filters) {
  const {
    startMonth, startYear, endMonth, endYear, search, hoursSource,
    sortBy = 'utilization_pct', sortOrder = 'DESC', limit, offset, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['pm_name', 'resource_count', 'project_count', 'total_logged_hours', 'total_available_hours', 'utilization_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'utilization_pct';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const replacements = {
    startPeriod: startYear * 100 + startMonth,
    endPeriod: endYear * 100 + endMonth,
    startMonthYear: startYear * 100 + startMonth,
    endMonthYear: endYear * 100 + endMonth,
    limit, offset, companyIds,
  };

  const searchClause = search ? 'AND (pms.pm_name ILIKE :search OR pms.pm_code ILIKE :search)' : '';
  if (search) replacements.search = `%${search}%`;

  const cte = `
    WITH ${PMS_ONLY_CTE_SQL},
    pm_mapped_spos AS (
      SELECT DISTINCT pms.pm_id, sp.id AS service_po_id, sp.project_id
      FROM employee_servicepo_mapping esm
      INNER JOIN pms ON pms.pm_id = esm.employee_id
      INNER JOIN service_pos sp ON sp.id = esm.service_po_id AND sp.is_deleted = false
      WHERE esm.status = 'active' AND ${BILLABLE_ENTRY_FILTER_SQL}
    ),
    spo_resources AS (
      SELECT pms2.pm_id, pms2.service_po_id, pms2.project_id, esm2.employee_id
      FROM pm_mapped_spos pms2
      INNER JOIN employee_servicepo_mapping esm2
              ON esm2.service_po_id = pms2.service_po_id AND esm2.status = 'active'
    ),
    pm_staffing AS (
      SELECT
        pm_id,
        COUNT(DISTINCT employee_id) AS resource_count,
        COUNT(DISTINCT project_id) FILTER (WHERE project_id IS NOT NULL) AS project_count
      FROM spo_resources
      GROUP BY pm_id
    ),
    logged AS (
      SELECT sr.pm_id, SUM(${hoursCol}) AS total_logged_hours
      FROM spo_resources sr
      INNER JOIN timesheets t ON t.employee_id = sr.employee_id AND t.service_po_id = sr.service_po_id
      WHERE ${PERIOD_EXPR_SQL} BETWEEN :startPeriod AND :endPeriod
      GROUP BY sr.pm_id
    ),
    available AS (
      SELECT sr.pm_id, SUM(rbm.hours) AS total_available_hours
      FROM spo_resources sr
      INNER JOIN resource_budget_master rbm
              ON rbm.emp_id = sr.employee_id AND rbm.service_po_id = sr.service_po_id
             AND rbm.status = 'active'
             AND (rbm.year * 100 + rbm.month) BETWEEN :startMonthYear AND :endMonthYear
      GROUP BY sr.pm_id
    )
  `;

  const baseSelect = `
    ${cte}
    SELECT
      pms.pm_id AS project_manager_id, pms.pm_name AS project_manager_name, pms.pm_code AS project_manager_code,
      COALESCE(ps.resource_count, 0)  AS resource_count,
      COALESCE(ps.project_count, 0)   AS project_count,
      ROUND(COALESCE(lg.total_logged_hours, 0)::numeric, 2)     AS total_logged_hours,
      ROUND(COALESCE(av.total_available_hours, 0)::numeric, 2) AS total_available_hours,
      CASE WHEN COALESCE(av.total_available_hours, 0) > 0
        THEN ROUND((COALESCE(lg.total_logged_hours, 0) / av.total_available_hours * 100)::numeric, 2)
        ELSE 0
      END AS utilization_pct
    FROM pms
    LEFT JOIN pm_staffing ps ON ps.pm_id = pms.pm_id
    LEFT JOIN logged lg      ON lg.pm_id = pms.pm_id
    LEFT JOIN available av   ON av.pm_id = pms.pm_id
    WHERE 1=1 ${searchClause}
  `;

  const dataQuery = `${baseSelect} ORDER BY ${safeSort} ${safeOrder} NULLS LAST LIMIT :limit OFFSET :offset`;
  const countQuery = `SELECT COUNT(*) AS total FROM (${baseSelect}) filtered`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// ---------------------------------------------------------------------------
// 12. "Project-wise" Utilization Report — despite the name (kept for
// continuity with the source spec), this is actually SERVICE PO-wise: one
// row per Service PO, carrying its Client and Project for context. Same
// staffing/hours/budget conventions as getPMWiseUtilization above (Service
// PO mapping defines the resource pool; logged hours from timesheets;
// available hours from resource_budget_master), just grouped by Service PO
// instead of by Project Manager.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number} filters.startMonth
 * @param {number} filters.startYear
 * @param {number} filters.endMonth
 * @param {number} filters.endYear
 * @param {string} [filters.search] - matches client/project/Service PO name or code
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @param {number[]} filters.companyIds
 * @param {string} [filters.hoursSource]
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getProjectWiseUtilization(filters) {
  const {
    startMonth, startYear, endMonth, endYear, search, hoursSource,
    sortBy = 'utilization_pct', sortOrder = 'DESC', limit, offset, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['client_name', 'project_name', 'service_po_name', 'resource_count', 'total_logged_hours', 'total_available_hours', 'utilization_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'utilization_pct';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const replacements = {
    startPeriod: startYear * 100 + startMonth,
    endPeriod: endYear * 100 + endMonth,
    startMonthYear: startYear * 100 + startMonth,
    endMonthYear: endYear * 100 + endMonth,
    limit, offset, companyIds,
  };

  const conditions = [
    'sp.is_deleted = false',
    '(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)',
    BILLABLE_ENTRY_FILTER_SQL,
  ];
  if (search) {
    conditions.push('(c.client_name ILIKE :search OR p.project_name ILIKE :search OR sp.service_po_name ILIKE :search OR sp.service_po_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const cte = `
    WITH in_scope_spos AS (
      SELECT
        sp.id AS service_po_id, sp.service_po_code, sp.service_po_name,
        p.id AS project_id, p.project_code, p.project_name,
        c.id AS client_id, c.client_name
      FROM service_pos sp
      LEFT JOIN projects p ON p.id = sp.project_id
      LEFT JOIN clients c  ON c.id = sp.client_id
      ${whereClause}
    ),
    spo_resources AS (
      SELECT iss.service_po_id, esm.employee_id
      FROM in_scope_spos iss
      INNER JOIN employee_servicepo_mapping esm
              ON esm.service_po_id = iss.service_po_id AND esm.status = 'active'
    ),
    spo_staffing AS (
      SELECT service_po_id, COUNT(DISTINCT employee_id) AS resource_count
      FROM spo_resources
      GROUP BY service_po_id
    ),
    logged AS (
      SELECT sr.service_po_id, SUM(${hoursCol}) AS total_logged_hours
      FROM spo_resources sr
      INNER JOIN timesheets t ON t.employee_id = sr.employee_id AND t.service_po_id = sr.service_po_id
      WHERE ${PERIOD_EXPR_SQL} BETWEEN :startPeriod AND :endPeriod
      GROUP BY sr.service_po_id
    ),
    available AS (
      SELECT sr.service_po_id, SUM(rbm.hours) AS total_available_hours
      FROM spo_resources sr
      INNER JOIN resource_budget_master rbm
              ON rbm.emp_id = sr.employee_id AND rbm.service_po_id = sr.service_po_id
             AND rbm.status = 'active'
             AND (rbm.year * 100 + rbm.month) BETWEEN :startMonthYear AND :endMonthYear
      GROUP BY sr.service_po_id
    )
  `;

  const baseSelect = `
    ${cte}
    SELECT
      iss.service_po_id, iss.service_po_code, iss.service_po_name,
      iss.project_id, iss.project_code, iss.project_name,
      iss.client_id, iss.client_name,
      COALESCE(ss.resource_count, 0) AS resource_count,
      ROUND(COALESCE(lg.total_logged_hours, 0)::numeric, 2)     AS total_logged_hours,
      ROUND(COALESCE(av.total_available_hours, 0)::numeric, 2)  AS total_available_hours,
      CASE WHEN COALESCE(av.total_available_hours, 0) > 0
        THEN ROUND((COALESCE(lg.total_logged_hours, 0) / av.total_available_hours * 100)::numeric, 2)
        ELSE 0
      END AS utilization_pct
    FROM in_scope_spos iss
    LEFT JOIN spo_staffing ss ON ss.service_po_id = iss.service_po_id
    LEFT JOIN logged lg       ON lg.service_po_id = iss.service_po_id
    LEFT JOIN available av    ON av.service_po_id = iss.service_po_id
  `;

  const dataQuery = `SELECT * FROM (${baseSelect}) filtered ORDER BY ${safeSort} ${safeOrder} NULLS LAST LIMIT :limit OFFSET :offset`;
  const countQuery = `SELECT COUNT(*) AS total FROM (${baseSelect}) filtered`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

// A month-range date-bounds helper shared by getMonthWiseBench and
// getResourceWiseBench below — both scan timesheets by real calendar date
// (not the year*100+month period-integer idiom used elsewhere in this file)
// since both need generate_series to zero-fill months with no activity.
function monthRangeDateBounds(startMonth, startYear, endMonth, endYear) {
  return {
    startDate: `${startYear}-${String(startMonth).padStart(2, '0')}-01`,
    endDateExclusive: endMonth === 12 ? `${endYear + 1}-01-01` : `${endYear}-${String(endMonth + 1).padStart(2, '0')}-01`,
  };
}

// ---------------------------------------------------------------------------
// 13. Month-wise Bench Report — org-wide monthly Bench %, one row per
// calendar month in range. Reuses the exact Bench heuristic already
// established in pmDashboardRepository.js/dashboardRepository.js
// (LOWER(service_po_name) IN ('idle', 'on bench')). "Total Available Hrs
// (Org)" per month = COUNT(DISTINCT employees who logged ANY hours that
// month) x MONTHLY_CAP — there is no historical headcount table (confirmed
// by pmDashboardService.getMonthlyHoursTrend's own doc comment), so "who was
// active that month" is proxied from actual logged activity rather than
// today's employees.status, which would misrepresent earlier months for
// anyone who joined/left mid-range.
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number} filters.startMonth
 * @param {number} filters.startYear
 * @param {number} filters.endMonth
 * @param {number} filters.endYear
 * @param {number[]} filters.companyIds
 * @param {string} [filters.hoursSource]
 * @returns {Promise<object[]>} one row per calendar month, zero-filled
 */
async function getMonthWiseBench(filters) {
  const { startMonth, startYear, endMonth, endYear, hoursSource, companyIds } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const replacements = {
    ...monthRangeDateBounds(startMonth, startYear, endMonth, endYear),
    monthlyCap: MONTHLY_CAP, companyIds,
  };

  const scopeClause = BENCH_COMPANY_SCOPE_SQL;

  const monthlyQuery = `
    WITH months AS (
      SELECT generate_series(:startDate::date, (:endDateExclusive::date - interval '1 month'), interval '1 month')::date AS month_start
    ),
    bench_entries AS (
      SELECT t.employee_id, date_trunc('month', t.timesheet_date)::date AS month_start, ${hoursCol} AS hours
      FROM timesheets t
      INNER JOIN service_pos sp ON sp.id = t.service_po_id
      WHERE ${scopeClause}
        AND t.timesheet_date >= :startDate AND t.timesheet_date < :endDateExclusive
        AND LOWER(sp.service_po_name) IN ('idle', 'on bench')
    ),
    bench_by_month AS (
      SELECT month_start, COUNT(DISTINCT employee_id) AS resources_on_bench, SUM(hours) AS total_bench_hours
      FROM bench_entries GROUP BY month_start
    ),
    active_by_month AS (
      SELECT date_trunc('month', t.timesheet_date)::date AS month_start, COUNT(DISTINCT t.employee_id) AS active_employee_count
      FROM timesheets t
      INNER JOIN service_pos sp ON sp.id = t.service_po_id
      WHERE ${scopeClause}
        AND t.timesheet_date >= :startDate AND t.timesheet_date < :endDateExclusive
      GROUP BY month_start
    )
    SELECT
      EXTRACT(MONTH FROM m.month_start)::int AS month,
      EXTRACT(YEAR FROM m.month_start)::int AS year,
      COALESCE(bm.resources_on_bench, 0) AS resources_on_bench,
      ROUND(COALESCE(bm.total_bench_hours, 0)::numeric, 2) AS total_bench_hours,
      ROUND((COALESCE(ahm.active_employee_count, 0) * :monthlyCap)::numeric, 2) AS total_available_hours,
      CASE WHEN COALESCE(ahm.active_employee_count, 0) > 0
        THEN ROUND((COALESCE(bm.total_bench_hours, 0) / (ahm.active_employee_count * :monthlyCap) * 100)::numeric, 2)
        ELSE 0
      END AS bench_pct
    FROM months m
    LEFT JOIN bench_by_month bm ON bm.month_start = m.month_start
    LEFT JOIN active_by_month ahm ON ahm.month_start = m.month_start
    ORDER BY m.month_start
  `;

  return sequelize.query(monthlyQuery, { replacements, type: QueryTypes.SELECT });
}

// ---------------------------------------------------------------------------
// 14. Resource-wise Bench % Report — one row per Employee who had at least
// one Bench-tagged (idle/on bench) timesheet entry anywhere in the month
// range, with a Bench % per calendar month plus an average across the
// range. Companion to getMonthWiseBench above (same source Excel tab, split
// into 2 reports/endpoints per product decision) — same Bench heuristic and
// MONTHLY_CAP=176 convention. `project_manager_name` is resolved via the
// same PM roster this file already builds for getPMWiseUtilization, walked
// through the Employee's PRIMARY manager mapping only (an Employee with only
// a SECONDARY manager mapping, no PRIMARY one, gets a null PM here).
// ---------------------------------------------------------------------------
/**
 * @param {object} filters
 * @param {number} filters.startMonth
 * @param {number} filters.startYear
 * @param {number} filters.endMonth
 * @param {number} filters.endYear
 * @param {string} [filters.sortBy]
 * @param {string} [filters.sortOrder]
 * @param {number} filters.limit
 * @param {number} filters.offset
 * @param {number[]} filters.companyIds
 * @param {string} [filters.hoursSource]
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function getResourceWiseBench(filters) {
  const {
    startMonth, startYear, endMonth, endYear, hoursSource,
    sortBy = 'avg_bench_pct', sortOrder = 'DESC', limit, offset, companyIds,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['full_name', 'avg_bench_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'avg_bench_pct';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const replacements = {
    ...monthRangeDateBounds(startMonth, startYear, endMonth, endYear),
    monthlyCap: MONTHLY_CAP, companyIds, limit, offset,
  };

  const scopeClause = BENCH_COMPANY_SCOPE_SQL;

  const resourceCte = `
    WITH ${PM_ROSTER_CTE},
    primary_chain AS (
      SELECT mem.employee_id, mem.manager_employee_id AS tl_id
      FROM manager_employee_mappings mem
      WHERE mem.status = 'active' AND mem.mapping_type = 'PRIMARY'
    ),
    employee_pm AS (
      SELECT pc.employee_id, COALESCE(tm.pm_id, direct_pm.pm_id) AS pm_id
      FROM primary_chain pc
      LEFT JOIN team_leads tm ON tm.tl_id = pc.tl_id
      LEFT JOIN pms direct_pm ON direct_pm.pm_id = pc.tl_id
    ),
    months AS (
      SELECT generate_series(:startDate::date, (:endDateExclusive::date - interval '1 month'), interval '1 month')::date AS month_start
    ),
    bench_entries AS (
      SELECT t.employee_id, date_trunc('month', t.timesheet_date)::date AS month_start, ${hoursCol} AS hours
      FROM timesheets t
      INNER JOIN service_pos sp ON sp.id = t.service_po_id
      WHERE ${scopeClause}
        AND t.timesheet_date >= :startDate AND t.timesheet_date < :endDateExclusive
        AND LOWER(sp.service_po_name) IN ('idle', 'on bench')
    ),
    bench_by_employee_month AS (
      SELECT employee_id, month_start, SUM(hours) AS bench_hours
      FROM bench_entries GROUP BY employee_id, month_start
    ),
    flagged_employees AS (
      SELECT DISTINCT employee_id FROM bench_entries
    )
  `;

  const baseSelect = `
    ${resourceCte}
    SELECT
      fe.employee_id, e.full_name, e.employee_code, pmEmp.full_name AS project_manager_name,
      json_agg(json_build_object(
        'month', EXTRACT(MONTH FROM m.month_start)::int,
        'year', EXTRACT(YEAR FROM m.month_start)::int,
        'bench_hours', ROUND(COALESCE(bem.bench_hours, 0)::numeric, 2),
        'bench_pct', ROUND((COALESCE(bem.bench_hours, 0) / :monthlyCap * 100)::numeric, 2)
      ) ORDER BY m.month_start) AS months,
      ROUND((AVG(COALESCE(bem.bench_hours, 0)) / :monthlyCap * 100)::numeric, 2) AS avg_bench_pct
    FROM flagged_employees fe
    CROSS JOIN months m
    INNER JOIN employees e ON e.id = fe.employee_id
    LEFT JOIN employee_pm ep ON ep.employee_id = fe.employee_id
    LEFT JOIN employees pmEmp ON pmEmp.id = ep.pm_id
    LEFT JOIN bench_by_employee_month bem ON bem.employee_id = fe.employee_id AND bem.month_start = m.month_start
    GROUP BY fe.employee_id, e.full_name, e.employee_code, pmEmp.full_name
  `;

  const dataQuery = `
    SELECT * FROM (${baseSelect}) filtered
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;
  const countQuery = `SELECT COUNT(*) AS total FROM (${resourceCte} SELECT 1 FROM flagged_employees) counted`;

  const [rows, countResult] = await Promise.all([
    sequelize.query(dataQuery, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(countQuery, { replacements, type: QueryTypes.SELECT }),
  ]);

  return { rows, count: parseInt(countResult[0].total, 10) };
}

module.exports = {
  getServicePOProfitability,
  getBudgetedMarginForecast,
  getResourceStaffingPlanAccuracy,
  getClientProfitabilityConcentration,
  getBUPerformanceScorecard,
  getEmployeeCapacityForecast,
  getServicePOTimelineRiskRaw,
  getDeliveryHeadPerformance,
  getInvoiceRealizationTrend,
  getServiceLineBusinessMix,
  getPMWiseUtilization,
  getProjectWiseUtilization,
  getMonthWiseBench,
  getResourceWiseBench,
};
