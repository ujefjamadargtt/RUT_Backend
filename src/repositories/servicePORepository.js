'use strict';

const { Op, fn, col, literal } = require('sequelize');
const {
  ServicePO,
  ServicePOResource,
  Client,
  Project,
  ServiceType,
  ServiceCategory,
  Employee,
  Timesheet,
  sequelize,
} = require('../models');

/**
 * ServicePO Repository
 * All direct database interaction for service_pos and service_po_resources.
 */

/**
 * Builds a `company_id` WHERE fragment. Accepts a single number (BU-scoped
 * actor's own `req.companyId`), an array (a company-less actor's resolved
 * list of owned Company ids — see companyAccessControlService.
 * resolveActorCompanyScope; an empty array correctly matches nothing), or
 * `null` (a Service PO with no Business Unit at all — a legacy row from
 * before a Business Unit became mandatory at create time; see
 * servicePOService.js's create()/update() — matches only OTHER BU-less
 * POs, e.g. the update-time duplicate-code/name check on such a row).
 * Same pattern as clientRepository.js/projectRepository.js.
 *
 * `createdBy`, when given alongside the ARRAY form, additionally matches a
 * Service PO this SAME company-less actor created with no Business Unit
 * assigned yet (company_id NULL) — `company_id IN (ownedCompanyIds)` alone
 * can never match a NULL row (SQL IN never matches NULL), which would
 * otherwise hide an Admin's own just-created, still-unassigned Service PO
 * from their own list/detail/update/close/delete calls forever. Same fix
 * already applied to Project (projectRepository.companyScope).
 *
 * @param {number|number[]|null} companyId
 * @param {number|null} [createdBy]
 * @returns {object}
 */
function companyScope(companyId, createdBy = null) {
  if (Array.isArray(companyId)) {
    if (createdBy != null) {
      return {
        [Op.or]: [
          { company_id: { [Op.in]: companyId } },
          { company_id: null, created_by: createdBy },
        ],
      };
    }
    return { company_id: { [Op.in]: companyId } };
  }
  return { company_id: companyId };
}

/**
 * Retrieve a paginated, filtered list of Service POs.
 * Joins Client and ServiceType for display columns.
 *
 * @param {object} filters    - { search, status, client_id, service_category_id, service_type_id, service_po_id, is_billable, start_date_from, start_date_to }
 * @param {{ limit: number, offset: number }} pagination
 * @param {{ sortBy: string, sortOrder: string }} sort
 * @returns {Promise<{ rows: ServicePO[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, client_id, project_id, service_category_id, service_type_id, service_po_id, is_billable, start_date_from, start_date_to, companyId, createdBy } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'created_at', sortOrder = 'DESC' } = sort;

  // companyScope(), when createdBy is given, may itself be an [Op.or]
  // fragment (in-scope-companies OR my-own-unassigned record) — kept in
  // its own [Op.and] entry so the search filter below (which needs its own,
  // unrelated Op.or) can never collide with and overwrite it under the same
  // object key — same fix as projectRepository.findAll().
  const where = { is_deleted: false, [Op.and]: [companyScope(companyId, createdBy)] };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (client_id) {
    where.client_id = client_id;
  }

  if (project_id) {
    where.project_id = project_id;
  }

  if (service_type_id) {
    where.service_type_id = service_type_id;
  }

  if (service_po_id) {
    where.id = service_po_id;
  }

  if (typeof is_billable === 'boolean') {
    where.is_billable = is_billable;
  }

  if (start_date_from) {
    where.start_date = { ...(where.start_date || {}), [Op.gte]: start_date_from };
  }

  if (start_date_to) {
    where.start_date = { ...(where.start_date || {}), [Op.lte]: start_date_to };
  }

  if (search && search.trim()) {
    where[Op.and].push({
      [Op.or]: [
        { service_po_name: { [Op.iLike]: `%${search.trim()}%` } },
        { service_po_code: { [Op.iLike]: `%${search.trim()}%` } },
      ],
    });
  }

  const allowedSortColumns = ['service_po_name', 'service_po_code', 'start_date', 'end_date', 'po_value', 'created_at'];
  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
  const safeSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';

  const serviceTypeInclude = {
    model: ServiceType,
    as: 'serviceType',
    attributes: ['id', 'service_type_name'],
    required: !!service_category_id, // NEW
    include: [
      {
        model: ServiceCategory,
        as: 'serviceCategory',
        attributes: ['id', 'name'],
        required: !!service_category_id,
        ...(service_category_id ? { where: { id: service_category_id } } : {}),
      },
    ],
  };

  return ServicePO.findAndCountAll({
    where,
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name'],
      },
      {
        model: Project,
        as: 'project',
        attributes: ['id', 'project_code', 'project_name'],
      },
      {
        model: Employee,
        as: 'deliveryHead',
        attributes: ['id', 'employee_code', 'full_name'],
        required: false,
      },
      serviceTypeInclude,
    ],
    limit,
    offset,
    order: [[safeSortBy, safeSortOrder]],
    distinct: true,
    subQuery: false,
  });
};

/**
 * Retrieve a single Service PO with full details:
 * client, service type, and allocated resources (employees).
 *
 * @param {number} id
 * @param {number|number[]|null} companyId
 * @param {number|null} [createdBy] - see companyScope()'s doc comment
 * @returns {Promise<ServicePO|null>}
 */
