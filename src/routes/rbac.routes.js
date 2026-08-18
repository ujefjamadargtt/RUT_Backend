'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const requirePlatformAdmin = require('../middlewares/requirePlatformAdmin');
const { validate } = require('../middlewares/validateRequest');
const {
  roleFormMappingSchema,
  replaceRoleFormMappingsSchema,
  getRoleFormMappingQuerySchema,
  formsForRolesSchema,
  mapFormSchema,
} = require('../validations/rbacValidation');
const rbacController = require('../controllers/rbacController');

/**
 * @swagger
 * tags:
 *   name: RBAC
 *   description: Role<->Form permission mapping (Platform Admin only)
 */

/**
 * Every route below discloses or edits Role -> Form permission mappings —
 * gated by requirePlatformAdmin, not the generic authorize() middleware,
 * for the same reason as role.routes.js: authorize()'s senior-tier bypass
 * (ranks 1-4) would incorrectly admit Admin/Entity Admin/BU Admin, but the
 * seeded RBAC data (role_capabilities: platform.manage_form_master) grants
 * this to Platform Admin only.
 */

/**
 * @swagger
 * /roles/forms:
 *   post:
 *     summary: Get forms mapped (active or inactive) to the given roles (Management only)
 *     description: >
 *       Returns only forms that have at least one role_form_mapping row for
 *       the given roles — a form never mapped to any of them is excluded
 *       entirely, not just marked false. Each returned form is annotated
 *       with whether it's currently actively mapped (status true) or was
 *       mapped and has since been unmapped (status false). A role with no
 *       mappings at all returns an empty object. Powers the admin Role-Form
 *       mapping screen, sorted alphabetically by module then form name. A
 *       regular user's own accessible forms (active mappings only, no
 *       status field) come from the login response instead — see
 *       POST /auth/login.
 *     tags: [RBAC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roleIds]
 *             properties:
 *               roleIds:
 *                 type: array
 *                 items: { type: integer }
 *                 example: [1, 3]
 *     responses:
 *       200:
 *         description: Forms grouped by module, each with { id, name, status }
 *       422:
 *         description: Validation error
 */
router.post(
  '/forms',
  authenticate,
  requirePlatformAdmin,
  validate(formsForRolesSchema),
  rbacController.formsForRoles
);

/**
 * @swagger
 * /roles/forms/mapping:
 *   post:
 *     summary: Map or unmap a form for a role (Management only)
 *     description: >
 *       Soft mapping only — never physically deletes a row. If the
 *       (roleId, formId) pair already has a mapping row, its status is
 *       updated in place; otherwise a new row is inserted with the given
 *       status. Idempotent: mapping an already-active form, or unmapping an
 *       already-inactive one, both succeed without change.
 *     tags: [RBAC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roleId, formId, status]
 *             properties:
 *               roleId: { type: integer, example: 2 }
 *               formId: { type: integer, example: 15 }
 *               status: { type: boolean, example: true, description: "true = map (active), false = unmap (inactive)" }
 *     responses:
 *       200:
 *         description: Mapping created or updated
 *       404:
 *         description: Role or form not found
 *       422:
 *         description: Validation error
 */
router.post(
  '/forms/mapping',
  authenticate,
  requirePlatformAdmin,
  validate(mapFormSchema),
  rbacController.mapForm
);

/**
 * @swagger
 * /roles/form-mappings/{roleId}:
 *   get:
 *     summary: List every form mapped to a role (Management only)
 *     tags: [RBAC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Role form mappings
 *       404:
 *         description: Role not found
 */
router.get(
  '/form-mappings/:roleId',
  authenticate,
  requirePlatformAdmin,
  rbacController.roleFormMappings
);

/**
 * @swagger
 * /roles/form-mappings:
 *   get:
 *     summary: Get a single role-form mapping row by its own ID (Management only)
 *     description: >
 *       Fetches one role_form_mapping row by its own primary key, passed as
 *       a query param — distinct from GET /roles/form-mappings/{roleId},
 *       which lists every mapping for one role.
 *     tags: [RBAC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: role_form_mapping.id
 *     responses:
 *       200:
 *         description: Role form mapping record
 *       404:
 *         description: Mapping not found
 *       422:
 *         description: Validation error
 */
router.get(
  '/form-mappings',
  authenticate,
  requirePlatformAdmin,
  validate(getRoleFormMappingQuerySchema, 'query'),
  rbacController.getRoleFormMappingById
);

/**
 * @swagger
 * /roles/form-mappings:
 *   post:
 *     summary: Map a form onto a role (Management only)
 *     description: >
 *       A status:true convenience wrapper around POST /roles/forms/mapping.
 *       Idempotent — mapping an already-active (or previously unmapped)
 *       form succeeds without erroring, reactivating it if needed.
 *     tags: [RBAC]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role_id, form_id]
 *             properties:
 *               role_id: { type: integer }
 *               form_id: { type: integer }
 *     responses:
 *       201:
 *         description: Mapping created or reactivated
 *       404:
 *         description: Role or form not found
 *       422:
 *         description: Validation error
 */
router.post(
  '/form-mappings',
  authenticate,
  requirePlatformAdmin,
  validate(roleFormMappingSchema),
  rbacController.createRoleFormMapping
);

/**
 * @swagger
 * /roles/form-mappings/{roleId}/{formId}:
 *   delete:
 *     summary: Unmap a form from a role (Management only)
 *     description: >
 *       A status:false convenience wrapper around POST /roles/forms/mapping
 *       — soft unmap only, the row is never physically deleted. 404s only
 *       if the pair was never mapped at all; unmapping an already-inactive
 *       mapping is a no-op success.
 *     tags: [RBAC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: formId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Mapping unmapped (status set to false)
 *       404:
 *         description: Mapping not found
 */
router.delete(
  '/form-mappings/:roleId/:formId',
  authenticate,
  requirePlatformAdmin,
  rbacController.deleteRoleFormMapping
);

/**
 * @swagger
 * /roles/form-mappings/{roleId}:
 *   put:
 *     summary: Replace all form mappings for a role in one call (Management only)
 *     description: >
 *       Bulk counterpart to POST/DELETE /roles/form-mappings — given the
 *       complete list of form_ids that should be active for this role, sets
 *       those active (inserting or reactivating as needed) and soft-unmaps
 *       every other form currently mapped to this role, all in one
 *       transaction. Rows are never physically deleted. Pass an empty
 *       form_ids array to unmap every form from the role.
 *     tags: [RBAC]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [form_ids]
 *             properties:
 *               form_ids:
 *                 type: array
 *                 items: { type: integer }
 *                 example: [1, 3, 8, 9, 14]
 *     responses:
 *       200:
 *         description: Updated form mappings for this role
 *       404:
 *         description: Role or one of the given forms not found
 *       422:
 *         description: Validation error
 */
router.put(
  '/form-mappings/:roleId',
  authenticate,
  requirePlatformAdmin,
  validate(replaceRoleFormMappingsSchema),
  rbacController.replaceRoleFormMappings
);

module.exports = router;
