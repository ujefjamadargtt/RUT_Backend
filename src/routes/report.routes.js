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
const utilisationReportController = require('../controllers/utilisationReportController');
const crossBuEmployeePoHoursReportController = require('../controllers/crossBuEmployeePoHoursReportController');
const { heavyReportLimiter } = require('../middlewares/rateLimiters');
const { validate, validateAll } = require('../middlewares/validateRequest');
const {
  employeeWorkLogHoursSummaryQuerySchema,
  employeeWorkLogHoursSummaryDetailQuerySchema,
  employeeWorkLogHoursSummaryDetailParamsSchema,
} = require('../validations/employeeWorkLogHoursSummaryValidation');
const { projectTimesheetReportQuerySchema } = require('../validations/projectTimesheetReportValidation');
const { crossBuEmployeePoHoursReportQuerySchema } = require('../validations/crossBuEmployeePoHoursReportValidation');
const { employeeRoleBuMappingQuerySchema } = require('../validations/employeeRoleBuMappingReportValidation');
const {
  teamLeadEmployeeProjectHoursQuerySchema,
  teamLeadEmployeeProjectHoursExportQuerySchema,
  teamLeadEmployeeProjectHoursFilterOptionsQuerySchema,
} = require('../validations/teamLeadEmployeeProjectHoursReportValidation');
const {
  teamLeadEmployeePoHoursQuerySchema,
  teamLeadEmployeePoHoursExportQuerySchema,
  teamLeadEmployeePoHoursFilterOptionsQuerySchema,
} = require('../validations/teamLeadEmployeePoHoursReportValidation');
const {
  buAdminEmployeePoHoursQuerySchema,
  buAdminEmployeePoHoursExportQuerySchema,
  buAdminEmployeePoHoursFilterOptionsQuerySchema,
  projectManagerEmployeePoHoursQuerySchema,
  projectManagerEmployeePoHoursExportQuerySchema,
  projectManagerEmployeePoHoursFilterOptionsQuerySchema,
} = require('../validations/poHoursScopedReportsValidation');
const authorize = require('../middlewares/authorize');

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
/**
 * @swagger
 * /reports/project-timesheet:
 *   get:
 *     summary: Project-wise timesheet report (entries with activity description, Project Manager, leave hours, approval status)
 *     description: >
 *       Employee-wise and day-wise work-log entries, filterable by Project / Service PO /
 *       Client / Employee. Period is month+year or start_date+end_date (max 366 days).
 *       format=json (paged, optional include_summary) | excel (Details, Project Summary,
 *       Employee Summary sheets) | csv (details). Visibility follows the caller's own
 *       Employee scope within their report reach.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/project-timesheet',
  authenticateMultiBU,
  validate(projectTimesheetReportQuerySchema, 'query'),
  reportController.getProjectTimesheetReport
);

/**
 * @swagger
 * /reports/cross-bu-employee-po-hours:
 *   get:
 *     summary: Cross-BU Employee & Service PO hours (Employee BU and PO BU as independent dimensions)
 *     description: >
 *       Employee -> Employee BU/Sub-BU -> Client -> Project -> Service PO -> PO BU -> total hours on
 *       that PO, one row per Employee + Service PO + month (no Activity/Task breakdown). Employee BU and PO BU are separate
 *       filters (employee_bu_ids / employee_sub_bu_ids vs po_bu_ids) so cross-BU work shows from both
 *       sides; work_type = own | cross | na (Centralised PO, PO/employee with no BU) | all. A BU-scoped
 *       caller sees rows where the Employee OR the PO belongs to their BUs. Returns summary cards
 *       (totals), the Employee BU <-> PO BU hours flow (bu_flow) and the paged records.
 *       Period: month+year, or start_date+end_date (max 366 days); default current month.
 *       format=json | excel (Details + BU Flow sheets) | csv (details).
 *       hoursSource=O = Original (as-logged) hours, omitted/M = Adjusted: drives sort_by=hours (Original -> logged_hours,
 *       Adjusted -> adjusted_hours) and the single hours column of the excel/csv export (header suffixed '(Original)').
 *       totals carry the original and adjusted Own BU / Cross BU / unclassified hours (original_own_bu_hours, adjusted_own_bu_hours, ...).
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/cross-bu-employee-po-hours',
  authenticateMultiBU,
  validate(crossBuEmployeePoHoursReportQuerySchema, 'query'),
  crossBuEmployeePoHoursReportController.getCrossBuEmployeePoHoursReport
);

/**
 * @swagger
 * /reports/employee-role-bu-mapping:
 *   get:
 *     summary: Employee Role & Organization Mapping — one row per Employee with Roles, BUs and Sub BUs
 *     description: >
 *       Roles/BUs/Sub BUs are each comma-separated (STRING_AGG DISTINCT), one
 *       row per Employee. Only mappings to Business Units inside the caller's
 *       own reach are read or shown. entityIds/buIds/subBuIds are all
 *       matched against the SAME employee_business_units row (a BU + Sub BU
 *       selection matches only a real mapping in that branch). buIds also
 *       match that BU's own Sub-BUs. No Entity/BU/role is hardcoded.
 *       format=excel returns every row matching the same filters as an .xlsx.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: entityIds, schema: { type: string }, description: Comma-separated Entity ids }
 *       - { in: query, name: buIds, schema: { type: string }, description: Comma-separated BU ids (includes their Sub-BUs) }
 *       - { in: query, name: subBuIds, schema: { type: string }, description: Comma-separated Sub-BU ids }
 *       - { in: query, name: roleIds, schema: { type: string }, description: Comma-separated role ids }
 *       - { in: query, name: employeeId, schema: { type: integer } }
 *       - { in: query, name: search, schema: { type: string }, description: Employee name or code }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 20, maximum: 100 } }
 *       - { in: query, name: format, schema: { type: string, enum: [json, excel], default: json } }
 *     responses:
 *       200:
 *         description: Paginated rows (json) or an .xlsx download (excel)
 */
