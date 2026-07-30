'use strict';

/**
 * @swagger
 * tags:
 *   name: ServicePOs
 *   description: Service Purchase Order management and resource allocation
 */

const express = require('express');
const router = express.Router();

const servicePOController = require('../controllers/servicePOController');
const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const { importLimiter } = require('../middlewares/rateLimiters');
const {
  createServicePOSchema,
  updateServicePOSchema,
  allocateResourcesSchema,
  listServicePOsQuerySchema,
} = require('../validations/servicePOValidation');
const { handleServicePOUpload } = require('../middlewares/upload');

// Convenience role arrays
const VIEW_ROLES = ['HR', 'Finance', 'Management', 'Division Head', 'Project Manager'];
const WRITE_ROLES = ['Finance', 'Management'];
const ALLOCATE_ROLES = ['HR', 'Project Manager', 'Management'];
const DEALLOCATE_ROLES = ['HR', 'Project Manager'];

// ─── Import Service POs from Excel/CSV (before /:id to avoid route shadowing) ─
/**
 * @swagger
 * /service-pos/import:
 *   post:
 *     summary: Bulk-import Service POs from an Excel or CSV file
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: >
 *                   .xlsx or .csv file. Expected columns (header row flexible):
 *                   Service PO Name*, Client Code or Client Name*,
 *                   Service Type*, PO Value*, Start Date*, End Date*, Expected Man Hours,
 *                   Is Billable, Account Manager, Service Description, Invoice Frequency,
 *                   Invoice Amount, Status. Service PO Code is always auto-generated
 *                   (format PO-YYYYMMDD-XXXX) and is ignored even if present in the sheet.
 *     responses:
 *       200:
 *         description: Import summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                   description: Total rows in the file
 *                 imported:
 *                   type: integer
 *                   description: Rows successfully inserted
 *                 skipped:
 *                   type: integer
 *                   description: Rows skipped due to validation or DB errors
 *                 error_rows:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       row:
 *                         type: integer
 *                         description: 1-based row number in the file
 *                       errors:
 *                         type: array
 *                         items:
 *                           type: string
 *       400:
 *         description: No file attached
 *       422:
 *         description: File format error (unreadable or no recognised header)
 */
router.post(
  '/import',
  authenticate,
  importLimiter,
  handleServicePOUpload,
  servicePOController.importServicePOs
);

// ─── Active PO list (before /:id to prevent route collision) ─────────────────
/**
 * @swagger
 * /service-pos/active/list:
 *   get:
 *     summary: Get all active Service POs (dropdown list)
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active Service POs returned
 */
router.get(
  '/active/list',
  authenticate,
  servicePOController.getActivePOs
);

// ─── List all Service POs ─────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos:
 *   get:
 *     summary: List Service POs with pagination and filters
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, completed, on-hold, all], default: active }
 *       - in: query
 *         name: client_id
 *         schema: { type: integer }
 *       - in: query
 *         name: service_category_id
 *         schema: { type: integer }
 *         description: Filter by service category
 *       - in: query
 *         name: service_type_id
 *         schema: { type: integer }
 *       - in: query
 *         name: service_po_id
 *         schema: { type: integer }
 *         description: Filter the list down to a specific Service PO
 *       - in: query
 *         name: is_billable
 *         schema: { type: boolean }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by service_po_name or service_po_code
 *       - in: query
 *         name: start_date_from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: start_date_to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, enum: [service_po_name, service_po_code, start_date, end_date, po_value, created_at] }
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [ASC, DESC], default: DESC }
 *     responses:
 *       200:
 *         description: Paginated list of Service POs
 */
router.get(
  '/',
  authenticate,
  validate(listServicePOsQuerySchema, 'query'),
  servicePOController.getAllServicePOs
);

// ─── Get single Service PO ────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos/{id}:
 *   get:
 *     summary: Get a single Service PO with full details and allocated employees
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Service PO detail
 *       404:
 *         description: Service PO not found
 */
router.get(
  '/:id',
  authenticate,
  servicePOController.getServicePOById
);

