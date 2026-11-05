'use strict';

/**
 * @swagger
 * tags:
 *   name: System Settings
 *   description: >
 *     System-wide settings. Monthly Cap Hours (default 176) is the monthly
 *     total employee hours are scaled down to at sync/import time and the
 *     capacity reports divide by. Readable by any authenticated user; only
 *     Admin can change it. A change applies to syncs/imports run afterwards —
 *     already-synced months keep the cap they were synced with until re-synced.
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requireSystemSettingsEditor = require('../middlewares/requireSystemSettingsEditor');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
const { handleLogoUpload } = require('../middlewares/upload');
const { validate } = require('../middlewares/validateRequest');
const { updateMonthlyCapSchema } = require('../validations/systemSettingsValidation');
const systemSettingsController = require('../controllers/systemSettingsController');

/**
 * @swagger
 * /system-settings/monthly-cap:
 *   get:
 *     summary: Get the current Monthly Cap Hours setting
 *     tags: [System Settings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: month, schema: { type: integer, minimum: 1, maximum: 12 }, description: "Optional; with year, adds cap_for_month" }
 *       - { in: query, name: year, schema: { type: integer }, description: "Optional; with month, adds cap_for_month" }
 *     responses:
 *       200:
 *         description: "{ monthly_cap_hours, cap_for_month, cap_for_employee_month, min, max, updated_by, updated_at }"
 *   put:
 *     summary: Change the Monthly Cap Hours setting (Admin only)
 *     tags: [System Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [monthly_cap_hours]
 *             properties:
 *               monthly_cap_hours:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 744
 *     responses:
 *       200:
 *         description: Updated setting
 *       403:
 *         description: Not an Admin
 *       422:
 *         description: Validation failed
 */
router.get('/monthly-cap', authenticate, systemSettingsController.getMonthlyCap);
router.put(
  '/monthly-cap',
  authenticate,
  requireSystemSettingsEditor,
  validate(updateMonthlyCapSchema),
  systemSettingsController.updateMonthlyCap
);

/**
 * @swagger
 * /system-settings/site-logo:
 *   get:
 *     summary: Get the active site logo (PUBLIC, no auth - the login page needs it)
 *     tags: [System Settings]
 *     responses:
 *       200:
 *         description: "data is { id, image_path, file_name, updated_at } or null when no logo is active (frontend falls back to its built-in logo). image_path is relative to the API base."
 * /system-settings/logos:
 *   get:
 *     summary: List all uploaded logos, newest first (Platform Admin only)
 *     tags: [System Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "data is an array of { id, file_name, mime_type, file_size, is_active, created_at, uploaded_by_name, image_path } (bytes are never included)"
 *       403:
 *         description: Not a Platform Admin
 *   post:
 *     summary: Upload a logo - JPG / PNG / GIF only, max 5 MB (Platform Admin only). Does not activate it.
 *     tags: [System Settings]
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
 *     responses:
 *       201:
 *         description: Created logo item (is_active false)
 *       403:
 *         description: Not a Platform Admin
 *       413:
 *         description: File larger than 5 MB
 *       422:
 *         description: "Not a real JPG/PNG/GIF (extension, mimetype and file signature are all checked; SVG is rejected) or no file sent"
 * /system-settings/logos/{id}/activate:
 *   put:
 *     summary: Make a logo THE site logo (Platform Admin only)
 *     tags: [System Settings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: The activated logo item
 *       403:
 *         description: Not a Platform Admin
 *       404:
 *         description: Logo not found
 * /system-settings/logos/{id}/image:
 *   get:
 *     summary: Stream a logo image (PUBLIC)
 *     tags: [System Settings]
 *     description: Sent with the stored Content-Type, Cache-Control public/max-age=31536000/immutable, X-Content-Type-Options nosniff and Cross-Origin-Resource-Policy cross-origin.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Image bytes
 *       404:
 *         description: Logo not found
 */
router.get('/site-logo', systemSettingsController.getSiteLogo);
router.get('/logos', authenticate, requirePlatformAdmin, systemSettingsController.listLogos);
router.post('/logos', authenticate, requirePlatformAdmin, handleLogoUpload, systemSettingsController.uploadLogo);
router.put('/logos/:id/activate', authenticate, requirePlatformAdmin, systemSettingsController.activateLogo);
router.get('/logos/:id/image', systemSettingsController.getLogoImage);

module.exports = router;
