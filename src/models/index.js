'use strict';

const { Sequelize } = require('sequelize');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    dialect: 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
      min: parseInt(process.env.DB_POOL_MIN, 10) || 0,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE, 10) || 30000,
      idle: parseInt(process.env.DB_POOL_IDLE, 10) || 10000,
    },
    define: {
      underscored: true,
      freezeTableName: true,
    },
  }
);

// ---------------------------------------------------------------------------
// Model imports
// ---------------------------------------------------------------------------
const Company                = require('./Company')(sequelize);
const Entity                 = require('./Entity')(sequelize);
const Role                   = require('./Role')(sequelize);
const Employee               = require('./Employee')(sequelize);
const EmployeeRole           = require('./EmployeeRole')(sequelize);
const EmployeeBusinessUnit   = require('./EmployeeBusinessUnit')(sequelize);
const EmployeeLoginSession   = require('./EmployeeLoginSession')(sequelize);
const User                   = require('./User')(sequelize);
const Client                 = require('./Client')(sequelize);
const Project                = require('./Project')(sequelize);
const ServiceCategory        = require('./ServiceCategory')(sequelize);
const ServiceType            = require('./ServiceType')(sequelize);
const DefaultCategory        = require('./DefaultCategory')(sequelize);
const DefaultType            = require('./DefaultType')(sequelize);
const CompanyCategory        = require('./CompanyCategory')(sequelize);
const CompanyType            = require('./CompanyType')(sequelize);
const ServicePO              = require('./ServicePO')(sequelize);
const ServicePOResource      = require('./ServicePOResource')(sequelize);
const ServicePOHierarchy     = require('./ServicePOHierarchy')(sequelize);
const ServicePOMonthlyBudget = require('./ServicePOMonthlyBudget')(sequelize);
const SubProject             = require('./SubProject')(sequelize);
const MonthlyCost            = require('./MonthlyCost')(sequelize);
const Timesheet              = require('./Timesheet')(sequelize);
const AuditLog               = require('./AuditLog')(sequelize);
const UserSession            = require('./UserSession')(sequelize);
const TimesheetImportHistory = require('./TimesheetImportHistory')(sequelize);
const TimesheetImportError   = require('./TimesheetImportError')(sequelize);
const Notification           = require('./Notification')(sequelize);
const FormMaster             = require('./FormMaster')(sequelize);
const Category                = require('./Category')(sequelize);
const RoleFormMapping        = require('./RoleFormMapping')(sequelize);
const RoleCapability         = require('./RoleCapability')(sequelize);
const AiInsightJob           = require('./AiInsightJob')(sequelize);
const AiInsight              = require('./AiInsight')(sequelize);
const EmployeeServicePOMapping = require('./EmployeeServicePOMapping')(sequelize);
const TeamMapping            = require('./TeamMapping')(sequelize);
const ManagerEmployeeMapping = require('./ManagerEmployeeMapping')(sequelize);
const ManagerServicePOMapping = require('./ManagerServicePOMapping')(sequelize);
const EmployeeWorkLog        = require('./EmployeeWorkLog')(sequelize);
const EmployeeWorkLogTimeEntry = require('./EmployeeWorkLogTimeEntry')(sequelize);
const PasswordResetOtp       = require('./PasswordResetOtp')(sequelize);
const PasswordResetHistory   = require('./PasswordResetHistory')(sequelize);
const CostBudget             = require('./CostBudget')(sequelize);
const ResourceBudget         = require('./ResourceBudget')(sequelize);

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

