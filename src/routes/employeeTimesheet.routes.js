'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const requireCompanyScope = require('../middlewares/requireCompanyScope');
const { validate } = require('../middlewares/validateRequest');
const {
  replaceDailyEntriesSchema,
  updateEntrySchema,
  addTimeEntriesSchema,
  monthYearQuerySchema,
  monthlySummaryQuerySchema,
  dailyQuerySchema,
  listEntriesQuerySchema,
} = require('../validations/employeeTimesheetValidation');
const controller = require('../controllers/employeeTimesheetController');

/**
 * @swagger
 * tags:
 *   name: Employee Timesheet
 *   description: >
 *     Employee Self Timesheet module — an Employee manages only their own
 *     entries, against Service POs they are mapped to. Requires an Employee
 *     access token (issued by the dynamic /auth/login), never the User token.
 *     These entries are stored in `employee_work_logs` (a draft table) and
 *     never directly in the official `timesheets` table — an Admin must run
 *     "Sync Employee Work Logs" on the Admin Timesheet page before an entry
 *     becomes part of the official Timesheet / Admin Reports.
 */

/**
 * @swagger
 * /employee-timesheets/calendar:
 *   get:
 *     summary: Calendar summary for one month (date, totalHours, hasEntries, futureDisabled)
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
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
 *         description: Calendar summary
 */
router.get(
  '/calendar',
  authenticate,
  requireCompanyScope,
  authorize('employee.view_timesheet'),
  validate(monthYearQuerySchema, 'query'),
  controller.getCalendar
);

/**
 * @swagger
 * /employee-timesheets/daily:
 *   get:
 *     summary: Service PO -> Parent -> Child hierarchy with hours-per-node, for one date
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         required: true
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: >
 *           { date, service_pos: [{ service_po_id, service_po_name, hours,
 *           po_total_hrs, children: [{ hierarchy_id, name, type, hours,
 *           children? }] }] } — same schema as one entry of the Monthly
 *           Summary array, so the frontend can reuse one rendering component
 *           for both.
 */
router.get(
  '/daily',
  authenticate,
  requireCompanyScope,
  authorize('employee.view_timesheet'),
  validate(dailyQuerySchema, 'query'),
  controller.getDaily
);

/**
 * @swagger
 * /employee-timesheets/monthly-summary:
 *   get:
 *     summary: Monthly summary — per-date hierarchy breakdown (default) or aggregated Service PO totals
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: month
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: viewType
 *         required: false
 *         schema: { type: string, enum: [day, month], default: day }
 *         description: >
 *           'day' (default) — unchanged existing response. 'month' —
 *           aggregated Service PO totals for the whole month, no dates.
 *     responses:
 *       200:
 *         description: >
 *           viewType=day (default): array of { date, service_pos: [{ service_po_id,
 *           service_po_name, hours, po_total_hrs, children: [...] }] } — one
 *           entry per calendar date, unchanged from before.
 *           viewType=month: { service_pos: [{ service_po_id, service_po_name,
 *           hours }], total_hours } — one row per Service PO with hours
 *           logged this month (zero-hour POs omitted), plus the month's total.
 */
router.get(
  '/monthly-summary',
  authenticate,
  requireCompanyScope,
  authorize('employee.view_timesheet'),
  validate(monthlySummaryQuerySchema, 'query'),
  controller.getMonthlySummary
);

/**
 * @swagger
 * /employee-timesheets/projects:
 *   get:
 *     summary: Service POs mapped to the logged-in employee (Project Loading)
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Mapped project list
 */
router.get(
  '/projects',
  authenticate,
  requireCompanyScope,
  authorize('employee.view_timesheet'),
  controller.getProjects
);

/**
 * @swagger
 * /employee-timesheets/entries:
 *   get:
 *     summary: >
 *       Flat list of the caller's own work log entries — id, status
 *       (pending/approved/rejected/synced), and (for rejected rows)
 *       rejection_remark/rejected_by_name/rejected_at. Backs the Employee
 *       Work Log list/history view and is how the Employee discovers a
 *       rejected entry's id for Resubmit/Delete.
 *     tags: [Employee Timesheet]
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
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected, synced] }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated list of the caller's own work log entries
 */
router.get(
  '/entries',
  authenticate,
  requireCompanyScope,
  authorize('employee.view_timesheet'),
  validate(listEntriesQuerySchema, 'query'),
  controller.getEntries
);

