'use strict';

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
// Every report in this file reads req.companyIds (an array), never a single
// req.companyId — resolveCompany.js (the default authenticateBase's tail)
// is deliberately skipped in favor of authenticateIdentity + this
// middleware's own "no X-Company-Id -> role reach across every BU the
// caller is mapped to" resolution, so a BU-scoped caller mapped to more
// than one Business Unit is never 400'd for omitting the header — see
// resolveReportCompanyScope.js's doc comment.
const authenticateMultiBU = [authenticateBase.authenticateIdentity, resolveReportCompanyScope];
const reportController = require('../controllers/reportController');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');
const { validate, validateAll } = require('../middlewares/validateRequest');
const {
  employeeWorkLogHoursSummaryQuerySchema,
  employeeWorkLogHoursSummaryDetailQuerySchema,
  employeeWorkLogHoursSummaryDetailParamsSchema,
} = require('../validations/employeeWorkLogHoursSummaryValidation');

/**
 * @swagger
 * tags:
 *   name: Reports
 *   description: Analytics and reporting endpoints for the RUT Portal
 */

// Reports run multi-join aggregate queries across the whole timesheet
// dataset — rate-limited as a class, independent of the general API limit.
router.use(heavyReportLimiter);

// Employee Work Log Hours Summary is intentionally a new report data source:
// it reads employee_work_logs, never the official timesheets table used by
// the pre-existing Reports endpoints below.
router.get(
  '/employee-work-log-hours-summary',
  authenticateMultiBU,
  validate(employeeWorkLogHoursSummaryQuerySchema, 'query'),
  reportController.getEmployeeWorkLogHoursSummary
);

router.get(
  '/employee-work-log-hours-summary/:employeeId/details',
  authenticateMultiBU,
  validateAll({
    params: employeeWorkLogHoursSummaryDetailParamsSchema,
    query: employeeWorkLogHoursSummaryDetailQuerySchema,
  }),
  reportController.getEmployeeWorkLogHoursSummaryDetails
);

/**
 * @swagger
 * /reports/employee-hourly-rate:
 *   get:
 *     summary: Employee hourly cost rate for a given month/year
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month number (1-12)
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *         description: Four-digit year
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by employee name or code
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [e.full_name, e.employee_code, e.designation, mc.salary_cost, mc.total_cost, per_hour_rate] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated employee hourly rate records
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month and year are required
 */
router.get(
  '/employee-hourly-rate',
  authenticateMultiBU,
  reportController.getEmployeeHourlyRate
);

