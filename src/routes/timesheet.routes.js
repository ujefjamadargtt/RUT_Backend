'use strict';

const express = require('express');
const router = express.Router();

const authenticateBase = require('../middlewares/auth');
const resolveCompanyContextForCompanyLessActors = require('../middlewares/resolveCompanyContextForCompanyLessActors');
const authenticateReadMultiBU = require('../middlewares/authenticateReadMultiBU');
// Admin/Entity Admin (ranks 2-3) have no single req.companyId from
// authenticateBase alone — this module's controllers all read req.companyId
// directly, so every route here resolves ONE Business Unit context for them
// too (see resolveCompanyContextForCompanyLessActors.js for the contract).
const authenticate = [authenticateBase, resolveCompanyContextForCompanyLessActors];
const { validate } = require('../middlewares/validateRequest');
const { handleTimesheetUpload } = require('../middlewares/upload');
const { importLimiter } = require('../middlewares/rateLimiters');
const timesheetController = require('../controllers/timesheetController');
const {
  createTimesheetSchema,
  updateTimesheetSchema,
  updateModifiedHoursSchema,
  bulkUpdateImportHoursSchema,
  bulkIdsSchema,
  listTimesheetsQuerySchema,
} = require('../validations/timesheetValidation');

/**
 * @swagger
 * tags:
 *   - name: Timesheets
 *     description: Timesheet entry management
 *   - name: Timesheet Import
 *     description: Excel / CSV bulk import with preview and confirm flow
 */

// ─────────────────────────────────────────────────────────────────────────────
// Import Routes  (must be declared BEFORE /:id to avoid route shadowing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /timesheets/import/history:
 *   get:
 *     summary: List all timesheet import history records
 *     tags: [Timesheet Import]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Filter to imports whose import_month matches
 *       - in: query
 *         name: year
 *         schema: { type: integer }
 *         description: Filter to imports whose import_year matches
 *       - in: query
 *         name: company_id
 *         schema: { type: integer }
 *         description: >
 *           Narrow to one specific Business Unit, validated against the
 *           caller's own reach. Omit to see every Business Unit the caller
 *           can reach at once (never a single frozen/wrong BU, never empty).
 *     responses:
 *       200:
 *         description: >
 *           Paginated list of import history records. Each record includes
 *           total_employees — the count of distinct employees covered by that
 *           import batch.
 *       401:
 *         description: Unauthorized
 */
// A missing X-Company-Id/company_id resolves to every Business Unit the
// caller can reach (never a single frozen one, never empty) — same
// "authenticateReadMultiBU" contract already used by /reports and
// /management-reports (see that middleware's doc comment). An explicit
// `company_id` query param narrows to just that one BU, validated against
// the caller's own reach. This is a GET-only list endpoint — every other
// route in this file still needs exactly one target BU and stays on the
// plain `authenticate` chain above.
router.get(
  '/import/history',
  authenticateReadMultiBU,
  timesheetController.getHistory
);

/**
 * @swagger
 * /timesheets/import/{id}:
 *   get:
 *     summary: Get a single import history record with its error rows
 *     tags: [Timesheet Import]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Import record including all error rows
 *       404:
 *         description: Import record not found
 */
router.get(
  '/import/:id',
  authenticate,
  timesheetController.getImportById
);

/**
 * @swagger
 * /timesheets/import/{id}/rows:
 *   get:
 *     summary: Get all timesheet rows created by a specific import
 *     tags: [Timesheet Import]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of timesheet rows for the import
 */
router.get(
  '/import/:id/rows',
  authenticate,
  timesheetController.getImportRows
);

/**
 * @swagger
 * /timesheets/import:
 *   delete:
 *     summary: Delete one or more monthly sheets (timesheet import batches)
 *     description: >
 *       Deletes one or more timesheet_import_history records in a single call.
 *       Pass a single-element ids array to delete just one sheet, or several IDs
 *       to delete many at once. For every import this removes the child timesheet
 *       rows created by that import, the child error rows, the import history
 *       record itself, and the originally uploaded file from disk.
 *     tags: [Timesheet Import]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *                 description: One or more import history IDs to delete
 *     responses:
 *       200:
 *         description: Sheet(s) and their child rows deleted successfully
 *       404:
 *         description: No matching import record(s) found
 *       422:
 *         description: ids missing or invalid
 */
