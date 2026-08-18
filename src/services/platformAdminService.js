'use strict';

const platformAdminRepository = require('../repositories/platformAdminRepository');

/**
 * Platform Admin Organization Overview — assembles the three independent
 * reads from platformAdminRepository (Companies/BUs, Projects+ServicePOs,
 * Users) into one plain-JSON payload. Pure mapping only; every relationship
 * (BU->Entity, Project->Client/ServicePO, ServicePO->Client/Company/
 * hierarchy, User->Employee/Company/Role) is read straight off the FK-based
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
 * A User's BU comes from its own company_id when set (the field the rest of
 * the app treats as authoritative for scoping — see resolveCompany.js);
 * Platform Admin/Admin/Entity Admin have none, so this falls back to the
 * linked Employee's company for any login tied to an Employee record
 * instead of silently reporting no BU.
 */
function resolveUserCompany(user) {
  if (user.company) return user.company;
  if (user.employee && user.employee.company) return user.employee.company;
  return null;
}

function mapUser(user) {
  const company = resolveUserCompany(user);
  const entity = company ? company.entity : null;

  const roleMap = new Map();
  if (user.role) roleMap.set(user.role.id, user.role.role_name);
  for (const role of user.additionalRoles || []) {
    roleMap.set(role.id, role.role_name);
  }

  return {
    user_id: user.id,
    employee_id: user.employee_id,
    name: user.employee ? user.employee.full_name : null,
    email: user.email,
    roles: [...roleMap.entries()].map(([id, name]) => ({ id, name })),
    status: user.status,
    bu: company ? { id: company.id, name: company.company_name } : null,
    entity: entity ? { id: entity.id, name: entity.entity_name } : null,
  };
}

const getOrganizationOverview = async () => {
  const [companies, projects, users] = await Promise.all([
    platformAdminRepository.findAllCompaniesWithEntity(),
    platformAdminRepository.findAllProjectsWithServicePOs(),
    platformAdminRepository.findAllUsersWithRoles(),
  ]);

  return {
    business_units: companies.map(mapCompany),
    projects_service_pos: projects.map(mapProject),
    users: users.map(mapUser),
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
