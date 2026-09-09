'use strict';

/**
 * @swagger
 * tags:
 *   name: My Team
 *   description: >
 *     Manager only. Own delegated Employees + granted Service POs, and
 *     assigning a granted Service PO to one of their own Employees
 *     (reuses the existing EmployeeServicePOMapping engine unmodified,
 *     scoped by manager_employee_mappings/manager_servicepo_mappings).
 *     Managers must NOT be able to map another Manager's Employees.
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const resolveMyTeamBusinessUnitScope = require('../middlewares/resolveMyTeamBusinessUnitScope');
const authorize = require('../middlewares/authorize');
const { validate } = require('../middlewares/validateRequest');
const { handleManagerWorkLogUpload } = require('../middlewares/upload');
const { importLimiter } = require('../middlewares/rateLimiters');
const {
  assignServicePOSchema,
  mapEmployeeSchema,
  listMyEmployeesQuerySchema,
  listMyTeamTimesheetsQuerySchema,
  approvalSummaryQuerySchema,
  bulkApproveTimesheetsSchema,
  rejectWorkLogSchema,
} = require('../validations/managerSelfServiceValidation');
const {
  submitManagerMonthlyWorkLogSchema,
  monthYearQuerySchema,
} = require('../validations/managerMonthlyWorkLogValidation');
const controller = require('../controllers/managerSelfServiceController');
const monthlyWorkLogController = require('../controllers/managerMonthlyWorkLogController');

/**
 * @swagger
 * /my-team/employees:
 *   get:
 *     summary: List the calling Manager's own delegated Employees
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Company-Id
 *         schema: { type: integer }
 *         description: Optional Business Unit filter. Omit to return all accessible Business Units.
 *       - in: query
 *         name: business_unit_id
 *         schema: { type: integer }
 *         description: Optional Business Unit filter. Takes precedence over X-Company-Id.
 *     responses:
 *       200:
 *         description: My Employees list, including each Employee's active business_unit_ids and manager mapping_type
 */
router.get(
  '/employees',
  authenticate.authenticateIdentity,
  validate(listMyEmployeesQuerySchema, 'query'),
  resolveMyTeamBusinessUnitScope,
  authorize('manager.view_mapped_employees'),
  controller.getMyEmployees
);

/**
 * @swagger
 * /my-team/timesheets:
 *   get:
 *     summary: >
 *       The calling Manager's own COMPLETE timesheet (default), or one of
 *       their mapped Employees' complete timesheet when employee_id is
 *       given. "Complete" = every Service PO/hierarchy-node entry that
 *       employee has, regardless of which Service PO the Manager
 *       themselves is granted — Service PO mapping is never used to
 *       restrict this. employee_id is re-validated against the caller's
 *       own mapped Employees (Primary or Secondary) server-side; a
 *       non-mapped id is rejected, never trusted from the request alone.
 *       Single unified source (employee_work_logs) — every lifecycle stage
 *       (pending/approved/synced) returns in ONE `data` array with the same
 *       record shape; there is no separate drafts collection.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: employee_id
 *         schema: { type: integer }
 *         description: Omit for "My Timesheet". Must be one of the caller's mapped Employees.
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: >
 *           Paginated employee_work_logs list. Every record shares the same
 *           shape regardless of status; `approval_status` mirrors the raw
 *           `status` column (pending/approved/synced).
 *       403:
 *         description: employee_id is not one of the caller's mapped Employees
 */
router.get(
  '/timesheets',
  authenticate,
  authorize('manager.view_mapped_employees'),
  validate(listMyTeamTimesheetsQuerySchema, 'query'),
  controller.getTimesheets
);

