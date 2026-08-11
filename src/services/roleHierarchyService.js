'use strict';

const { Role, RoleCapability } = require('../models');

/**
 * Role Hierarchy Service
 *
 * The single place permission-inheritance logic lives, per the RBAC
 * redesign — replaces every previous ad hoc role-name string check
 * (authorize.js's SUPERUSER_ROLES bypass, requireEntityAdmin.js's hardcoded
 * check, userService.js's BU_ADMIN_CREATABLE_ROLES array, the old
 * users.is_platform_admin boolean) with one data-driven resolver over
 * `roles.hierarchy_rank` / `roles.inherits_role_id` / `role_capabilities`
 * (see database/migrations/20260834-20260836).
 *
 * Inheritance is deliberately NOT a blanket "every senior role gets every
 * junior role's capabilities" rule — only the two edges the RBAC spec
 * actually states are wired (Service PO Admin <- Manager, Project Admin <-
 * Service PO Admin) via `inherits_role_id`. Every other role's capability
 * list is self-contained. Adding a new inheritance edge later is a data
 * change (set `inherits_role_id`), not a code change — this resolver simply
 * walks whatever chain the data describes.
 */

/**
 * Platform Admin (hierarchy_rank 1) through BU Admin (hierarchy_rank 4) sit
 * above the delegation chain and manage everything within their own scope —
 * the generalized, rank-based replacement for the old hardcoded
 * SUPERUSER_ROLES = ['super admin', 'bu admin'] bypass list. Company/entity
 * scoping is enforced separately (resolveCompany.js / requireEntityAdmin.js),
 * so this bypass only ever grants reach within the caller's own scope, never
 * cross-tenant.
 */
const SENIOR_BYPASS_MAX_RANK = 4;

/**
 * @param {number} roleId
 * @returns {Promise<object|null>}
 */
async function getRoleById(roleId) {
  if (!roleId) return null;
  return Role.findOne({ where: { id: roleId, is_deleted: false } });
}

/**
 * Walks a role's `inherits_role_id` chain and returns the union of its own
 * capabilities plus every capability of every role it inherits from,
 * transitively. Guards against a cyclic chain (shouldn't ever exist, but a
 * resolver walking arbitrary data should never infinite-loop on bad data).
 *
 * @param {number} roleId
 * @returns {Promise<Set<string>>}
 */
async function getEffectiveCapabilities(roleId) {
  const capabilities = new Set();
  const visited = new Set();

  let currentId = roleId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);

    const [role, grants] = await Promise.all([
      getRoleById(currentId),
      RoleCapability.findAll({ where: { role_id: currentId }, attributes: ['capability_key'] }),
    ]);

    grants.forEach((grant) => capabilities.add(grant.capability_key));
    currentId = role ? role.inherits_role_id : null;
  }

  return capabilities;
}

/**
 * @param {Set<string>|string[]} effectiveCapabilities
 * @param {string|string[]} required - one capability key, or several (any-of)
 * @returns {boolean}
 */
function hasCapability(effectiveCapabilities, required) {
  const set = effectiveCapabilities instanceof Set ? effectiveCapabilities : new Set(effectiveCapabilities);
  const requiredKeys = Array.isArray(required) ? required : [required];
  return requiredKeys.some((key) => set.has(key));
}

/**
 * @param {object|null} role - a Role instance/plain object with hierarchy_rank
 * @returns {boolean} true for Platform Admin/Admin/Entity Admin/BU Admin
 */
function isSeniorTier(role) {
  return !!role && Number.isInteger(role.hierarchy_rank) && role.hierarchy_rank <= SENIOR_BYPASS_MAX_RANK;
}

/**
 * Union of getEffectiveCapabilities() across every role id supplied — a
 * user's PRIMARY role plus zero or more ADDITIONAL operational roles (see
 * database/migrations/20260850_add_user_additional_roles.sql). Reuses the
 * existing single-role inheritance walk per id rather than duplicating it;
 * order doesn't matter, this is a pure set union. Deliberately separate
 * from isSeniorTier/hierarchy-rank logic, which must stay single-role — see
 * that function's doc comment and roleHierarchy.js's ROLE_CREATION_MATRIX.
 *
 * @param {number[]} roleIds
 * @returns {Promise<Set<string>>}
 */
async function getEffectiveCapabilitiesForRoleIds(roleIds) {
  const uniqueIds = [...new Set(roleIds)].filter(Boolean);
  const sets = await Promise.all(uniqueIds.map(getEffectiveCapabilities));
  return sets.reduce((union, set) => {
    set.forEach((capability) => union.add(capability));
    return union;
  }, new Set());
}

module.exports = {
  SENIOR_BYPASS_MAX_RANK,
  getRoleById,
  getEffectiveCapabilities,
  getEffectiveCapabilitiesForRoleIds,
  hasCapability,
  isSeniorTier,
};
