'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const { createFormSchema, updateFormSchema, listFormsSchema } = require('../validations/formMasterValidation');
const formMasterController = require('../controllers/formMasterController');

/**
 * @swagger
 * tags:
 *   name: Forms
 *   description: Form Master — every screen/form available in the application (Management only)
 */

/**
 * @swagger
 * /forms:
 *   get:
 *     summary: List all forms
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: all }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search on module_name or form_name
 *     responses:
 *       200:
 *         description: Form list
 */
router.get(
  '/',
  authenticate,
  validate(listFormsSchema, 'query'),
  formMasterController.getAll
);

/**
 * @swagger
 * /forms/{id}:
 *   get:
 *     summary: Get a single form by ID
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Form record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  formMasterController.getById
);

/**
 * @swagger
 * /forms:
 *   post:
 *     summary: Register a new screen/form
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [module_name, form_name]
 *             properties:
 *               module_name: { type: string, example: "Reports" }
 *               form_name: { type: string, example: "Client Cost Report" }
 *               status: { type: string, enum: [active, inactive], default: active }
 *     responses:
 *       201:
 *         description: Form created
 *       409:
 *         description: A form with this module name and form name already exists
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  validate(createFormSchema),
  formMasterController.create
);

/**
 * @swagger
 * /forms/{id}:
 *   put:
 *     summary: Update a form
 *     tags: [Forms]
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
 *               module_name: { type: string }
 *               form_name: { type: string }
 *               status: { type: string, enum: [active, inactive] }
 *     responses:
 *       200:
 *         description: Form updated
 *       404:
 *         description: Not found
 *       409:
 *         description: Module name / form name conflict
 */
router.put(
  '/:id',
  authenticate,
  validate(updateFormSchema),
  formMasterController.update
);

/**
 * @swagger
 * /forms/{id}:
 *   delete:
 *     summary: Deactivate a form
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Form deactivated
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  authenticate,
  formMasterController.remove
);

module.exports = router;
