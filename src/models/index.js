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
const Role                   = require('./Role')(sequelize);
const Employee               = require('./Employee')(sequelize);
const User                   = require('./User')(sequelize);
const Client                 = require('./Client')(sequelize);
const ServiceCategory        = require('./ServiceCategory')(sequelize);
const ServiceType            = require('./ServiceType')(sequelize);
const ServicePO              = require('./ServicePO')(sequelize);
const ServicePOResource      = require('./ServicePOResource')(sequelize);
const SubProject             = require('./SubProject')(sequelize);
const MonthlyCost            = require('./MonthlyCost')(sequelize);
const Timesheet              = require('./Timesheet')(sequelize);
const AuditLog               = require('./AuditLog')(sequelize);
const UserSession            = require('./UserSession')(sequelize);
const TimesheetImportHistory = require('./TimesheetImportHistory')(sequelize);
const TimesheetImportError   = require('./TimesheetImportError')(sequelize);
const Notification           = require('./Notification')(sequelize);
const UserRole               = require('./UserRole')(sequelize);
const FormMaster             = require('./FormMaster')(sequelize);
const RoleFormMapping        = require('./RoleFormMapping')(sequelize);
const AiInsightJob           = require('./AiInsightJob')(sequelize);
const AiInsight              = require('./AiInsight')(sequelize);

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

// Company <-> every company-owned table (query convenience only — filtering
// itself is done via plain `where: { company_id }`, not these includes).
Company.hasMany(User,                   { foreignKey: 'company_id', as: 'users' });
Company.hasMany(Client,                 { foreignKey: 'company_id', as: 'clients' });
Company.hasMany(Employee,               { foreignKey: 'company_id', as: 'employees' });
Company.hasMany(MonthlyCost,            { foreignKey: 'company_id', as: 'monthlyCosts' });
Company.hasMany(ServicePO,              { foreignKey: 'company_id', as: 'servicePOs' });
Company.hasMany(ServicePOResource,      { foreignKey: 'company_id', as: 'servicePOResources' });
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
Employee.belongsTo(Company,               { foreignKey: 'company_id', as: 'company' });
MonthlyCost.belongsTo(Company,            { foreignKey: 'company_id', as: 'company' });
ServicePO.belongsTo(Company,              { foreignKey: 'company_id', as: 'company' });
ServicePOResource.belongsTo(Company,      { foreignKey: 'company_id', as: 'company' });
ServiceType.belongsTo(Company,            { foreignKey: 'company_id', as: 'company' });
ServiceCategory.belongsTo(Company,        { foreignKey: 'company_id', as: 'company' });
SubProject.belongsTo(Company,             { foreignKey: 'company_id', as: 'company' });
Timesheet.belongsTo(Company,              { foreignKey: 'company_id', as: 'company' });
TimesheetImportHistory.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
TimesheetImportError.belongsTo(Company,   { foreignKey: 'company_id', as: 'company' });
AiInsight.belongsTo(Company,              { foreignKey: 'company_id', as: 'company' });
AiInsightJob.belongsTo(Company,           { foreignKey: 'company_id', as: 'company' });

// Role <-> User
Role.hasMany(User, { foreignKey: 'role_id', as: 'users' });
User.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

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

// User <-> UserRole (many-to-many roles)
User.belongsToMany(Role, {
  through: UserRole,
  foreignKey: 'user_id',
  otherKey: 'role_id',
  as: 'roles',
});
Role.belongsToMany(User, {
  through: UserRole,
  foreignKey: 'role_id',
  otherKey: 'user_id',
  as: 'usersWithRoles',
});
User.hasMany(UserRole, { foreignKey: 'user_id', as: 'userRoles' });
Role.hasMany(UserRole, { foreignKey: 'role_id', as: 'userRoles' });
UserRole.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
UserRole.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

// Role <-> FormMaster (many-to-many through RoleFormMapping)
Role.belongsToMany(FormMaster, { through: RoleFormMapping, foreignKey: 'role_id', otherKey: 'form_id', as: 'forms' });
FormMaster.belongsToMany(Role, { through: RoleFormMapping, foreignKey: 'form_id', otherKey: 'role_id', as: 'roles' });
Role.hasMany(RoleFormMapping, { foreignKey: 'role_id', as: 'roleFormMappings' });
FormMaster.hasMany(RoleFormMapping, { foreignKey: 'form_id', as: 'roleFormMappings' });
RoleFormMapping.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });
RoleFormMapping.belongsTo(FormMaster, { foreignKey: 'form_id', as: 'form' });

// User <-> AuditLog
User.hasMany(AuditLog, { foreignKey: 'user_id', as: 'auditLogs' });
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// User <-> Notification
User.hasMany(Notification, { foreignKey: 'user_id', as: 'notifications' });
Notification.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Client <-> ServicePO
Client.hasMany(ServicePO, { foreignKey: 'client_id', as: 'servicePOs' });
ServicePO.belongsTo(Client, { foreignKey: 'client_id', as: 'client' });

// ServiceCategory <-> ServiceType
ServiceCategory.hasMany(ServiceType, { foreignKey: 'service_category_id', as: 'serviceTypes' });
ServiceType.belongsTo(ServiceCategory, { foreignKey: 'service_category_id', as: 'serviceCategory' });

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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  sequelize,
  Sequelize,
  Company,
  Role,
  Employee,
  User,
  Client,
  ServiceCategory,
  ServiceType,
  ServicePO,
  ServicePOResource,
  SubProject,
  MonthlyCost,
  Timesheet,
  AuditLog,
  UserSession,
  TimesheetImportHistory,
  TimesheetImportError,
  Notification,
  UserRole,
  FormMaster,
  RoleFormMapping,
  AiInsightJob,
  AiInsight,
};