router.delete(
  '/import',
  authenticate,
  validate(bulkIdsSchema, 'body'),
  timesheetController.deleteImports
);

/**
 * @swagger
 * /timesheets/upload:
 *   post:
 *     summary: Upload a timesheet Excel or CSV file for preview
 *     description: >
 *       Parses the uploaded file, validates every row, persists an import history
 *       record with status=pending, and returns a preview of valid rows and errors.
 *       Call POST /confirm/{importId} to commit the valid rows.
 *     tags: [Timesheet Import]
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
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: .xlsx or .csv file (max 10 MB)
 *               month:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 12
 *                 description: Month the timesheet covers (1–12)
 *               year:
 *                 type: integer
 *                 minimum: 2000
 *                 description: Year the timesheet covers (e.g. 2025)
 *     responses:
 *       200:
 *         description: Preview data with valid rows, error rows, and importId
 *       400:
 *         description: No file uploaded or invalid file type
 *       403:
 *         description: Forbidden — Finance or HR role required
 *       422:
 *         description: File could not be parsed, or month/year is missing or invalid
 */
router.post(
  '/upload',
  authenticate,
  importLimiter,
  handleTimesheetUpload,
  timesheetController.upload
);

/**
 * @swagger
 * /timesheets/sync-employee-worklogs:
 *   post:
 *     summary: Sync Employee Work Logs — pull employee-entered work logs for one month and preview an import
 *     description: >
 *       Reads every 'pending' row from the employee_work_logs table
 *       (Employee Self Timesheet module — never from `timesheets`) for the
 *       selected month/year and runs them through the exact same preview
 *       pipeline as an Excel upload (validation, 176-hour adjustment,
 *       duplicate detection, import history). Confirm with the same
 *       POST /confirm/{importId} used for Excel imports. On confirm, the
 *       source employee_work_logs rows are marked 'synced' and linked to
 *       the resulting import batch.
 *     tags: [Timesheet Import]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [month, year]
 *             properties:
 *               month:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 12
 *               year:
 *                 type: integer
 *                 minimum: 2000
 *     responses:
 *       200:
 *         description: Preview data with valid rows, error rows, and importId
 *       422:
 *         description: month/year is missing or invalid
 */
router.post(
  '/sync-employee-worklogs',
  authenticate,
  importLimiter,
  timesheetController.syncEmployeeWorkLogs
);

/**
 * @swagger
 * /timesheets/confirm/{importId}:
 *   post:
 *     summary: Confirm and commit a pending import
 *     description: >
 *       Re-validates the source file and bulk-inserts all valid rows into the
 *       timesheets table within a single transaction. The import history record
 *       is updated to status=completed on success or status=failed on error.
 *     tags: [Timesheet Import]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: importId
 *         required: true
 *         schema: { type: integer }
 *         description: ID returned by the /upload endpoint
 *     responses:
 *       200:
 *         description: Import committed; returns inserted row count
 *       404:
 *         description: Import record not found
 *       409:
 *         description: Import already confirmed or failed
 *       422:
 *         description: No valid rows after re-validation
 */
router.post(
  '/confirm/:importId',
  authenticate,
  timesheetController.confirm
);

// ─────────────────────────────────────────────────────────────────────────────
// CRUD Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /timesheets:
 *   get:
 *     summary: List timesheet entries
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *         description: Filter entries from this date (inclusive)
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *         description: Filter entries up to this date (inclusive)
 *       - in: query
 *         name: employeeId
 *         schema: { type: integer }
 *       - in: query
 *         name: poId
 *         schema: { type: integer }
 *       - in: query
 *         name: subProjectId
 *         schema: { type: integer }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [timesheet_date, hours_logged, created_at], default: timesheet_date }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC], default: DESC }
 *     responses:
 *       200:
 *         description: Paginated list of timesheet entries
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  authenticate,
  validate(listTimesheetsQuerySchema, 'query'),
  timesheetController.getAll
);

