'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const {
  createCategorySchema,
  updateCategorySchema,
  listCategoriesSchema,
  reorderCategoriesSchema,
} = require('../validations/categoryValidation');
const categoryController = require('../controllers/categoryController');

/**
 * @swagger
 * tags:
 *   name: Categories
 *   description: >
 *     The optional Module -> Category -> Form layer. A category always
 *     belongs to exactly one module (module_id — the module's own
 *     form_master row id) and is never moved between modules; only forms
 *     move, via PUT /forms/:id/move.
 */

/**
 * @swagger
 * /forms/categories:
 *   get:
 *     summary: List categories, optionally scoped to one module
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: module_id
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, all], default: all }
 *     responses:
 *       200:
 *         description: Category list
 */
router.get(
  '/',
  authenticate,
  validate(listCategoriesSchema, 'query'),
  categoryController.getAll
);

/**
 * @swagger
 * /forms/categories/reorder:
 *   patch:
 *     summary: Reorder the categories inside one module
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [module_id, items]
 *             properties:
 *               module_id: { type: integer, example: 1 }
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
 *         description: Categories reordered
 *       400:
 *         description: One or more items do not belong to the given module
 *       404:
 *         description: Module or one of the given category IDs was not found
 */
router.patch(
  '/reorder',
  authenticate,
  validate(reorderCategoriesSchema),
  categoryController.reorder
);

/**
 * @swagger
 * /forms/categories/{id}:
 *   get:
 *     summary: Get a single category by ID
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Category record
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  authenticate,
  categoryController.getById
);

/**
 * @swagger
 * /forms/categories:
 *   post:
 *     summary: Create a category under an existing module
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [module_id, name]
 *             properties:
 *               module_id: { type: integer, example: 1 }
 *               name: { type: string, example: "Financial Reports" }
 *               description: { type: string, nullable: true }
 *               status: { type: string, enum: [active, inactive], default: active }
 *     responses:
 *       201:
 *         description: Category created
 *       400:
 *         description: Referenced module does not exist
 *       409:
 *         description: A category with this name already exists under this module
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  validate(createCategorySchema),
  categoryController.create
);

/**
 * @swagger
 * /forms/categories/{id}:
 *   put:
 *     summary: Rename/describe/(de)activate a category
 *     tags: [Categories]
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
 *               name: { type: string }
 *               description: { type: string, nullable: true }
 *               status: { type: string, enum: [active, inactive] }
 *     responses:
 *       200:
 *         description: Category updated
 *       404:
 *         description: Not found
 *       409:
 *         description: Name conflict
 */
router.put(
  '/:id',
  authenticate,
  validate(updateCategorySchema),
  categoryController.update
);

/**
 * @swagger
 * /forms/categories/{id}:
 *   delete:
 *     summary: Deactivate a category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Category deactivated
 *       400:
 *         description: Category still has forms assigned to it
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  authenticate,
  categoryController.remove
);

module.exports = router;