// ─── Create Service PO ────────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos:
 *   post:
 *     summary: Create a new Service PO
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_name, client_id, service_type_id, start_date, end_date]
 *             properties:
 *               service_po_name:
 *                 type: string
 *               client_id:
 *                 type: integer
 *               service_type_id:
 *                 type: integer
 *               po_value:
 *                 type: number
 *               start_date:
 *                 type: string
 *                 format: date
 *               end_date:
 *                 type: string
 *                 format: date
 *               expected_man_hours:
 *                 type: number
 *               is_billable:
 *                 type: boolean
 *               account_manager:
 *                 type: string
 *                 maxLength: 100
 *                 description: Name of the account manager for this PO
 *               service_description:
 *                 type: string
 *                 description: Detailed description of the service
 *               invoice_frequency:
 *                 type: string
 *                 enum: [monthly, milestone-based, internal-no-invoice, poc, yearly-amc]
 *                 description: How often the client is invoiced
 *               invoice_amount:
 *                 type: number
 *                 description: Invoice amount for billing
 *     responses:
 *       201:
 *         description: Service PO created
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  validate(createServicePOSchema),
  servicePOController.createServicePO
);

// ─── Update Service PO ────────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos/{id}:
 *   put:
 *     summary: Update an existing Service PO
 *     tags: [ServicePOs]
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
 *               service_po_name:    { type: string }
 *               client_id:          { type: integer }
 *               service_type_id:    { type: integer }
 *               po_value:           { type: number }
 *               start_date:         { type: string, format: date }
 *               end_date:           { type: string, format: date }
 *               expected_man_hours: { type: number }
 *               is_billable:        { type: boolean }
 *               account_manager:
 *                 type: string
 *                 maxLength: 100
 *               service_description:
 *                 type: string
 *               invoice_frequency:
 *                 type: string
 *                 enum: [monthly, milestone-based, internal-no-invoice, poc, yearly-amc]
 *               invoice_amount:
 *                 type: number
 *                 description: Invoice amount for billing
 *     responses:
 *       200:
 *         description: Service PO updated
 *       400:
 *         description: PO is closed or cancelled
 *       404:
 *         description: Service PO not found
 */
router.put(
  '/:id',
  authenticate,
  validate(updateServicePOSchema),
  servicePOController.updateServicePO
);

// ─── Delete (soft-delete) Service PO ─────────────────────────────────────────
/**
 * @swagger
 * /service-pos/{id}:
 *   delete:
 *     summary: Soft-delete a Service PO (marks as cancelled + is_deleted)
 *     tags: [ServicePOs]
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
 *         description: Service PO not found
 */
router.delete(
  '/:id',
  authenticate,
  servicePOController.deleteServicePO
);

// ─── Close Service PO ─────────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos/{id}/close:
 *   post:
 *     summary: Close a Service PO (status transitions active -> closed)
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Service PO closed
 *       400:
 *         description: Invalid status transition
 */
router.post(
  '/:id/close',
  authenticate,
  servicePOController.closeServicePO
);

// ─── Allocate resources ───────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos/{id}/allocate:
 *   post:
 *     summary: Allocate employees to a Service PO
 *     tags: [ServicePOs]
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
 *             required: [employee_ids]
 *             properties:
 *               employee_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 minItems: 1
 *                 maxItems: 100
 *     responses:
 *       200:
 *         description: Resources allocated
 *       400:
 *         description: PO not active or employee inactive
 *       404:
 *         description: PO or employee not found
 */
router.post(
  '/:id/allocate',
  authenticate,
  validate(allocateResourcesSchema),
  servicePOController.allocateResources
);

// ─── Deallocate a resource ────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos/{id}/resources/{employeeId}:
 *   delete:
 *     summary: Remove an employee from a Service PO
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Service PO ID
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Resource removed
 *       404:
 *         description: PO or allocation not found
 */
router.delete(
  '/:id/resources/:employeeId',
  authenticate,
  servicePOController.deallocateResource
);

// ─── Get utilisation ──────────────────────────────────────────────────────────
/**
 * @swagger
 * /service-pos/{id}/utilisation:
 *   get:
 *     summary: Get utilisation data for a Service PO
 *     tags: [ServicePOs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Utilisation breakdown with percentage, logged hours, and remaining hours
 */
router.get(
  '/:id/utilisation',
  authenticate,
  servicePOController.getUtilisation
);

module.exports = router;