/**
 * @swagger
 * /timesheets/{id}:
 *   get:
 *     summary: Get a single timesheet entry by ID
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Timesheet entry
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  timesheetController.getById
);

/**
 * @swagger
 * /timesheets:
 *   post:
 *     summary: Create a single timesheet entry (manual) — e.g. backfilling a row missing from an Excel upload
 *     description: >
 *       Resolves and validates employee, Service PO, and sub-project exactly as the
 *       Excel upload's import validation does (active employee, PO must have a
 *       loggable status, sub-project must belong to the PO). client_id,
 *       service_type_id, and service_category_id are optional extra checks —
 *       when supplied, each is cross-validated against the resolved Service PO
 *       (project belongs to client, Service Type belongs to PO, Service Type
 *       belongs to Service Category) and are never stored on the row itself.
 *       timesheet_import_id is required — the entry is attached to that
 *       monthly sheet (Timesheet Import History record), and the employee's
 *       total hours within that one import must not exceed 176.
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employee_id, service_po_id, timesheet_import_id, timesheet_date, hours_logged]
 *             properties:
 *               employee_id:         { type: integer }
 *               service_po_id:       { type: integer }
 *               sub_project_id:      { type: integer, nullable: true }
 *               timesheet_import_id: { type: integer, description: "Required — the monthly sheet this entry belongs to. Employee's total hours within this import must not exceed 176." }
 *               client_id:           { type: integer, description: "Optional — validated against the resolved Service PO's client." }
 *               service_type_id:     { type: integer, description: "Optional — validated against the resolved Service PO's Service Type." }
 *               service_category_id: { type: integer, description: "Optional — validated against the resolved Service Type's Service Category." }
 *               timesheet_date:      { type: string, format: date }
 *               hours_logged:        { type: number, minimum: 0 }
 *     responses:
 *       201:
 *         description: Timesheet entry created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Timesheet entry created successfully." }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: integer, example: 12345 }
 *       422:
 *         description: A referenced entity was not found, is ineligible, or a cross-check failed (e.g. project does not belong to the given client)
 *       400:
 *         description: Employee's total hours (monthly, or within the given timesheet_import_id) would exceed 176
 *       409:
 *         description: Duplicate entry for this employee/PO/date
 */
router.post(
  '/',
  authenticate,
  validate(createTimesheetSchema, 'body'),
  timesheetController.create
);

/**
 * @swagger
 * /timesheets/{id}:
 *   put:
 *     summary: Update a timesheet entry
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               employee_id:    { type: integer }
 *               service_po_id:  { type: integer }
 *               sub_project_id: { type: integer, nullable: true }
 *               timesheet_date: { type: string, format: date }
 *               hours_logged:   { type: number, minimum: 0 }
 *     responses:
 *       200:
 *         description: Updated timesheet entry
 *       404:
 *         description: Not found
 *       409:
 *         description: Duplicate entry
 */
router.put(
  '/:id',
  authenticate,
  validate(updateTimesheetSchema, 'body'),
  timesheetController.update
);

/**
 * @swagger
 * /timesheets/{id}/modified-hours:
 *   patch:
 *     summary: Set the admin-adjustable Modified Hours for a timesheet entry (HR only)
 *     description: >
 *       A separate, dedicated endpoint from PUT /timesheets/{id} — that one
 *       continues to behave exactly as before and never touches
 *       modified_hours/is_publish. This endpoint updates modified_hours for
 *       one timesheet entry and marks it, and its parent monthly sheet
 *       (timesheet_import_history), as published (is_publish = true) — a
 *       one-way flag, never reset to false. hours_logged, the original
 *       immutable value, is never modified.
 *     tags: [Timesheets]
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
 *             required: [modified_hours]
 *             properties:
 *               modified_hours: { type: number, minimum: 0, maximum: 999.99 }
 *     responses:
 *       200:
 *         description: Modified hours updated
 *       404:
 *         description: Timesheet not found
 *       403:
 *         description: Forbidden — HR role required
 *       422:
 *         description: Validation failed
 */
