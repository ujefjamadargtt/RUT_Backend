'use strict';

/**
 * @swagger
 * tags:
 *   name: Entities
 *   description: >
 *     Entity Master. Reachable by both Entity Admin and Admin, all scoped by
 *     req.entityIds (see requireEntityAdminOrAdmin.js) — an Admin never sees
 *     another Admin's Entities, and an Entity Admin only ever sees/touches
 *     their own. An Admin may create an Entity unassigned or assign it to
 *     any Entity Admin they created; an Entity Admin may create an Entity
 *     for themselves (entity_admin_user_id is always forced to their own
 *     user id server-side, never trusted from the request body) and may
 *     update/delete only that Entity — never another Entity Admin's.
 */

const express = require('express');
const router = express.Router();

const entityController = require('../controllers/entityController');
const authenticate = require('../middlewares/auth');
const requireEntityAdminOrAdmin = require('../middlewares/requireEntityAdminOrAdmin');
const { validate } = require('../middlewares/validateRequest');
const {
  createEntitySchema,
  updateEntitySchema,
  listEntitiesQuerySchema,
} = require('../validations/entityValidation');

/**
 * @swagger
 * /entities:
 *   get:
 *     summary: List Entities in the caller's scope (Entity Admin or Admin)
 *     tags: [Entities]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated list of Entities
 *       403:
 *         description: Not an Entity Admin or Admin
 */
router.get(
  '/',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(listEntitiesQuerySchema, 'query'),
  entityController.getAllEntities
);

/**
 * @swagger
 * /entities/{id}:
 *   get:
 *     summary: Get a single Entity by ID (must be within the caller's scope)
 *     tags: [Entities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entity record
 *       404:
 *         description: Not found (or not in the caller's scope)
 */
router.get(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  entityController.getEntityById
);

/**
 * @swagger
 * /entities:
 *   post:
 *     summary: Create a new Entity (Admin or Entity Admin)
 *     description: >
 *       An Admin may optionally assign entity_admin_user_id to an existing
 *       Entity Admin user THEY created — enforced server-side, never trusted
 *       from the request alone. An Entity Admin creating their own Entity
 *       has entity_admin_user_id forced to their own user id regardless of
 *       what the request body contains.
 *     tags: [Entities]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [entity_name]
 *             properties:
 *               entity_name: { type: string }
 *               entity_admin_user_id: { type: integer, description: "Admin callers only — ignored for Entity Admin callers." }
 *               status: { type: string, enum: [active, inactive] }
 *     responses:
 *       201:
 *         description: Entity created
 *       403:
 *         description: entity_admin_user_id isn't an Entity Admin the caller created (Admin callers only)
 *       422:
 *         description: Validation error
 */
router.post(
  '/',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(createEntitySchema),
  entityController.createEntity
);

/**
 * @swagger
 * /entities/{id}:
 *   put:
 *     summary: Update an Entity, or (re)assign its Entity Admin (must own/be-assigned the Entity)
 *     description: >
 *       An Entity Admin may update only the Entity assigned to them, and
 *       cannot reassign it to a different Entity Admin (the same
 *       ownership check an Admin's reassignment goes through rejects that).
 *     tags: [Entities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entity updated
 *       403:
 *         description: entity_admin_user_id isn't an Entity Admin the caller created
 *       404:
 *         description: Not found (or not in the caller's scope)
 */
router.put(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  validate(updateEntitySchema),
  entityController.updateEntity
);

/**
 * @swagger
 * /entities/{id}:
 *   delete:
 *     summary: Delete an Entity (must own/be-assigned the Entity)
 *     tags: [Entities]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Entity deleted
 *       404:
 *         description: Not found (or not in the caller's scope)
 *       409:
 *         description: Companies still linked to this entity
 */
router.delete(
  '/:id',
  authenticate,
  requireEntityAdminOrAdmin,
  entityController.deleteEntity
);

module.exports = router;