// Company <-> every company-owned table (query convenience only — filtering
// itself is done via plain `where: { company_id }`, not these includes).
Company.hasMany(User,                   { foreignKey: 'company_id', as: 'users' });
Company.hasMany(Client,                 { foreignKey: 'company_id', as: 'clients' });
Company.hasMany(Project,                { foreignKey: 'company_id', as: 'projects' });
Company.hasMany(Employee,               { foreignKey: 'company_id', as: 'employees' });
Company.hasMany(MonthlyCost,            { foreignKey: 'company_id', as: 'monthlyCosts' });
Company.hasMany(ServicePO,              { foreignKey: 'company_id', as: 'servicePOs' });
Company.hasMany(ServicePOResource,      { foreignKey: 'company_id', as: 'servicePOResources' });
Company.hasMany(ServicePOMonthlyBudget, { foreignKey: 'company_id', as: 'servicePOMonthlyBudgets' });
Company.hasMany(ServiceType,            { foreignKey: 'company_id', as: 'serviceTypes' });
Company.hasMany(ServiceCategory,        { foreignKey: 'company_id', as: 'serviceCategories' });
Company.hasMany(SubProject,             { foreignKey: 'company_id', as: 'subProjects' });
Company.hasMany(Timesheet,              { foreignKey: 'company_id', as: 'timesheets' });
Company.hasMany(TimesheetImportHistory, { foreignKey: 'company_id', as: 'timesheetImportHistory' });
Company.hasMany(TimesheetImportError,   { foreignKey: 'company_id', as: 'timesheetImportErrors' });
Company.hasMany(AiInsight,              { foreignKey: 'company_id', as: 'aiInsights' });
Company.hasMany(AiInsightJob,           { foreignKey: 'company_id', as: 'aiInsightJobs' });

User.belongsTo(Company,                   { foreignKey: 'company_id', as: 'company' });
Client.belongsTo(Company,                 { foreignKey: 'company_id', as: 'company' });
Project.belongsTo(Company,                { foreignKey: 'company_id', as: 'company' });
Employee.belongsTo(Company,               { foreignKey: 'company_id', as: 'company' });
MonthlyCost.belongsTo(Company,            { foreignKey: 'company_id', as: 'company' });
ServicePO.belongsTo(Company,              { foreignKey: 'company_id', as: 'company' });
ServicePOResource.belongsTo(Company,      { foreignKey: 'company_id', as: 'company' });
ServicePOMonthlyBudget.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
ServiceType.belongsTo(Company,            { foreignKey: 'company_id', as: 'company' });
ServiceCategory.belongsTo(Company,        { foreignKey: 'company_id', as: 'company' });
SubProject.belongsTo(Company,             { foreignKey: 'company_id', as: 'company' });
Timesheet.belongsTo(Company,              { foreignKey: 'company_id', as: 'company' });
TimesheetImportHistory.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
TimesheetImportError.belongsTo(Company,   { foreignKey: 'company_id', as: 'company' });
AiInsight.belongsTo(Company,              { foreignKey: 'company_id', as: 'company' });
AiInsightJob.belongsTo(Company,           { foreignKey: 'company_id', as: 'company' });

// Entity <-> Employee (ownership) and Entity <-> Company — the tenancy
// tier: Platform Admin -> Entity Admin (owns Entities) -> Entity ->
// Company (BU Admin). One Employee (an Entity Admin) may own several
// Entities; each Entity has exactly one owner at a time. Employee-keyed
// since login/identity moved off User Master — see database/migrations/
// 20260875_add_entities_entity_admin_employee_id.sql.
Entity.belongsTo(Employee, { foreignKey: 'entity_admin_employee_id', as: 'entityAdmin' });
Employee.hasMany(Entity, { foreignKey: 'entity_admin_employee_id', as: 'ownedEntities' });
Entity.hasMany(Company, { foreignKey: 'entity_id', as: 'companies' });
Company.belongsTo(Entity, { foreignKey: 'entity_id', as: 'entity' });

// Role <-> User: users.role_id is the sole PRIMARY role and the sole
// source of truth for hierarchy rank / company-entity scoping / the
// role-creation matrix — the old user_roles many-to-many table was dropped
// specifically because it competed with this column, see
// 20260840_collapse_user_roles.sql.
Role.hasMany(User, { foreignKey: 'role_id', as: 'users' });
User.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