const findById = async (id, companyId, createdBy = null) => {
  return ServicePO.findOne({
    where: { id, is_deleted: false, ...companyScope(companyId, createdBy) },
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name', 'industry'],
      },
      {
        model: Project,
        as: 'project',
        attributes: ['id', 'project_code', 'project_name'],
      },
      {
        model: ServiceType,
        as: 'serviceType',
        attributes: ['id', 'service_type_name'],
      },
      {
        model: Employee,
        as: 'deliveryHead',
        attributes: ['id', 'employee_code', 'full_name'],
        required: false,
      },
      {
        model: Employee,
        as: 'employees',
        attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
        through: { attributes: ['id', 'created_at'] },
      },
    ],
  });
};

/**
 * Find a Service PO by its unique code, regardless of status or soft-delete
 * state — used for uniqueness checks so a code held by a closed/cancelled/
 * deleted PO can never be reassigned.
 *
 * @param {string} code
 * @returns {Promise<ServicePO|null>}
 */
const findByCode = async (code, companyId) => {
  return ServicePO.findOne({
    where: { service_po_code: code, ...companyScope(companyId) },
    attributes: ['id', 'service_po_code', 'status'],
  });
};

/**
 * Find a Service PO by its name (case-insensitive), scoped to one company —
 * uniqueness of the human-readable name, alongside the machine-facing code
 * uniqueness findByCode() already enforces. Excludes soft-deleted rows —
 * a cancelled/deleted PO's name is free to reuse.
 *
 * @param {string} name
 * @param {number} companyId
 * @returns {Promise<ServicePO|null>}
 */
const findByName = async (name, companyId) => {
  return ServicePO.findOne({
    where: { service_po_name: { [Op.iLike]: name.trim() }, is_deleted: false, ...companyScope(companyId) },
    attributes: ['id', 'service_po_name'],
  });
};

/**
 * Insert a new Service PO record.
 *
 * @param {object} data
 * @param {object} [options] - Sequelize options, e.g. { transaction } — passed
 *   straight through so a caller (servicePOImportService.js) can run this
 *   inside its own managed transaction.
 * @returns {Promise<ServicePO>}
 */
const create = async (data, options) => {
  return ServicePO.create(data, options);
};

/**
 * Update an existing Service PO by primary key.
 *
 * @param {number} id
 * @param {object} data
 * @returns {Promise<ServicePO|null>}
 */
const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await ServicePO.update(data, {
    where: { id, ...companyScope(companyId) },
    returning: true,
  });

  if (affectedRows === 0) {
    return null;
  }

  return updated;
};

