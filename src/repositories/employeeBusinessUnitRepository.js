'use strict';

const { Op } = require('sequelize');
const { EmployeeBusinessUnit, Company, Entity } = require('../models');

/**
 * All direct database interaction for employee_business_units — an
 * Employee's many-to-many Business Unit set. No business logic here —
 * that belongs in employeeService.js/resolveCompany.js.
 */

/**
 * @param {number} employeeId
 * @returns {Promise<Company[]>} active, non-deleted Business Units this employee
 *   belongs to, each with its parent Entity attached (entity_id + the nested
 *   `entity: { id, entity_name }` relation) — a BU-scoped caller (HR, BU
 *   Admin, etc.) has no GET /entities access, so this is their ONLY source
 *   for Entity info; see companyService.getAllForEmployee(), the GET
 *   /companies path this feeds for such a caller.
 */
const findBusinessUnitsByEmployeeId = async (employeeId) => {
  const grants = await EmployeeBusinessUnit.findAll({
    where: { employee_id: employeeId, status: 'active' },
    include: [
      {
        model: Company,
        as: 'businessUnit',
        attributes: ['id', 'company_code', 'company_name', 'status', 'is_original_data_visible', 'saturday_off_rule', 'entity_id', 'parent_business_unit_id'],
        where: { is_deleted: false },
        required: true,
        include: [
          { model: Entity, as: 'entity', attributes: ['id', 'entity_name'], required: false },
          // BU Hierarchy — lets a caller render "Technology -> Development"
          // for a Sub-BU mapping without a second round trip; null for a
          // Parent BU (or a legacy BU with no hierarchy configured).
          { model: Company, as: 'parent', attributes: ['id', 'company_name', 'company_code'], required: false },
        ],
      },
    ],
  });
  return grants.map((grant) => grant.businessUnit);
};

/**
 * @param {number} employeeId
 * @returns {Promise<number[]>}
 */
const findIdsByEmployeeId = async (employeeId) => {
  const grants = await EmployeeBusinessUnit.findAll({
    where: { employee_id: employeeId },
    attributes: ['business_unit_id'],
  });
  return grants.map((grant) => grant.business_unit_id);
};

/**
 * Batched version of findBusinessUnitsByEmployeeId — one query for every
 * employee given, not N+1 — for attaching each employee's active BUs onto
 * a list/detail response (see employeeService.js's
 * attachRoleAndBusinessUnitInfo()).
 *
 * @param {number[]} employeeIds
 * @returns {Promise<{ employee_id: number, id: number, name: string }[]>}
 */
const findBusinessUnitsByEmployeeIds = async (employeeIds) => {
  if (!employeeIds || employeeIds.length === 0) return [];
  const grants = await EmployeeBusinessUnit.findAll({
    where: { employee_id: { [Op.in]: employeeIds }, status: 'active' },
    include: [
      {
        model: Company,
        as: 'businessUnit',
        attributes: ['id', 'company_name', 'parent_business_unit_id'],
        where: { is_deleted: false },
        required: true,
        // BU Hierarchy — one batched join (not per-row) so the Employee
        // Master list can render "Technology -> Development" for every row
        // on the page; null for a Parent BU.
        include: [{ model: Company, as: 'parent', attributes: ['id', 'company_name'], required: false }],
      },
    ],
  });
  return grants.map((grant) => ({
    employee_id: grant.employee_id,
    id: grant.businessUnit.id,
    name: grant.businessUnit.company_name,
    parent_business_unit_id: grant.businessUnit.parent_business_unit_id,
    parent_business_unit_name: grant.businessUnit.parent ? grant.businessUnit.parent.company_name : null,
  }));
};

/**
 * Reverse of findIdsByEmployeeId() — every distinct Employee id with an
 * ACTIVE grant to any of the given Business Units. Used to find the
 * existing-Employee candidates for a newly-created Centralised Service PO
 * (employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO()
 * — the mirror, in the other direction, of autoMapCentralisedServicePOs()'s
 * own `EmployeeBusinessUnit.findAll({ business_unit_id, status: 'active' })`
 * lookup in employeeRepository.getActiveEmployees()).
 *
 * @param {number[]} businessUnitIds
 * @returns {Promise<number[]>}
 */
const findActiveEmployeeIdsByBusinessUnitIds = async (businessUnitIds) => {
  if (!businessUnitIds || businessUnitIds.length === 0) return [];
  const grants = await EmployeeBusinessUnit.findAll({
    where: { business_unit_id: { [Op.in]: businessUnitIds }, status: 'active' },
    attributes: ['employee_id'],
  });
  return [...new Set(grants.map((grant) => grant.employee_id))];
};

/**
 * @param {number} employeeId
 * @param {number} businessUnitId
 * @returns {Promise<boolean>}
 */
const exists = async (employeeId, businessUnitId) => {
  const count = await EmployeeBusinessUnit.count({
    where: { employee_id: employeeId, business_unit_id: businessUnitId, status: 'active' },
  });
  return count > 0;
};

/**
 * Diff-sync an employee's Business Unit set to exactly `businessUnitIds`
 * inside the given transaction — same keep/add/remove semantics as
 * employeeRoleRepository.replaceForEmployee().
 *
 * @param {number} employeeId
 * @param {number[]} businessUnitIds - already validated (existence, active, actor may assign)
 * @param {number} actorId
 * @param {object} transaction
 * @returns {Promise<void>}
 */
const replaceForEmployee = async (employeeId, businessUnitIds, actorId, transaction) => {
  const desired = new Set(businessUnitIds);
  const existing = await EmployeeBusinessUnit.findAll({ where: { employee_id: employeeId }, transaction });
  const existingIds = new Set(existing.map((row) => row.business_unit_id));

  const toRemove = existing.filter((row) => !desired.has(row.business_unit_id)).map((row) => row.id);
  if (toRemove.length > 0) {
    await EmployeeBusinessUnit.destroy({ where: { id: { [Op.in]: toRemove } }, transaction });
  }

  const toAdd = businessUnitIds.filter((buId) => !existingIds.has(buId));
  if (toAdd.length > 0) {
    await EmployeeBusinessUnit.bulkCreate(
      toAdd.map((businessUnitId) => ({
        employee_id: employeeId,
        business_unit_id: businessUnitId,
        status: 'active',
        created_by: actorId,
        updated_by: actorId,
      })),
      { transaction }
    );
  }
};

module.exports = {
  findBusinessUnitsByEmployeeId,
  findIdsByEmployeeId,
  findBusinessUnitsByEmployeeIds,
  findActiveEmployeeIdsByBusinessUnitIds,
  exists,
  replaceForEmployee,
};