router.get(
  '/employee-role-bu-mapping',
  authenticateMultiBU,
  validate(employeeRoleBuMappingQuerySchema, 'query'),
  reportController.getEmployeeRoleBuMappingReport
);

/**
 * @swagger
 * /reports/team-lead-employee-project-hours:
 *   get:
 *     summary: Team Lead Employee Project Hours — work log entries of the caller's own Primary/Secondary-mapped Employees
 *     description: >
 *       Access is ONLY the caller's active manager_employee_mappings rows
 *       (PRIMARY or SECONDARY). BU/company, Service PO and Project Manager
 *       (employee_servicepo_mapping) relationships never grant visibility.
 *       The Team Lead is always the authenticated caller — no id is accepted.
 *       One row per employee_work_logs entry; BU/Sub-BU are the Service PO's.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: month, schema: { type: integer }, description: With year; mutually exclusive with startDate/endDate }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: employeeIds, schema: { type: string }, description: Comma-separated; only narrows the caller's own team }
 *       - { in: query, name: clientIds, schema: { type: string } }
 *       - { in: query, name: projectIds, schema: { type: string } }
 *       - { in: query, name: servicePoIds, schema: { type: string } }
 *       - { in: query, name: buIds, schema: { type: string }, description: Top-level BU (includes its Sub-BUs) }
 *       - { in: query, name: subBuIds, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string }, description: Comma-separated pending,approved,rejected,synced }
 *       - { in: query, name: search, schema: { type: string }, description: Employee name/code or entry description }
 *       - { in: query, name: sortBy, schema: { type: string, enum: [employee, client, project, spo, hours, status, date] } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: [asc, desc], default: desc } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 20, maximum: 100 } }
 *     responses:
 *       200:
 *         description: "{ records[], summary: { total_logged_hours, period } } plus pagination meta"
 *       403:
 *         description: Caller lacks the manager.view_mapped_employees capability
 */
/**
 * @swagger
 * /reports/team-lead-employee-project-hours/filter-options:
 *   get:
 *     summary: Dropdown options for the Team Lead Employee Project Hours report
 *     description: >
 *       employees = every Employee mapped to the caller as Primary/Secondary
 *       manager; clients/projects/servicePos/businessUnits/subBusinessUnits =
 *       only those present in those Employees' work log entries (optionally
 *       within month+year or startDate/endDate). Same access rule as the report.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ employees, clients, projects, servicePos, businessUnits, subBusinessUnits }"
 */
router.get(
  '/team-lead-employee-project-hours/filter-options',
  authenticateBase.authenticateIdentity,
  authorize(['manager.view_mapped_employees']),
  validate(teamLeadEmployeeProjectHoursFilterOptionsQuerySchema, 'query'),
  reportController.getTeamLeadEmployeeProjectHoursFilterOptions
);

