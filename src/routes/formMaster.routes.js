'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const {
  createFormSchema,
  updateFormSchema,
  listFormsSchema,
  listModulesSchema,
  reorderModulesSchema,
  reorderFormsSchema,
} = require('../validations/formMasterValidation');
const formMasterController = require('../controllers/formMasterController');

/**
 * @swagger
 * tags:
 *   name: Forms
 *   description: >
 *     Form Master — every screen/module available in the application
 *     (Management only). A module IS a form_master row (module_name = NULL,
 *     form_name = the module's name); a form is a row with module_name
 *     pointing at its module. seq orders modules among themselves, and
 *     independently orders each module's own forms.
 */

/**
 * @swagger
 * /forms:
 *   get:
 *     summary: List all forms and modules
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
 *       - in: query
 *         name: module_name
 *         schema: { type: string }
 *         description: Restrict to forms registered under this module
 *     responses:
 *       200:
 *         description: Form/module list
 */
router.get(
  '/',
  authenticate,
  validate(listFormsSchema, 'query'),
  formMasterController.getAll
);

/**
 * @swagger
 * /forms/modules:
 *   get:
 *     summary: List module rows only — the Create Form screen's Module dropdown
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: active }
 *     responses:
 *       200:
 *         description: Modules, ordered by seq
 */
router.get(
  '/modules',
  authenticate,
  validate(listModulesSchema, 'query'),
  formMasterController.getModules
);

/**
 * @swagger
 * /forms/modules/reorder:
 *   patch:
 *     summary: Reorder modules
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     seq: { type: integer }
 *                 example: [{ id: 5, seq: 1 }, { id: 7, seq: 2 }]
 *     responses:
 *       200:
 *         description: Modules reordered
 *       400:
 *         description: One or more items are not module rows
 *       404:
 *         description: One or more module IDs were not found
 */
router.patch(
  '/modules/reorder',
  authenticate,
  validate(reorderModulesSchema),
  formMasterController.reorderModules
);

/**
 * @swagger
 * /forms/reorder:
 *   patch:
 *     summary: Reorder the forms inside one module
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [module_name, items]
 *             properties:
 *               module_name: { type: string, example: "Reports" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     seq: { type: integer }
 *                 example: [{ id: 9, seq: 1 }, { id: 8, seq: 2 }]
 *     responses:
 *       200:
 *         description: Forms reordered
 *       400:
 *         description: One or more items do not belong to the given module
 *       404:
 *         description: Module or one of the given form IDs was not found
 */
router.patch(
  '/reorder',
  authenticate,
  validate(reorderFormsSchema),
  formMasterController.reorderForms
);

/**
 * @swagger
 * /forms/{id}:
 *   get:
 *     summary: Get a single form or module by ID
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
 *         description: Form/module record
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
 *     summary: Register a new module (module_name null/omitted) or a new form under an existing module
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [form_name]
 *             properties:
 *               form_name: { type: string, example: "Client Cost Report" }
 *               module_name:
 *                 type: string
 *                 nullable: true
 *                 example: "Reports"
 *                 description: Omit or send null to create a module instead of a form.
 *               status: { type: string, enum: [active, inactive], default: active }
 *     responses:
 *       201:
 *         description: Form/module created
 *       400:
 *         description: Referenced module does not exist
 *       409:
 *         description: A module/form with this name already exists
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
 *     summary: Update a form or module
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
 *               module_name:
 *                 type: string
 *                 nullable: true
 *                 description: For a form, moves it to a different module. Cannot be used to turn a module into a form or vice versa.
 *               form_name: { type: string }
 *               status: { type: string, enum: [active, inactive] }
 *     responses:
 *       200:
 *         description: Form/module updated
 *       400:
 *         description: Referenced module does not exist, or attempted to change row type
 *       404:
 *         description: Not found
 *       409:
 *         description: Name conflict
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
 *     summary: Deactivate a form or module
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
 *         description: Form/module deactivated
 *       400:
 *         description: Module still has forms registered under it
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  authenticate,
  formMasterController.remove
);

module.exports = router;