// Role <-> Employee (many-to-many via employee_roles) — replaces the old
// single users.role_id + user_additional_roles split now that login lives
// on Employee. No primary/additional distinction — every consumer treats
// the set uniformly (effective hierarchy rank = MIN across active rows,
// see roleHierarchyService.js). See database/migrations/
// 20260865_create_employee_roles.sql.
Employee.belongsToMany(Role, {
  through: EmployeeRole,
  foreignKey: 'employee_id',
  otherKey: 'role_id',
  as: 'roles',
});
Role.belongsToMany(Employee, {
  through: EmployeeRole,
  foreignKey: 'role_id',
  otherKey: 'employee_id',
  as: 'employeesWithRole',
});
EmployeeRole.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
EmployeeRole.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

// Company ("Business Unit") <-> Employee (many-to-many via
// employee_business_units) — replaces the old single users.company_id
// column and the BU-Head-only bu_head_company_mappings mechanism. This is
// the table resolveCompany.js reads to resolve a request's active BU. See
// database/migrations/20260866_create_employee_business_units.sql.
Employee.belongsToMany(Company, {
  through: EmployeeBusinessUnit,
  foreignKey: 'employee_id',
  otherKey: 'business_unit_id',
  as: 'businessUnits',
});
Company.belongsToMany(Employee, {
  through: EmployeeBusinessUnit,
  foreignKey: 'business_unit_id',
  otherKey: 'employee_id',
  as: 'employeesInBusinessUnit',
});
EmployeeBusinessUnit.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
EmployeeBusinessUnit.belongsTo(Company, { foreignKey: 'business_unit_id', as: 'businessUnit' });

// Employee <-> EmployeeLoginSession — refresh-token store for
// Employee-based login. See database/migrations/
// 20260879_create_employee_login_sessions.sql.
Employee.hasMany(EmployeeLoginSession, { foreignKey: 'employee_id', as: 'loginSessions' });
EmployeeLoginSession.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

// Role self-referencing inheritance edge (see roleHierarchyService.js) —
// only ever set for the two edges the RBAC spec states (Service PO Admin <-
// Manager, Project Admin <- Service PO Admin); NULL for every other role.
Role.belongsTo(Role, { foreignKey: 'inherits_role_id', as: 'inheritsFrom' });
Role.hasMany(Role, { foreignKey: 'inherits_role_id', as: 'inheritedBy' });

// Role <-> RoleCapability — a role's OWN directly-granted capabilities only;
// inherited ones are computed at read time (roleHierarchyService.js), never
// duplicated into this table.
Role.hasMany(RoleCapability, { foreignKey: 'role_id', as: 'capabilities' });
RoleCapability.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

// Employee <-> User
Employee.hasMany(User, { foreignKey: 'employee_id', as: 'users' });
User.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

// Employee <-> ServicePOResource
Employee.hasMany(ServicePOResource, { foreignKey: 'employee_id', as: 'servicePOResources' });
ServicePOResource.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

// Employee <-> MonthlyCost
Employee.hasMany(MonthlyCost, { foreignKey: 'employee_id', as: 'monthlyCosts' });
MonthlyCost.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

// Employee <-> Timesheet
Employee.hasMany(Timesheet, { foreignKey: 'employee_id', as: 'timesheets' });
Timesheet.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

// User <-> UserSession
User.hasMany(UserSession, { foreignKey: 'user_id', as: 'sessions' });
UserSession.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Role <-> FormMaster (many-to-many through RoleFormMapping)
Role.belongsToMany(FormMaster, { through: RoleFormMapping, foreignKey: 'role_id', otherKey: 'form_id', as: 'forms' });
FormMaster.belongsToMany(Role, { through: RoleFormMapping, foreignKey: 'form_id', otherKey: 'role_id', as: 'roles' });
Role.hasMany(RoleFormMapping, { foreignKey: 'role_id', as: 'roleFormMappings' });
FormMaster.hasMany(RoleFormMapping, { foreignKey: 'form_id', as: 'roleFormMappings' });
RoleFormMapping.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });
RoleFormMapping.belongsTo(FormMaster, { foreignKey: 'form_id', as: 'form' });