/**
 * @swagger
 * /reports/monthly-cost-summary:
 *   get:
 *     summary: Aggregated cost summary grouped by month and year
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [year, month, total_salary_cost, total_ops_cost, total_cost, employee_count] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated monthly cost summary with page-level totals
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/monthly-cost-summary',
  authenticateMultiBU,
  reportController.getMonthlyCostSummary
);

/**
 * @swagger
 * /reports/timesheet-summary:
 *   get:
 *     summary: Timesheet entries with employee and PO details
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by employee name, code, PO name or code
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated timesheet records
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/timesheet-summary',
  authenticateMultiBU,
  reportController.getTimesheetSummary
);

/**
 * @swagger
 * /reports/service-po-utilisation:
 *   get:
 *     summary: Actual vs expected hours utilisation per Service PO
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, closed, all] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated PO utilisation data with status classification
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/service-po-utilisation',
  authenticateMultiBU,
  reportController.getServicePOUtilisation
);

/**
 * @swagger
 * /reports/sub-project-hours:
 *   get:
 *     summary: Hours logged per sub-project
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, closed, all] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated sub-project hours
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/sub-project-hours',
  authenticateMultiBU,
  reportController.getSubProjectHours
);

/**
 * @swagger
 * /reports/resource-allocation:
 *   get:
 *     summary: Employee-to-PO allocation with hours logged
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Filter hours to this month (optional)
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Filter hours to this year (optional)
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *         description: Filter by Service PO (project)
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *         description: Filter by client
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [in-progress, completed, on-hold, pending, cancelled, closed, all] }
 *         description: Filter by PO status
 *       - in: query
 *         name: isBillable
 *         schema: { type: boolean }
 *         description: Filter by the PO's billable flag
 *       - in: query
 *         name: serviceCategoryId
 *         schema: { type: integer }
 *         description: Filter by service category
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *         description: Filter by service type
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [e.full_name, e.employee_code, e.designation, sp.service_po_name, c.client_name, total_hours_logged, sc.name, st.service_type_name] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: >
 *           Paginated resource allocation records derived from timesheet entries.
 *           total_hours_logged is scoped to month/year when provided.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/resource-allocation',
  authenticateMultiBU,
  reportController.getResourceAllocation
);

/**
 * @swagger
 * /reports/operational-cost-breakdown:
 *   get:
 *     summary: Per-employee salary and operational cost breakdown
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated cost breakdown with page-level totals
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/operational-cost-breakdown',
  authenticateMultiBU,
  reportController.getOperationalCostBreakdown
);

/**
 * @swagger
 * /reports/employee-utilization-summary:
 *   get:
 *     summary: Monthly employee utilization summary with billable/non-billable breakdown
 *     description: >
 *       Returns one row per active employee for the given month and year.
 *       Non-billable hours are pivoted into five category columns based on
 *       service_types.service_type_name (keyword matching with priority order —
 *       leaves → team_management → lnd → internal_support → others).
 *       Monthly capacity defaults to 176 hrs. Total utilization excludes leave hours.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month number (1-12)
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *         description: Four-digit year
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by employee name or code
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum:
 *             - full_name
 *             - designation
 *             - total_experience
 *             - company_experience
 *             - billable_total
 *             - non_billable_total
 *             - total_utilization_excl_leaves_pct
 *             - leaves_hours
 *             - lnd_hours
 *             - internal_support_hours
 *             - team_management_hours
 *             - others_hours
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: >
 *           Paginated utilization records. Each record includes:
 *           full_name, designation, total_experience, company_experience,
 *           monthly_capacity (176), monthly_billing_capacity (176), clients,
 *           internal_support_hours, team_management_hours, leaves_hours,
 *           lnd_hours, others_hours, billable_total, non_billable_total,
 *           total_utilization_excl_leaves_pct.
 *           Summary contains page-level totals for all hour columns.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month and year are required
 */
router.get(
  '/employee-utilization-summary',
  authenticateMultiBU,
  reportController.getEmployeeUtilizationSummary
);

/**
 * @swagger
 * /reports/service-po-summary:
 *   get:
 *     summary: Service PO summary with hours delivered and monthly billable amount
 *     description: >
 *       One row per Service PO. For the selected month/year:
 *       hours_delivered_before_month = sum of timesheet hours logged before the 1st of the month;
 *       available_hours = expected_man_hours - hours_delivered_before_month;
 *       monthly_billable_amount = sum(hours_logged_this_month × employee_hourly_rate) for billable POs only.
 *       hourly_rate = total_cost / 160 from monthly_costs.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month number (1-12)
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *         description: Four-digit year
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [in-progress, completed, on-hold, pending, cancelled, closed, all] }
 *         description: Filter by PO status
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *         description: Filter by client
 *       - in: query
 *         name: is_billable
 *         schema: { type: boolean }
 *         description: Filter by billable flag
 *       - in: query
 *         name: serviceCategoryId
 *         schema: { type: integer }
 *         description: Filter by service category
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *         description: Filter by service type
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *         description: Filter by a specific Service PO (project)
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *         description: Only include POs whose start_date is on or after this date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *         description: Only include POs whose end_date is on or before this date (YYYY-MM-DD)
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by client name, PO name or PO code
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum:
 *             - c.client_name
 *             - sp.service_po_name
 *             - sp.start_date
 *             - sp.end_date
 *             - sp.po_value
 *             - sp.expected_man_hours
 *             - hours_delivered_before_month
 *             - available_hours
 *             - monthly_billable_amount
 *             - sp.status
 *             - sc.name
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200 }
 *     responses:
 *       200:
 *         description: >
 *           Paginated Service PO summary. Each record includes:
 *           service_po_id, service_po_code, service_po_name, service_description,
 *           start_date, end_date, status, is_billable, invoice_frequency, po_value,
 *           account_manager, expected_man_hours, client_id, client_name, service_type,
 *           hours_delivered_before_month, available_hours, monthly_billable_amount.
 *           Summary contains page-level totals for all numeric columns.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month and year are required
 */