router.get(
  '/team-lead-employee-project-hours',
  authenticateBase.authenticateIdentity,
  authorize(['manager.view_mapped_employees']),
  validate(teamLeadEmployeeProjectHoursQuerySchema, 'query'),
  reportController.getTeamLeadEmployeeProjectHoursReport
);

/**
 * @swagger
 * /reports/team-lead-employee-project-hours/export:
 *   get:
 *     summary: Excel export of the Team Lead Employee Project Hours report (every matching row)
 *     description: >
 *       Same access rule and filters as GET /reports/team-lead-employee-project-hours
 *       (caller's own Primary/Secondary-mapped Employees only; the Team Lead is
 *       always the authenticated caller). No page/limit/sortBy/sortOrder —
 *       returns every matching row, newest first. Columns: Employee (name +
 *       code), Client, Project, SPO (name + code), Module / Task, BU, Sub-BU,
 *       Logged Hours, Date, Description, Status.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: format, schema: { type: string, enum: [excel], default: excel } }
 *       - { in: query, name: month, schema: { type: integer }, description: With year; mutually exclusive with startDate/endDate }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: employeeIds, schema: { type: string } }
 *       - { in: query, name: clientIds, schema: { type: string } }
 *       - { in: query, name: projectIds, schema: { type: string } }
 *       - { in: query, name: servicePoIds, schema: { type: string } }
 *       - { in: query, name: buIds, schema: { type: string } }
 *       - { in: query, name: subBuIds, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string }, description: Comma-separated pending,approved,rejected,synced }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses:
 *       200:
 *         description: .xlsx attachment
 *       403:
 *         description: Caller lacks the manager.view_mapped_employees capability
 */
router.get(
  '/team-lead-employee-project-hours/export',
  authenticateBase.authenticateIdentity,
  authorize(['manager.view_mapped_employees']),
  validate(teamLeadEmployeeProjectHoursExportQuerySchema, 'query'),
  reportController.exportTeamLeadEmployeeProjectHoursReport
);

/**
 * @swagger
 * /reports/team-lead-employee-po-hours:
 *   get:
 *     summary: Team Lead Employee PO Hours — Employees (rows) x Service POs (columns) matrix
 *     description: >
 *       Employees = the caller's active Primary/Secondary manager mappings (manager_employee_mappings);
 *       the Team Lead is always the authenticated caller. Columns = every Service PO those Employees
 *       are mapped to or logged approved hours on in the period — NOT restricted by BU (Cross-BU and
 *       Centralised POs included); a PO shared by several Employees is one column. hoursBasis=original
 *       sums approved/synced work-log hours (works before any sync); hoursBasis=adjusted sums the
 *       post-sync timesheet hours and returns sync_available=false plus a message when none exist.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: month, schema: { type: integer }, description: With year; defaults to the current month when no period is sent }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: hoursBasis, schema: { type: string, enum: [original, adjusted], default: original } }
 *       - { in: query, name: employeeIds, schema: { type: string }, description: Comma-separated; only narrows the caller's own team }
 *       - { in: query, name: clientIds, schema: { type: string } }
 *       - { in: query, name: projectIds, schema: { type: string } }
 *       - { in: query, name: servicePoIds, schema: { type: string } }
 *       - { in: query, name: entityIds, schema: { type: string }, description: Filters the PO columns by the PO's Entity }
 *       - { in: query, name: buIds, schema: { type: string }, description: Filters the PO columns by the PO's BU (includes its Sub-BUs) }
 *       - { in: query, name: subBuIds, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string }, description: Employee name or code }
 *     responses:
 *       200:
 *         description: "{ period, hours_basis, sync_available, message, columns[], data[], totals }"
 *       403:
 *         description: Caller lacks the manager.view_mapped_employees capability
 */
router.get(
  '/team-lead-employee-po-hours/filter-options',
  authenticateBase.authenticateIdentity,
  authorize(['manager.view_mapped_employees']),
  validate(teamLeadEmployeePoHoursFilterOptionsQuerySchema, 'query'),
  reportController.getTeamLeadEmployeePoHoursFilterOptions
);

router.get(
  '/team-lead-employee-po-hours/export',
  authenticateBase.authenticateIdentity,
  authorize(['manager.view_mapped_employees']),
  validate(teamLeadEmployeePoHoursExportQuerySchema, 'query'),
  reportController.exportTeamLeadEmployeePoHoursReport
);

