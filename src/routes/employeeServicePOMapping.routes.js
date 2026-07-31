'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const {
  assignMappingSchema,
  listMappingsQuerySchema,
} = require('../validations/employeeServicePOMappingValidation');
const controller = require('../controllers/employeeServicePOMappingController');

/**
 * @swagger
 * tags:
 *   name: Employee Service PO Mapping
 *   description: >
 *     Admin-side management of which Service POs an Employee may self-log
 *     time against (Employee Self Timesheet module). Requires the existing
 *     User authentication — HR/Admin manage these assignments, not employees
 *     themselves.
 */

/**
 * @swagger
 * /employee-servicepo-mapping:
 *   post:
 *     summary: Assign a Service PO to an Employee
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employee_id, service_po_id]
 *             properties:
 *               employee_id: { type: integer }
 *               service_po_id: { type: integer }
 *     responses:
 *       201:
 *         description: Mapping created
 *       404:
 *         description: Employee or Service PO not found
 *       409:
 *         description: Mapping already exists
 */
router.post(
  '/',
  authenticate,
  validate(assignMappingSchema),
  controller.assign
);

/**
 * @swagger
 * /employee-servicepo-mapping/employee/{employeeId}:
 *   get:
 *     summary: Get every Service PO mapped to one Employee
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive] }
 *     responses:
 *       200:
 *         description: Mapping list
 */
router.get(
  '/employee/:employeeId',
  authenticate,
  validate(listMappingsQuerySchema, 'query'),
  controller.getEmployeeMappings
);

/**
 * @swagger
 * /employee-servicepo-mapping/service-po/{servicePOId}:
 *   get:
 *     summary: Get every Employee mapped to one Service PO
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePOId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive] }
 *     responses:
 *       200:
 *         description: Mapping list
 */
router.get(
  '/service-po/:servicePOId',
  authenticate,
  validate(listMappingsQuerySchema, 'query'),
  controller.getServicePOEmployees
);

/**
 * @swagger
 * /employee-servicepo-mapping/{id}/activate:
 *   put:
 *     summary: Activate a mapping
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Mapping activated
 *       404:
 *         description: Not found
 */
router.put(
  '/:id/activate',
  authenticate,
  controller.activateMapping
);

/**
 * @swagger
 * /employee-servicepo-mapping/{id}/deactivate:
 *   put:
 *     summary: Deactivate a mapping
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Mapping deactivated
 *       404:
 *         description: Not found
 */
router.put(
  '/:id/deactivate',
  authenticate,
  controller.deactivateMapping
);

/**
 * @swagger
 * /employee-servicepo-mapping/{id}:
 *   delete:
 *     summary: Remove a mapping (hard delete)
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Mapping removed
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  authenticate,
  controller.removeMapping
);

module.exports = router;
