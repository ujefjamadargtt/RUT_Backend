'use strict';

const {
  Company,
  Entity,
  Project,
  Client,
  ServicePO,
  ServicePOHierarchy,
  Employee,
  Role,
} = require('../models');

/**
 * Platform Admin Organization Overview Repository — three independent,
 * fully-joined reads (no N+1): all Companies/BUs with Entity, all Projects
 * with Client/Company/Entity/ServicePOs (each with its OWN Client/Company/
 * Entity and hierarchy nodes), and all actors (Employees) with their
 * Role(s)/Business Unit(s)/Entity. Read-only and intentionally unscoped —
 * this is the one endpoint that returns cross-tenant data (Platform Admin
 * only, gated by requirePlatformAdmin.js).
 *
 * findAllEmployeesWithRolesAndBUs() reads `employees`, NOT `users` —
 * `users` was intentionally TRUNCATED by the Employee-as-Identity redesign
 * (see database/migrations/20260880_truncate_users.sql: "users is NEVER
 * dropped — only its data is cleared") once every login/role/BU grant was
 * backfilled onto Employee. Every real actor lives in `employees` now, with
 * roles via EmployeeRole (`roles` alias, no primary/additional split — see
 * models/index.js's Employee.belongsToMany(Role, { as: 'roles' })) and
 * Business Units via EmployeeBusinessUnit (`businessUnits` alias, an
 * Employee can hold more than one). Querying `users` here (as this used to)
 * either throws (a stale association alias — see git history for the
 * `additionalRoles` bug this replaced) or silently returns almost nothing,
 * since only a handful of post-truncation rows remain in that table.
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

const findAllEmployeesWithRolesAndBUs = () => {
  return Employee.findAll({
    where: { is_deleted: false },
    attributes: ['id', 'employee_code', 'full_name', 'email', 'status', 'created_at'],
    include: [
      {
        model: Role,
        as: 'roles',
        attributes: ['id', 'role_name'],
        // Only ACTIVE grants — a revoked-but-not-deleted employee_roles row
        // must not make a role appear still held (see EmployeeRole.js's
        // status column; through.where filters on the join row itself).
        through: { attributes: [], where: { status: 'active' } },
        required: false,
      },
      {
        model: Company,
        as: 'businessUnits',
        attributes: ['id', 'company_name'],
        through: { attributes: [], where: { status: 'active' } },
        required: false,
        include: [
          { model: Entity, as: 'entity', attributes: ['id', 'entity_name'], required: false },
        ],
      },
    ],
    order: [['id', 'ASC']],
  });
};

module.exports = {
  findAllCompaniesWithEntity,
  findAllProjectsWithServicePOs,
  findAllEmployeesWithRolesAndBUs,
};