// FormMaster (module row) <-> Category <-> FormMaster (form row) — the
// optional Module -> Category -> Form layer. module_id points at the
// module's OWN form_master row id; category_id (on a form row only) points
// at the category. See database/migrations/
// 20260881_add_form_master_categories.sql.
FormMaster.hasMany(Category, { foreignKey: 'module_id', as: 'categories' });
Category.belongsTo(FormMaster, { foreignKey: 'module_id', as: 'module' });
Category.hasMany(FormMaster, { foreignKey: 'category_id', as: 'forms' });
FormMaster.belongsTo(Category, { foreignKey: 'category_id', as: 'category' });

// User <-> AuditLog
User.hasMany(AuditLog, { foreignKey: 'user_id', as: 'auditLogs' });
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// User <-> Notification
User.hasMany(Notification, { foreignKey: 'user_id', as: 'notifications' });
Notification.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Client <-> ServicePO
Client.hasMany(ServicePO, { foreignKey: 'client_id', as: 'servicePOs' });
ServicePO.belongsTo(Client, { foreignKey: 'client_id', as: 'client' });

// Client <-> Project — every Project belongs to exactly one Client (see
// database/migrations/20260848_add_projects_client_id.sql).
Client.hasMany(Project, { foreignKey: 'client_id', as: 'projects' });
Project.belongsTo(Client, { foreignKey: 'client_id', as: 'client' });

// Project <-> ServicePO — independent of Client (a Service PO has both a
// project_id and a client_id, unrelated to each other).
Project.hasMany(ServicePO, { foreignKey: 'project_id', as: 'servicePOs' });
ServicePO.belongsTo(Project, { foreignKey: 'project_id', as: 'project' });

// ServicePO <-> Employee (Delivery Head) — a direct staffing attribute,
// distinct from the employees/resources many-to-many further down. Always
// an Employee Master id (see database/migrations/20260849_add_service_pos_delivery_head.sql).
ServicePO.belongsTo(Employee, { foreignKey: 'delivery_head_employee_id', as: 'deliveryHead' });
Employee.hasMany(ServicePO, { foreignKey: 'delivery_head_employee_id', as: 'deliveryHeadServicePOs' });

// ServiceCategory <-> ServiceType
ServiceCategory.hasMany(ServiceType, { foreignKey: 'service_category_id', as: 'serviceTypes' });
ServiceType.belongsTo(ServiceCategory, { foreignKey: 'service_category_id', as: 'serviceCategory' });

// Manager hierarchy chain: Service PO Admin -> Manager -> Employee/
// ServicePO (one hop shorter than before "Head Manager" was retired — see
// database/migrations/20260844_rename_head_manager_mappings_to_team_mappings.sql).
// Three distinct mapping tables, each a strict "one owner" or plain
// many-to-many relationship — see the individual model files for the exact
// cardinality each one enforces at the DB level.
TeamMapping.belongsTo(Employee, { foreignKey: 'service_po_admin_employee_id', as: 'servicePOAdmin' });
TeamMapping.belongsTo(Employee, { foreignKey: 'manager_employee_id', as: 'manager' });
TeamMapping.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
Employee.hasMany(TeamMapping, { foreignKey: 'service_po_admin_employee_id', as: 'managedTeamMappings' });

ManagerEmployeeMapping.belongsTo(Employee, { foreignKey: 'manager_employee_id', as: 'manager' });
ManagerEmployeeMapping.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
ManagerEmployeeMapping.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
Employee.hasMany(ManagerEmployeeMapping, { foreignKey: 'manager_employee_id', as: 'managedEmployeeMappings' });

