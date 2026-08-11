'use strict';

const { UserAdditionalRole, Role } = require('../models');

const ROLE_ATTRIBUTES = ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'];

/**
 * All direct database interaction for user_additional_roles. No business
 * logic — that belongs in userService.js/roleHierarchyService.js. This
 * table is purely an additive capability grant; see
 * database/migrations/20260850_add_user_additional_roles.sql.
 */

/**
 * @param {number} userId
 * @returns {Promise<Role[]>} active, non-deleted roles held additionally by this user
 */
const findRolesByUserId = async (userId) => {
  const grants = await UserAdditionalRole.findAll({
    where: { user_id: userId },
    include: [
      {
        model: Role,
        as: 'role',
        attributes: ROLE_ATTRIBUTES,
        where: { is_deleted: false },
        required: true,
      },
    ],
  });
  return grants.map((grant) => grant.role);
};

/**
 * Replace a user's entire additional-role set inside the given transaction
 * — full-replace semantics, matching how the primary role_id is already
 * fully replaced (not patched) on update.
 *
 * @param {number} userId
 * @param {number[]} roleIds - already validated (existence, active, operational-only)
 * @param {number} actorId
 * @param {object} transaction
 * @returns {Promise<void>}
 */
const replaceForUser = async (userId, roleIds, actorId, transaction) => {
  await UserAdditionalRole.destroy({ where: { user_id: userId }, transaction });

  if (roleIds.length === 0) {
    return;
  }

  await UserAdditionalRole.bulkCreate(
    roleIds.map((roleId) => ({
      user_id: userId,
      role_id: roleId,
      created_by: actorId,
      updated_by: actorId,
    })),
    { transaction }
  );
};

/**
 * Count how many users hold this role as an ADDITIONAL role — used by
 * roleRepository.hasAssignedUsers() as a hard-delete guard alongside the
 * primary-role count, so deleting a role only ever held additionally
 * doesn't silently cascade-delete that grant unnoticed.
 *
 * @param {number} roleId
 * @returns {Promise<number>}
 */
const countByRoleId = async (roleId) => {
  return UserAdditionalRole.count({ where: { role_id: roleId } });
};

module.exports = {
  findRolesByUserId,
  replaceForUser,
  countByRoleId,
};