router.patch(
  '/:id/modified-hours',
  authenticate,
  validate(updateModifiedHoursSchema, 'body'),
  timesheetController.updateModifiedHours
);

/**
 * @swagger
 * /timesheets/import/{timesheetImportId}/hours:
 *   put:
 *     summary: Bulk-update Modified Hours for a monthly import (HR only)
 *     description: >
 *       A dedicated, narrower sibling of PATCH /timesheets/{id}/modified-hours
 *       for editing several rows of ONE monthly import at once. Only updates
 *       modified_hours on the given rows — never touches hours_logged or
 *       is_publish (publishing is a separate endpoint, see
 *       PUT /timesheets/import/{timesheetImportId}/publish). Every `id` must
 *       belong to the given timesheetImportId. Enforces the employee's
 *       176-hour monthly cap, scoped to this one import, across the row's new
 *       modified_hours value plus every other row that employee has in this
 *       same import — before any write happens. All rows update in a single
 *       transaction: either all succeed or none do.
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: timesheetImportId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [timesheets]
 *             properties:
 *               timesheets:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [id, hours]
 *                   properties:
 *                     id: { type: integer, description: "timesheets.id — must belong to this import" }
 *                     hours: { type: number, minimum: 0, maximum: 999.99, description: "New modified_hours value" }
 *     responses:
 *       200:
 *         description: Timesheet hours updated successfully
 *       400:
 *         description: An affected employee's total modified hours for this import would exceed 176
 *       403:
 *         description: Forbidden — HR role required
 *       422:
 *         description: Import not found, or one or more ids don't belong to this import
 */
router.put(
  '/import/:timesheetImportId/hours',
  authenticate,
  validate(bulkUpdateImportHoursSchema, 'body'),
  timesheetController.bulkUpdateImportHours
);

/**
 * @swagger
 * /timesheets/import/{timesheetImportId}/publish:
 *   put:
 *     summary: Publish an imported monthly sheet (HR only)
 *     description: >
 *       A dedicated, narrower sibling of PUT /timesheets/import/{timesheetImportId}/hours
 *       — this one only ever sets is_publish = true, never any hours field.
 *       Publishes the timesheet_import_history record AND every timesheets
 *       row belonging to it, in one transaction, so both stay in sync.
 *       is_publish is a one-way flag: publishing an already-published import
 *       returns a message saying so instead of writing again.
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: timesheetImportId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: Published (or already published)
 *       403:
 *         description: Forbidden — HR role required
 *       422:
 *         description: Import not found
 */
router.put(
  '/import/:timesheetImportId/publish',
  authenticate,
  timesheetController.publishImport
);

/**
 * @swagger
 * /timesheets/{id}:
 *   delete:
 *     summary: Delete a timesheet entry
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Deleted successfully
 *       404:
 *         description: Not found
 *       403:
 *         description: Forbidden — Finance role required
 */
router.delete(
  '/:id',
  authenticate,
  timesheetController.deleteTimesheet
);

/**
 * @swagger
 * /timesheets:
 *   delete:
 *     summary: Delete one or more monthly sheets (timesheet import batches)
 *     description: >
 *       Accepts one or more Timesheet Import History IDs (timesheet_import_history.id)
 *       — this is the ID the frontend calls the "Timesheet History ID". For each ID,
 *       within a single transaction, this removes the child timesheet rows
 *       (timesheets.timesheet_import_id), the child error rows
 *       (timesheet_import_errors.import_id), the import history record itself, and
 *       the originally uploaded file from disk. The transaction rolls back if any
 *       step fails. Equivalent to, and shares implementation with, DELETE /timesheets/import.
 *     tags: [Timesheets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *                 description: One or more Timesheet Import History IDs (timesheet_import_history.id) to delete
 *     responses:
 *       200:
 *         description: Monthly sheet(s) and their child rows deleted successfully
 *       404:
 *         description: No matching Timesheet Import History record(s) found
 *       422:
 *         description: ids missing or invalid
 *       403:
 *         description: Forbidden — Finance or HR role required
 */
router.delete(
  '/',
  authenticate,
  validate(bulkIdsSchema, 'body'),
  timesheetController.deleteImports
);

module.exports = router;