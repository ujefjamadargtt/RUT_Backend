'use strict';

const { Employee } = require('../models');
const platformAdminRepository = require('../repositories/platformAdminRepository');
const employeeRepository = require('../repositories/employeeRepository');
const roleRepository = require('../repositories/roleRepository');
const dateHelper = require('../helpers/dateHelper');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');

const asNumber = (value) => Number.parseFloat(value) || 0;

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
 * Same comma-separated collapsing as formatBusinessUnits/formatEntities, for
 * an Employee's held Role(s) — an Employee can hold more than one active
 * Role (see EmployeeRole), previously returned here as a bare array of
 * `{id, name}` objects, inconsistent with `bu`/`entity`'s `{ids, name}`
 * shape and easy for a consumer written against that shape (a plain
 * `roles?.name` read) to silently render blank for a multi-role Employee.
 */
function formatRoles(roles) {
  if (!roles || roles.length === 0) return null;
  return {
    ids: roles.map((role) => role.id),
    name: roles.map((role) => role.role_name).join(', '),
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
    employee_code: employee.employee_code,
    name: employee.full_name,
    email: employee.email,
    roles: formatRoles(employee.roles),
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

async function resolveAdminRoleId() {
  const role = await roleRepository.findByName('Admin');
  if (!role) {
    const err = new Error('The "Admin" role is not seeded.');
    err.statusCode = 500;
    throw err;
  }
  return role.id;
}

/**
 * "Total Admins" tab — every Admin-role Employee on the whole platform, not
 * just ones the calling Platform Admin created themselves (contrast with
 * adminService.getAll's created_by-scoped "Admins I created" listing — see
 * employeeRepository.findAllByRoleName's doc comment). Each row is enriched
 * with a `created_by` summary (name/email of whichever actor created that
 * Admin), resolved with one batched lookup rather than N+1 per row.
 */
const getTotalAdmins = async (query = {}) => {
  const { page, limit, offset } = getPaginationParams(query);
  const roleId = await resolveAdminRoleId();

  const { rows, count } = await employeeRepository.findAllByRoleName(
    roleId,
    { search: query.search, status: query.status },
    { limit, offset },
    { sortBy: query.sort_by, sortOrder: query.sort_order }
  );

  const plainRows = rows.map((row) => (row.get ? row.get({ plain: true }) : row));
  const creatorIds = [...new Set(plainRows.map((row) => row.created_by).filter((id) => id != null))];
  const creators = creatorIds.length
    ? await Employee.findAll({ where: { id: creatorIds }, attributes: ['id', 'full_name', 'email'], raw: true })
    : [];
  const creatorById = new Map(creators.map((creator) => [creator.id, creator]));

  const data = plainRows.map((row) => {
    const creator = row.created_by != null ? creatorById.get(row.created_by) : null;
    return {
      id: row.id,
      employee_code: row.employee_code,
      full_name: row.full_name,
      email: row.email,
      status: row.status,
      created_at: row.created_at,
      created_by: creator ? { id: creator.id, name: creator.full_name, email: creator.email } : null,
    };
  });

  return { data, meta: getPaginationMeta(count, page, limit) };
};

const WORK_LOG_SYNCED_COLUMNS = [
  { key: 'employee_code', label: 'Emp Code' },
  { key: 'employee_name', label: 'Emp Name' },
  { key: 'admin_name', label: 'Admin' },
  { key: 'entity_name', label: 'Entity Name' },
  { key: 'bu_name', label: 'BU Name' },
  { key: 'total_hours', label: 'Total Hours (Synced)' },
];

function mapSyncedRow(row) {
  return {
    employee_id: row.employee_id,
    employee_code: row.employee_code,
    employee_name: row.employee_name,
    admin_name: row.admin_name || null,
    entity_name: row.entity_name || null,
    bu_name: row.bu_name || null,
    total_hours: asNumber(row.total_hours),
  };
}

/**
 * "Employee Work Log" tab — one row per Employee, system-wide, for the
 * selected month, with ONLY synced hours counted (see
 * platformAdminRepository.buildSyncedWorkLogQuery's doc comment). An
 * Employee with no synced work log that month still appears, with
 * total_hours: 0 — never dropped.
 */
const getEmployeeWorkLogSynced = async (query = {}) => {
  const { month, year } = query;
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);
  const { page, limit, offset } = getPaginationParams(query);

  const { rows, count } = await platformAdminRepository.getEmployeeWorkLogSyncedPage({
    startDate,
    endDate,
    search: query.search || undefined,
    status: query.status,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit,
    offset,
  });

  return {
    period: { month, year, startDate, endDate },
    data: rows.map(mapSyncedRow),
    meta: getPaginationMeta(count, page, limit),
  };
};

/**
 * Excel export for the "Employee Work Log" tab — one workbook, 2 sheets,
 * split by whether the Employee has ANY synced hours in the selected month:
 * "Hours > 0" (filled) and "Hours = 0" (not filled). Unpaginated — pulls
 * every matching row so both sheets are complete. See
 * reportExporter.toMultiSheetExcelBuffer, consumed by the controller exactly
 * like tenantExportController.js's own export endpoint.
 */
const exportEmployeeWorkLogSynced = async (query = {}) => {
  const { month, year } = query;
  const { startDate, endDate } = dateHelper.getMonthBounds(month, year);

  const rawRows = await platformAdminRepository.getEmployeeWorkLogSyncedAll({
    startDate,
    endDate,
    search: query.search || undefined,
    status: query.status,
    sortBy: 'employee_name',
    sortOrder: 'ASC',
  });

  const rows = rawRows.map(mapSyncedRow);
  const filled = rows.filter((row) => row.total_hours > 0);
  const notFilled = rows.filter((row) => row.total_hours === 0);

  return {
    period: { month, year, startDate, endDate },
    sheets: [
      { name: 'Hours > 0', columns: WORK_LOG_SYNCED_COLUMNS, rows: filled },
      { name: 'Hours = 0', columns: WORK_LOG_SYNCED_COLUMNS, rows: notFilled },
    ],
  };
};

module.exports = {
  getOrganizationOverview,
  mapCompany,
  mapServicePO,
  mapProject,
  mapUser,
  buildServicePOHierarchy,
  getTotalAdmins,
  getEmployeeWorkLogSynced,
  exportEmployeeWorkLogSynced,
};