ManagerServicePOMapping.belongsTo(Employee, { foreignKey: 'manager_employee_id', as: 'manager' });
ManagerServicePOMapping.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });
ManagerServicePOMapping.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
Employee.hasMany(ManagerServicePOMapping, { foreignKey: 'manager_employee_id', as: 'grantedServicePOMappings' });

// Default Category/Type Master + per-company mapping tables — does NOT
// replace ServiceCategory/ServiceType above; see DefaultCategory.js's doc.
DefaultCategory.hasMany(DefaultType, { foreignKey: 'default_category_id', as: 'defaultTypes' });
DefaultType.belongsTo(DefaultCategory, { foreignKey: 'default_category_id', as: 'defaultCategory' });

Company.hasMany(CompanyCategory, { foreignKey: 'company_id', as: 'companyCategories' });
CompanyCategory.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
CompanyCategory.belongsTo(DefaultCategory, { foreignKey: 'default_category_id', as: 'defaultCategory' });
DefaultCategory.hasMany(CompanyCategory, { foreignKey: 'default_category_id', as: 'companyCategories' });

CompanyCategory.hasMany(CompanyType, { foreignKey: 'company_category_id', as: 'companyTypes' });
CompanyType.belongsTo(CompanyCategory, { foreignKey: 'company_category_id', as: 'companyCategory' });
CompanyType.belongsTo(DefaultType, { foreignKey: 'default_type_id', as: 'defaultType' });
DefaultType.hasMany(CompanyType, { foreignKey: 'default_type_id', as: 'companyTypes' });

// ServiceType <-> ServicePO
ServiceType.hasMany(ServicePO, { foreignKey: 'service_type_id', as: 'servicePOs' });
ServicePO.belongsTo(ServiceType, { foreignKey: 'service_type_id', as: 'serviceType' });

// ServicePO <-> ServicePOResource
ServicePO.hasMany(ServicePOResource, { foreignKey: 'service_po_id', as: 'resources' });
ServicePOResource.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });

// ServicePO <-> SubProject
ServicePO.hasMany(SubProject, { foreignKey: 'service_po_id', as: 'subProjects' });
SubProject.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });

// ServicePO <-> Timesheet
ServicePO.hasMany(Timesheet, { foreignKey: 'service_po_id', as: 'timesheets' });
Timesheet.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });

// ServicePO <-> Employee (many-to-many through ServicePOResource)
ServicePO.belongsToMany(Employee, {
  through: ServicePOResource,
  foreignKey: 'service_po_id',
  otherKey: 'employee_id',
  as: 'employees',
});
Employee.belongsToMany(ServicePO, {
  through: ServicePOResource,
  foreignKey: 'employee_id',
  otherKey: 'service_po_id',
  as: 'servicePOs',
});

// SubProject <-> Timesheet
SubProject.hasMany(Timesheet, { foreignKey: 'sub_project_id', as: 'timesheets' });
Timesheet.belongsTo(SubProject, { foreignKey: 'sub_project_id', as: 'subProject' });

// User <-> TimesheetImportHistory (imported_by)
User.hasMany(TimesheetImportHistory, { foreignKey: 'imported_by', as: 'importHistory' });
TimesheetImportHistory.belongsTo(User, { foreignKey: 'imported_by', as: 'importer' });

// TimesheetImportHistory <-> TimesheetImportError
TimesheetImportHistory.hasMany(TimesheetImportError, { foreignKey: 'import_id', as: 'errors' });
TimesheetImportError.belongsTo(TimesheetImportHistory, { foreignKey: 'import_id', as: 'importHistory' });

// AiInsightJob <-> AiInsight
AiInsightJob.hasMany(AiInsight, { foreignKey: 'job_id', as: 'insights' });
AiInsight.belongsTo(AiInsightJob, { foreignKey: 'job_id', as: 'job' });