/**
 * Close a Service PO — sets status = 'closed'.
 *
 * @param {number} id
 * @param {number} updatedBy
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const close = async (id, updatedBy, companyId) => {
  const [affectedRows] = await ServicePO.update(
    { status: 'closed', updated_by: updatedBy },
    { where: { id, is_deleted: false, ...companyScope(companyId) } }
  );
  return affectedRows > 0;
};

/**
 * Upsert employee allocations into service_po_resources.
 * Uses bulkCreate with ignoreDuplicates so re-allocating already-assigned
 * employees is idempotent and not an error.
 *
 * @param {number} poId
 * @param {number[]} employeeIds
 * @returns {Promise<ServicePOResource[]>}
 */
const allocateResources = async (poId, employeeIds, companyId) => {
  const records = employeeIds.map((employee_id) => ({
    service_po_id: poId,
    employee_id,
    company_id: companyId,
  }));

  return ServicePOResource.bulkCreate(records, {
    ignoreDuplicates: true,
  });
};

/**
 * Remove a single employee from a Service PO.
 *
 * @param {number} poId
 * @param {number} employeeId
 * @param {number} companyId
 * @returns {Promise<number>} Number of rows deleted
 */
const deallocateResource = async (poId, employeeId, companyId) => {
  return ServicePOResource.destroy({
    where: {
      service_po_id: poId,
      employee_id: employeeId,
      ...companyScope(companyId),
    },
  });
};

/**
 * Return all employees currently allocated to a PO.
 *
 * @param {number} poId
 * @param {number} companyId
 * @returns {Promise<Employee[]>}
 */
const getResources = async (poId, companyId) => {
  const resources = await ServicePOResource.findAll({
    where: { service_po_id: poId, ...companyScope(companyId) },
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
      },
    ],
    attributes: ['id', 'service_po_id', 'employee_id', 'created_at'],
    order: [[{ model: Employee, as: 'employee' }, 'full_name', 'ASC']],
  });

  return resources;
};

/**
 * Sum of hours logged against a PO.
 *
 * @param {number} poId
 * @returns {Promise<{ total_hours_logged: number }>}
 */
const getUtilisation = async (poId, companyId) => {
  const result = await Timesheet.findOne({
    where: { service_po_id: poId, ...companyScope(companyId) },
    attributes: [[fn('COALESCE', fn('SUM', col('hours_logged')), literal('0')), 'total_hours_logged']],
    raw: true,
  });

  return {
    total_hours_logged: parseFloat(result ? result.total_hours_logged : 0),
  };
};

/**
 * Return all active Service POs (for dropdowns, validation lookups etc.).
 *
 * @param {number|number[]|null} companyId
 * @param {number|null} [createdBy] - see companyScope()'s doc comment
 * @returns {Promise<ServicePO[]>}
 */
const getActivePOs = async (companyId, createdBy = null) => {
  return ServicePO.findAll({
    where: { status: { [Op.in]: ['in-progress', 'on-hold', 'pending'] }, is_deleted: false, ...companyScope(companyId, createdBy) },
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name'],
      },
      {
        model: Project,
        as: 'project',
        attributes: ['id', 'project_code', 'project_name'],
      },
      {
        model: ServiceType,
        as: 'serviceType',
        attributes: ['id', 'service_type_name'],
      },
      {
        model: Employee,
        as: 'deliveryHead',
        attributes: ['id', 'employee_code', 'full_name'],
        required: false,
      },
    ],
    attributes: ['id', 'service_po_code', 'service_po_name', 'start_date', 'end_date', 'is_billable', 'company_id'],
    order: [['service_po_name', 'ASC']],
  });
};

/**
 * Return { id, company_id, created_by } for every active, non-deleted
 * Centralised Service PO applicable to a company — "active" here is the
 * same status set getActivePOs() already uses, so the definition of
 * "active" stays consistent everywhere. Matches BOTH this exact company's
 * own Centralised POs (unchanged, original behavior — ownership is already
 * structurally guaranteed by the company_id match itself) AND any
 * Centralised PO with no Business Unit at all (company_id IS NULL). A
 * BU-less Centralised PO is NOT global — it still belongs to whichever
 * Admin/Entity Admin created it — so `created_by` is returned alongside
 * `company_id` for every row; the caller (employeeServicePOMappingService.
 * autoMapCentralisedServicePOs()) is responsible for checking that
 * ownership before mapping a BU-less row, this function only fetches
 * CANDIDATES. `companyId` may itself be `null` (a company-less employee/
 * actor) — that just means there is no specific company left to ALSO match,
 * so only BU-less Centralised POs are candidates.
 *
 * @param {number|null} companyId
 * @returns {Promise<{id: number, company_id: number|null, created_by: number|null}[]>}
 */
