'use strict';

const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');
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

const SYNCED_SORTS = {
  employee_name: 'e.full_name',
  employee_code: 'e.employee_code',
  total_hours: 'total_hours',
};

/**
 * Shared WHERE/replacements for the "Employee Work Log — Synced" tab
 * (Platform Admin only): every non-deleted Employee, system-wide — never
 * scoped to a Business Unit, since a Platform Admin's overview spans the
 * whole platform. `status` filters the EMPLOYEE's own status (active/
 * inactive/all), separate from `employee_work_logs.status = 'synced'`,
 * which is applied inside the `synced` CTE regardless of this filter.
 */
function syncedWorkLogConditions({ search, status }) {
  const replacements = {};
  const conditions = ['e.is_deleted = false'];

  if (status && status !== 'all') {
    conditions.push('e.status = :status');
    replacements.status = status;
  }
  if (search && search.trim()) {
    conditions.push('(e.full_name ILIKE :search OR e.employee_code ILIKE :search)');
    replacements.search = `%${search.trim()}%`;
  }

  return { conditions, replacements };
}

/**
 * One row per Employee, system-wide, for the selected month — the owning
 * Admin, Entity, and Business Unit names (comma-joined when an Employee
 * holds more than one active Business Unit — see platformAdminService's
 * formatBusinessUnits/formatEntities for the same collapsing convention),
 * and total SYNCED hours only (employee_work_logs.status = 'synced'),
 * defaulting to 0 when the Employee has no synced work log in the period at
 * all (LEFT JOIN, never INNER — an Employee who filled nothing must still
 * appear with total_hours: 0, not be dropped from the report).
 *
 * "Admin" is resolved as the Employee's Business Unit's Entity's creating
 * Admin (companies.entity_id -> entities.created_by), per
 * companyAccessControlService.resolveOwningAdminIdForCompany's own
 * "Entity Master management is Admin-only, so entities.created_by IS the
 * owning Admin" convention — done here as a single set-based join instead
 * of N per-employee calls to that helper.
 */
function buildSyncedWorkLogQuery({ startDate, endDate, search, status, sortBy, sortOrder }) {
  const { conditions, replacements } = syncedWorkLogConditions({ search, status });
  const whereSql = conditions.join(' AND ');
  const orderBy = SYNCED_SORTS[sortBy] || SYNCED_SORTS.employee_name;
  const order = sortOrder === 'DESC' ? 'DESC' : 'ASC';

  const sql = `
    WITH synced AS (
      SELECT employee_id, SUM(hours) AS total_hours
      FROM employee_work_logs
      WHERE status = 'synced' AND work_date BETWEEN :startDate AND :endDate
      GROUP BY employee_id
    )
    SELECT
      e.id AS employee_id,
      e.employee_code,
      e.full_name AS employee_name,
      STRING_AGG(DISTINCT adm.full_name, ', ' ORDER BY adm.full_name) AS admin_name,
      STRING_AGG(DISTINCT ent.entity_name, ', ' ORDER BY ent.entity_name) AS entity_name,
      STRING_AGG(DISTINCT co.company_name, ', ' ORDER BY co.company_name) AS bu_name,
      COALESCE(ROUND(MAX(synced.total_hours)::NUMERIC, 2), 0) AS total_hours
    FROM employees e
    LEFT JOIN employee_business_units ebu ON ebu.employee_id = e.id AND ebu.status = 'active'
    LEFT JOIN companies co ON co.id = ebu.business_unit_id AND co.is_deleted = false
    LEFT JOIN entities ent ON ent.id = co.entity_id AND ent.is_deleted = false
    LEFT JOIN employees adm ON adm.id = ent.created_by
    LEFT JOIN synced ON synced.employee_id = e.id
    WHERE ${whereSql}
    GROUP BY e.id, e.employee_code, e.full_name
    ORDER BY ${orderBy} ${order}, e.id ASC
  `;

  return { sql, replacements: { ...replacements, startDate, endDate } };
}

/**
 * Paginated page of the Employee Work Log Synced report (Platform Admin's
 * "Employee Work Log" tab). Count query deliberately ignores the
 * Business-Unit/synced-hours joins — one Employee is always exactly one row
 * regardless of how many BUs it fans out to, so counting `employees` alone
 * (with the same filters) is both correct and cheaper.
 */
async function getEmployeeWorkLogSyncedPage({ startDate, endDate, search, status, sortBy, sortOrder, limit, offset }) {
  const { sql, replacements } = buildSyncedWorkLogQuery({ startDate, endDate, search, status, sortBy, sortOrder });
  const { conditions, replacements: countReplacements } = syncedWorkLogConditions({ search, status });

  const rows = await sequelize.query(`${sql} LIMIT :limit OFFSET :offset`, {
    replacements: { ...replacements, limit, offset },
    type: QueryTypes.SELECT,
  });

  const countRows = await sequelize.query(
    `SELECT COUNT(*)::int AS count FROM employees e WHERE ${conditions.join(' AND ')}`,
    { replacements: countReplacements, type: QueryTypes.SELECT }
  );

  return { rows, count: countRows[0].count };
}

/**
 * Every matching row, unpaginated — the Excel export's data source (see
 * platformAdminService.exportEmployeeWorkLogSynced), which needs the FULL
 * set to split into "hours > 0" / "hours = 0" sheets, not just one page.
 */
async function getEmployeeWorkLogSyncedAll({ startDate, endDate, search, status, sortBy, sortOrder }) {
  const { sql, replacements } = buildSyncedWorkLogQuery({ startDate, endDate, search, status, sortBy, sortOrder });
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

module.exports = {
  findAllCompaniesWithEntity,
  findAllProjectsWithServicePOs,
  findAllEmployeesWithRolesAndBUs,
  getEmployeeWorkLogSyncedPage,
  getEmployeeWorkLogSyncedAll,
};
