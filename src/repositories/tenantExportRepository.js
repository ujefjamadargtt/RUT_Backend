'use strict';

const { Op } = require('sequelize');
const {
  Company,
  ServicePO,
  Client,
  Project,
  Employee,
  EmployeeBusinessUnit,
} = require('../models');

/**
 * Tenant Data Export — read-only data access.
 * Every function here is scoped by the caller (tenantExportService) to
 * either an explicit `companyIds` array (the requesting Admin/Entity
 * Admin's OWN Business Units — see companyAccessControlService.
 * resolveOwnedCompanyIds) or an explicit `employeeIds` list derived from
 * employeeAccessControlService.resolveEmployeeAccessWhere. Nothing here
 * ever queries unscoped — an empty `companyIds`/`employeeIds` array
 * correctly yields zero rows (Sequelize `IN ()` matches nothing), never
 * "all rows".
 */

/**
 * Sheet 1 — every Business Unit (Company) owned by the caller.
 * @param {number[]} companyIds
 * @returns {Promise<Company[]>}
 */
const findBusinessUnits = async (companyIds) => {
  if (companyIds.length === 0) return [];
  return Company.findAll({
    where: { id: { [Op.in]: companyIds }, is_deleted: false },
    attributes: ['id', 'company_name', 'status'],
    order: [['company_name', 'ASC']],
  });
};

/**
 * Sheet 2 — every Service PO under the caller's Business Units, one row
 * each (never aggregated), with its BU/Client/Project already joined.
 * @param {number[]} companyIds
 * @returns {Promise<ServicePO[]>}
 */
const findServicePOs = async (companyIds) => {
  if (companyIds.length === 0) return [];
  return ServicePO.findAll({
    where: { company_id: { [Op.in]: companyIds }, is_deleted: false },
    attributes: [
      'id', 'service_po_code', 'service_po_name', 'company_id',
      'po_value', 'start_date', 'end_date', 'status',
    ],
    include: [
      { model: Company, as: 'company', attributes: ['id', 'company_name'] },
      { model: Client, as: 'client', attributes: ['id', 'client_name'] },
      { model: Project, as: 'project', attributes: ['id', 'project_name'] },
    ],
    order: [['id', 'ASC']],
  });
};

/**
 * Every non-deleted Employee within the caller's authorized scope
 * (`accessWhere` — employeeAccessControlService.resolveEmployeeAccessWhere,
 * NOT a bare companyId — this is what correctly includes an Admin's own
 * directly-created, not-yet-BU-mapped Employees; see that service's doc
 * comment). Shared source list for both the BU-mapping sheet and the
 * Not-Filled-Timesheet sheet, so both sheets always agree on "who is a
 * tenant Employee."
 * @param {object} accessWhere
 * @returns {Promise<Employee[]>}
 */
const findTenantEmployees = async (accessWhere) => {
  return Employee.findAll({
    where: { is_deleted: false, ...accessWhere },
    attributes: ['id', 'employee_code', 'full_name', 'email', 'status'],
    order: [['full_name', 'ASC']],
  });
};

/**
 * Sheet 3 source — every ACTIVE Employee -> Business Unit mapping row for
 * the given Employees (an Employee mapped to N BUs yields N rows here; the
 * service layer, not this query, adds the "employee has zero mappings"
 * rows so this can stay a simple existence join).
 * @param {number[]} employeeIds
 * @returns {Promise<EmployeeBusinessUnit[]>}
 */
const findActiveBUMappings = async (employeeIds) => {
  if (employeeIds.length === 0) return [];
  return EmployeeBusinessUnit.findAll({
    where: { employee_id: { [Op.in]: employeeIds }, status: 'active' },
    attributes: ['employee_id', 'business_unit_id'],
    include: [{ model: Company, as: 'businessUnit', attributes: ['id', 'company_name'] }],
    order: [['employee_id', 'ASC']],
  });
};

module.exports = {
  findBusinessUnits,
  findServicePOs,
  findTenantEmployees,
  findActiveBUMappings,
};