/**
 * @swagger
 * /my-team/timesheets/approval-summary:
 *   get:
 *     summary: >
 *       Day-level (default) or month-level approval units for the calling
 *       Manager's own or one mapped Employee's OFFICIAL timesheet data
 *       only — never employee_work_logs drafts. Each bucket sums every
 *       Service PO/Parent/Child/hierarchy-node row for that
 *       employee+date (daily) or employee+month (monthly) into ONE
 *       approval unit, per the Daily/Monthly Approval requirement — a
 *       Manager approves a whole day (or month) at once, never one row
 *       per Service PO. For an Employee whose is_timesheet_approval_required
 *       is false, every bucket is already 'approved' (that policy already
 *       force-publishes their rows at creation/sync time — see
 *       timesheetPublishPolicy.js), so nothing ever appears pending for
 *       them here. Drill into one bucket's underlying rows via the
 *       existing GET /my-team/timesheets?employee_id=X&startDate=...&endDate=...
 *       narrowed to that date (or month) — no separate details endpoint.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: employee_id
 *         schema: { type: integer }
 *         description: Omit for "My Timesheet". Must be one of the caller's mapped Employees.
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: log_type
 *         schema: { type: string, enum: [daily, monthly], default: daily }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated daily or monthly approval buckets, each with status 'pending' | 'approved'
 *       403:
 *         description: employee_id is not one of the caller's mapped Employees
 */
router.get(
  '/timesheets/approval-summary',
  authenticate,
  authorize('manager.view_mapped_employees'),
  validate(approvalSummaryQuerySchema, 'query'),
  controller.getApprovalSummary
);

/**
 * @swagger
 * /my-team/timesheets/{id}/approve:
 *   put:
 *     summary: >
 *       Approve ONE pending Employee Work Log entry belonging to one of the
 *       calling Manager's own mapped Employees — the same
 *       `employee_work_logs` id space {id}/reject below uses (this is NOT
 *       an official-Timesheet id; the entry needn't be synced yet).
 *       Symmetric with reject: same table, same ownership check, same
 *       pending-only guard.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Work log entry approved (status set to 'approved')
 *       403:
 *         description: This entry's Employee is not mapped to the caller
 *       404:
 *         description: Not found
 *       409:
 *         description: Entry is not currently pending
 */
router.put(
  '/timesheets/:id/approve',
  authenticate,
  authorize('manager.approve_timesheets'),
  controller.approveTimesheet
);

/**
 * @swagger
 * /my-team/timesheets/{id}/reject:
 *   put:
 *     summary: >
 *       Reject one pending Employee Work Log entry belonging to one of the
 *       calling Manager's own mapped Employees. A remark is mandatory.
 *       Only a currently-'pending' entry can be rejected; the Employee can
 *       then Resubmit it (back to 'pending') or delete it.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [remark]
 *             properties:
 *               remark: { type: string, example: "Hours entered do not match the project activity." }
 *     responses:
 *       200:
 *         description: Work log entry rejected (status set to 'rejected', remark stored)
 *       403:
 *         description: This entry's Employee is not mapped to the caller
 *       404:
 *         description: Not found
 *       409:
 *         description: Entry is not currently pending
 *       422:
 *         description: remark is missing or empty
 */
router.put(
  '/timesheets/:id/reject',
  authenticate,
  authorize('manager.approve_timesheets'),
  validate(rejectWorkLogSchema),
  controller.rejectWorkLogEntry
);

/**
 * @swagger
 * /my-team/timesheets/approve:
 *   post:
 *     summary: >
 *       Bulk-approve one Employee's OFFICIAL timesheet data across several
 *       dates (daily) or several months (monthly) at once — provide
 *       exactly one of "dates"/"months". Only currently-pending
 *       (is_publish=false) rows are touched; a date/month with nothing
 *       pending is a harmless no-op, not an error.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employee_id]
 *             properties:
 *               employee_id: { type: integer }
 *               dates:
 *                 type: array
 *                 items: { type: string, format: date }
 *                 example: ["2026-08-04", "2026-08-06", "2026-08-07"]
 *               months:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     month: { type: integer, minimum: 1, maximum: 12 }
 *                     year: { type: integer }
 *                 example: [{ "month": 7, "year": 2026 }]
 *     responses:
 *       200:
 *         description: Approval summary — which dates/months were approved and how many rows each affected
 *       403:
 *         description: employee_id is not one of the caller's mapped Employees
 *       422:
 *         description: Neither or both of dates/months were provided
 */