// Employee <-> ServicePO (many-to-many through EmployeeServicePOMapping —
// Phase 2's "which projects can this employee self-log time against" table,
// distinct from the existing ServicePOResource allocation table)
Employee.hasMany(EmployeeServicePOMapping, { foreignKey: 'employee_id', as: 'servicePOMappings' });
EmployeeServicePOMapping.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
ServicePO.hasMany(EmployeeServicePOMapping, { foreignKey: 'service_po_id', as: 'employeeMappings' });
EmployeeServicePOMapping.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });
EmployeeServicePOMapping.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });

// Employee <-> EmployeeWorkLog — Employee Self Timesheet "draft" table.
// NOT part of the official Timesheet graph; only linked to
// TimesheetImportHistory once a row has been synced (status='synced').
Employee.hasMany(EmployeeWorkLog, { foreignKey: 'employee_id', as: 'workLogs' });
EmployeeWorkLog.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
ServicePO.hasMany(EmployeeWorkLog, { foreignKey: 'service_po_id', as: 'employeeWorkLogs' });
EmployeeWorkLog.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });
SubProject.hasMany(EmployeeWorkLog, { foreignKey: 'sub_project_id', as: 'employeeWorkLogs' });
EmployeeWorkLog.belongsTo(SubProject, { foreignKey: 'sub_project_id', as: 'subProject' });
TimesheetImportHistory.hasMany(EmployeeWorkLog, { foreignKey: 'timesheet_import_id', as: 'syncedWorkLogs', onDelete: 'SET NULL' });
EmployeeWorkLog.belongsTo(TimesheetImportHistory, { foreignKey: 'timesheet_import_id', as: 'importHistory', onDelete: 'SET NULL' });

// The Manager who rejected this row — see rejection_remark/rejected_by/
// rejected_at on EmployeeWorkLog. rejected_by is populated from req.userId,
// which since the identity redesign is an alias for req.employeeId (see
// middlewares/auth.js), i.e. this column holds an Employee id, not a
// users.id — must join against Employee, not User. No reverse hasMany,
// matching the imported_by/importer association above (a "who acted on
// this" FK, not a listable collection).
EmployeeWorkLog.belongsTo(Employee, { foreignKey: 'rejected_by', as: 'rejectedByEmployee' });

// EmployeeWorkLog <-> EmployeeWorkLogTimeEntry — the detailed Start Time/
// End Time segments backing one Daily Work Log row (see
// EmployeeWorkLogTimeEntry.js and database/migrations/
// 20260885_create_employee_work_log_time_entries.sql). ON DELETE CASCADE
// matches the FK: deleting a work log row (e.g. the Daily REPLACE SAVE
// flow's delete-then-reinsert) always deletes its time entries with it.
EmployeeWorkLog.hasMany(EmployeeWorkLogTimeEntry, { foreignKey: 'employee_work_log_id', as: 'timeEntries', onDelete: 'CASCADE' });
EmployeeWorkLogTimeEntry.belongsTo(EmployeeWorkLog, { foreignKey: 'employee_work_log_id', as: 'workLog' });

// Service PO Hierarchy — Parent/Child nodes belonging to exactly one
// Service PO (max depth 2: Service PO -> Parent -> Child; a CHILD can never
// itself be a parent_hierarchy_id target — enforced in
// servicePOHierarchyService.js, not by these associations).
ServicePO.hasMany(ServicePOHierarchy, { foreignKey: 'service_po_id', as: 'hierarchyNodes' });
ServicePOHierarchy.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });
ServicePOHierarchy.belongsTo(ServicePOHierarchy, { foreignKey: 'parent_hierarchy_id', as: 'parentNode' });
ServicePOHierarchy.hasMany(ServicePOHierarchy, { foreignKey: 'parent_hierarchy_id', as: 'children' });

