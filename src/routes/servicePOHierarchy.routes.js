'use strict';

/**
 * @swagger
 * tags:
 *   name: ServicePOHierarchy
 *   description: >
 *     Service PO Hierarchy — Parent/Child nodes belonging to exactly ONE
 *     Service PO (max depth: Service PO -> Parent -> Child). Completely
 *     independent of Service PO CRUD (servicePO.routes.js) — these routes
 *     never create, update, or delete a `service_pos` row; they only ever
 *     read/write `service_po_hierarchy`. Mounted at the same `/service-pos`
 *     prefix as servicePO.routes.js, as its own router.
 */

const express = require('express');
const router = express.Router();

const servicePOHierarchyController = require('../controllers/servicePOHierarchyController');
const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const {
  createHierarchyNodeSchema,
  renameHierarchyNodeSchema,
} = require('../validations/servicePOHierarchyValidation');

/**
 * @swagger
 * /service-pos/{servicePoId}/hierarchy:
 *   get:
 *     summary: Get the Parent/Child hierarchy tree for one Service PO
 *     tags: [ServicePOHierarchy]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePoId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Hierarchy tree — array of Parent nodes, each with a children array
 *       404:
 *         description: Service PO not found
 */
router.get(
  '/:servicePoId/hierarchy',
  authenticate,
  servicePOHierarchyController.getHierarchy
);

/**
 * @swagger
 * /service-pos/{servicePoId}/hierarchy/parent:
 *   post:
 *     summary: Create a Parent node under a Service PO
 *     tags: [ServicePOHierarchy]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePoId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [node_name]
 *             properties:
 *               node_name: { type: string }
 *               display_order: { type: integer }
 *     responses:
 *       201:
 *         description: Parent node created
 *       404:
 *         description: Service PO not found
 */
router.post(
  '/:servicePoId/hierarchy/parent',
  authenticate,
  validate(createHierarchyNodeSchema),
  servicePOHierarchyController.createParent
);

/**
 * @swagger
 * /service-pos/{servicePoId}/hierarchy/{parentId}/child:
 *   post:
 *     summary: Create a Child node under an existing Parent node
 *     tags: [ServicePOHierarchy]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePoId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: parentId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [node_name]
 *             properties:
 *               node_name: { type: string }
 *               display_order: { type: integer }
 *     responses:
 *       201:
 *         description: Child node created
 *       400:
 *         description: Target node is not a Parent (max depth is Service PO -> Parent -> Child)
 *       404:
 *         description: Service PO or Parent node not found
 */
router.post(
  '/:servicePoId/hierarchy/:parentId/child',
  authenticate,
  validate(createHierarchyNodeSchema),
  servicePOHierarchyController.createChild
);

/**
 * @swagger
 * /service-pos/hierarchy/{hierarchyId}:
 *   put:
 *     summary: Rename (and/or reorder) a Parent or Child node
 *     tags: [ServicePOHierarchy]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: hierarchyId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               node_name: { type: string }
 *               display_order: { type: integer }
 *     responses:
 *       200:
 *         description: Hierarchy node updated
 *       404:
 *         description: Hierarchy node not found
 */
router.put(
  '/hierarchy/:hierarchyId',
  authenticate,
  validate(renameHierarchyNodeSchema),
  servicePOHierarchyController.renameNode
);

/**
 * @swagger
 * /service-pos/hierarchy/{hierarchyId}:
 *   delete:
 *     summary: Delete a Parent (and all its Children) or a Child node
 *     tags: [ServicePOHierarchy]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: hierarchyId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Deleted successfully
 *       404:
 *         description: Hierarchy node not found
 */
router.delete(
  '/hierarchy/:hierarchyId',
  authenticate,
  servicePOHierarchyController.deleteNode
);

module.exports = router;