router.post(
  '/timesheets/approve',
  authenticate,
  authorize('manager.approve_timesheets'),
  validate(bulkApproveTimesheetsSchema),
  controller.bulkApproveTimesheets
);

/**
 * @swagger
 * /my-team/service-pos:
 *   get:
 *     summary: List the Service POs granted to the calling Manager
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Granted Service PO list
 */
router.get(
  '/service-pos',
  authenticate,
  authorize('manager.map_servicepos'),
  controller.getMyServicePOs
);

/**
 * @swagger
 * /my-team/employees/{employeeId}/service-pos:
 *   get:
 *     summary: List the Service POs currently assigned to one of my own Employees
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Employee's assigned Service PO list
 *       403:
 *         description: Not one of my Employees
 */
router.get(
  '/employees/:employeeId/service-pos',
  authenticate,
  authorize('manager.map_servicepos'),
  controller.getEmployeeServicePOs
);

/**
 * @swagger
 * /my-team/employees/{employeeId}/service-pos:
 *   post:
 *     summary: Assign a granted Service PO to one of my own Employees
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_id]
 *             properties:
 *               service_po_id: { type: integer }
 *     responses:
 *       201:
 *         description: Service PO assigned
 *       403:
 *         description: Not one of my Employees, or Service PO not granted to me
 *       409:
 *         description: Already assigned
 */
router.post(
  '/employees/:employeeId/service-pos',
  authenticate,
  authorize('manager.map_servicepos'),
  validate(assignServicePOSchema),
  controller.assignServicePO
);

/**
 * @swagger
 * /my-team/employees/{employeeId}/service-pos/{servicePOId}:
 *   delete:
 *     summary: Remove a Service PO assignment from one of my own Employees
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: servicePOId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Removed
 *       403:
 *         description: Not one of my Employees
 */
router.delete(
  '/employees/:employeeId/service-pos/:servicePOId',
  authenticate,
  authorize('manager.map_servicepos'),
  controller.removeServicePO
);

/**
 * @swagger
 * /my-team/monthly-worklog/bulk-upload:
 *   post:
 *     summary: >
 *       Bulk-upload the Monthly Work Log for several Employees at once from
 *       an Excel/CSV file, for one month. Columns: Employee Code, Employee
 *       Name, Service PO Name, Hours, Description (optional) — all but
 *       Description are required. Validated in two GLOBAL gates across the
 *       whole file before anything is inserted: (1) every row's Employee
 *       Code must belong to an active Employee this Manager is the PRIMARY
 *       Manager of — stricter than the manual form, which also allows
 *       Secondary; (2) every row's Service PO Name must be one of that
 *       Employee's actively-mapped Service POs (Main PO only, same as the
 *       manual form). If ANY row fails a gate, the ENTIRE file is rejected
 *       and nothing is written — this is not a partial "skip bad rows"
 *       import. Once both gates pass for every row, rows are grouped by
 *       Employee and REPLACE-SAVEd (176-hour cap enforced per Employee),
 *       auto-approved, exactly like the manual form.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, month, year]
 *             properties:
 *               file: { type: string, format: binary }
 *               month: { type: integer }
 *               year: { type: integer }
 *     responses:
 *       200:
 *         description: >
 *           { month, year, employees_processed, total_rows, results: [{
 *           employee_id, employee_code, entry_count }] } — every row
 *           inserted directly as 'approved'.
 *       400:
 *         description: No file attached, unreadable file, or no data rows
 *       422:
 *         description: >
 *           { success: false, message, phase: 'format'|'ownership'|'service_po',
 *           errors: [{ row, errors: string[] }] } — the whole file was
 *           rejected; nothing was written.
 */
router.post(
  '/monthly-worklog/bulk-upload',
  authenticate,
  authorize('manager.fill_worklog'),
  importLimiter,
  handleManagerWorkLogUpload,
  monthlyWorkLogController.bulkUpload
);

/**
 * @swagger
 * /my-team/employees/{employeeId}/monthly-worklog:
 *   get:
 *     summary: >
 *       Fetch the Monthly Work Log for one of my own mapped Employees, for
 *       one month, plus eligibility. Same shape as Employee self-service's
 *       GET /employee-timesheets/monthly.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: >
 *           { month, year, work_date, eligible, service_pos: [...] } — same
 *           Service PO hierarchy shape Daily/Monthly use elsewhere.
 *       403:
 *         description: Not one of my mapped Employees
 */