router.get(
  '/team-lead-employee-po-hours',
  authenticateBase.authenticateIdentity,
  authorize(['manager.view_mapped_employees']),
  validate(teamLeadEmployeePoHoursQuerySchema, 'query'),
  reportController.getTeamLeadEmployeePoHoursReport
);

/**
 * @swagger
 * /reports/bu-admin-employee-po-hours:
 *   get:
 *     summary: BU Admin Employee PO Hours — BU members (rows) x Service POs (columns) matrix
 *     description: >
 *       Admin / Entity Admin / BU Admin only (hierarchyRank 4 or lower, else 403). Employees = every active
 *       employee who is an active member of the caller's BU scope (the BU picked via X-Company-Id or
 *       company_id, else the caller's full reach; Sub-BUs included) — not manager mappings. Columns = every
 *       Service PO those employees are mapped to or logged approved hours on in the period, any BU; each
 *       column carries is_cross_bu (the PO has a BU, is not Centralised and its BU is outside the caller's
 *       scope) and each row employee_bu_names. Same response shape as team-lead-employee-po-hours
 *       (mapping_type is null). Sub-routes /export (xlsx) and /filter-options take the same filters.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: month, schema: { type: integer } }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: hoursBasis, schema: { type: string, enum: [original, adjusted], default: original } }
 *       - { in: query, name: employeeIds, schema: { type: string }, description: Comma-separated; narrows within the BU scope }
 *       - { in: query, name: clientIds, schema: { type: string } }
 *       - { in: query, name: projectIds, schema: { type: string } }
 *       - { in: query, name: servicePoIds, schema: { type: string } }
 *       - { in: query, name: entityIds, schema: { type: string } }
 *       - { in: query, name: buIds, schema: { type: string } }
 *       - { in: query, name: subBuIds, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: company_id, schema: { type: integer }, description: Optional BU selection (alternative to X-Company-Id) }
 *     responses:
 *       200:
 *         description: "{ period, hours_basis, sync_available, message, columns[], data[], totals }"
 *       403:
 *         description: Caller is above BU Admin level
 */
router.get(
  '/bu-admin-employee-po-hours/filter-options',
  authenticateMultiBU,
  validate(buAdminEmployeePoHoursFilterOptionsQuerySchema, 'query'),
  reportController.getBuAdminEmployeePoHoursFilterOptions
);

router.get(
  '/bu-admin-employee-po-hours/export',
  authenticateMultiBU,
  validate(buAdminEmployeePoHoursExportQuerySchema, 'query'),
  reportController.exportBuAdminEmployeePoHoursReport
);

router.get(
  '/bu-admin-employee-po-hours',
  authenticateMultiBU,
  validate(buAdminEmployeePoHoursQuerySchema, 'query'),
  reportController.getBuAdminEmployeePoHoursReport
);

/**
 * @swagger
 * /reports/project-manager-employee-po-hours:
 *   get:
 *     summary: Project Manager Employee PO Hours — the PM's PO roster (rows) x the PM's own POs (columns)
 *     description: >
 *       Employees = everyone actively mapped to a non-Centralised Service PO on which the CALLER is flagged
 *       Project Manager (the caller is always the authenticated user, never a query value). Columns = ONLY the
 *       caller's own flagged POs, each with is_cross_bu relative to the caller's BU scope; rows carry
 *       employee_bu_names. A caller with no flagged POs gets an empty matrix. Same filters, response shape,
 *       /export and /filter-options as bu-admin-employee-po-hours.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: month, schema: { type: integer } }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: startDate, schema: { type: string, format: date } }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: hoursBasis, schema: { type: string, enum: [original, adjusted], default: original } }
 *       - { in: query, name: employeeIds, schema: { type: string } }
 *       - { in: query, name: clientIds, schema: { type: string } }
 *       - { in: query, name: projectIds, schema: { type: string } }
 *       - { in: query, name: servicePoIds, schema: { type: string } }
 *       - { in: query, name: entityIds, schema: { type: string } }
 *       - { in: query, name: buIds, schema: { type: string } }
 *       - { in: query, name: subBuIds, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: company_id, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: "{ period, hours_basis, sync_available, message, columns[], data[], totals }"
 */
router.get(
  '/project-manager-employee-po-hours/filter-options',
  authenticateMultiBU,
  validate(projectManagerEmployeePoHoursFilterOptionsQuerySchema, 'query'),
  reportController.getProjectManagerEmployeePoHoursFilterOptions
);

