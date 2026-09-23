'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const {
  assignMappingSchema,
  listMappingsQuerySchema,
  saveEmployeeMappingsSchema,
  updateProjectManagerFlagSchema,
  getServicePOEmployeeOptionsQuerySchema,
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
 *     description: >
 *       `is_project_manager: true` (Section 11.B of the PM redesign spec —
 *       the Service PO Master "Map Employees" entry point) explicitly marks
 *       this Employee as the Project Manager/approver for THIS Service PO,
 *       separate from and in addition to a plain employee mapping. Rejected
 *       with 400 if the Employee does not currently hold the Project
 *       Manager role. Defaults to false (a plain employee mapping) when
 *       omitted.
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
 *               is_project_manager: { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: Mapping created
 *       400:
 *         description: is_project_manager=true but the Employee does not hold the Project Manager role
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
 * /employee-servicepo-mapping/employee/{employeeId}/options:
 *   get:
 *     summary: >
 *       Get eligible Service PO options for an Employee, plus their current
 *       mappings — data source for the "Manage Service PO Mapping" action on
 *       Employee Master.
 *     description: >
 *       If the Employee holds Project Manager or Delivery Head (checked
 *       server-side), every eligible Service PO in the caller's authorized
 *       company/tenant scope is returned, regardless of the Employee's own
 *       Business Unit. Every other role stays restricted to their own
 *       Business Unit(s) plus Centralised/BU-less Service POs. Uses
 *       identity-only authentication (no mandatory X-Company-Id) — same
 *       reasoning as GET .../service-po/{id} above: a BU Admin/Project
 *       Manager/Delivery Head managing MULTIPLE Business Units must reach
 *       this screen for any Employee across their own full managed scope,
 *       not just whichever ONE Business Unit is currently selected.
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Eligible Service PO options and current mappings
 *       404:
 *         description: Employee not found
 */
router.get(
  '/employee/:employeeId/options',
  authenticate.authenticateIdentity,
  controller.getServicePOOptions
);

/**
 * @swagger
 * /employee-servicepo-mapping/employee/{employeeId}:
 *   put:
 *     summary: Save (replace) an Employee's Service PO mapping set
 *     description: >
 *       Replaces the Employee's mapping set to exactly `service_po_ids`.
 *       Every id is revalidated server-side against the same eligibility
 *       rule GET .../options uses; an ineligible id rejects the whole
 *       request with 400. Existing mappings are diff-synced (activated/
 *       deactivated), never hard-deleted. Uses identity-only authentication
 *       (no mandatory X-Company-Id) — same reasoning as GET .../options
 *       above, so Save never rejects an already-eligible Service PO purely
 *       because the caller's currently-selected Global BU doesn't happen to
 *       match it.
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [service_po_ids]
 *             properties:
 *               service_po_ids:
 *                 type: array
 *                 items: { type: integer }
 *     responses:
 *       200:
 *         description: Mappings saved
 *       400:
 *         description: One or more Service PO ids are not eligible for this Employee
 *       404:
 *         description: Employee not found
 */
router.put(
  '/employee/:employeeId',
  authenticate.authenticateIdentity,
  validate(saveEmployeeMappingsSchema),
  controller.saveMappings
);

/**
 * @swagger
 * /employee-servicepo-mapping/service-po/{servicePOId}:
 *   get:
 *     summary: Get every Employee mapped to one Service PO
 *     description: |
 *       Uses identity-only authentication (no mandatory X-Company-Id) — a
 *       BU Admin / Project Manager / Delivery Head mapped to MULTIPLE
 *       Business Units can open ANY Service PO within their own managed
 *       set without first selecting that exact BU via the Global BU
 *       selector; company/tenant authorization is still fully enforced
 *       (a Service PO outside the caller's own managed scope 404s).
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
 *       404:
 *         description: Service PO not found, or outside the caller's authorized scope
 */
router.get(
  '/service-po/:servicePOId',
  authenticate.authenticateIdentity,
  validate(listMappingsQuerySchema, 'query'),
  controller.getServicePOEmployees
);

/**
 * @swagger
 * /employee-servicepo-mapping/service-po/{servicePOId}/options:
 *   get:
 *     summary: >
 *       Get eligible Employee options for a Service PO, plus their current
 *       mappings — data source for the "Map Employees" action launched
 *       from a Service PO (the REVERSE direction of
 *       .../employee/{employeeId}/options above).
 *     description: >
 *       Restricted to callers who hold Service PO mapping authority (BU
 *       Admin / Project Manager / Delivery Head, or Admin/Entity Admin) —
 *       checked server-side from the caller's own verified role, never a
 *       role/mode the request could assert. For those callers, the
 *       returned Employee list spans their ENTIRE authorized Admin/company
 *       scope — it is NEVER narrowed by Business Unit: not the Service
 *       PO's own BU, not the caller's currently selected Global BU, and
 *       not whether the Employee has a BU at all. Only cross-company/
 *       cross-tenant Employees are excluded.
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: servicePOId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Eligible Employee options and current mappings
 *       403:
 *         description: Caller does not hold Service PO mapping authority
 *       404:
 *         description: Service PO not found
 */
router.get(
  '/service-po/:servicePOId/options',
  authenticate.authenticateIdentity,
  validate(getServicePOEmployeeOptionsQuerySchema, 'query'),
  controller.getServicePOEmployeeOptions
);

/**
 * @swagger
 * /employee-servicepo-mapping/filter-options:
 *   get:
 *     summary: >
 *       Get the Entity / Business Unit filter dropdown options for the
 *       "Map Employees" screen's own Entity → BU filter bar.
 *     description: >
 *       Same authorization and scope as GET .../service-po/{id}/options
 *       above (BU Admin / Project Manager / Delivery Head get their owning
 *       Admin's full scope; Admin/Entity Admin get their own owned scope) —
 *       not scoped to one Service PO, since that scope is identical across
 *       every Service PO the caller can open this screen for.
 *     tags: [Employee Service PO Mapping]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Entities and Business Units within the caller's authorized scope
 *       403:
 *         description: Caller does not hold Service PO mapping authority
 */
router.get(
  '/filter-options',
  authenticate.authenticateIdentity,
  controller.getMappingFilterOptions
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
 * /employee-servicepo-mapping/{id}/project-manager:
 *   put:
 *     summary: Update ONLY an existing mapping's Project Manager flag
 *     description: >
 *       Never creates or deletes the mapping, and never touches `status` —
 *       purely toggles `is_project_manager` on an already-existing row
 *       (Section 8 Case 1 of the PM redesign spec, and the Service PO
 *       Master "Map Employees" screen's Employee/Project-Manager radio).
 *       Turning it ON is rejected with 400 if the mapping's Employee does
 *       not currently hold the Project Manager role.
 *     tags: [Employee Service PO Mapping]
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
 *             required: [is_project_manager]
 *             properties:
 *               is_project_manager: { type: boolean }
 *     responses:
 *       200:
 *         description: Mapping updated
 *       400:
 *         description: is_project_manager=true but the Employee does not hold the Project Manager role
 *       404:
 *         description: Not found
 */
router.put(
  '/:id/project-manager',
  authenticate,
  validate(updateProjectManagerFlagSchema),
  controller.updateProjectManagerFlag
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