router.get(
  '/employees/:employeeId/monthly-worklog',
  authenticate,
  authorize('manager.fill_worklog'),
  validate(monthYearQuerySchema, 'query'),
  monthlyWorkLogController.getMonthly
);

/**
 * @swagger
 * /my-team/employees/{employeeId}/monthly-worklog:
 *   post:
 *     summary: >
 *       Fill in (create) the Monthly Work Log for one of my own mapped
 *       Employees, for one month. Every entry is inserted directly as
 *       'approved' — a Manager-filled entry never goes through the
 *       pending/approve workflow. Restricted to the Employee's Main PO only
 *       (hierarchy_node_id is not accepted here — may be supported in a
 *       future release). Deletes every existing entry (Daily or Monthly)
 *       for that month before inserting, same REPLACE-SAVE semantics as
 *       Employee self-service's Monthly Work Log.
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [month, year, entries]
 *             properties:
 *               month: { type: integer }
 *               year: { type: integer }
 *               entries:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [service_po_id, hours, description]
 *                   properties:
 *                     service_po_id: { type: integer }
 *                     sub_project_id: { type: integer }
 *                     hours: { type: number }
 *                     description: { type: string }
 *     responses:
 *       200:
 *         description: The month's Monthly Work Log after the save, already approved
 *       400:
 *         description: 176-hour cap exceeded, duplicate service_po_id in the same request, or a hierarchy_node_id was supplied
 *       403:
 *         description: Not one of my mapped Employees, or a Service PO in the payload is not mapped to this Employee
 *       422:
 *         description: Selected month is not yet eligible for Monthly Work Log
 */
router.post(
  '/employees/:employeeId/monthly-worklog',
  authenticate,
  authorize('manager.fill_worklog'),
  validate(submitManagerMonthlyWorkLogSchema),
  monthlyWorkLogController.submitMonthly
);

/**
 * @swagger
 * /my-team/employees/{employeeId}/monthly-worklog:
 *   put:
 *     summary: Edit the existing Monthly Work Log I filled in for this Employee (same as POST — upsert)
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: The month's Monthly Work Log after the save, already approved
 */
router.put(
  '/employees/:employeeId/monthly-worklog',
  authenticate,
  authorize('manager.fill_worklog'),
  validate(submitManagerMonthlyWorkLogSchema),
  monthlyWorkLogController.submitMonthly
);

/**
 * @swagger
 * /my-team/employees/{employeeId}/monthly-worklog:
 *   delete:
 *     summary: Delete the Monthly Work Log I filled in for this Employee, for one month
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Monthly work log deleted
 *       403:
 *         description: Not one of my mapped Employees
 */
router.delete(
  '/employees/:employeeId/monthly-worklog',
  authenticate,
  authorize('manager.fill_worklog'),
  validate(monthYearQuerySchema, 'query'),
  monthlyWorkLogController.deleteMonthly
);

/**
 * @swagger
 * /my-team/employees:
 *   post:
 *     summary: Map an Employee to myself as their Secondary Manager
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employee_id]
 *             properties:
 *               employee_id: { type: integer }
 *     responses:
 *       201:
 *         description: Employee mapped
 *       404:
 *         description: Employee not found
 *       409:
 *         description: Employee already has a different Secondary Manager
 */
router.post(
  '/employees',
  authenticate,
  authorize('manager.map_employees'),
  validate(mapEmployeeSchema),
  controller.mapEmployee
);

/**
 * @swagger
 * /my-team/employees/{employeeId}:
 *   delete:
 *     summary: Remove my own Manager mapping (Primary or Secondary) to an Employee
 *     tags: [My Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Removed
 *       404:
 *         description: Not one of my mapped Employees
 */
router.delete(
  '/employees/:employeeId',
  authenticate,
  authorize('manager.map_employees'),
  controller.unmapEmployee
);

module.exports = router;
