'use strict';

const { Op } = require('sequelize');
const { RoleFormMapping, Role, FormMaster } = require('../models');

/**
 * RBAC Repository
 * Raw database access for the role_form_mapping junction table — no
 * business logic (existence/duplicate checks live in rbacService.js).
 *
 * The old User <-> Role mapping functions (user_roles table) were removed
 * with the RBAC redesign — every user now holds exactly one role via
 * `users.role_id` directly (see database/migrations/20260840_collapse_user_roles.sql).
 */

// ── Role <-> Form mappings ───────────────────────────────────────────────────

/**
 * Find a single role-form mapping row, if it exists.
 * @param {number} roleId
 * @param {number} formId
 * @returns {Promise<RoleFormMapping|null>}
 */
const findRoleFormMapping = async (roleId, formId) => {
  return RoleFormMapping.findOne({ where: { role_id: roleId, form_id: formId } });
};

/**
 * Insert a single role-form mapping.
 * @param {object} data - { role_id, form_id }
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<RoleFormMapping>}
 */
const createRoleFormMapping = async (data, options = {}) => {
  return RoleFormMapping.create(data, options);
};

/**
 * Delete a single role-form mapping.
 * @param {number} roleId
 * @param {number} formId
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<number>} number of rows deleted (0 or 1)
 */
const deleteRoleFormMapping = async (roleId, formId, options = {}) => {
  return RoleFormMapping.destroy({ where: { role_id: roleId, form_id: formId }, ...options });
};

/**
 * Delete every role-form mapping row for one role — a hard delete used only
 * when the role itself is being hard-deleted (roleService.delete()), always
 * inside that same transaction, immediately before the role row itself is
 * removed.
 * @param {number} roleId
 * @param {object} transaction
 * @returns {Promise<number>} number of rows deleted
 */
const deleteAllRoleFormMappingsForRole = async (roleId, transaction) => {
  return RoleFormMapping.destroy({ where: { role_id: roleId }, transaction });
};

/**
 * Map or unmap a form for a role without ever deleting the row: if a
 * (role_id, form_id) mapping already exists, its status is updated in
 * place; otherwise a new row is inserted with the given status. This is the
 * one primitive behind POST /roles/forms/mapping and the soft-delete
 * behavior of the legacy create/delete role-form-mapping endpoints.
 *
 * @param {number} roleId
 * @param {number} formId
 * @param {boolean} status - true = map (active), false = unmap (inactive)
 * @returns {Promise<{ mapping: RoleFormMapping, created: boolean }>}
 */
const upsertRoleFormMapping = async (roleId, formId, status) => {
  const existing = await RoleFormMapping.findOne({ where: { role_id: roleId, form_id: formId } });

  if (existing) {
    await existing.update({ status });
    return { mapping: existing, created: false };
  }

  const mapping = await RoleFormMapping.create({ role_id: roleId, form_id: formId, status });
  return { mapping, created: true };
};

/**
 * Set status=true for every (roleId, formId) pair in the list — inserting a
 * new row if none exists yet, or reactivating an existing one, in a single
 * bulk statement (ON CONFLICT (role_id, form_id) DO UPDATE, via the unique
 * index already declared on the model). Always called inside the same
 * transaction as deactivateUnlistedRoleFormMappings() below — the two
 * together implement "replace all form mappings for this role."
 *
 * @param {number} roleId
 * @param {number[]} formIds
 * @param {object} transaction
 * @returns {Promise<RoleFormMapping[]>}
 */
const bulkUpsertRoleFormMappings = async (roleId, formIds, transaction) => {
  if (formIds.length === 0) return [];
  return RoleFormMapping.bulkCreate(
    formIds.map((formId) => ({ role_id: roleId, form_id: formId, status: true })),
    { updateOnDuplicate: ['status', 'updated_at'], transaction }
  );
};

/**
 * Set status=false (soft-unmap, never deleted) on every role_form_mapping
 * row for this role whose form_id is NOT in the given list — the other half
 * of "replace all form mappings for this role." Passing an empty formIds
 * array deactivates every currently-mapped form for the role, which is a
 * valid "give this role no forms" request.
 *
 * @param {number} roleId
 * @param {number[]} formIds - forms that SHOULD remain/become active
 * @param {object} transaction
 * @returns {Promise<number>} number of rows deactivated
 */
const deactivateUnlistedRoleFormMappings = async (roleId, formIds, transaction) => {
  const where = { role_id: roleId, status: true };
  if (formIds.length > 0) {
    where.form_id = { [Op.notIn]: formIds };
  }
  const [affectedCount] = await RoleFormMapping.update({ status: false }, { where, transaction });
  return affectedCount;
};

/**
 * Find a single role-form mapping row by its own primary key, with both the
 * role and the form eager-loaded.
 * @param {number} id - role_form_mapping.id (the mapping row's own id, not role_id/form_id)
 * @returns {Promise<RoleFormMapping|null>}
 */