router.get(
  '/project-manager-employee-po-hours/export',
  authenticateMultiBU,
  validate(projectManagerEmployeePoHoursExportQuerySchema, 'query'),
  reportController.exportProjectManagerEmployeePoHoursReport
);

router.get(
  '/project-manager-employee-po-hours',
  authenticateMultiBU,
  validate(projectManagerEmployeePoHoursQuerySchema, 'query'),
  reportController.getProjectManagerEmployeePoHoursReport
);

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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional, single-value (legacy). Narrows the caller's existing
 *           Business Unit scope (X-Company-Id header / role reach) to just
 *           the Companies under this Entity — intersected with, never
 *           replacing, that scope. Superseded by entityIds below; entityIds
 *           wins when both are given.
 *       - in: query
 *         name: entityIds
 *         schema: { type: string }
 *         description: >
 *           Optional. Comma-separated Entity ids (e.g. "1,4"). Same
 *           intersect-never-widen narrowing as entityId, for more than one
 *           Entity at once.
 *       - in: query
 *         name: businessUnitIds
 *         schema: { type: string }
 *         description: >
 *           Optional. Comma-separated Business Unit ids (e.g. "10,12,15").
 *           Further narrows the caller's existing BU scope (after any
 *           entityId/entityIds narrowing) — intersected with, never
 *           replacing, that scope. An id outside the caller's reach is
 *           silently dropped, never an error.
 *     responses:
 *       200:
 *         description: >
 *           Paginated monthly cost summary. `summary` totals are computed
 *           over the FULL filtered dataset (every month_year bucket matching
 *           the current filters), not just the current page.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       Employees are scoped to the caller's own Business Unit(s), but each
 *       employee's hour totals are NOT further BU-scoped — an employee
 *       resourced onto a different BU's Service PO has those hours included
 *       here too, so this reflects their true total workload rather than
 *       only the portion billed to the caller's own BU.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       total_utilization (total_hours - leaves_hours),
 *       utilization_percentage (total_utilization / monthly_capacity * 100, rounded
 *       to 2 decimals; null if monthly_capacity is unavailable),
 *       contributed_percentage (billable_total / monthly_capacity * 100, rounded
 *       to 2 decimals; null if monthly_capacity is unavailable) — what share of
 *       this employee's Monthly Capacity (e.g. 176) was billable, e.g. 150
 *       billable of a 176 capacity -> 85.23.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional, single-value (legacy). Narrows the caller's existing
 *           Business Unit scope (X-Company-Id header / role reach) to just
 *           the Companies under this Entity — intersected with, never
 *           replacing, that scope. Superseded by entityIds below; entityIds
 *           wins when both are given.
 *       - in: query
 *         name: entityIds
 *         schema: { type: string }
 *         description: Optional. Comma-separated Entity ids (e.g. "1,4"). Same intersect-never-widen narrowing as entityId, for more than one Entity at once.
 *       - in: query
 *         name: businessUnitIds
 *         schema: { type: string }
 *         description: >
 *           Optional. Comma-separated Business Unit ids (e.g. "10,12,15").
 *           Further narrows the caller's existing BU scope (after any
 *           entityId/entityIds narrowing) — intersected with, never
 *           replacing, that scope. An id outside the caller's reach is
 *           silently dropped, never an error.
 *     responses:
 *       200:
 *         description: >
 *           columns: [{ category_id, category_name, service_types: [{id, name}] }].
 *           records: employee rows — full_name, designation, total_experience,
 *           company_experience, resource_description, monthly_capacity (160),
 *           monthly_billing_capacity (160), clients (comma-separated string),
 *           hours { [service_type_id]: decimal_hours },
 *           billable_total, non_billable_total, leaves_hours, total_utilization,
 *           utilization_percentage (null if monthly_capacity is unavailable),
 *           contributed_percentage (billable_total / monthly_capacity * 100;
 *           null if monthly_capacity is unavailable).
 *           summary: totals across the FULL filtered dataset (every employee
 *           matching the current filters, not just the current page) — also
 *           carries its own aggregate contributed_percentage, computed from
 *           the summed billable_total/monthly_capacity, never by averaging
 *           each employee's own contributed_percentage.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 * /reports/resource-monthly-utilization:
 *   get:
 *     summary: Employee/resource-wise monthly utilization — Billable, Non-Billable, and Overall utilization %, each against the 176-hr monthly capacity
 *     description: >
 *       A NEW report combining the Resource Project Utilization report's
 *       employee/month/client/project/service-type filter scope with the
 *       Monthly Resource Utilization report's billable/non-billable
 *       classification and utilization formula. Does not modify either
 *       source report.
 *       Billable Utilisation % = Billable Hours / 176 × 100.
 *       Non-Billable Utilisation % = Non-Billable Hours / 176 × 100
 *       (computed independently of each other — never against Total Hours).
 *       Overall Utilisation % reuses the existing Monthly Resource
 *       Utilization report's formula unchanged: (Total Hours − Leave Hours)
 *       / 176 × 100. Summary totals are computed from aggregated hours
 *       across the full filtered result set, not by averaging per-employee
 *       percentages.
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
 *         name: clientId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *         description: Filter by Service PO (project). `projectId` is accepted as an alias.
 *       - in: query
 *         name: projectId
 *         schema: { type: integer }
 *         description: Alias for poId.
 *       - in: query
 *         name: serviceTypeId
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
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional, single-value (legacy). Narrows the caller's existing
 *           Business Unit scope (X-Company-Id header / role reach) to just
 *           the Companies under this Entity — intersected with, never
 *           replacing, that scope. Superseded by entityIds below; entityIds
 *           wins when both are given.
 *       - in: query
 *         name: entityIds
 *         schema: { type: string }
 *         description: >
 *           Optional. Comma-separated Entity ids (e.g. "1,4"). Same
 *           intersect-never-widen narrowing as entityId, for more than one
 *           Entity at once.
 *       - in: query
 *         name: businessUnitIds
 *         schema: { type: string }
 *         description: >
 *           Optional. Comma-separated Business Unit ids (e.g. "10,12,15").
 *           Further narrows the caller's existing BU scope (after any
 *           entityId/entityIds narrowing) — intersected with, never
 *           replacing, that scope. An id outside the caller's reach is
 *           silently dropped, never an error.
 *     responses:
 *       200:
 *         description: >
 *           Paginated employee rows — employeeId, employeeCode, employeeName,
 *           month, year, billableHours, nonBillableHours, totalHours,
 *           billableUtilizationPercentage, nonBillableUtilizationPercentage,
 *           overallUtilizationPercentage. summary carries the same fields
 *           aggregated across the full filtered result set (every employee
 *           matching the current filters, not just the current page).
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Validation error – month and year are required
 */
