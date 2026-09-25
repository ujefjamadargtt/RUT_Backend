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
 * `centralisedOwnerIds`, when a non-empty array, additionally matches a
 * Centralised Service PO with no Business Unit at all (`company_id IS NULL
 * AND is_centralised = true AND created_by IN (centralisedOwnerIds)`) —
 * such a PO is visible to every Business Unit it was auto-mapped into (see
 * getActiveCentralisedPOIds()'s doc comment), so a strict company_id match
 * alone would wrongly hide it from PO Master's list/detail/allocate/
 * dropdown paths for a BU-scoped actor (BU Admin/Project Manager). The
 * `created_by IN (...)` guard is the TENANT boundary — callers must resolve
 * `centralisedOwnerIds` via companyAccessControlService.
 * resolveCentralisedOwnerCreatorIds(), the Admin(s)/Entity Admin who
 * actually administer the CALLER's own Business Unit(s), never every
 * Centralised PO on the platform — without it, one Admin's Centralised PO
 * would leak into an unrelated Admin's own PO Master list just because both
 * happen to be `company_id: null`.
 *
 * Applies to BOTH the plain-number form (a BU-scoped actor authenticated
 * via the `authenticate` chain — req.companyId) AND the ARRAY form — a
 * BU-scoped actor reaches list/detail/active-list/utilisation via the
 * `authenticateReadMultiBU` chain instead (see servicePO.routes.js), which
 * resolves their scope as `req.companyIds`, ALWAYS an array even for a
 * single mapped Business Unit (resolveReportCompanyScope() always returns
 * one), so the array form is by far the more common shape these callers
 * actually see in real traffic, not the exception. Only widens read/view/
 * map access — never opted into by update()/close()/softDelete(), so a
 * BU-scoped actor can still never edit, close, or delete a Centralised PO.
 * No effect when `centralisedOwnerIds` is omitted/empty (the default).
 *
 * `mappedServicePOIds` — for a Project Manager/Delivery Head, whose
 * visibility is driven ENTIRELY by individual mapping
 * (employee_servicepo_mapping, an active row) rather than Business Unit
 * membership: a PO mapped to them shows regardless of whether its own BU is
 * one of theirs, and — just as importantly — a PO in their own mapped BU
 * that ISN'T individually mapped to them stays hidden. So passing an ARRAY
 * here (even an empty one — "this actor qualifies, but has zero mappings
 * right now") REPLACES the `company_id`/`centralisedOwnerIds` matching
 * entirely with `id IN (mappedServicePOIds)`, rather than adding to it.
 * `null` (the default) means "not applicable for this actor" — every other
 * role keeps its normal BU/Centralised scoping, completely unaffected.
 * Callers resolve this via servicePOService.resolveIndividuallyMappedServicePOIds(),
 * which returns `null` for every role except Project Manager/Delivery Head.
 * Read/view only, same as `centralisedOwnerIds` — never opted into by
 * update()/close()/softDelete().
 *
 * @param {number|number[]|null} companyId
 * @param {number|null} [createdBy]
 * @param {number[]|null} [centralisedOwnerIds]
 * @param {number[]|null} [mappedServicePOIds] - non-null (possibly empty)
 *   overrides companyId/centralisedOwnerIds entirely; null/omitted leaves
 *   them in full effect.
 * @returns {object}
 */
function companyScope(companyId, createdBy = null, centralisedOwnerIds = null, mappedServicePOIds = null) {
  if (Array.isArray(mappedServicePOIds)) {
    return { id: { [Op.in]: mappedServicePOIds } };
  }

  const includeCentralised = Array.isArray(centralisedOwnerIds) && centralisedOwnerIds.length > 0;
  if (Array.isArray(companyId)) {
    const clauses = [{ company_id: { [Op.in]: companyId } }];
    if (createdBy != null) {
      clauses.push({ company_id: null, created_by: createdBy });
    }
    if (includeCentralised) {
      clauses.push({ company_id: null, is_centralised: true, created_by: { [Op.in]: centralisedOwnerIds } });
    }
    return clauses.length === 1 ? clauses[0] : { [Op.or]: clauses };
  }
  if (includeCentralised && typeof companyId === 'number') {
    return {
      [Op.or]: [
        { company_id: companyId },
        { company_id: null, is_centralised: true, created_by: { [Op.in]: centralisedOwnerIds } },
      ],
    };
  }
  return { company_id: companyId };
}

/**
 * The Centralised Service POs belonging to one Admin tenant —
 * `centralisedTenant` is companyAccessControlService.
 * resolveCentralisedServicePOTenant()'s `{ companyIds, ownerIds }`: a
 * Centralised PO stamped with one of the tenant's Business Units, or a
 * BU-less one created by one of the tenant's Admin/Entity Admins.
 *
 * A Centralised PO is NOT globally visible — this replaces the former
 * unconditional `{ is_centralised: true }` OR, which let every Admin see
 * every other Admin's Centralised POs. `null`/empty (omitted) matches
 * nothing, so a caller that forgets to resolve a tenant fails closed.
 *
 * @param {{ companyIds?: number[], ownerIds?: number[] }|null} centralisedTenant
 * @returns {object|null} a WHERE fragment, or null when nothing can match
 */
function centralisedTenantScope(centralisedTenant) {
  if (!centralisedTenant || typeof centralisedTenant !== 'object') return null;
  const { companyIds = [], ownerIds = [] } = centralisedTenant;
  const clauses = [];
  if (companyIds.length > 0) clauses.push({ company_id: { [Op.in]: companyIds } });
  if (ownerIds.length > 0) clauses.push({ company_id: null, created_by: { [Op.in]: ownerIds } });
  if (clauses.length === 0) return null;
  return { is_centralised: true, [Op.or]: clauses };
}

/**
 * `scope` OR this tenant's Centralised POs (see centralisedTenantScope()).
 * @param {object} scope
 * @param {{ companyIds?: number[], ownerIds?: number[] }|null} centralisedTenant
 * @returns {object}
 */
function withCentralisedTenant(scope, centralisedTenant) {
  const centralised = centralisedTenantScope(centralisedTenant);
  return centralised ? { [Op.or]: [scope, centralised] } : scope;
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
  const { search, status, client_id, project_id, service_category_id, service_type_id, service_po_id, is_billable, start_date_from, start_date_to, companyId, createdBy, centralisedOwnerIds, mappedServicePOIds, centralisedTenant } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'created_at', sortOrder = 'DESC' } = sort;

  // companyScope(), when createdBy is given, may itself be an [Op.or]
  // fragment (in-scope-companies OR my-own-unassigned record) — kept in
  // its own [Op.and] entry so the search filter below (which needs its own,
  // unrelated Op.or) can never collide with and overwrite it under the same
  // object key — same fix as projectRepository.findAll().
  //
  // centralisedOwnerIds — PO Master's list must show a BU-scoped actor's
  // applicable Centralised POs alongside their own BU's POs, not just the
  // latter, but only the ones administered by THEIR OWN tenant. See
  // companyScope()'s doc comment.
  //
  // mappedServicePOIds — for a Project Manager/Delivery Head, REPLACES the
  // BU/Centralised scoping above with exactly their individually-mapped
  // POs, even outside their own BU(s) — never a union. See companyScope()'s
  // doc comment.
  //
  // centralisedTenant — every Centralised PO of the caller's OWN Admin
  // tenant is OR'd in (including over the Project Manager/Delivery Head
  // mappedServicePOIds override), never another Admin's. See
  // centralisedTenantScope()'s doc comment.
  const where = {
    is_deleted: false,
    [Op.and]: [withCentralisedTenant(companyScope(companyId, createdBy, centralisedOwnerIds, mappedServicePOIds), centralisedTenant)],
  };

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
 * @param {number[]|null} [centralisedOwnerIds] - see companyScope()'s doc
 *   comment; omit/empty so a plain lookup stays strictly BU-scoped (update()/
 *   close()/deleteServicePO() rely on this default).
 * @param {number[]|null} [mappedServicePOIds] - see companyScope()'s doc
 *   comment; omit/empty so a plain lookup stays strictly BU-scoped (same
 *   default rule as centralisedOwnerIds above).
 * @param {{ companyIds: number[], ownerIds: number[] }|null} [centralisedTenant] -
 *   explicit opt-in, default null: also match the caller's OWN Admin
 *   tenant's Centralised POs (see centralisedTenantScope()) — ONLY for
 *   read/view/map callers that ask for it. Defaults to null so update()/
 *   close()/deleteServicePO() (which never pass this) keep their strict
 *   BU-scoped behavior — a BU-scoped actor still can't edit/close/delete a
 *   Centralised PO just because it's viewable.
 * @returns {Promise<ServicePO|null>}
 */
const findById = async (id, companyId, createdBy = null, centralisedOwnerIds = null, mappedServicePOIds = null, centralisedTenant = null) => {
  const scope = withCentralisedTenant(companyScope(companyId, createdBy, centralisedOwnerIds, mappedServicePOIds), centralisedTenant);
  return ServicePO.findOne({
    // Op.and, not object spread: when mappedServicePOIds is given,
    // companyScope() itself returns an `id` key (see its doc comment) —
    // spreading it here would silently overwrite the requested `id` above
    // instead of narrowing by it, matching ANY individually-mapped PO rather
    // than specifically this one.
    where: {
      id,
      is_deleted: false,
      [Op.and]: [scope],
    },
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
 * @param {number|number[]} companyId - the PO's CURRENT company_id (WHERE scope)
 * @param {object} [options] - Sequelize options, e.g. { transaction }
 * @returns {Promise<ServicePO|null>}
 */
const update = async (id, data, companyId, options) => {
  const [affectedRows, [updated]] = await ServicePO.update(data, {
    where: { id, ...companyScope(companyId) },
    returning: true,
    ...options,
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
 * @param {number[]|null} [centralisedOwnerIds] - see companyScope()'s doc comment
 * @param {{ companyIds: number[], ownerIds: number[] }|null} [centralisedTenant] - see centralisedTenantScope()'s doc comment
 * @returns {Promise<ServicePO[]>}
 */
const getActivePOs = async (companyId, createdBy = null, centralisedOwnerIds = null, centralisedTenant = null) => {
  return ServicePO.findAll({
    where: {
      status: { [Op.in]: ['in-progress', 'on-hold', 'pending'] },
      is_deleted: false,
      // The caller's own Admin tenant's Centralised POs only — see
      // findAll()'s identical comment above.
      [Op.and]: [withCentralisedTenant(companyScope(companyId, createdBy, centralisedOwnerIds), centralisedTenant)],
    },
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
 * Centralised Service PO of ONE Admin tenant — "active" here is the same
 * status set getActivePOs() already uses. A Centralised PO is for every
 * Employee of its own Admin tenant (any of that tenant's Business Units),
 * never for another Admin's Employees — see centralisedTenantScope().
 * Fails closed: no tenant (or an empty one) returns [] rather than every
 * Centralised PO on the platform.
 *
 * @param {{ companyIds: number[], ownerIds: number[] }|null} centralisedTenant
 * @returns {Promise<{id: number, company_id: number|null, created_by: number|null}[]>}
 */
const getActiveCentralisedPOIds = async (centralisedTenant) => {
  const tenantScope = centralisedTenantScope(centralisedTenant);
  if (!tenantScope) return [];
  const rows = await ServicePO.findAll({
    where: {
      ...tenantScope,
      is_deleted: false,
      status: { [Op.in]: ['in-progress', 'on-hold', 'pending'] },
    },
    attributes: ['id', 'company_id', 'created_by'],
  });
  return rows.map((r) => ({ id: r.id, company_id: r.company_id, created_by: r.created_by }));
};

/**
 * Which of the given Service PO ids are flagged is_centralised=true — used
 * by the Timesheet Approval redesign's Project-Manager scope resolution
 * (employeeServicePOMappingService.getProjectManagerServicePOIds/
 * getProjectManagersForServicePOs) to EXCLUDE centralised POs (Leaves, On
 * Bench, Training & Upskilling, HR and Admin Activity, etc.) from "which
 * Service POs is this employee the Project Manager of." A Centralised PO is
 * auto-mapped to EVERY Employee (see autoMapCentralisedServicePOs()) —
 * an employee_servicepo_mapping row against one reflects that blanket
 * auto-mapping, never a genuine PM-ownership assignment, so it must never
 * be treated as "this employee approves this PO's work" or "this PO's
 * Project Manager should be reminded about this pending Leave/Bench entry."
 *
 * @param {number[]} servicePoIds
 * @returns {Promise<number[]>}
 */
const findCentralisedIdsAmong = async (servicePoIds) => {
  if (!servicePoIds || servicePoIds.length === 0) return [];
  const rows = await ServicePO.findAll({
    where: { id: { [Op.in]: servicePoIds }, is_centralised: true },
    attributes: ['id'],
    raw: true,
  });
  return rows.map((r) => r.id);
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
 * `unrestricted: true` (the target Employee holds Project Manager or
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
 * @param {{ companyIds: number[], ownerIds: number[] }|null} [params.centralisedTenant] - see centralisedTenantScope()
 * @returns {Promise<ServicePO[]>}
 */
const getEligibleForMapping = async ({ companyId, createdBy = null, unrestricted, businessUnitIds = [], centralisedTenant = null }) => {
  const scopeConditions = [companyScope(companyId, createdBy)];

  if (!unrestricted) {
    const buOr = [{ company_id: null }];
    if (businessUnitIds.length) buOr.push({ company_id: { [Op.in]: businessUnitIds } });
    scopeConditions.push({ [Op.or]: buOr });
  }

  const where = {
    is_deleted: false,
    status: { [Op.in]: ['in-progress', 'on-hold', 'pending'] },
    // A Centralised Service PO of the caller's OWN Admin tenant is eligible
    // for every Employee regardless of the target Employee's Business Unit —
    // OR'd in independently of the BU scoping above (which still applies to
    // every non-Centralised PO), but never another Admin's. See
    // centralisedTenantScope().
    [Op.and]: [withCentralisedTenant({ [Op.and]: scopeConditions }, centralisedTenant)],
  };

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
  centralisedTenantScope,
  findCentralisedIdsAmong,
  getEligibleForMapping,
};