/**
 * @swagger
 * /employee-timesheets/entries:
 *   post:
 *     summary: >
 *       REPLACE SAVE the employee's complete set of timesheet entries for
 *       one date. Deletes every existing entry for (employee, date) and
 *       reinserts exactly the given `entries` list, in one transaction —
 *       never a duplicate-entry error. Pass an empty `entries` array to
 *       clear the date entirely.
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [timesheet_date, entries]
 *             properties:
 *               timesheet_date: { type: string, format: date }
 *               entries:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [service_po_id, hours, description]
 *                   properties:
 *                     service_po_id: { type: integer }
 *                     sub_project_id: { type: integer }
 *                     hierarchy_node_id: { type: integer }
 *                     hours: { type: number }
 *                     description: { type: string }
 *     responses:
 *       200:
 *         description: The date's entries after the replace (array)
 *       400:
 *         description: Future date, daily hour cap exceeded, or duplicate (service_po_id, hierarchy_node_id) within the payload
 *       403:
 *         description: A Service PO in the payload is not mapped to this employee
 *       422:
 *         description: Validation error
 */
router.post(
  '/entries',
  authenticate,
  requireCompanyScope,
  authorize('employee.fill_worklog'),
  validate(replaceDailyEntriesSchema),
  controller.createEntry
);

/**
 * @swagger
 * /employee-timesheets/entries/{id}:
 *   put:
 *     summary: Update the employee's own timesheet entry
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entry updated
 *       404:
 *         description: Not found (or not owned by this employee)
 */
router.put(
  '/entries/:id',
  authenticate,
  requireCompanyScope,
  authorize('employee.fill_worklog'),
  validate(updateEntrySchema),
  controller.updateEntry
);

/**
 * @swagger
 * /employee-timesheets/time-entries:
 *   post:
 *     summary: >
 *       The dedicated Time Entry form. ADDS the given Start Time/End Time
 *       segments to whatever this Module/Task (service_po_id +
 *       hierarchy_node_id) already has logged for this date — it never
 *       replaces or requires resending segments saved by an earlier call
 *       (this endpoint, or a previous session). Find-or-creates the
 *       underlying work log entry: if this is the first time this
 *       Module/Task is logged on this date, `description` is required and a
 *       new entry is created; if an entry already exists, only the new
 *       segments are inserted and `hours` becomes the old total plus the new
 *       segments' total. Overlap is checked against the FULL combined set
 *       (already-saved + new), not just the segments in this request.
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [work_date, service_po_id, time_entries]
 *             properties:
 *               work_date: { type: string, format: date }
 *               service_po_id: { type: integer }
 *               sub_project_id: { type: integer, nullable: true }
 *               hierarchy_node_id: { type: integer, nullable: true }
 *               time_entries:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [start_time, end_time]
 *                   properties:
 *                     start_time: { type: string, example: "09:30" }
 *                     end_time: { type: string, example: "10:20" }
 *               description: { type: string, description: "Required only when no entry exists yet for this Module/Task/date" }
 *     responses:
 *       200:
 *         description: Entry after the add — includes the FULL time_entries breakdown (old + new)
 *       400:
 *         description: Overlapping segments, missing description on first log, or over the 12-hour/day cap
 */
router.post(
  '/time-entries',
  authenticate,
  requireCompanyScope,
  authorize('employee.fill_worklog'),
  validate(addTimeEntriesSchema),
  controller.addTimeEntries
);

/**
 * @swagger
 * /employee-timesheets/entries/{id}/resubmit:
 *   put:
 *     summary: >
 *       Resubmit a rejected work log entry — the only way to move
 *       REJECTED -> PENDING. No request body: the backend always sets
 *       status to 'pending' itself, never accepting a caller-supplied
 *       status. Re-runs the same business validations (project mapping,
 *       PO/sub-project eligibility, hierarchy node ownership, 12-hour/day
 *       cap, Daily/Monthly exclusion) a fresh submission would.
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entry resubmitted (status set to 'pending')
 *       404:
 *         description: Not found (or not owned by this employee)
 *       409:
 *         description: Entry is not currently rejected
 */
router.put(
  '/entries/:id/resubmit',
  authenticate,
  requireCompanyScope,
  authorize('employee.fill_worklog'),
  controller.resubmitEntry
);

/**
 * @swagger
 * /employee-timesheets/entries/{id}:
 *   delete:
 *     summary: Delete the employee's own timesheet entry
 *     tags: [Employee Timesheet]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entry deleted
 *       404:
 *         description: Not found (or not owned by this employee)
 */
router.delete(
  '/entries/:id',
  authenticate,
  requireCompanyScope,
  authorize('employee.fill_worklog'),
  controller.deleteEntry
);

module.exports = router;
