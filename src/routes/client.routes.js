'use strict';

/**
 * @swagger
 * tags:
 *   name: Clients
 *   description: Client management endpoints
 */

const express = require('express');
const router = express.Router();

const clientController = require('../controllers/clientController');
const authenticate = require('../middlewares/auth');
// GET-only: lets a BU-scoped caller mapped to more than one Business Unit
// omit X-Company-Id and see every Client across every BU they're mapped to,
// instead of resolveCompany.js's 400 — see resolveReportCompanyScope.js.
// Writes below keep the full `authenticate` (single req.companyId) chain
// unchanged — a create/update/delete always needs exactly one target BU.
const resolveReportCompanyScope = require('../middlewares/resolveReportCompanyScope');
const authenticateReadMultiBU = [authenticate.authenticateIdentity, resolveReportCompanyScope];
const { importLimiter } = require('../middlewares/rateLimiters');
const { validate } = require('../middlewares/validateRequest');
const {
  createClientSchema,
  updateClientSchema,
  listClientsQuerySchema,
} = require('../validations/clientValidation');
const { handleClientUpload } = require('../middlewares/upload');

// ─── Import clients from Excel/CSV (before /:id to avoid route shadowing) ────
/**
 * @swagger
 * /clients/import:
 *   post:
 *     summary: Import clients from an Excel or CSV file
 *     tags: [Clients]
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
 *                 description: .xlsx or .csv file. Required column - "Client Name". Optional columns - "Client Code", "Industry", "Status".
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
 *                   description: Total non-empty rows in file
 *                 imported:
 *                   type: integer
 *                   description: Successfully inserted rows
 *                 skipped:
 *                   type: integer
 *                   description: Duplicate rows skipped
 *                 error_rows:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       row_number: { type: integer }
 *                       row_data:   { type: object }
 *                       errors:     { type: array, items: { type: string } }
 *                       skipped:    { type: boolean }
 *       400:
 *         description: No file uploaded
 *       422:
 *         description: File parse or header error
 */
router.post(
  '/import',
  authenticate,
  importLimiter,
  handleClientUpload,
  clientController.importClients
);

// ─── Active clients dropdown (must come before /:id to avoid route shadowing) ──
/**
 * @swagger
 * /clients/active/list:
 *   get:
 *     summary: Get all active clients (dropdown list)
 *     tags: [Clients]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active clients returned successfully
 */
router.get(
  '/active/list',
  authenticateReadMultiBU,
  clientController.getActiveClients
);

// ─── List all clients ─────────────────────────────────────────────────────────
/**
 * @swagger
 * /clients:
 *   get:
 *     summary: List clients with pagination, search and filters
 *     tags: [Clients]
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
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by client_name or client_code
 *       - in: query
 *         name: industry
 *         schema: { type: string }
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, enum: [client_name, client_code, industry, created_at], default: client_name }
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [ASC, DESC], default: ASC }
 *     responses:
 *       200:
 *         description: Paginated list of clients
 */
router.get(
  '/',
  authenticateReadMultiBU,
  validate(listClientsQuerySchema, 'query'),
  clientController.getAllClients
);

// ─── Get single client ────────────────────────────────────────────────────────
/**
 * @swagger
 * /clients/{id}:
 *   get:
 *     summary: Get a single client by ID
 *     tags: [Clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Client record
 *       404:
 *         description: Client not found
 */
router.get(
  '/:id',
  authenticateReadMultiBU,
  clientController.getClientById
);

// ─── Create client ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /clients:
 *   post:
 *     summary: Create a new client
 *     tags: [Clients]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [client_name]
 *             properties:
 *               client_name:
 *                 type: string
 *               industry:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, inactive]
 *     responses:
 *       201:
 *         description: Client created
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  validate(createClientSchema),
  clientController.createClient
);

// ─── Update client ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /clients/{id}:
 *   put:
 *     summary: Update an existing client
 *     tags: [Clients]
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
 *             properties:
 *               client_name:
 *                 type: string
 *               industry:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, inactive]
 *     responses:
 *       200:
 *         description: Client updated
 *       404:
 *         description: Client not found
 */
router.put(
  '/:id',
  authenticate,
  validate(updateClientSchema),
  clientController.updateClient
);

// ─── Soft-delete client ───────────────────────────────────────────────────────
/**
 * @swagger
 * /clients/{id}:
 *   delete:
 *     summary: Deactivate a client (soft delete)
 *     tags: [Clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Client deactivated
 *       409:
 *         description: Client has active Service POs
 */
router.delete(
  '/:id',
  authenticate,
  clientController.deleteClient
);

module.exports = router;
