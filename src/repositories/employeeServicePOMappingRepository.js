'use strict';

const { Op } = require('sequelize');
const { EmployeeServicePOMapping, Employee, ServicePO, Project } = require('../models');

/**
 * Employee Service PO Mapping Repository
 * Raw database access — no business logic.
 */

/**
 * Builds a `company_id` WHERE fragment — Op.in-aware for an array (a
 * company-less Admin/Entity Admin's resolved owned-Company-id scope, see
 * companyAccessControlService.resolveActorCompanyScope), plain equality for
 * a number. No "omit when undefined" fallback — every function below must
 * always be company-scoped (the cross-tenant mapping IDOR fix); a caller
 * that hasn't resolved a real scope throws instead of silently reading/
 * writing across every tenant's mappings.
 *
 * @param {number|number[]} companyId
 * @returns {object}
 */
function companyScope(companyId) {
  if (Array.isArray(companyId)) {
    return { company_id: { [Op.in]: companyId } };
  }
  return { company_id: companyId };
}

/**
 * Find a mapping row for one (employee, PO) pair, regardless of status —
 * used both to detect a duplicate before creating a new row and (from
 * employeeTimesheetService.assertProjectMapped) as the gate that decides
 * whether an employee may log time against a Service PO.
 *
 * Deliberately NOT company-scoped — unlike every other function in this
 * file. `uq_employee_servicepo_mapping` is a UNIQUE constraint on
 * (employee_id, service_po_id) alone (no company_id), so at most one row
 * can ever match this pair regardless of which company it carries; a
 * companyId filter here can therefore only ever turn a real match into a
 * false negative, never resolve an ambiguity. This matters because
 * employeeServicePOMappingService.assign() intentionally allows mapping an
 * Employee to a Service PO in a DIFFERENT company/Business Unit than their
 * own home one (cross-BU resourcing) — a strict companyId match previously
 * broke exactly that case: an employee genuinely mapped to a PO under a BU
 * they don't personally belong to got "Service PO #X is not assigned to
 * you" when trying to log time, even though the mapping row was real and
 * active. Every caller (assign()'s duplicate check, this file's own
 * removeMapping()/activateMapping() callers via the service layer,
 * managerSelfServiceService.removeServicePOFromEmployee()) already
 * authorizes the employeeId/servicePOId pair through its own separate
 * check before or via this lookup, same precedent as findByServicePO()
 * below.
 * @param {number} employeeId
 * @param {number} servicePOId
 * @returns {Promise<EmployeeServicePOMapping|null>}
 */
const findByEmployeeAndPO = async (employeeId, servicePOId) => {
  return EmployeeServicePOMapping.findOne({
    where: { employee_id: employeeId, service_po_id: servicePOId },
  });
};

/**
 * Find a single mapping row by primary key.
 * @param {number} id
 * @param {number|number[]} companyId
 * @returns {Promise<EmployeeServicePOMapping|null>}
 */
const findById = async (id, companyId) => {
  return EmployeeServicePOMapping.findOne({ where: { id, ...companyScope(companyId) } });
};

/**
 * Insert a new mapping row.
 * @param {object} data - { company_id, employee_id, service_po_id, status, created_by, updated_by }
 * @returns {Promise<EmployeeServicePOMapping>}
 */
const create = async (data) => {
  return EmployeeServicePOMapping.create(data);
};

/**
 * Bulk-insert mapping rows, e.g. one employee -> many Centralised Service
 * POs. ignoreDuplicates relies on uq_employee_servicepo_mapping
 * (employee_id, service_po_id) so re-running this for an already-mapped
 * pair (e.g. manually assigned first) is a no-op rather than an error —
 * mirrors servicePORepository.allocateResources()'s bulkCreate pattern.
 * @param {object[]} records - [{ company_id, employee_id, service_po_id, status, created_by, updated_by }]
 * @param {object} [options] - Sequelize options, e.g. { transaction }
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const bulkCreate = async (records, options) => {
  if (!records.length) return [];
  return EmployeeServicePOMapping.bulkCreate(records, { ignoreDuplicates: true, ...options });
};

/**
 * Update a mapping row's status.
 * @param {number} id
 * @param {string} status - 'active' | 'inactive'
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<EmployeeServicePOMapping|null>}
 */
