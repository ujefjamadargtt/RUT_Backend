'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

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
 * invoiced_amount (service_po_monthly_budgets, actual) minus delivery_cost
 * (hours logged this month x employee's monthly_costs.total_cost) = margin.
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
 * @param {number} filters.companyId
 * @returns {{ rows: object[], count: number }}
 */
async function getServicePOProfitability(filters) {
  const {
    month, year, clientId, poId, status, isBillable,
    serviceCategoryId, serviceTypeId, search,
    sortBy = 'margin', sortOrder = 'DESC', limit, offset, hoursSource, roleId, companyId,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['c.client_name', 'sp.service_po_name', 'invoiced_amount', 'delivery_cost', 'margin', 'margin_pct', 'hours_delivered'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);

  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyId };
  const conditions = ['sp.company_id = :companyId', 'sp.is_billable = true'];

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
      ROUND(COALESCE(cur.delivery_cost, 0)::numeric, 2)    AS delivery_cost,
      ROUND((COALESCE(spmb.invoice_amount, 0) - COALESCE(cur.delivery_cost, 0))::numeric, 2) AS margin,
      CASE
        WHEN COALESCE(spmb.invoice_amount, 0) > 0
          THEN ROUND(((COALESCE(spmb.invoice_amount, 0) - COALESCE(cur.delivery_cost, 0)) / spmb.invoice_amount * 100)::numeric, 2)
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
        SUM(${hoursCol})                                AS hours_delivered,
        SUM(${hoursCol} * COALESCE(mc.total_cost, 0))    AS delivery_cost
      FROM timesheets t
      LEFT JOIN monthly_costs mc
             ON mc.employee_id = t.employee_id AND mc.month_year = :monthYear
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
        AND t.company_id = :companyId
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
    sortBy = 'forecasted_margin', sortOrder = 'DESC', limit, offset, companyId,
  } = filters;

  const allowedSort = ['c.client_name', 'sp.service_po_name', 'budgeted_revenue', 'budgeted_cost', 'forecasted_margin', 'forecasted_margin_pct', 'budgeted_hours'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'forecasted_margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);

  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyId };
  const conditions = ["cbm.company_id = :companyId", "cbm.status = 'active'", 'cbm.month = :monthNum', 'cbm.year = :yearNum'];

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
        AND rbm.company_id = :companyId
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
    month, year, employeeId, poId, search,
    sortBy = 'variance', sortOrder = 'DESC', limit, offset, hoursSource, roleId, companyId,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['e.full_name', 'sp.service_po_name', 'planned_hours', 'actual_hours', 'variance', 'variance_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'variance';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const replacements = { monthNum, yearNum, limit, offset, companyId };

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

  const cteBlock = `
    WITH planned AS (
      SELECT emp_id, service_po_id AS po_id, SUM(hours) AS planned_hours
      FROM resource_budget_master
      WHERE status = 'active' AND month = :monthNum AND year = :yearNum AND company_id = :companyId
      GROUP BY emp_id, service_po_id
    ),
    actual AS (
      SELECT t.employee_id AS emp_id, t.service_po_id AS po_id, SUM(${hoursCol}) AS actual_hours
      FROM timesheets t
      WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
        AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
        AND t.company_id = :companyId
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

  const dataQuery = `
    ${cteBlock}
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
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT :limit OFFSET :offset
  `;

  const countQuery = `
    ${cteBlock}
    SELECT COUNT(*) AS total
    FROM combined
    INNER JOIN employees e   ON e.id  = combined.emp_id
    INNER JOIN service_pos sp ON sp.id = combined.po_id
    WHERE 1=1 ${employeeFilter} ${poFilter} ${searchFilter}
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
 *
 * @param {object} filters
 * @returns {{ rows: object[], count: number }}
 */
async function getClientProfitabilityConcentration(filters) {
  const {
    month, year, search, sortBy = 'total_margin', sortOrder = 'DESC',
    limit, offset, hoursSource, roleId, companyId,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['client_name', 'total_invoiced', 'total_delivery_cost', 'total_margin', 'margin_pct', 'revenue_concentration_pct'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'total_margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);
  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyId };

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const searchFilter = search ? 'AND c.client_name ILIKE :search' : '';
  if (search) replacements.search = `%${search}%`;

  const perClientCte = `
    WITH per_client AS (
      SELECT
        c.id   AS client_id,
        c.client_name,
        COALESCE(SUM(spmb.invoice_amount), 0)                     AS total_invoiced,
        COALESCE(SUM(cur.delivery_cost), 0)                       AS total_delivery_cost
      FROM clients c
      INNER JOIN service_pos sp ON sp.client_id = c.id AND sp.is_billable = true
      LEFT JOIN service_po_monthly_budgets spmb
             ON spmb.service_po_id = sp.id AND spmb.month = :monthNum AND spmb.year = :yearNum
      LEFT JOIN (
        SELECT t.service_po_id, SUM(${hoursCol} * COALESCE(mc.total_cost, 0)) AS delivery_cost
        FROM timesheets t
        LEFT JOIN monthly_costs mc ON mc.employee_id = t.employee_id AND mc.month_year = :monthYear
        WHERE EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
          AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
          AND t.company_id = :companyId
          ${publishGuard}
        GROUP BY t.service_po_id
      ) cur ON cur.service_po_id = sp.id
      WHERE c.company_id = :companyId
      GROUP BY c.id, c.client_name
      HAVING COALESCE(SUM(spmb.invoice_amount), 0) > 0 OR COALESCE(SUM(cur.delivery_cost), 0) > 0
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
  const monthYear = formatMonthYear(month, year);
  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyIds };

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const searchFilter = search ? 'AND co.company_name ILIKE :search' : '';
  if (search) replacements.search = `%${search}%`;

  const cte = `
    WITH bu AS (
      SELECT
        co.id AS company_id, co.company_code, co.company_name, co.entity_id,
        (SELECT COUNT(*) FROM employees e WHERE e.company_id = co.id AND e.status = 'active') AS active_employees,
        (SELECT COUNT(*) FROM service_pos sp WHERE sp.company_id = co.id AND sp.status IN ('in-progress','pending')) AS active_pos,
        COALESCE((
          SELECT SUM(spmb.invoice_amount)
          FROM service_po_monthly_budgets spmb
          INNER JOIN service_pos sp ON sp.id = spmb.service_po_id
          WHERE sp.company_id = co.id AND spmb.month = :monthNum AND spmb.year = :yearNum
        ), 0) AS total_invoiced,
        COALESCE((
          SELECT SUM(${hoursCol} * COALESCE(mc.total_cost, 0))
          FROM timesheets t
          LEFT JOIN monthly_costs mc ON mc.employee_id = t.employee_id AND mc.month_year = :monthYear
          WHERE t.company_id = co.id
            AND EXTRACT(MONTH FROM t.timesheet_date) = :monthNum
            AND EXTRACT(YEAR  FROM t.timesheet_date) = :yearNum
            ${publishGuard}
        ), 0) AS total_delivery_cost,
        COALESCE((
          SELECT SUM(${hoursCol})
          FROM timesheets t
          WHERE t.company_id = co.id
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
    sortBy = 'capacity_used_pct', sortOrder = 'DESC', limit, offset, companyId,
  } = filters;

  const MONTHLY_CAP = 176;
  const benchThreshold = benchThresholdHours !== undefined ? parseFloat(benchThresholdHours) : 40;

  const allowedSort = ['full_name', 'designation', 'total_planned_hours', 'capacity_used_pct', 'active_po_mappings_count'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'capacity_used_pct';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const replacements = { monthNum, yearNum, limit, offset, companyId, monthlyCap: MONTHLY_CAP, benchThreshold };

  const conditions = ["e.status = 'active'", 'e.company_id = :companyId'];
  if (employeeId) { conditions.push('e.id = :employeeId'); replacements.employeeId = employeeId; }
  if (designation) { conditions.push('e.designation ILIKE :designation'); replacements.designation = `%${designation}%`; }
  if (search) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search}%`;
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const dataQuery = `
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
      WHERE status = 'active' AND month = :monthNum AND year = :yearNum AND company_id = :companyId
      GROUP BY emp_id
    ) rb ON rb.emp_id = e.id
    LEFT JOIN (
      SELECT employee_id, COUNT(*) AS active_po_mappings_count
      FROM employee_servicepo_mapping
      WHERE status = 'active' AND company_id = :companyId
      GROUP BY employee_id
    ) map ON map.employee_id = e.id
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

// ---------------------------------------------------------------------------
// 7. Service PO Budget & Timeline Exhaustion Risk Report
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
    sortBy = 'sp.end_date', sortOrder = 'ASC', limit, offset, hoursSource, roleId, companyId,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['sp.service_po_name', 'sp.start_date', 'sp.end_date', 'sp.expected_man_hours', 'hours_delivered_to_date'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'sp.end_date';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const replacements = { limit, offset, companyId };
  const conditions = [
    'sp.company_id = :companyId',
    'sp.start_date IS NOT NULL',
    'sp.end_date IS NOT NULL',
    'sp.expected_man_hours IS NOT NULL',
    'sp.expected_man_hours > 0',
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
      sp.expected_man_hours,
      c.id                                  AS client_id,
      c.client_name,
      COALESCE(hrs.hours_delivered_to_date, 0) AS hours_delivered_to_date
    FROM service_pos sp
    INNER JOIN clients c ON c.id = sp.client_id
    LEFT JOIN (
      SELECT t.service_po_id, SUM(${hoursCol}) AS hours_delivered_to_date
      FROM timesheets t
      WHERE t.company_id = :companyId
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
    sortBy = 'total_margin', sortOrder = 'DESC', limit, offset, hoursSource, roleId, companyId,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const allowedSort = ['full_name', 'po_count', 'total_hours_delivered', 'total_invoiced', 'total_delivery_cost', 'total_margin', 'at_risk_po_count'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'total_margin';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);
  const replacements = { monthNum, yearNum, monthYear, limit, offset, companyId };

  const publishGuard = Number(roleId) === 5
    ? `AND EXISTS (SELECT 1 FROM timesheet_import_history h WHERE h.id = t.timesheet_import_id AND h.is_publish = true)`
    : '';

  const conditions = ['sp.company_id = :companyId', 'sp.delivery_head_employee_id IS NOT NULL'];
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
        sp.expected_man_hours,
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
          AND t.company_id = :companyId
          ${publishGuard}
        GROUP BY t.service_po_id
      ) cur ON cur.service_po_id = sp.id
      LEFT JOIN (
        SELECT service_po_id, SUM(${hoursCol}) AS hours_delivered_before
        FROM timesheets t
        WHERE timesheet_date < MAKE_DATE(:yearNum, :monthNum, 1)
          AND t.company_id = :companyId
          ${publishGuard}
        GROUP BY service_po_id
      ) prev ON prev.service_po_id = sp.id
      WHERE sp.company_id = :companyId AND sp.delivery_head_employee_id IS NOT NULL
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
      ROUND((SUM(per_po.invoiced_amount) - SUM(per_po.delivery_cost))::numeric, 2) AS total_margin,
      COUNT(*) FILTER (
        WHERE per_po.expected_man_hours > 0
          AND (per_po.hours_delivered_before + per_po.hours_delivered) > per_po.expected_man_hours
      )                                        AS at_risk_po_count
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
    sortBy = 'total_unbilled', sortOrder = 'DESC', limit, offset, companyId,
  } = filters;

  const allowedSort = ['service_po_name', 'total_invoiced', 'total_billed', 'total_unbilled', 'months_outstanding'];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : 'total_unbilled';
  const safeOrder = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const replacements = {
    startPeriod: startYear * 100 + startMonth,
    endPeriod: endYear * 100 + endMonth,
    limit, offset, companyId,
  };

  const conditions = ['sp.company_id = :companyId', '(spmb.year * 100 + spmb.month) BETWEEN :startPeriod AND :endPeriod'];
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
    serviceCategoryId, serviceTypeId, hoursSource, roleId, companyId,
  } = filters;

  const hoursCol = (hoursSource === 'O') ? 't.hours_logged' : 'COALESCE(t.modified_hours, t.hours_logged)';
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  const monthYear = formatMonthYear(month, year);

  const replacements = { monthNum, yearNum, monthYear, companyId };
  const conditions = ['t.company_id = :companyId', 'EXTRACT(MONTH FROM t.timesheet_date) = :monthNum', 'EXTRACT(YEAR FROM t.timesheet_date) = :yearNum'];

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
    WHERE sp.company_id = :companyId
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
};