router.get(
  '/service-po-summary',
  authenticateMultiBU,
  reportController.getServicePOSummary
);

/**
 * @swagger
 * /reports/invoice-po-summary:
 *   get:
 *     summary: Invoice PO summary with hours delivered, monthly billable amount, and monthly-budget billing
 *     description: >
 *       Replica of /reports/service-po-summary (same filters, pagination, sorting, and
 *       PO/client/project structure). One row per Service PO. For the selected month/year:
 *       hours_delivered_before_month = sum of timesheet hours logged before the 1st of the month;
 *       available_hours = expected_man_hours - hours_delivered_before_month;
 *       monthly_billable_amount = sum(hours_logged_this_month × employee_hourly_rate) for billable POs only.
 *       hourly_rate = total_cost / 160 from monthly_costs.
 *       invoiced_amount and billed_amount are read from the Service PO Monthly
 *       Budget master (service_po_monthly_budgets, matched on service_po_id +
 *       month/year — see /service-po-monthly-budgets) instead of being
 *       computed from sp.invoice_amount or timesheets/monthly_costs; missing
 *       budget data for a PO/month defaults both to 0.
 *       unbilled_amount = invoiced_amount - billed_amount.
 *       This is a separate report from Service PO Summary — it does not modify
 *       or affect that report's behavior.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month number (1-12)
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *         description: Four-digit year
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [in-progress, completed, on-hold, pending, cancelled, closed, all] }
 *         description: Filter by PO status
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *         description: Filter by client
 *       - in: query
 *         name: is_billable
 *         schema: { type: boolean }
 *         description: Filter by billable flag
 *       - in: query
 *         name: serviceCategoryId
 *         schema: { type: integer }
 *         description: Filter by service category
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *         description: Filter by service type
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *         description: Filter by a specific Service PO (project)
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *         description: Only include POs whose start_date is on or after this date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *         description: Only include POs whose end_date is on or before this date (YYYY-MM-DD)
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by client name, PO name or PO code
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum:
 *             - c.client_name
 *             - sp.service_po_name
 *             - sp.start_date
 *             - sp.end_date
 *             - sp.po_value
 *             - sp.expected_man_hours
 *             - hours_delivered_before_month
 *             - available_hours
 *             - monthly_billable_amount
 *             - sp.status
 *             - sc.name
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200 }
 *     responses:
 *       200:
 *         description: >
 *           Paginated Invoice PO summary. Each record includes:
 *           service_po_id, service_po_code, service_po_name, service_description,
 *           start_date, end_date, status, is_billable, invoice_frequency, po_value,
 *           account_manager, expected_man_hours, client_id, client_name, service_type,
 *           hours_delivered_before_month, available_hours, monthly_billable_amount,
 *           invoiced_amount, billed_amount, unbilled_amount.
 *           Summary contains page-level totals for all numeric columns, including
 *           total_invoiced_amount, total_billed_amount, total_unbilled_amount.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month and year are required
 */
router.get(
  '/invoice-po-summary',
  authenticateMultiBU,
  reportController.getInvoicePOSummary
);

/**
 * @swagger
 * /reports/resource-utilization:
 *   get:
 *     summary: Employee hours pivot by service category and service type
 *     description: >
 *       Returns dynamic columns (service categories → service types) and one row per employee
 *       with hours logged in each service type for the given month/year.
 *       Also computes billable_total, non_billable_total, total_hours, leaves_hours,
 *       and total_utilization (total_hours minus leaves) per employee.
 *       Paged at the employee level.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month number (1-12)
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *         description: Four-digit year
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by employee name or code
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200 }
 *     responses:
 *       200:
 *         description: >
 *           columns: array of { category_id, category_name, service_types: [{id, name}] }.
 *           records: array of employee rows with hours map { [service_type_id]: hours }
 *           plus billable_total, non_billable_total, total_hours, leaves_hours, total_utilization.
 *           summary: page-level totals for all hour columns.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month and year are required
 */
