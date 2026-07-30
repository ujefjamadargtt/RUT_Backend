'use strict';

const { sequelize } = require('../models');
const rbacRepository = require('../repositories/rbacRepository');
const roleRepository = require('../repositories/roleRepository');
const formRepository = require('../repositories/formMasterRepository');
const userRepository = require('../repositories/userRepository');
const { createAuditLog } = require('../middlewares/auditLog');

/**
 * RBAC Service
 * Business logic for the user_roles and role_form_mapping junction tables:
 * existence checks, duplicate-mapping guards, and the Get Accessible Forms
 * aggregation. Raw DB access lives in rbacRepository.js.
 */

/**
 * Throw a statusCode-tagged error the controller's error handler understands.
 * @param {string} message
 * @param {number} statusCode
 */
function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

/**
 * Confirm a user exists, or throw 404.
 * @param {number} userId
 */
async function ensureUserExists(userId) {
  const user = await userRepository.findById(userId);
  if (!user) {
    fail(`User with ID ${userId} not found.`, 404);
  }
}

/**
 * Confirm a role exists, or throw 404. Returns the role for callers that
 * need it (e.g. getFormsWithMappingStatus() callers, if a Management check
 * is ever reintroduced there).
 * @param {number} roleId
 * @returns {Promise<Role>}
 */
async function ensureRoleExists(roleId) {
  const role = await roleRepository.findById(roleId);
  if (!role) {
    fail(`Role with ID ${roleId} not found.`, 404);
  }
  return role;
}

/**
 * Confirm a form exists, or throw 404.
 * @param {number} formId
 */
async function ensureFormExists(formId) {
  const form = await formRepository.findById(formId);
  if (!form) {
    fail(`Form with ID ${formId} not found.`, 404);
  }
}

// ── User <-> Role mappings ───────────────────────────────────────────────────

/**
 * List every role currently mapped to one user.
 * @param {number} userId
 * @returns {Promise<UserRole[]>}
 */
const listUserMappings = async (userId) => {
  await ensureUserExists(userId);
  return rbacRepository.listUserMappings(userId);
};

/**
 * Map one additional role onto one user.
 * @param {object} data - { user_id, role_id }
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<UserRole>}
 */
const createUserMapping = async ({ user_id: userId, role_id: roleId }, actorId, ipAddress) => {
  await ensureUserExists(userId);
  await ensureRoleExists(roleId);

  const existing = await rbacRepository.findUserMapping(userId, roleId);
  if (existing) {
    fail('This user-role mapping already exists.', 409);
  }

  const mapping = await rbacRepository.createUserMapping({ user_id: userId, role_id: roleId });

  await createAuditLog(actorId, 'CREATE', 'user_roles', mapping.id, null, mapping.toJSON(), ipAddress);

  return mapping;
};

/**
 * Remove one role mapping from one user.
 * @param {object} data - { user_id, role_id }
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<void>}
 */
const deleteUserMapping = async ({ user_id: userId, role_id: roleId }, actorId, ipAddress) => {
  const deletedCount = await rbacRepository.deleteUserMapping(userId, roleId);
  if (deletedCount === 0) {
    fail('User-role mapping not found.', 404);
  }

  await createAuditLog(actorId, 'DELETE', 'user_roles', null, { user_id: userId, role_id: roleId }, null, ipAddress);
};

/**
 * Replace ALL of a user's role mappings with the given set in one
 * transaction — every existing mapping for this user is removed and the new
 * list is inserted, so a failure partway through leaves the user's previous
 * roles untouched rather than half-updated.
 *
 * @param {number} userId
 * @param {number[]} roleIds
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<UserRole[]>} the user's mappings after the replace
 */
