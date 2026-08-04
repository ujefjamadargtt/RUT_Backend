'use strict';

const { ServicePOHierarchy } = require('../models');

/**
 * Service PO Hierarchy Repository
 * Raw database access for service_po_hierarchy — no business logic (depth
 * rules, PARENT/CHILD type checks, company/tenant ownership, cascade-delete
 * orchestration all live in servicePOHierarchyService.js).
 *
 * This table has no company_id column — every function here is scoped only
 * by service_po_id/id, exactly as stored. The service layer is responsible
 * for confirming the relevant service_po_id belongs to the caller's company
 * (via servicePORepository.findById) BEFORE calling into this repository.
 */

/**
 * Every node (both PARENT and CHILD rows) for one Service PO — the service
 * layer nests this into a tree.
 *
 * @param {number} servicePOId
 * @returns {Promise<ServicePOHierarchy[]>}
 */
const findByServicePO = async (servicePOId) => {
  return ServicePOHierarchy.findAll({
    where: { service_po_id: servicePOId },
    order: [['node_type', 'ASC'], ['display_order', 'ASC'], ['id', 'ASC']],
  });
};

/**
 * Every node across MULTIPLE Service POs in one query — used by
 * employeeTimesheetService.getMappedProjects so the whole hierarchy for
 * every mapped PO is fetched in a single round-trip instead of one query
 * per PO.
 *
 * @param {number[]} servicePOIds
 * @returns {Promise<ServicePOHierarchy[]>}
 */
const findByServicePOIds = async (servicePOIds) => {
  if (!servicePOIds || servicePOIds.length === 0) return [];
  return ServicePOHierarchy.findAll({
    where: { service_po_id: servicePOIds },
    order: [['service_po_id', 'ASC'], ['node_type', 'ASC'], ['display_order', 'ASC'], ['id', 'ASC']],
  });
};

/**
 * A single node by its own id, with no scoping — callers (the service
 * layer) are responsible for then verifying the returned row's
 * service_po_id belongs to the caller's company.
 *
 * @param {number} id
 * @returns {Promise<ServicePOHierarchy|null>}
 */
const findById = async (id) => {
  return ServicePOHierarchy.findOne({ where: { id } });
};

/**
 * A single node, scoped to a specific Service PO — used by the nested
 * "create Child under Parent" route, where the Service PO has already been
 * authorized by the caller.
 *
 * @param {number} id
 * @param {number} servicePOId
 * @returns {Promise<ServicePOHierarchy|null>}
 */
const findByIdAndServicePO = async (id, servicePOId) => {
  return ServicePOHierarchy.findOne({ where: { id, service_po_id: servicePOId } });
};

/**
 * A single node, scoped to a Service PO, WITH its parentNode loaded (only
 * populated when the node is a CHILD) — everything
 * servicePOHierarchyDTO.buildBreadcrumb() needs in one query. Used when
 * validating hierarchy_node_id on a timesheet entry, so the breadcrumb for
 * the create/update response can be built without a second lookup.
 *
 * @param {number} id
 * @param {number} servicePOId
 * @returns {Promise<ServicePOHierarchy|null>}
 */
const findByIdAndServicePOWithParent = async (id, servicePOId) => {
  return ServicePOHierarchy.findOne({
    where: { id, service_po_id: servicePOId },
    include: [{ model: ServicePOHierarchy, as: 'parentNode' }],
  });
};

/**
 * Every node in `ids`, each WITH its parentNode loaded — the batched
 * version of findByIdAndServicePOWithParent, used wherever multiple
 * entries/rows need breadcrumbs built at once (monthly-summary, daily
 * entries) so it's one query, not one per entry.
 *
 * @param {number[]} ids
 * @returns {Promise<ServicePOHierarchy[]>}
 */
const findByIdsWithParent = async (ids) => {
  if (!ids || ids.length === 0) return [];
  return ServicePOHierarchy.findAll({
    where: { id: ids },
    include: [{ model: ServicePOHierarchy, as: 'parentNode' }],
  });
};

/**
 * Direct children of a PARENT node.
 *
 * @param {number} parentHierarchyId
 * @returns {Promise<ServicePOHierarchy[]>}
 */
const findChildren = async (parentHierarchyId) => {
  return ServicePOHierarchy.findAll({
    where: { parent_hierarchy_id: parentHierarchyId },
    order: [['display_order', 'ASC'], ['id', 'ASC']],
  });
};

/**
 * Insert a new hierarchy node (PARENT or CHILD).
 *
 * @param {object} data
 * @returns {Promise<ServicePOHierarchy>}
 */
const create = async (data) => {
  return ServicePOHierarchy.create(data);
};

/**
 * Rename/reorder a node by its own id.
 *
 * @param {number} id
 * @param {object} data
 * @returns {Promise<ServicePOHierarchy|null>}
 */
const update = async (id, data) => {
  const [affectedRows, [updated]] = await ServicePOHierarchy.update(data, {
    where: { id },
    returning: true,
  });
  return affectedRows === 0 ? null : updated;
};

/**
 * Hard-delete one or more nodes by id. Used for both a single CHILD delete
 * and, from the service layer, a PARENT + all its children in one call.
 *
 * @param {number[]} ids
 * @returns {Promise<number>} rows deleted
 */
const deleteByIds = async (ids) => {
  return ServicePOHierarchy.destroy({ where: { id: ids } });
};

module.exports = {
  findByServicePO,
  findByServicePOIds,
  findById,
  findByIdAndServicePO,
  findByIdAndServicePOWithParent,
  findByIdsWithParent,
  findChildren,
  create,
  update,
  deleteByIds,
};