router.get(
  '/resource-utilization',
  authenticateMultiBU,
  reportController.getResourceUtilization
);

/**
 * @swagger
 * /reports/monthly-resource-utilization:
 *   get:
 *     summary: Full employee detail × service-type hours pivot for a given month/year
 *     description: >
 *       Matches the Excel resource utilization report.
 *       Fixed employee columns: full_name, designation, total_experience,
 *       company_experience (UVTech/GTT DATA), resource_description,
 *       monthly_capacity (160), monthly_billing_capacity (160), clients.
 *       Dynamic columns (service category → service types) hold decimal hours.
 *       Computed totals per row: billable_total, non_billable_total, leaves_hours,
 *       total_utilization (total_hours - leaves_hours).
 *       Only active employees with timesheet entries in the period appear.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month number (1-12)
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *         description: Four-digit year
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by employee name or code
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200 }
 *     responses:
 *       200:
 *         description: >
 *           columns: [{ category_id, category_name, service_types: [{id, name}] }].
 *           records: employee rows — full_name, designation, total_experience,
 *           company_experience, resource_description, monthly_capacity (160),
 *           monthly_billing_capacity (160), clients (comma-separated string),
 *           hours { [service_type_id]: decimal_hours },
 *           billable_total, non_billable_total, leaves_hours, total_utilization.
 *           summary: page-level totals.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month and year are required
 */
router.get(
  '/monthly-resource-utilization',
  authenticateMultiBU,
  reportController.getMonthlyResourceUtilization
);

/**
 * @swagger
 * /reports/resource-project-utilization-report:
 *   get:
 *     summary: Per-employee project/hours utilization report for a given month/year
 *     description: >
 *       For each employee active in the selected month/year, returns their
 *       total hours and a per-project breakdown (client, project name/type/subtype,
 *       category, hours, billable amount). employeeId, clientId, poId (alias:
 *       projectId), and serviceTypes are multi-select — pass a single ID, a
 *       comma-separated list, or repeated query keys, and matching rows for
 *       ANY of the given IDs are returned.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Month number (1-12). Defaults to the current month.
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Four-digit year. Defaults to the current year.
 *       - in: query
 *         name: employeeId
 *         schema:
 *           oneOf:
 *             - { type: integer }
 *             - { type: string }
 *         example: "175,178,179"
 *         description: Multi-select — single ID or comma-separated list of employee IDs.
 *       - in: query
 *         name: clientId
 *         schema:
 *           oneOf:
 *             - { type: integer }
 *             - { type: string }
 *         example: "12,15"
 *         description: Multi-select — single ID or comma-separated list of client IDs.
 *       - in: query
 *         name: poId
 *         schema:
 *           oneOf:
 *             - { type: integer }
 *             - { type: string }
 *         example: "301,302,305"
 *         description: >
 *           Multi-select — single ID or comma-separated list of Service PO IDs.
 *           `projectId` is accepted as an alias for this same filter.
 *       - in: query
 *         name: projectId
 *         schema:
 *           oneOf:
 *             - { type: integer }
 *             - { type: string }
 *         description: Alias for poId (kept for backward compatibility).
 *       - in: query
 *         name: employeeName
 *         schema: { type: string }
 *       - in: query
 *         name: clientName
 *         schema: { type: string }
 *       - in: query
 *         name: projectName
 *         schema: { type: string }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypes
 *         schema:
 *           oneOf:
 *             - { type: integer }
 *             - { type: string }
 *         example: "1,3,4"
 *         description: Multi-select — single ID or comma-separated list of service type IDs.
 *       - in: query
 *         name: categoryId
 *         schema: { type: integer }
 *       - in: query
 *         name: subProjectId
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search across employee, client, project, service type, category, and sub-project names.
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200 }
 *     responses:
 *       200:
 *         description: >
 *           Paginated employee rows — employeeId, employeeName, totalHours,
 *           and projects: [{ client, projectName, projectType, projectSubType,
 *           category, projectHours, billableAmount }].
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month must be between 1 and 12
 *
 * # Example — multi-select employeeId filter:
 * #   GET /reports/resource-project-utilization-report?month=5&year=2026&page=1&limit=10&employeeId=175,178,179
 */