router.get(
  '/resource-monthly-utilization',
  authenticateMultiBU,
  reportController.getResourceMonthlyUtilization
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *         schema: { type: string, enum: [total_cost, total_hours, original_total_hours, average_cost_per_hour, total_projects, percentage_of_total_cost] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *         schema: { type: string, enum: [bench_pct, bench_hours, total_hours, original_bench_pct, original_bench_hours, original_total_hours] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *         schema: { type: string, enum: [utilization_percentage, total_hours, billable_hours, full_name, original_utilization_percentage, original_total_hours, original_billable_hours] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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
 *         schema: { type: string, enum: [total_hours, original_total_hours, cost_budget] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: entityId
 *         schema: { type: integer }
 *         description: >
 *           Optional. Narrows the caller's existing Business Unit scope
 *           (X-Company-Id header / role reach) to just the Companies under
 *           this Entity — intersected with, never replacing, that scope.
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

/**
 * @swagger
 * /reports/bu-wise-utilisation:
 *   get:
 *     summary: BU-wise Utilisation — one row per Business Unit
 *     description: >
 *       BU name, total employees in the BU, Expected Hrs (employees x 176),
 *       Billable, Non-Billable (Leave / On Bench / Idle excluded), Customer
 *       Non-Billable, Total Logged (the sum of those three) and Utilisation %
 *       (Total Logged / Expected x 100). Admin sees every BU; a BU Admin sees
 *       only the BUs they are mapped to. Rows are the BUs inside the caller's
 *       reach, so a BU with no logged hours still appears with zeros.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: month, schema: { type: integer, minimum: 1, maximum: 12 }, description: "Default = current month. Ignored when startDate/endDate are given." }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: startDate, schema: { type: string, format: date }, description: "Use with endDate instead of month/year. Capacity (176) scales by the months spanned." }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: entityIds, schema: { type: string }, description: "Comma-separated. Narrows (never widens) the caller's BU reach." }
 *       - { in: query, name: businessUnitIds, schema: { type: string }, description: "Comma-separated. Also matches Sub-BUs." }
 *       - { in: query, name: employeeIds, schema: { type: string }, description: "Comma-separated (alias employeeId)." }
 *       - { in: query, name: clientIds, schema: { type: string }, description: "Comma-separated (alias clientId)." }
 *       - { in: query, name: projectIds, schema: { type: string }, description: "Comma-separated Service PO ids (aliases poId, projectId)." }
 *       - { in: query, name: serviceTypeIds, schema: { type: string }, description: "Comma-separated (alias serviceTypeId)." }
 *       - { in: query, name: hoursSource, schema: { type: string, enum: [O] }, description: "O = original logged hours; default = adjusted (after sync) hours." }
 *       - { in: query, name: groupBy, schema: { type: string, enum: [hierarchy, bu] }, description: "hierarchy = one row per top-level BU (its Sub-BUs rolled up, employees counted once) carrying its Sub-BU rows as subBus[] (plus an isDirect child for the BU's own level when it has data); bu = just the rolled-up BU rows; omitted = flat one-row-per-company layout. Pagination/sort/search/summary work on the BU rows. Inactive BUs / Sub-BUs are never returned." }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: [ASC, DESC] } }
 *       - { in: query, name: search, schema: { type: string }, description: "BU name" }
 *       - { in: query, name: sortBy, schema: { type: string, enum: [buName, employeeCount, expectedHours, billableHours, nonBillableHours, customerNonBillableHours, totalLoggedHours, utilizationPercentage] } }
 *     responses:
 *       200:
 *         description: Paginated BU rows plus a full-dataset summary
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Invalid period
 */
router.get(
  '/bu-wise-utilisation',
  authenticateMultiBU,
  utilisationReportController.getBuWiseUtilisation
);

/**
 * @swagger
 * /reports/employee-project-utilisation:
 *   get:
 *     summary: Employee x Project Utilisation — original vs after-sync hours
 *     description: >
 *       One row per Employee and Project (Service PO): Logged Hrs (original),
 *       Adjusted Hrs (after sync), Original Utilisation % (the Employee's
 *       total logged hours / 176 x 100) and Total Utilisation % after sync
 *       (the Employee's total adjusted hours / 176 x 100). The two % values are
 *       the Employee's whole-period totals, so they repeat on each of their
 *       project rows and are not changed by the project/client/service-type
 *       filters.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: month, schema: { type: integer, minimum: 1, maximum: 12 }, description: "Default = current month. Ignored when startDate/endDate are given." }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: startDate, schema: { type: string, format: date }, description: "Use with endDate instead of month/year. Capacity (176) scales by the months spanned." }
 *       - { in: query, name: endDate, schema: { type: string, format: date } }
 *       - { in: query, name: entityIds, schema: { type: string }, description: "Comma-separated. Narrows (never widens) the caller's BU reach." }
 *       - { in: query, name: businessUnitIds, schema: { type: string }, description: "Comma-separated. Also matches Sub-BUs." }
 *       - { in: query, name: employeeIds, schema: { type: string }, description: "Comma-separated (alias employeeId)." }
 *       - { in: query, name: clientIds, schema: { type: string }, description: "Comma-separated (alias clientId)." }
 *       - { in: query, name: projectIds, schema: { type: string }, description: "Comma-separated Service PO ids (aliases poId, projectId)." }
 *       - { in: query, name: serviceTypeIds, schema: { type: string }, description: "Comma-separated (alias serviceTypeId)." }
 *       - { in: query, name: hoursSource, schema: { type: string, enum: [O] }, description: "O = original logged hours; default = adjusted (after sync) hours." }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: [ASC, DESC] } }
 *       - { in: query, name: categoryIds, schema: { type: string }, description: "Comma-separated service category ids (alias categoryId)." }
 *       - { in: query, name: search, schema: { type: string }, description: "Employee name / code / project name" }
 *       - { in: query, name: sortBy, schema: { type: string, enum: [employeeName, employeeCode, projectName, loggedHours, adjustedHours, originalUtilizationPercentage, totalUtilizationPercentage] } }
 *     responses:
 *       200:
 *         description: Paginated Employee x Project rows plus a full-dataset summary
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Invalid period
 */
router.get(
  '/employee-project-utilisation',
  authenticateMultiBU,
  utilisationReportController.getEmployeeProjectUtilisation
);

module.exports = router;
