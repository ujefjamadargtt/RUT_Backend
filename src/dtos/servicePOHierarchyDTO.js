'use strict';

/**
 * Service PO Hierarchy DTOs
 * Shapes raw ServicePOHierarchy rows into the response shapes the API and
 * other modules (employeeTimesheetService.getMappedProjects) return —
 * separate from servicePOHierarchyService.js's business rules (depth,
 * PARENT/CHILD type checks, cascade-delete, tenant ownership).
 */

/**
 * A single node, flat (no children array) — used for create/rename
 * responses.
 *
 * @param {ServicePOHierarchy} row
 * @returns {object}
 */
const toNodeDTO = (row) => ({
  id: row.id,
  service_po_id: row.service_po_id,
  parent_hierarchy_id: row.parent_hierarchy_id,
  node_name: row.node_name,
  node_type: row.node_type,
  display_order: row.display_order,
  status: row.status,
});

/**
 * A single node WITH a `children` array — the unit both toTree() and
 * employee-facing hierarchy responses are built from. Always present
 * (empty for a CHILD, since a CHILD can never have children of its own).
 *
 * @param {ServicePOHierarchy} row
 * @returns {object}
 */
const toTreeNodeDTO = (row) => ({
  ...toNodeDTO(row),
  children: [],
});

/**
 * Nest a flat list of hierarchy rows (PARENT + CHILD, any order) into a
 * tree: PARENT nodes at the top level, each carrying its CHILD nodes in
 * `children`.
 *
 * @param {ServicePOHierarchy[]} rows
 * @returns {Array<object>}
 */
const toTree = (rows) => {
  const nodeById = new Map();
  const parents = [];

  for (const row of rows) {
    if (row.node_type === 'PARENT') {
      const node = toTreeNodeDTO(row);
      nodeById.set(String(row.id), node);
      parents.push(node);
    }
  }
  for (const row of rows) {
    if (row.node_type === 'CHILD') {
      const parentNode = nodeById.get(String(row.parent_hierarchy_id));
      const childNode = toTreeNodeDTO(row);
      // A CHILD whose PARENT is missing (shouldn't happen — FK-enforced —
      // but defensive rather than silently dropping data) surfaces as its
      // own top-level entry instead of vanishing.
      if (parentNode) {
        parentNode.children.push(childNode);
      } else {
        parents.push(childNode);
      }
    }
  }
  return parents;
};

/**
 * Build the full breadcrumb path for a Service PO, optionally deepened by
 * a specific hierarchy node the employee logged hours against:
 *   - no node                      -> "ABC Service PO"
 *   - node is a PARENT             -> "ABC Service PO > Parent 1"
 *   - node is a CHILD (has parentNode loaded) -> "ABC Service PO > Parent 1 > Child 1"
 * Max depth is 2 (Parent, then Child), so this never needs to walk more
 * than one hop up — `node.parentNode` (from findByIdWithParent/
 * findByIdsWithParent) is as far as it ever goes.
 *
 * @param {string} servicePOName
 * @param {ServicePOHierarchy|null} [node]
 * @returns {string}
 */
const buildBreadcrumb = (servicePOName, node) => {
  const parts = [servicePOName];
  if (node) {
    if (node.node_type === 'CHILD' && node.parentNode) {
      parts.push(node.parentNode.node_name);
    }
    parts.push(node.node_name);
  }
  return parts.join(' > ');
};

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Nest a flat list of hierarchy rows for ONE Service PO into a tree, each
 * node carrying `hours` for a single date — the shape
 * employeeTimesheetService.getMonthlySummary returns per Service PO per day.
 * Every PARENT and CHILD row is included even when `hoursByNodeId` has no
 * entry for it (hours default to 0), per the "return every node, logged or
 * not" rule. A CHILD node never carries a `children` key (max depth 2).
 *
 * @param {ServicePOHierarchy[]} rows - all nodes (PARENT + CHILD) for one Service PO
 * @param {Map<string, number>} hoursByNodeId - node id (string) -> hours logged on the date in question
 * @returns {Array<object>}
 */
const toHierarchyTreeWithHours = (rows, hoursByNodeId) => {
  const nodeById = new Map();
  const parents = [];

  for (const row of rows) {
    if (row.node_type === 'PARENT') {
      const node = {
        hierarchy_id: row.id,
        name: row.node_name,
        type: row.node_type,
        hours: round2(hoursByNodeId.get(String(row.id)) || 0),
        children: [],
      };
      nodeById.set(String(row.id), node);
      parents.push(node);
    }
  }
  for (const row of rows) {
    if (row.node_type === 'CHILD') {
      const childNode = {
        hierarchy_id: row.id,
        name: row.node_name,
        type: row.node_type,
        hours: round2(hoursByNodeId.get(String(row.id)) || 0),
      };
      const parentNode = nodeById.get(String(row.parent_hierarchy_id));
      // A CHILD whose PARENT is missing (shouldn't happen — FK-enforced —
      // but defensive rather than silently dropping data) surfaces as its
      // own top-level entry instead of vanishing.
      if (parentNode) {
        parentNode.children.push(childNode);
      } else {
        parents.push(childNode);
      }
    }
  }
  return parents;
};

/**
 * Sum every node's `hours` across a tree built by toHierarchyTreeWithHours —
 * every Parent's hours plus every Child's hours, recursively.
 *
 * @param {Array<object>} nodes
 * @returns {number}
 */
const sumHierarchyHours = (nodes) =>
  nodes.reduce((sum, node) => sum + node.hours + (node.children ? sumHierarchyHours(node.children) : 0), 0);

module.exports = {
  toNodeDTO,
  toTreeNodeDTO,
  toTree,
  buildBreadcrumb,
  toHierarchyTreeWithHours,
  sumHierarchyHours,
};