router.get(
  '/resource-project-utilization-report',
  authenticateMultiBU,
  reportController.getResourseProjectUtilizationReport
);

/**
 * @swagger
 * /reports/client-service-po-hours:
 *   get:
 *     summary: Hours grouped by Client then Service PO
 *     description: >
 *       Independent of the Dashboard's "Client x Service PO (Hours)" chart —
 *       grouped server-side by Client, each Client listing all its Service
 *       POs with summed hours (Main + Parent + Child hierarchy hours
 *       combined — timesheets has no separate hierarchy rows to begin with)
 *       and a backend-computed total_hrs_of_client.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Required together with year (mutually exclusive with startDate/endDate)
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *         description: Required together with endDate (mutually exclusive with month/year)
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *         description: Filter by Service PO (project)
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [in-progress, completed, on-hold, pending, cancelled, closed, all] }
 *     responses:
 *       200:
 *         description: >
 *           Array of { client_id, client_name, total_hrs_of_client,
 *           service_pos: [{ service_po_id, service_po_code, service_po_name, hours }] }
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Missing/ambiguous date filter (must provide exactly one of month+year or startDate+endDate)
 */
router.get(
  '/client-service-po-hours',
  authenticateMultiBU,
  reportController.getClientServicePOHoursReport
);

/**
 * @swagger
 * /reports/client-cost-analytics:
 *   get:
 *     summary: Client cost analytics — total hours/cost per client, Top Clients by Cost ranking, and client x category cost matrix
 *     description: >
 *       Based on the Dashboard Analytics2 endpoint's client_wise_cost_analytics,
 *       top_clients_by_cost, and client_category_cost_matrix reports. Always
 *       the complete, unfiltered, all-time dataset (Invoice Master /
 *       service_po_monthly_budgets.billed_amount basis) — no period or
 *       entity filter applies, matching the Dashboard's own scope.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: hoursSource
 *         schema: { type: string, enum: [O, M] }
 *         description: "'O' = original hours_logged, 'M' (default) = modified_hours falling back to hours_logged."
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *         description: Page number for the top_clients ranking only.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *         description: Page size for the top_clients ranking only. Defaults to 15.
 *     responses:
 *       200:
 *         description: "{ clients: [...], top_clients: { data, pagination }, category_matrix: [...] }"
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/client-cost-analytics',
  authenticateMultiBU,
  reportController.getClientCostAnalytics
);

/**
 * @swagger
 * /reports/client-wise-analytics:
 *   get:
 *     summary: Per-client total cost, total hours, average cost/hour, project count, and % of total cost, for a period
 *     description: >
 *       Based on the Dashboard Analytics2 endpoint's client_wise_analytics
 *       report. percentage_of_total_cost is computed against every client
 *       matching these same filters, before pagination.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: hoursSource
 *         schema: { type: string, enum: [O, M] }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [total_cost, total_hours, average_cost_per_hour, total_projects, percentage_of_total_cost] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated client wise analytics
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Missing/ambiguous date filter (must provide exactly one of month+year or startDate+endDate)
 */
router.get(
  '/client-wise-analytics',
  authenticateMultiBU,
  reportController.getClientWiseAnalytics
);

/**
 * @swagger
 * /reports/monthly-hours-trend:
 *   get:
 *     summary: Monthly hours-by-category, cost-by-category, utilization %, leave hours, and no-work (Idle/On Bench) hours trend
 *     description: >
 *       Based on the Dashboard Analytics endpoint's monthly_hours_trend chart
 *       and the Analytics2 endpoint's cost_trend_by_type/
 *       monthly_resource_utilization/leave_hours_trend/no_work_trend
 *       reports, bundled into one report — all five are month-by-month
 *       trends sharing the same period/filter resolution. Not paginated;
 *       every month in the resolved period is zero-filled so the series
 *       never has gaps.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: hoursSource
 *         schema: { type: string, enum: [O, M] }
 *     responses:
 *       200:
 *         description: "{ monthly_hours_by_category, monthly_cost_by_category, monthly_utilization, leave_hours_trend, no_work_trend }"
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Missing/ambiguous date filter (must provide exactly one of month+year or startDate+endDate)
 */
