'use strict';

const { sequelize } = require('../models');
const rbacRepository = require('../repositories/rbacRepository');
const roleRepository = require('../repositories/roleRepository');
const formRepository = require('../repositories/formMasterRepository');
const { createAuditLog } = require('../middlewares/auditLog');

/**
 * RBAC Service
 * Business logic for the role_form_mapping junction table: existence
 * checks, duplicate-mapping guards, and the Get Accessible Forms
 * aggregation. Raw DB access lives in rbacRepository.js.
 *
 * The old User <-> Role mapping functions (user_roles table) were removed
 * with the RBAC redesign — see database/migrations/20260840_collapse_user_roles.sql
 * and rbacRepository.js's header comment.
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

// The "Roles" and "Forms" admin screens (seeded in database/rbac_seed.sql,
// module "Administration") ARE the RBAC configuration surface itself — they
// manage which roles/forms exist system-wide. Per
// database/migrations/20260807_restrict_admin_forms_to_platform_admin.sql,
// these may ONLY ever be mapped to the "Platform Admin" role.
const RESTRICTED_ADMIN_FORMS = [
  { moduleName: 'Administration', formName: 'Roles' },
  { moduleName: 'Administration', formName: 'Forms' },
];
const PLATFORM_ADMIN_ROLE_NAME = 'Platform Admin';

/**
 * Resolve the current ids behind RESTRICTED_ADMIN_FORMS and the Platform
 * Admin role — looked up fresh on every call (cheap queries against small,
 * rarely-changing tables) rather than cached, so a form/role rename takes
 * effect immediately rather than needing a process restart.
 * @returns {Promise<{ restrictedFormIds: Set<number>, platformAdminRoleId: number|null }>}
 */
async function loadFormRoleMappingGuardData() {
  const [forms, platformAdminRole] = await Promise.all([
    Promise.all(RESTRICTED_ADMIN_FORMS.map((f) => formRepository.findByName(f.moduleName, f.formName))),
    roleRepository.findByName(PLATFORM_ADMIN_ROLE_NAME),
  ]);

  return {
    restrictedFormIds: new Set(forms.filter(Boolean).map((f) => f.id)),
    platformAdminRoleId: platformAdminRole ? platformAdminRole.id : null,
  };
}

/**
 * Enforce that the "Roles"/"Forms" admin screens stay mapped to Platform
 * Admin ONLY: reject mapping either of them onto any other role, and reject
 * unmapping Platform Admin's own access (it must always stay mapped). A
 * no-op for every other (role, form) pair. Called from both the single-pair
 * mapForm() and the bulk replaceRoleFormMappings() below, since either can
 * otherwise change this mapping.
 * @param {number} roleId
 * @param {number} formId
 * @param {boolean} status - true = map/activate, false = unmap/deactivate
 */
async function assertFormRoleMappingAllowed(roleId, formId, status) {
  const { restrictedFormIds, platformAdminRoleId } = await loadFormRoleMappingGuardData();
  if (!restrictedFormIds.has(formId)) return;

  if (roleId !== platformAdminRoleId && status) {
    fail('This form can only be mapped to the Platform Admin role.', 403);
  }
  if (roleId === platformAdminRoleId && !status) {
    fail('This form must always stay mapped to the Platform Admin role and cannot be unmapped.', 403);
  }
}

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
  await assertFormRoleMappingAllowed(roleId, formId, status);

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

/**
 * Replace ALL of a role's form mappings with the given set in one
 * transaction: every form_id in the list is set active (inserted or
 * reactivated), every other form currently mapped to this role is soft-
 * unmapped (status set to false, never deleted). An empty formIds array is
 * a valid "give this role no forms" request.
 *
 * @param {number} roleId
 * @param {number[]} formIds
 * @param {number} actorId
 * @param {string} ipAddress
 * @returns {Promise<RoleFormMapping[]>} the role's form mappings after the replace
 */
const replaceRoleFormMappings = async (roleId, formIds, actorId, ipAddress) => {
  await ensureRoleExists(roleId);
  for (const formId of formIds) {
    await ensureFormExists(formId);
  }

  // This bulk replace bypasses mapForm(), so it needs its own check: any
  // restricted form (see assertFormRoleMappingAllowed) being ADDED for a
  // non-Platform-Admin role, or OMITTED (i.e. implicitly unmapped) for
  // Platform Admin, is rejected — same rule, applied to the whole set at once.
  const { restrictedFormIds, platformAdminRoleId } = await loadFormRoleMappingGuardData();
  if (restrictedFormIds.size > 0) {
    const requestedFormIds = new Set(formIds);
    if (roleId !== platformAdminRoleId) {
      const disallowed = formIds.some((formId) => restrictedFormIds.has(formId));
      if (disallowed) {
        fail('This form can only be mapped to the Platform Admin role.', 403);
      }
    } else {
      const missing = [...restrictedFormIds].some((formId) => !requestedFormIds.has(formId));
      if (missing) {
        fail('This form must always stay mapped to the Platform Admin role and cannot be unmapped.', 403);
      }
    }
  }

  const t = await sequelize.transaction();
  try {
    await rbacRepository.deactivateUnlistedRoleFormMappings(roleId, formIds, t);
    await rbacRepository.bulkUpsertRoleFormMappings(roleId, formIds, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await createAuditLog(actorId, 'UPDATE', 'role_form_mapping', roleId, null, { role_id: roleId, form_ids: formIds }, ipAddress);

  return rbacRepository.listRoleFormMappings(roleId);
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
 * Platform Admin (hierarchyRank === 1) is a deliberate bypass of the
 * role_form_mapping table entirely — "All Forms" per the RBAC spec is
 * implemented as every currently-active form, not literal seeded mapping
 * rows, so a newly-added form is visible to Platform Admin immediately with
 * no reseed needed (see database/migrations/
 * 20260845_reseed_form_master_and_role_form_mapping.sql's header comment).
 *
 * @param {number[]} roleIds
 * @param {number|null} [hierarchyRank] - the caller's role.hierarchy_rank, if known
 * @returns {Promise<object>} forms grouped by module_name: { [module]: {id, name}[] }
 */
const getActiveFormsForRoles = async (roleIds, hierarchyRank = null) => {
  const forms = hierarchyRank === 1
    ? await rbacRepository.findAllActiveForms()
    : await rbacRepository.findAccessibleForms([...new Set(roleIds)]);

  return forms.reduce((formsByModule, form) => {
    if (!formsByModule[form.module_name]) {
      formsByModule[form.module_name] = [];
    }
    formsByModule[form.module_name].push({ id: form.id, name: form.form_name });
    return formsByModule;
  }, {});
};

module.exports = {
  listRoleFormMappings,
  getRoleFormMappingById,
  createRoleFormMapping,
  deleteRoleFormMapping,
  replaceRoleFormMappings,
  mapForm,
  getFormsWithMappingStatus,
  getActiveFormsForRoles,
};
