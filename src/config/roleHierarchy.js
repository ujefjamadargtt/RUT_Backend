'use strict';

/**
 * Role Creation Matrix — the single source of truth for "who may create a
 * user holding role X," replacing the ad hoc, single-actor
 * BU_ADMIN_CREATABLE_ROLES array that used to live inline in
 * userService.js. Every entry is a HARD business rule, not a generic
 * permission — deliberately NOT bypassed by authorize()'s senior-tier
 * bypass (roleHierarchyService.isSeniorTier), since the whole point of
 * this redesign is that Platform Admin must NOT be able to create an
 * Entity Admin or BU Admin directly, even though it outranks them.
 *
 * A role that is not a key here has no user-creation rights at all via the
 * generic userService.create() path (HR creates Employees through the
 * dedicated employeeService.create() flow instead — see
 * database/migrations/20260836_seed_target_roles_and_capabilities.sql's
 * hr.create_employee capability).
 */
const ROLE_CREATION_MATRIX = {
  'Platform Admin': ['Admin'],
  Admin: ['Entity Admin', 'BU Admin', 'BU Head'],
  'Entity Admin': ['BU Admin', 'BU Head'],
  'BU Admin': ['Project Admin', 'Service PO Admin', 'Manager', 'Employee', 'HR'],
  'Project Admin': ['Service PO Admin'],
  'Service PO Admin': ['Manager'],
};

/**
 * @param {string} actorRoleName
 * @returns {string[]|null} the role names this actor may create, or null
 *   if the actor has no creation rights at all under this matrix
 */
function getCreatableRoleNames(actorRoleName) {
  if (!actorRoleName) return null;
  const match = Object.keys(ROLE_CREATION_MATRIX).find(
    (key) => key.toLowerCase() === actorRoleName.toLowerCase()
  );
  return match ? ROLE_CREATION_MATRIX[match] : null;
}

/**
 * @param {string} actorRoleName
 * @param {string} targetRoleName
 * @returns {boolean}
 */
function canActorCreateRole(actorRoleName, targetRoleName) {
  const creatable = getCreatableRoleNames(actorRoleName);
  if (!creatable) return false;
  return creatable.some((r) => r.toLowerCase() === targetRoleName.toLowerCase());
}

module.exports = {
  ROLE_CREATION_MATRIX,
  getCreatableRoleNames,
  canActorCreateRole,
};
