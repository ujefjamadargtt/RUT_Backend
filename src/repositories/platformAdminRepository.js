'use strict';

const {
  Company,
  Entity,
  Project,
  Client,
  ServicePO,
  ServicePOHierarchy,
  User,
  Employee,
  Role,
} = require('../models');

/**
 * Platform Admin Organization Overview Repository — three independent,
 * fully-joined reads (no N+1): all Companies/BUs with Entity, all Projects
 * with Client/Company/Entity/ServicePOs (each with its OWN Client/Company/
 * Entity and hierarchy nodes), and all Users with Employee/Company/Entity/
 * Role/additionalRoles. Read-only and intentionally unscoped — this is the
 * one endpoint that returns cross-tenant data (Platform Admin only, gated
 * by requirePlatformAdmin.js).
 */

// A factory, not a shared constant — this include config is nested at
// multiple sites (Project, its ServicePOs, User, User.employee) within the
// SAME findAll() call, and Sequelize mutates each include object in place
// while building the query, so every usage site needs its own object.
const buCompanyInclude = () => ({
  model: Company,
  as: 'company',
  attributes: ['id', 'company_name', 'entity_id'],
  required: false,
  include: [
    { model: Entity, as: 'entity', attributes: ['id', 'entity_name'], required: false },
  ],
});

const findAllCompaniesWithEntity = () => {
  return Company.findAll({
    where: { is_deleted: false },
    attributes: ['id', 'company_name', 'entity_id', 'status', 'created_at'],
    include: [
      { model: Entity, as: 'entity', attributes: ['id', 'entity_name'], required: false },
    ],
    order: [['id', 'ASC']],
  });
};

const findAllProjectsWithServicePOs = () => {
  return Project.findAll({
    where: { is_deleted: false },
    attributes: ['id', 'project_code', 'project_name', 'status', 'client_id', 'company_id'],
    include: [
      { model: Client, as: 'client', attributes: ['id', 'client_name'], required: false },
      buCompanyInclude(),
      {
        model: ServicePO,
        as: 'servicePOs',
        where: { is_deleted: false },
        required: false,
        attributes: ['id', 'service_po_code', 'service_po_name', 'status', 'client_id', 'company_id'],
        include: [
          { model: Client, as: 'client', attributes: ['id', 'client_name'], required: false },
          buCompanyInclude(),
          {
            model: ServicePOHierarchy,
            as: 'hierarchyNodes',
            attributes: ['id', 'node_name', 'node_type', 'parent_hierarchy_id', 'display_order', 'status'],
            required: false,
          },
        ],
      },
    ],
    order: [['id', 'ASC']],
  });
};

const findAllUsersWithRoles = () => {
  return User.findAll({
    where: { is_deleted: false },
    attributes: ['id', 'email', 'status', 'company_id', 'employee_id', 'role_id', 'created_at'],
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'full_name', 'employee_code', 'status'],
        required: false,
        include: [buCompanyInclude()],
      },
      buCompanyInclude(),
      { model: Role, as: 'role', attributes: ['id', 'role_name'], required: false },
      {
        model: Role,
        as: 'additionalRoles',
        attributes: ['id', 'role_name'],
        through: { attributes: [] },
        required: false,
      },
    ],
    order: [['id', 'ASC']],
  });
};

module.exports = {
  findAllCompaniesWithEntity,
  findAllProjectsWithServicePOs,
  findAllUsersWithRoles,
};