const updateStatus = async (id, status, updatedBy, companyId) => {
  const mapping = await EmployeeServicePOMapping.findOne({ where: { id, ...companyScope(companyId) } });
  if (!mapping) return null;
  return mapping.update({ status, updated_by: updatedBy });
};

/**
 * Hard-delete a mapping row.
 * @param {number} id
 * @param {number|number[]} companyId
 * @returns {Promise<number>} rows deleted
 */
const remove = async (id, companyId) => {
  return EmployeeServicePOMapping.destroy({ where: { id, ...companyScope(companyId) } });
};

/**
 * List every Service PO mapped to one Employee, joined with the PO's
 * name/code, optionally filtered by status. This is the ONLY query the
 * Employee Timesheet module (Phase 3) uses to discover which Service POs an
 * employee may self-log time against — unmapped POs are never returned.
 *
 * Also matches this SAME employee's mapping(s) to a BU-less Centralised
 * Service PO (company_id NULL on the mapping row — see
 * employeeServicePOMappingService.autoMapCentralisedServicePOs()). Safe to
 * OR in unconditionally here (unlike the rest of this file's strictly
 * company-scoped functions): `employee_id: employeeId` is always a fixed,
 * specific filter already, so this only ever additionally reveals THIS
 * employee's own BU-less mappings, never another employee's or another
 * company's.
 * @param {number} employeeId
 * @param {number} companyId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const findByEmployee = async (employeeId, companyId, status) => {
  const where = {
    employee_id: employeeId,
    [Op.or]: [companyScope(companyId), { company_id: null }],
  };
  if (status) where.status = status;

  return EmployeeServicePOMapping.findAll({
    where,
    include: [
      {
        model: ServicePO,
        as: 'servicePO',
        attributes: ['id', 'service_po_code', 'service_po_name', 'status', 'client_id'],
      },
    ],
    order: [['created_at', 'DESC']],
  });
};

/**
 * List EVERY Service PO mapped to one Employee, with NO company filter at
 * all — used only by employeeTimesheetService.getMappedProjects() (the
 * Service PO dropdown for the Employee Self Timesheet form), which is
 * always called with the AUTHENTICATED employee's own req.employeeId, never
 * a path/body-supplied id. There is no cross-tenant IDOR risk here (unlike
 * findByEmployee(), which the Admin-facing controller also calls for an
 * arbitrary employeeId and so must stay company-scoped): an employee is
 * always entitled to see every one of their OWN mappings regardless of
 * which Business Unit the mapped Service PO belongs to, since
 * employeeServicePOMappingService.assign() intentionally allows cross-BU
 * resourcing. Without this, a PO mapped under a different BU than the
 * employee's own home company would silently never appear in their own
 * dropdown even though they hold an active mapping to it.
 * @param {number} employeeId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const findAllByEmployee = async (employeeId, status) => {
  const where = { employee_id: employeeId };
  if (status) where.status = status;

  return EmployeeServicePOMapping.findAll({
    where,
    include: [
      {
        model: ServicePO,
        as: 'servicePO',
        attributes: ['id', 'service_po_code', 'service_po_name', 'status', 'client_id'],
      },
    ],
    order: [['created_at', 'DESC']],
  });
};

/**
 * Same as findAllByEmployee(), plus the Service PO's Project (id + name) —
 * for the Employee Project Hours report (employeeProjectHoursReportService.js),
 * which groups a mapped PO under its Project. Kept as a separate function
 * rather than adding the extra include to findAllByEmployee() itself, so
 * every other existing caller of findAllByEmployee() is completely
 * unaffected.
 *
 * Deliberately NEVER company/BU-scoped (same reasoning as
 * findAllByEmployee()'s doc comment): the employee↔Service PO mapping is the
 * sole source of truth for "which Service POs can this employee see," not
 * their own Business Unit or the mapped PO's project's Business Unit. A
 * mapping made under a different BU than the employee's own home one
 * (cross-BU resourcing — see employeeServicePOMappingService.assign()) must
 * stay visible here exactly as it does in
 * employeeTimesheetService.getMappedProjects()/buildServicePOsForDate — this
 * function previously filtered by companyId and silently dropped such
 * mappings from the Project Hours report while `/employee-timesheets/daily`
 * kept showing them, producing two disagreeing lists of "my Service POs" for
 * the same employee.
 * @param {number} employeeId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const findAllByEmployeeWithProject = async (employeeId, status) => {
  const where = { employee_id: employeeId };
  if (status) where.status = status;

  return EmployeeServicePOMapping.findAll({
    where,
    include: [
      {
        model: ServicePO,
        as: 'servicePO',
        attributes: ['id', 'service_po_code', 'service_po_name', 'status', 'client_id', 'project_id'],
        include: [
          {
            model: Project,
            as: 'project',
            attributes: ['id', 'project_code', 'project_name'],
            required: false,
          },
        ],
      },
    ],
    order: [['created_at', 'DESC']],
  });
};

/**
 * List every Employee mapped to one Service PO, joined with the employee's
 * name/code, optionally filtered by status.
 *
 * Deliberately NOT company-scoped here (unlike every other function in this
 * file) — a Centralised (BU-less) Service PO's own mapping rows carry
 * company_id: null, which no actor's resolved scope could ever match via
 * the usual companyScope(). Authorization is the caller's responsibility
 * BEFORE calling this — see employeeServicePOMappingService.
 * getServicePOEmployees(), which verifies the actor may see this exact
 * servicePOId via servicePORepository.findById() first. servicePOId already
 * narrows this query to exactly one, already-authorized PO.
 *
 * @param {number} servicePOId
 * @param {string} [status]
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const findByServicePO = async (servicePOId, status) => {
  const where = { service_po_id: servicePOId };
  if (status) where.status = status;

  return EmployeeServicePOMapping.findAll({
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
      },
    ],
    order: [['created_at', 'DESC']],
  });
};

/**
 * Find every mapping row (any status) for one Employee, narrowed to a
 * specific set of Service PO ids — the diff-sync base query for
 * employeeServicePOMappingService.saveEmployeeServicePOMappings(). Callers
 * pass exactly the SAME eligible-PO id set the GET options endpoint
 * computed, so this only ever touches rows within that already-authorized
 * set — a mapping made outside it (e.g. a legitimate cross-BU mapping via
 * the single assign() endpoint) is never seen or altered by the bulk save.
 * @param {number} employeeId
 * @param {number[]} servicePOIds
 * @returns {Promise<EmployeeServicePOMapping[]>}
 */
const findByEmployeeAndPOIds = async (employeeId, servicePOIds) => {
  if (!servicePOIds.length) return [];
  return EmployeeServicePOMapping.findAll({
    where: { employee_id: employeeId, service_po_id: { [Op.in]: servicePOIds } },
  });
};

/**
 * Bulk-update the status of several mapping rows by id — the bulk save's
 * activate/deactivate step, one statement instead of N.
 * @param {number[]} ids
 * @param {string} status - 'active' | 'inactive'
 * @param {number} updatedBy
 * @returns {Promise<number>} rows updated
 */
const bulkUpdateStatus = async (ids, status, updatedBy) => {
  if (!ids.length) return 0;
  const [count] = await EmployeeServicePOMapping.update(
    { status, updated_by: updatedBy },
    { where: { id: { [Op.in]: ids } } }
  );
  return count;
};

module.exports = {
  findByEmployeeAndPO,
  findById,
  create,
  bulkCreate,
  updateStatus,
  remove,
  findByEmployee,
  findAllByEmployee,
  findAllByEmployeeWithProject,
  findByServicePO,
  findByEmployeeAndPOIds,
  bulkUpdateStatus,
};
