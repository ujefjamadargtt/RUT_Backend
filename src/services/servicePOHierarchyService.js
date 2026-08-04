'use strict';

const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const servicePORepository = require('../repositories/servicePORepository');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const servicePOHierarchyDTO = require('../dtos/servicePOHierarchyDTO');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Service PO Hierarchy Service
 *
 * Hierarchy belongs to exactly ONE Service PO. Max depth 2 inside that PO:
 *   Service PO
 *     Parent      (parent_hierarchy_id = NULL, node_type = 'PARENT')
 *       Child     (parent_hierarchy_id = the Parent's id, node_type = 'CHILD')
 * A CHILD can never itself be a parent_hierarchy_id target — there is no
 * Child -> Child. This is a completely separate table/module from
 * `service_pos` — nothing here ever calls servicePORepository.create() or
 * .update(), only .findById() to confirm a Service PO exists in the
 * caller's company.
 *
 * service_po_hierarchy has no company_id column of its own — every
 * operation proves tenant ownership by resolving through service_po_id ->
 * servicePORepository.findById(servicePOId, companyId), which is already
 * company-scoped.
 */

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Confirm the Service PO exists, isn't soft-deleted, and belongs to this
 * company — the gate every servicePoId-scoped hierarchy operation starts
 * with.
 */
async function assertServicePOExists(servicePOId, companyId) {
  const po = await servicePORepository.findById(servicePOId, companyId);
  if (!po) {
    throw notFoundError(`Service PO #${servicePOId} was not found.`);
  }
  return po;
}

/**
 * Load a hierarchy node by its own id and confirm it belongs to a Service
 * PO in the caller's company — the gate the flat (no servicePoId in the
 * URL) rename/delete routes use instead of assertServicePOExists.
 */
async function loadNodeForCompany(hierarchyId, companyId) {
  const node = await servicePOHierarchyRepository.findById(hierarchyId);
  if (!node) {
    throw notFoundError(`Hierarchy node #${hierarchyId} was not found.`);
  }
  const po = await servicePORepository.findById(node.service_po_id, companyId);
  if (!po) {
    // Either the PO doesn't exist, is soft-deleted, or belongs to another
    // company — in every case this node is not visible to this caller.
    throw notFoundError(`Hierarchy node #${hierarchyId} was not found.`);
  }
  return node;
}

/**
 * GET /api/v1/service-pos/:servicePoId/hierarchy
 *
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<Array<object>>}
 */
const getTree = async (servicePOId, companyId) => {
  await assertServicePOExists(servicePOId, companyId);
  const rows = await servicePOHierarchyRepository.findByServicePO(servicePOId);
  return servicePOHierarchyDTO.toTree(rows);
};

/**
 * POST /api/v1/service-pos/:servicePoId/hierarchy/parent — create a Parent
 * node.
 *
 * @param {number} servicePOId
 * @param {object} data - { node_name, display_order? }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object>} node DTO
 */
const createParent = async (servicePOId, data, userId, req) => {
  const companyId = req.companyId;
  await assertServicePOExists(servicePOId, companyId);

  const node = await servicePOHierarchyRepository.create({
    service_po_id: servicePOId,
    parent_hierarchy_id: null,
    node_name: data.node_name,
    node_type: 'PARENT',
    display_order: data.display_order ?? 0,
    created_by: userId,
    updated_by: userId,
  });

  await createAuditLog(
    userId, 'CREATE', 'service_po_hierarchy', node.id,
    null, { service_po_id: servicePOId, node_type: 'PARENT', node_name: node.node_name },
    getIpAddress(req)
  );
  logger.info('Service PO hierarchy Parent created', { servicePOId, nodeId: node.id, userId });

  return servicePOHierarchyDTO.toNodeDTO(node);
};

/**
 * POST /api/v1/service-pos/:servicePoId/hierarchy/:parentId/child — create
 * a Child node under an existing Parent node.
 *
 * @param {number} servicePOId
 * @param {number} parentId
 * @param {object} data - { node_name, display_order? }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object>} node DTO
 */
const createChild = async (servicePOId, parentId, data, userId, req) => {
  const companyId = req.companyId;
  await assertServicePOExists(servicePOId, companyId);

  const parent = await servicePOHierarchyRepository.findByIdAndServicePO(parentId, servicePOId);
  if (!parent) {
    throw notFoundError(`Hierarchy node #${parentId} was not found under this Service PO.`);
  }
  if (parent.node_type !== 'PARENT') {
    throw badRequestError('Cannot nest a Child under another Child — maximum depth is Service PO -> Parent -> Child.');
  }

  const node = await servicePOHierarchyRepository.create({
    service_po_id: servicePOId,
    parent_hierarchy_id: parentId,
    node_name: data.node_name,
    node_type: 'CHILD',
    display_order: data.display_order ?? 0,
    created_by: userId,
    updated_by: userId,
  });

  await createAuditLog(
    userId, 'CREATE', 'service_po_hierarchy', node.id,
    null, { service_po_id: servicePOId, parent_hierarchy_id: parentId, node_type: 'CHILD', node_name: node.node_name },
    getIpAddress(req)
  );
  logger.info('Service PO hierarchy Child created', { servicePOId, parentId, nodeId: node.id, userId });

  return servicePOHierarchyDTO.toNodeDTO(node);
};

/**
 * PUT /api/v1/service-pos/hierarchy/:hierarchyId — rename a Parent or
 * Child node (and/or change its display_order). Node type/parent are never
 * changed here — moving a node to a different parent isn't part of this
 * feature. No servicePoId in the URL — ownership is resolved from the
 * node's own service_po_id.
 *
 * @param {number} hierarchyId
 * @param {object} data - { node_name?, display_order? }
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<object>} node DTO
 */
const rename = async (hierarchyId, data, userId, req) => {
  const companyId = req.companyId;
  const existing = await loadNodeForCompany(hierarchyId, companyId);

  const payload = { updated_by: userId };
  if (data.node_name !== undefined) payload.node_name = data.node_name;
  if (data.display_order !== undefined) payload.display_order = data.display_order;

  const updated = await servicePOHierarchyRepository.update(hierarchyId, payload);

  await createAuditLog(
    userId, 'UPDATE', 'service_po_hierarchy', hierarchyId,
    { node_name: existing.node_name, display_order: existing.display_order },
    payload,
    getIpAddress(req)
  );
  logger.info('Service PO hierarchy node renamed', { hierarchyId, userId });

  return servicePOHierarchyDTO.toNodeDTO(updated);
};

/**
 * DELETE /api/v1/service-pos/hierarchy/:hierarchyId — delete a Parent or
 * Child node. Deleting a Parent also deletes all of its Child nodes;
 * deleting a Child removes only that Child. No servicePoId in the URL —
 * ownership is resolved from the node's own service_po_id.
 *
 * Blocked (400) if the node being deleted — or, for a Parent, ANY of its
 * Children — has a work log entry against it (employee_work_logs.
 * hierarchy_node_id). Deleting a Child only ever checks that Child itself;
 * a Parent's check covers the Parent's own entries plus every Child's,
 * since idsToDelete already contains all of them at that point.
 *
 * @param {number} hierarchyId
 * @param {number} userId
 * @param {object} req
 * @returns {Promise<void>}
 */
const remove = async (hierarchyId, userId, req) => {
  const companyId = req.companyId;
  const existing = await loadNodeForCompany(hierarchyId, companyId);

  let idsToDelete = [hierarchyId];
  if (existing.node_type === 'PARENT') {
    const children = await servicePOHierarchyRepository.findChildren(hierarchyId);
    idsToDelete = idsToDelete.concat(children.map((c) => c.id));
  }

  const hasWorkLogs = await employeeWorkLogRepository.existsForHierarchyNodes(idsToDelete, companyId);
  if (hasWorkLogs) {
    throw badRequestError('This hierarchy node cannot be deleted because work log entries exist.');
  }

  await servicePOHierarchyRepository.deleteByIds(idsToDelete);

  await createAuditLog(
    userId, 'DELETE', 'service_po_hierarchy', hierarchyId,
    { node_type: existing.node_type, node_name: existing.node_name, deleted_ids: idsToDelete },
    null,
    getIpAddress(req)
  );
  logger.info('Service PO hierarchy node deleted', { hierarchyId, deletedIds: idsToDelete, userId });
};

module.exports = {
  getTree,
  createParent,
  createChild,
  rename,
  remove,
};