// EmployeeWorkLog <-> ServicePOHierarchy — optional tag alongside the
// existing, required service_po_id (see EmployeeWorkLog.js's
// hierarchy_node_id doc comment). onDelete: 'SET NULL' matches the FK.
ServicePOHierarchy.hasMany(EmployeeWorkLog, { foreignKey: 'hierarchy_node_id', as: 'workLogs', onDelete: 'SET NULL' });
EmployeeWorkLog.belongsTo(ServicePOHierarchy, { foreignKey: 'hierarchy_node_id', as: 'hierarchyNode', onDelete: 'SET NULL' });

// ServicePO <-> ServicePOMonthlyBudget — one row per (service_po_id, month,
// year), see database/migrations/20260853_create_service_po_monthly_budgets.sql.
// Consumed by reportRepository.getServicePOSummary() for invoice/billed
// amounts instead of computing them from timesheets/monthly_costs.
ServicePO.hasMany(ServicePOMonthlyBudget, { foreignKey: 'service_po_id', as: 'monthlyBudgets' });
ServicePOMonthlyBudget.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });

// Forgot Password module — User/Employee <-> PasswordResetOtp/PasswordResetHistory
User.hasMany(PasswordResetOtp, { foreignKey: 'user_id', as: 'passwordResetOtps' });
PasswordResetOtp.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Employee.hasMany(PasswordResetOtp, { foreignKey: 'employee_id', as: 'passwordResetOtps' });
PasswordResetOtp.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
PasswordResetOtp.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });

User.hasMany(PasswordResetHistory, { foreignKey: 'user_id', as: 'passwordResetHistory' });
PasswordResetHistory.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
Employee.hasMany(PasswordResetHistory, { foreignKey: 'employee_id', as: 'passwordResetHistory' });
PasswordResetHistory.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
PasswordResetHistory.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
EmployeeWorkLog.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });

// Cost Budget Master — one row per (service_po_id, month, year), see
// database/migrations/20260858_create_cost_budget_master.sql. Isolated from
// ServicePOMonthlyBudget above (kept unchanged) per this feature's isolation
// requirement.
ServicePO.hasMany(CostBudget, { foreignKey: 'service_po_id', as: 'costBudgets' });
CostBudget.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });
CostBudget.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });

// Resource Budget Master — one row per (emp_id, service_po_id, month, year),
// see database/migrations/20260859_create_resource_budget_master.sql.
Employee.hasMany(ResourceBudget, { foreignKey: 'emp_id', as: 'resourceBudgets' });
ResourceBudget.belongsTo(Employee, { foreignKey: 'emp_id', as: 'employee' });
ServicePO.hasMany(ResourceBudget, { foreignKey: 'service_po_id', as: 'resourceBudgets' });
ResourceBudget.belongsTo(ServicePO, { foreignKey: 'service_po_id', as: 'servicePO' });
ResourceBudget.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  sequelize,
  Sequelize,
  Company,
  Entity,
  Role,
  Employee,
  EmployeeRole,
  EmployeeBusinessUnit,
  EmployeeLoginSession,
  User,
  Client,
  Project,
  ServiceCategory,
  ServiceType,
  DefaultCategory,
  DefaultType,
  CompanyCategory,
  CompanyType,
  ServicePO,
  ServicePOResource,
  ServicePOHierarchy,
  ServicePOMonthlyBudget,
  SubProject,
  MonthlyCost,
  Timesheet,
  AuditLog,
  UserSession,
  TimesheetImportHistory,
  TimesheetImportError,
  Notification,
  FormMaster,
  Category,
  RoleFormMapping,
  RoleCapability,
  AiInsightJob,
  AiInsight,
  EmployeeServicePOMapping,
  TeamMapping,
  ManagerEmployeeMapping,
  ManagerServicePOMapping,
  EmployeeWorkLog,
  EmployeeWorkLogTimeEntry,
  PasswordResetOtp,
  PasswordResetHistory,
  CostBudget,
  ResourceBudget,
};
