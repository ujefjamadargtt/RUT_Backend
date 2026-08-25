'use strict';

const platformAdminRepository = require('../repositories/platformAdminRepository');

/**
 * Platform Admin Organization Overview — assembles the three independent
 * reads from platformAdminRepository (Companies/BUs, Projects+ServicePOs,
 * Employees) into one plain-JSON payload (the `users` key is kept for
 * frontend compatibility, even though its rows are Employees now — see
 * mapUser's doc comment). Pure mapping only; every relationship (BU->Entity,
 * Project->Client/ServicePO, ServicePO->Client/Company/hierarchy,
 * Employee->Role/BusinessUnit->Entity) is read straight off the FK-based
 * Sequelize associations already loaded by the repository — never inferred
 * from names. Read-only, cross-tenant by design (Platform Admin only).
 */

function mapCompany(company) {
  return {
    id: company.id,
    name: company.company_name,
    entity_id: company.entity_id,
    entity_name: company.entity ? company.entity.entity_name : null,
    status: company.status,
    created_at: company.created_at,
  };
}

/**
 * Flattens one Service PO's hierarchy nodes into a level-tagged list,
 * reusing service_po_hierarchy's existing node_type/parent_hierarchy_id
 * columns (see ServicePOHierarchy.js) rather than duplicating that logic:
 * the Service PO itself is the level-1 root, PARENT nodes (parented
 * directly to the PO) are level 2, CHILD nodes (parented to a PARENT node)
 * are level 3 — matching the max-depth-2-inside-a-PO rule already enforced
 * in servicePOHierarchyService.js.
 */
function buildServicePOHierarchy(servicePO) {
  const nodes = servicePO.hierarchyNodes || [];
  const levels = [
    { id: servicePO.id, name: servicePO.service_po_name, node_type: 'ROOT', parent_id: null, level: 1 },
  ];
  for (const node of nodes) {
    levels.push({
      id: node.id,
      name: node.node_name,
      node_type: node.node_type,
      parent_id: node.parent_hierarchy_id || servicePO.id,
      level: node.node_type === 'PARENT' ? 2 : 3,
    });
  }
  return levels;
}

function mapServicePO(servicePO) {
  const bu = servicePO.company || null;
  const entity = bu ? bu.entity : null;

  return {
    id: servicePO.id,
    code: servicePO.service_po_code,
    name: servicePO.service_po_name,
    status: servicePO.status,
    client_id: servicePO.client_id,
    client_name: servicePO.client ? servicePO.client.client_name : null,
    bu: bu ? { id: bu.id, name: bu.company_name } : null,
    entity: entity ? { id: entity.id, name: entity.entity_name } : null,
    hierarchy: buildServicePOHierarchy(servicePO),
  };
}

function mapProject(project) {
  const bu = project.company || null;
  const entity = bu ? bu.entity : null;

  return {
    project_id: project.id,
    project_code: project.project_code,
    project_name: project.project_name,
    status: project.status,
    client_id: project.client_id,
    client_name: project.client ? project.client.client_name : null,
    bu: bu ? { id: bu.id, name: bu.company_name } : null,
    entity: entity ? { id: entity.id, name: entity.entity_name } : null,
    service_pos: (project.servicePOs || []).map(mapServicePO),
  };
}

/**
 * An Employee can hold more than one active Business Unit membership (see
 * EmployeeBusinessUnit) — collapsed here into a single display-friendly
 * field: `ids` (every BU's own id, for anyone filtering/linking by id) and
 * a comma-separated `name` string (per product decision — multiple BUs are
 * shown as "BU One, BU Two" rather than an array of objects). Returns null
 * when the employee holds no active BU, rather than an empty-string name.
 */
function formatBusinessUnits(businessUnits) {
  if (!businessUnits || businessUnits.length === 0) return null;
  return {
    ids: businessUnits.map((bu) => bu.id),
    name: businessUnits.map((bu) => bu.company_name).join(', '),
  };
}

/**
 * Same comma-separated collapsing as formatBusinessUnits, but for the
 * DISTINCT Entities behind an employee's Business Units — several BUs can
 * share the same parent Entity, which must only be listed once (dedupe by
 * entity id, not one entry per BU).
 */
function formatEntities(businessUnits) {
  const entities = (businessUnits || []).map((bu) => bu.entity).filter(Boolean);
  const uniqueById = [...new Map(entities.map((entity) => [entity.id, entity])).values()];
  if (uniqueById.length === 0) return null;
  return {
    ids: uniqueById.map((entity) => entity.id),
    name: uniqueById.map((entity) => entity.entity_name).join(', '),
  };
}

/**
 * Maps one Employee (the sole login identity since the Employee-as-Identity
 * redesign — see platformAdminRepository.findAllEmployeesWithRolesAndBUs's
 * doc comment) into this endpoint's `users` array shape. Field names
 * (`user_id`, `employee_id`) are kept exactly as before this redesign for
 * frontend compatibility, even though both now resolve to the same
 * Employee id — there is no separate User identity left to distinguish.
 *
 * @param {import('../models').Employee} employee
 */
function mapUser(employee) {
  return {
    user_id: employee.id,
    employee_id: employee.id,
    name: employee.full_name,
    email: employee.email,
    roles: (employee.roles || []).map((role) => ({ id: role.id, name: role.role_name })),
    status: employee.status,
    bu: formatBusinessUnits(employee.businessUnits),
    entity: formatEntities(employee.businessUnits),
  };
}

const getOrganizationOverview = async () => {
  const [companies, projects, employees] = await Promise.all([
    platformAdminRepository.findAllCompaniesWithEntity(),
    platformAdminRepository.findAllProjectsWithServicePOs(),
    platformAdminRepository.findAllEmployeesWithRolesAndBUs(),
  ]);

  return {
    business_units: companies.map(mapCompany),
    projects_service_pos: projects.map(mapProject),
    users: employees.map(mapUser),
  };
};

module.exports = {
  getOrganizationOverview,
  mapCompany,
  mapServicePO,
  mapProject,
  mapUser,
  buildServicePOHierarchy,
};
