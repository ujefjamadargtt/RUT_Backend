'use strict';

const { Op } = require('sequelize');
const { EmployeeRole, Role } = require('../models');

const ROLE_ATTRIBUTES = ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'];

/**
 * All direct database interaction for employee_roles — an Employee's
 * many-to-many role set (no primary/additional split). No business logic
 * here — that belongs in employeeService.js/roleHierarchyService.js.
 */

/**
 * @param {number} employeeId
 * @returns {Promise<Role[]>} active, non-deleted roles held by this employee
 */
const findRolesByEmployeeId = async (employeeId) => {
  const grants = await EmployeeRole.findAll({
    where: { employee_id: employeeId, status: 'active' },
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
 * @param {number} employeeId
 * @returns {Promise<number[]>}
 */
const findIdsByEmployeeId = async (employeeId) => {
  const grants = await EmployeeRole.findAll({ where: { employee_id: employeeId }, attributes: ['role_id'] });
  return grants.map((grant) => grant.role_id);
};

/**
 * Batched version of findRolesByEmployeeId — one query for every employee
 * given, not N+1 — for attaching each employee's active roles onto a list/
 * detail response (see employeeService.js's attachRoleAndBusinessUnitInfo()).
 *
 * @param {number[]} employeeIds
 * @returns {Promise<{ employee_id: number, id: number, name: string }[]>}
 */
const findRolesByEmployeeIds = async (employeeIds) => {
  if (!employeeIds || employeeIds.length === 0) return [];
  const grants = await EmployeeRole.findAll({
    where: { employee_id: { [Op.in]: employeeIds }, status: 'active' },
    include: [
      {
        model: Role,
        as: 'role',
        attributes: ['id', 'role_name'],
        where: { is_deleted: false },
        required: true,
      },
    ],
  });
  return grants.map((grant) => ({ employee_id: grant.employee_id, id: grant.role.id, name: grant.role.role_name }));
};

/**
 * Diff-sync an employee's role set to exactly `roleIds` inside the given
 * transaction: existing rows not in the new set are removed, missing ones
 * are added, rows already present are left untouched (no needless
 * updated_at churn) — see the Employee CRUD verification plan's diff-sync
 * requirement.
 *
 * @param {number} employeeId
 * @param {number[]} roleIds - already validated (existence, active, at-most-one-senior-tier)
 * @param {number} actorId
 * @param {object} transaction
 * @returns {Promise<void>}
 */
const replaceForEmployee = async (employeeId, roleIds, actorId, transaction) => {
  const desired = new Set(roleIds);
  const existing = await EmployeeRole.findAll({ where: { employee_id: employeeId }, transaction });
  const existingIds = new Set(existing.map((row) => row.role_id));

  const toRemove = existing.filter((row) => !desired.has(row.role_id)).map((row) => row.id);
  if (toRemove.length > 0) {
    await EmployeeRole.destroy({ where: { id: { [Op.in]: toRemove } }, transaction });
  }

  const toAdd = roleIds.filter((roleId) => !existingIds.has(roleId));
  if (toAdd.length > 0) {
    await EmployeeRole.bulkCreate(
      toAdd.map((roleId) => ({
        employee_id: employeeId,
        role_id: roleId,
        status: 'active',
        created_by: actorId,
        updated_by: actorId,
      })),
      { transaction }
    );
  }
};

/**
 * Count how many employees hold this role — a hard-delete guard for
 * roleRepository, mirroring userAdditionalRoleRepository.countByRoleId's
 * old purpose.
 *
 * @param {number} roleId
 * @returns {Promise<number>}
 */
const countByRoleId = async (roleId) => {
  return EmployeeRole.count({ where: { role_id: roleId } });
};

module.exports = {
  findRolesByEmployeeId,
  findIdsByEmployeeId,
  findRolesByEmployeeIds,
  replaceForEmployee,
  countByRoleId,
};