const replaceUserRoles = async (userId, roleIds, actorId, ipAddress) => {
  await ensureUserExists(userId);
  for (const roleId of roleIds) {
    await ensureRoleExists(roleId);
  }

  const t = await sequelize.transaction();
  try {
    await rbacRepository.deleteAllUserMappings(userId, t);
    await rbacRepository.bulkCreateUserMappings(
      roleIds.map((roleId) => ({ user_id: userId, role_id: roleId })),
      t
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await createAuditLog(actorId, 'UPDATE', 'user_roles', userId, null, { user_id: userId, role_ids: roleIds }, ipAddress);

  return rbacRepository.listUserMappings(userId);
};

// ── Role <-> Form mappings ───────────────────────────────────────────────────

/**
 * List every form currently mapped to one role.
 * @param {number} roleId
 * @returns {Promise<RoleFormMapping[]>}
 */
const listRoleFormMappings = async (roleId) => {
  await ensureRoleExists(roleId);
  return rbacRepository.listRoleFormMappings(roleId);
};

/**
 * Fetch a single role-form mapping row by its own primary key.
 * @param {number} id - role_form_mapping.id
 * @returns {Promise<RoleFormMapping>}
 * @throws {Error} statusCode 404 if no mapping row has this id
 */
const getRoleFormMappingById = async (id) => {
  const mapping = await rbacRepository.findRoleFormMappingById(id);
  if (!mapping) {
    fail(`Role-form mapping with ID ${id} not found.`, 404);
  }
  return mapping;
};

/**
 * Map one additional form onto one role. Idempotent: if the mapping already
 * exists (active or previously unmapped), its status is simply set to true
 * rather than erroring — see mapForm() below, which this is now a thin
 * status:true convenience wrapper around.
 * @param {object} data - { role_id, form_id }
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<RoleFormMapping>}
 */
const createRoleFormMapping = async ({ role_id: roleId, form_id: formId }, actorId, ipAddress) => {
  return mapForm({ roleId, formId, status: true }, actorId, ipAddress);
};

/**
 * Remove one form mapping from one role — a SOFT unmap (status set to
 * false), never a physical delete. 404s if the mapping never existed at
 * all, since there is nothing to unmap in that case; re-unmapping an
 * already-inactive mapping is a no-op success (idempotent), not an error.
 * @param {object} data - { role_id, form_id }
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<void>}
 */
const deleteRoleFormMapping = async ({ role_id: roleId, form_id: formId }, actorId, ipAddress) => {
  const existing = await rbacRepository.findRoleFormMapping(roleId, formId);
  if (!existing) {
    fail('Role-form mapping not found.', 404);
  }

  await mapForm({ roleId, formId, status: false }, actorId, ipAddress);
};

/**
 * Map or unmap a form for a role (POST /roles/forms/mapping). Never
 * physically deletes a row: if the (role_id, form_id) pair already has a
 * mapping row, its status is updated in place; otherwise a new row is
 * inserted with the given status. Idempotent either way — mapping an
 * already-active form, or unmapping an already-inactive one, both succeed
 * without change.
 *
 * @param {object} data - { roleId, formId, status } (status: true = map/active, false = unmap/inactive)
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<RoleFormMapping>}
 */
const mapForm = async ({ roleId, formId, status }, actorId, ipAddress) => {
  await ensureRoleExists(roleId);
  await ensureFormExists(formId);

  const { mapping, created } = await rbacRepository.upsertRoleFormMapping(roleId, formId, status);

  await createAuditLog(
    actorId,
    created ? 'CREATE' : 'UPDATE',
    'role_form_mapping',
    mapping.id,
    null,
    mapping.toJSON(),
    ipAddress
  );

  return mapping;
};

// ── Get Accessible Forms (POST /roles/forms) ────────────────────────────────

/**
 * Fetch every form that has AT LEAST ONE role_form_mapping row for the
 * given role IDs (POST /roles/forms), each annotated with whether it's
 * currently actively mapped (status true) or was mapped and has since been
 * unmapped (status false). A form never mapped to any of these roles is
 * excluded entirely — a role with zero mappings gets back an empty object,
 * not the full form catalog. Grouped by module, both modules and forms
 * sorted alphabetically (module order falls out of
 * findAllFormsWithMappingStatus()'s ORDER BY module_name — object key
 * insertion order follows the row order Postgres returns them in).
 *
 * This is the admin Role-Form mapping screen's data source (what's actually
 * configured for these roles, so an admin can review/toggle it), which is
 * why it's restricted to Management only at the route level — a regular
 * user's own accessible forms come from the login response instead (see
 * getActiveFormsForRoles() below), not this endpoint.
 *
 * @param {number[]} roleIds
 * @returns {Promise<object>} forms grouped by module_name: { [module]: {id, name, status}[] }
 */
const getFormsWithMappingStatus = async (roleIds) => {
  const requestedRoleIds = [...new Set(roleIds)];

  const forms = await rbacRepository.findAllFormsWithMappingStatus(requestedRoleIds);

  return forms.reduce((formsByModule, form) => {
    if (!formsByModule[form.module_name]) {
      formsByModule[form.module_name] = [];
    }
    formsByModule[form.module_name].push({ id: form.id, name: form.form_name, status: form.status });
    return formsByModule;
  }, {});
};

/**
 * Fetch every ACTIVELY-mapped form for the given role IDs, deduplicated and
 * grouped by module — no status field (presence in the response already
 * means "accessible"). Used only by the login/refresh-token flow
 * (authService.js) to build the forms a user should actually see;
 * unmapped/inactive forms are excluded entirely, never just flagged.
 *
 * @param {number[]} roleIds
 * @returns {Promise<object>} forms grouped by module_name: { [module]: {id, name}[] }
 */
const getActiveFormsForRoles = async (roleIds) => {
  const requestedRoleIds = [...new Set(roleIds)];
  const forms = await rbacRepository.findAccessibleForms(requestedRoleIds);

  return forms.reduce((formsByModule, form) => {
    if (!formsByModule[form.module_name]) {
      formsByModule[form.module_name] = [];
    }
    formsByModule[form.module_name].push({ id: form.id, name: form.form_name });
    return formsByModule;
  }, {});
};

module.exports = {
  listUserMappings,
  createUserMapping,
  deleteUserMapping,
  replaceUserRoles,
  listRoleFormMappings,
  getRoleFormMappingById,
  createRoleFormMapping,
  deleteRoleFormMapping,
  mapForm,
  getFormsWithMappingStatus,
  getActiveFormsForRoles,
};