const findRoleFormMappingById = async (id) => {
  return RoleFormMapping.findOne({
    where: { id },
    include: [
      {
        model: Role,
        as: 'role',
        attributes: ['id', 'role_name', 'permission', 'status'],
      },
      {
        model: FormMaster,
        as: 'form',
        attributes: ['id', 'module_name', 'form_name', 'status'],
      },
    ],
  });
};

/**
 * List every form mapped to one role, with the form's own fields eager-loaded.
 * @param {number} roleId
 * @returns {Promise<RoleFormMapping[]>}
 */
const listRoleFormMappings = async (roleId) => {
  return RoleFormMapping.findAll({
    where: { role_id: roleId },
    include: [
      {
        model: FormMaster,
        as: 'form',
        attributes: ['id', 'module_name', 'form_name', 'status'],
      },
    ],
    order: [
      [{ model: FormMaster, as: 'form' }, 'module_name', 'ASC'],
      [{ model: FormMaster, as: 'form' }, 'form_name', 'ASC'],
    ],
  });
};

/**
 * Fetch every distinct ACTIVELY-mapped form for ANY of the given role IDs —
 * used by login (only forms the user should actually see). A form mapped to
 * one of these roles with status=false (unmapped) is excluded entirely, not
 * just marked inactive. GROUP BY collapses a form actively mapped to more
 * than one of the requested roles down to a single row.
 *
 * @param {number[]} roleIds
 * @returns {Promise<FormMaster[]>}
 */
const findAccessibleForms = async (roleIds) => {
  return FormMaster.findAll({
    attributes: ['id', 'module_name', 'form_name'],
    where: { status: 'active' },
    include: [
      {
        model: Role,
        as: 'roles',
        attributes: [],
        where: { id: { [Op.in]: roleIds } },
        through: { attributes: [], where: { status: true } },
        required: true,
      },
    ],
    order: [
      ['module_name', 'ASC'],
      ['form_name', 'ASC'],
    ],
    group: ['FormMaster.id'],
  });
};

/**
 * Fetch EVERY active form in the system (the full catalog, not just ones
 * with a mapping row for ANY of the given roles) — forms that have never
 * been mapped to any of these roles at all are excluded entirely, not just
 * marked false. Each returned form is annotated with whether it is
 * currently actively mapped (true) or was mapped and has since been
 * unmapped (false) for this role set. Used by the admin Role-Form mapping
 * screen (POST /roles/forms) to show what's actually been configured for
 * these roles, rather than every form in the system.
 *
 * @param {number[]} roleIds
 * @returns {Promise<{ id: number, module_name: string, form_name: string, status: boolean }[]>}
 */
const findAllFormsWithMappingStatus = async (roleIds) => {
  const mappings = await RoleFormMapping.findAll({
    attributes: ['form_id', 'status'],
    where: { role_id: { [Op.in]: roleIds } },
  });

  if (mappings.length === 0) return [];

  // A form counts as actively mapped (true) for this role set if ANY of
  // its mapping rows among the given roles is active — otherwise (mapped,
  // but every one of those rows is inactive) it's false.
  const statusByFormId = new Map();
  for (const mapping of mappings) {
    statusByFormId.set(mapping.form_id, (statusByFormId.get(mapping.form_id) || false) || mapping.status);
  }

  const forms = await FormMaster.findAll({
    attributes: ['id', 'module_name', 'form_name'],
    where: { id: { [Op.in]: [...statusByFormId.keys()] }, status: 'active' },
    order: [
      ['module_name', 'ASC'],
      ['form_name', 'ASC'],
    ],
  });

  return forms.map((form) => ({
    id: form.id,
    module_name: form.module_name,
    form_name: form.form_name,
    status: statusByFormId.get(form.id),
  }));
};

/**
 * Fetch EVERY active form in the system, regardless of role_form_mapping —
 * backs Platform Admin's implicit "All Forms" access (hierarchy_rank === 1),
 * which is never represented as stored mapping rows (see
 * database/migrations/20260845_reseed_form_master_and_role_form_mapping.sql's
 * header comment) so a newly-added form is visible to Platform Admin
 * immediately, with no reseed required.
 * @returns {Promise<FormMaster[]>}
 */
const findAllActiveForms = async () => {
  return FormMaster.findAll({
    attributes: ['id', 'module_name', 'form_name'],
    where: { status: 'active' },
    order: [
      ['module_name', 'ASC'],
      ['form_name', 'ASC'],
    ],
  });
};

module.exports = {
  findAllActiveForms,
  findRoleFormMapping,
  findRoleFormMappingById,
  createRoleFormMapping,
  deleteRoleFormMapping,
  deleteAllRoleFormMappingsForRole,
  upsertRoleFormMapping,
  bulkUpsertRoleFormMappings,
  deactivateUnlistedRoleFormMappings,
  listRoleFormMappings,
  findAccessibleForms,
  findAllFormsWithMappingStatus,
};