const getActiveCentralisedPOIds = async (companyId) => {
  const companyCondition = companyId == null
    ? { company_id: null }
    : { [Op.or]: [{ company_id: companyId }, { company_id: null }] };

  const rows = await ServicePO.findAll({
    where: {
      ...companyCondition,
      is_centralised: true,
      is_deleted: false,
      status: { [Op.in]: ['in-progress', 'on-hold', 'pending'] },
    },
    attributes: ['id', 'company_id', 'created_by'],
  });
  return rows.map((r) => ({ id: r.id, company_id: r.company_id, created_by: r.created_by }));
};

const softDelete = async (id, updatedBy, companyId) => {
  const po = await ServicePO.findOne({ where: { id, is_deleted: false, ...companyScope(companyId) } });
  if (!po) return null;
  return po.update({ status: 'cancelled', is_deleted: true, updated_by: updatedBy });
};

/**
 * Return every eligible Service PO for the Employee Service PO Mapping
 * screen (employeeServicePOMappingService.getServicePOOptionsForEmployee()/
 * saveEmployeeServicePOMappings()) — same "active-ish" status set as
 * getActivePOs() above, scoped to the CALLER's authorized company/tenant
 * scope via companyScope() (the hard tenant boundary — never bypassed).
 *
 * `unrestricted: true` (the target Employee holds Service PO Admin or
 * Delivery Head — see employeeServicePOMappingService.
 * hasUnrestrictedServicePOVisibility()) additionally skips any Business
 * Unit narrowing: every eligible PO across the caller's whole authorized
 * scope is returned, regardless of the target Employee's own BU. This is
 * the ticket's core rule — that role must never have its Service PO
 * mapping narrowed by its own BU membership.
 *
 * `unrestricted: false` additionally requires the PO's own company_id to
 * be either one of `businessUnitIds` (the target Employee's own active
 * Business Units) or NULL (a Centralised, BU-less PO — already
 * auto-mapped to every employee regardless of BU at creation time, see
 * autoMapCentralisedServicePOs(), so it stays visible/eligible here too).
 *
 * @param {object} params
 * @param {number|number[]} params.companyId - caller's authorized scope
 * @param {number|null} [params.createdBy] - see companyScope()'s doc comment
 * @param {boolean} params.unrestricted
 * @param {number[]} [params.businessUnitIds]
 * @returns {Promise<ServicePO[]>}
 */
const getEligibleForMapping = async ({ companyId, createdBy = null, unrestricted, businessUnitIds = [] }) => {
  const where = {
    is_deleted: false,
    status: { [Op.in]: ['in-progress', 'on-hold', 'pending'] },
    [Op.and]: [companyScope(companyId, createdBy)],
  };

  if (!unrestricted) {
    const buOr = [{ company_id: null }];
    if (businessUnitIds.length) buOr.push({ company_id: { [Op.in]: businessUnitIds } });
    where[Op.and].push({ [Op.or]: buOr });
  }

  return ServicePO.findAll({
    where,
    include: [
      { model: Client, as: 'client', attributes: ['id', 'client_code', 'client_name'] },
      { model: Project, as: 'project', attributes: ['id', 'project_code', 'project_name'] },
    ],
    attributes: ['id', 'service_po_code', 'service_po_name', 'company_id', 'is_centralised', 'status'],
    order: [['service_po_name', 'ASC']],
  });
};

module.exports = {
  findAll,
  findById,
  findByCode,
  findByName,
  create,
  update,
  close,
  softDelete,
  allocateResources,
  deallocateResource,
  getResources,
  getUtilisation,
  getActivePOs,
  getActiveCentralisedPOIds,
  getEligibleForMapping,
};