router.get(
  '/monthly-hours-trend',
  authenticateMultiBU,
  reportController.getMonthlyHoursTrend
);

/**
 * @swagger
 * /reports/employee-bench-percentage:
 *   get:
 *     summary: Per-employee bench % — hours logged against Idle/On Bench Service POs as a share of total hours, for a period
 *     description: >
 *       Based on the Dashboard Analytics endpoint's employee_bench_pct chart.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: hoursSource
 *         schema: { type: string, enum: [O, M] }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [bench_pct, bench_hours, total_hours] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated employee bench percentage
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Missing/ambiguous date filter (must provide exactly one of month+year or startDate+endDate)
 */
router.get(
  '/employee-bench-percentage',
  authenticateMultiBU,
  reportController.getEmployeeBenchPercentage
);

/**
 * @swagger
 * /reports/budget-vs-billed:
 *   get:
 *     summary: Budget Cost (Cost Budget Master) vs Actual Billed Amount (Invoice Master) — monthly trend, per-Service-PO breakdown, and over/under-budget lists
 *     description: >
 *       Based on the Dashboard Analytics2 endpoint's budget_vs_billed report.
 *       Budget Cost is cost_budget_master.invoice_amount (only 'active' rows
 *       count); Actual Billed Amount is
 *       service_po_monthly_budgets.billed_amount. employeeId does not apply
 *       — both source tables are Service-PO-level, never per-employee.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [budget_cost, billed_amount, variance, variance_pct] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *         description: Applies to by_service_po only.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *         description: Applies to by_service_po only.
 *     responses:
 *       200:
 *         description: "{ monthly, by_service_po: { data, meta }, summary, over_budget_service_pos, under_budget_service_pos }"
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Missing/ambiguous date filter (must provide exactly one of month+year or startDate+endDate)
 */
router.get(
  '/budget-vs-billed',
  authenticateMultiBU,
  reportController.getBudgetVsBilled
);

/**
 * @swagger
 * /reports/resource-utilization-trend:
 *   get:
 *     summary: Utilization Trend grouped by Month + Resource — same formula as monthly-hours-trend's monthly_utilization series
 *     description: >
 *       Utilization % = (Billable Hours / Total Hours) × 100, rounded to 2
 *       decimals, 0 when Total Hours = 0 — the existing Utilization Trend
 *       formula, unchanged, additionally broken down per employee/resource.
 *       Paginated.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: hoursSource
 *         schema: { type: string, enum: [O, M] }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [utilization_percentage, total_hours, billable_hours, full_name] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated resource utilization trend (Month + Resource rows)
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Missing/ambiguous date filter (must provide exactly one of month+year or startDate+endDate)
 */
router.get(
  '/resource-utilization-trend',
  authenticateMultiBU,
  reportController.getResourceUtilizationTrend
);

/**
 * @swagger
 * /reports/service-po-hours-budget:
 *   get:
 *     summary: Total PO Hours and Cost Budget per Month + Service PO
 *     description: >
 *       Total PO Hours uses the existing timesheet-hours logic (hoursSource,
 *       Role ID 5 published-import-batch restriction). Cost Budget is
 *       cost_budget_master.invoice_amount ('active' rows only) for that
 *       Service PO and month — the monthly budget table, never an
 *       overall/lifetime PO figure. A PO with hours but no budget configured
 *       still appears (cost_budget: 0); a PO with a budget but no hours
 *       logged that month still appears (total_hours: 0). Paginated.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: serviceTypeId
 *         schema: { type: integer }
 *       - in: query
 *         name: hoursSource
 *         schema: { type: string, enum: [O, M] }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [total_hours, cost_budget] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated Service PO hours & cost budget (Month + Service PO rows)
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Missing/ambiguous date filter (must provide exactly one of month+year or startDate+endDate)
 */
router.get(
  '/service-po-hours-budget',
  authenticateMultiBU,
  reportController.getServicePOHoursBudget
);

module.exports = router;
