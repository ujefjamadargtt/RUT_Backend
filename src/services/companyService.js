'use strict';

const { sequelize, DefaultCategory, DefaultType } = require('../models');
const companyRepository = require('../repositories/companyRepository');
const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const employeeRepository = require('../repositories/employeeRepository');
const userAdditionalRoleRepository = require('../repositories/userAdditionalRoleRepository');
const serviceCategoryRepository = require('../repositories/serviceCategoryRepository');
const serviceTypeRepository = require('../repositories/serviceTypeRepository');
const companyCategoryRepository = require('../repositories/companyCategoryRepository');
const companyTypeRepository = require('../repositories/companyTypeRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const { generateTemporaryPassword } = require('../utils/password');
const logger = require('../utils/logger');

/**
 * report_bucket_key isn't part of the default_categories master table (see
 * database/migrations/20260815_create_default_categories.sql) — it's a
 * service_categories-only concern the Dashboard/Analytics report-bucket
 * logic reads (not the name string), so it stays a small hardcoded lookup
 * here, keyed by the same category_name that now comes from the DB.
 */
const REPORT_BUCKET_KEY_BY_CATEGORY_NAME = {
  'Billable': 'billable',
  'Non-Billable': 'non_billable',
  'Customer Non-Billable': 'customer_non_billable',
};

/**
 * Company Service
 * Entity Admin-scoped provisioning (repurposed from Platform-Admin-scoped
 * when Entity Admin was introduced): create/list/update companies, and the
 * transactional "company + its first BU Admin" creation flow, always
 * scoped to the calling Entity Admin's own owned Entities (entityIds). A
 * company is never created without an owner — if admin creation fails, the
 * company insert rolls back too.
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

const getAll = async (query = {}, entityIds) => {
  return companyRepository.findAllForEntities(entityIds, { search: query.search, status: query.status });
};

const getById = async (id, entityIds) => {
  const company = await companyRepository.findByIdForEntities(id, entityIds);
  if (!company) fail(`Company with ID ${id} not found.`, 404);
  return company;
};

/**
 * Create a company, its first BU Admin, and that BU Admin's linked Employee
 * record — all in one transaction, under one of the calling Entity Admin's
 * own owned Entities.
 *
 * The BU Admin is an Employee from the beginning (not a User created first
 * and an Employee bolted on later): one Employee row, one User row (with
 * `employee_id` pointing at it), and that single User holds TWO roles —
 * `BU Admin` as its PRIMARY role (role_id — unchanged from before, so every
 * existing BU-Admin-scoped permission/route check keeps working unmodified)
 * plus `Employee` as an ADDITIONAL role (user_additional_roles — the same
 * mechanism employeeService.js's Manager-capability check and userService.js's
 * multi-role user creation already use — see
 * database/migrations/20260850_add_user_additional_roles.sql). Login,
 * capability resolution (req.capabilities), and role serialisation all
 * already union primary + additional roles, so no auth/login code changes
 * were needed for this user to resolve as both BU Admin and Employee.
 *
 * @param {object} data - { company: { entity_id, company_code, company_name, is_original_data_visible? },
 *   admin: { admin_email, admin_password }, employee: { employee_code, full_name, designation?, etc. —
 *   see employeeValidation.createEmployeeSchema, reused verbatim by createCompanySchema } }
 * @param {number} actorId - the Entity Admin creating this company
 * @param {string} ipAddress
 * @param {number[]} entityIds - the calling Entity Admin's own owned Entities (req.entityIds)
 * @returns {Promise<{ company: Company, employee: object, admin: object, temporaryPassword?: string }>}
 */
const createWithAdmin = async (data, actorId, ipAddress = null, entityIds = []) => {
  const { entity_id, company_code, company_name, is_original_data_visible } = data.company;
  const { admin_email: email, admin_password: password } = data.admin;
  // employee.email is present because the frontend reuses the Employee
  // creation form component wholesale — the actual login identity is
  // admin.admin_email/admin.admin_password; employee.email is only checked
  // for consistency, never used to create the User (see below).
  // is_timesheet_approval_required is stripped and force-set to false below
  // — a BU Admin's own timesheets are auto-published, never held for
  // approval (unlike a normal Employee, whose approval-required default
  // stays true — see employeeService.create()); not a choice the creation
  // form gets to override.
  const {
    email: employeeEmail,
    password: employeePassword,
    is_timesheet_approval_required: _requestedApprovalRequired,
    ...employeeFields
  } = data.employee;

  if (employeeEmail && employeeEmail.toLowerCase() !== email.toLowerCase()) {
    fail(`Employee email "${employeeEmail}" must match Admin email "${email}".`, 400);
  }

  // "Entity Admin cannot access Entities belonging to another Entity
  // Admin" — enforced here before anything else runs.
  if (!entityIds.includes(entity_id)) {
    fail(`Entity #${entity_id} is not one of your own entities.`, 403);
  }

  const existingCompany = await companyRepository.findByCode(company_code);
  if (existingCompany) {
    fail(`Company code "${company_code}" already exists.`, 409);
  }

  const existingUser = await userRepository.findByEmail(email);
  if (existingUser) {
    fail(`A user with email "${email}" already exists.`, 409);
  }

  // No employee_code duplicate check is needed here — employee_code
  // uniqueness is scoped per-company (uq_employees_company_code) and this
  // Employee is, by construction, the very first one in a Company that
  // doesn't exist yet.

  const [companyAdminRole, employeeRole] = await Promise.all([
    roleRepository.findByName('BU Admin'),
    roleRepository.findByName('Employee'),
  ]);
  if (!companyAdminRole) {
    fail('The "BU Admin" role is not seeded. Run database/migrations/20260729_seed_platform_roles.sql and 20260807_rename_company_admin_to_bu_admin.sql first.', 500);
  }
  if (!employeeRole) {
    fail('The "Employee" role is not seeded.', 500);
  }

  const temporaryPassword = password || generateTemporaryPassword();

  let company, employee, admin;
  await sequelize.transaction(async (transaction) => {
    company = await companyRepository.create(
      { entity_id, company_code, company_name, is_original_data_visible, created_by: actorId, updated_by: actorId },
      { transaction }
    );

    employee = await employeeRepository.create(
      {
        ...employeeFields,
        is_timesheet_approval_required: false,
        company_id: company.id,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction }
    );

    admin = await userRepository.create(
      {
        email,
        password: temporaryPassword,
        role_id: companyAdminRole.id,
        employee_id: employee.id,
        company_id: company.id,
        status: 'active',
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction }
    );

    // The BU Admin's second role — Employee — granted additively so the
    // same User resolves as both (see this function's doc comment above).
    await userAdditionalRoleRepository.replaceForUser(admin.id, [employeeRole.id], actorId, transaction);

    // Single master copy of the default category/type list now lives in
    // default_categories/default_types (see database/migrations/
    // 20260815_create_default_categories.sql onward) instead of a
    // hardcoded array here. service_categories/service_types are still
    // seeded exactly as before — same columns, same shape, so every
    // existing report/dashboard/timesheet/import query keeps working
    // unchanged — plus a company_categories/company_types mapping row is
    // now additionally written to record which default each row came from.
    const defaultCategories = await DefaultCategory.findAll({
      where: { status: 'active' },
      order: [['display_order', 'ASC']],
      transaction,
    });

    const categoryMap = {}; // default_category name -> { serviceCategoryId, companyCategoryId }
    for (const defaultCategory of defaultCategories) {
      const created = await serviceCategoryRepository.create(
        {
          name: defaultCategory.category_name,
          report_bucket_key: REPORT_BUCKET_KEY_BY_CATEGORY_NAME[defaultCategory.category_name] || null,
          company_id: company.id,
          status: 'active',
          created_by: actorId,
          updated_by: actorId,
        },
        { transaction }
      );

      const companyCategory = await companyCategoryRepository.create(
        {
          company_id: company.id,
          default_category_id: defaultCategory.id,
          status: 'active',
        },
        { transaction }
      );

      categoryMap[defaultCategory.category_name] = {
        serviceCategoryId: created.id,
        companyCategoryId: companyCategory.id,
      };
    }

    const defaultTypes = await DefaultType.findAll({
      where: { status: 'active' },
      include: [{ model: DefaultCategory, as: 'defaultCategory', attributes: ['category_name'] }],
      order: [['display_order', 'ASC']],
      transaction,
    });

    for (const defaultType of defaultTypes) {
      const mapping = categoryMap[defaultType.defaultCategory.category_name];

      await serviceTypeRepository.create(
        {
          service_type_name: defaultType.type_name,
          service_category_id: mapping.serviceCategoryId,
          company_id: company.id,
          created_by: actorId,
          updated_by: actorId,
        },
        { transaction }
      );

      await companyTypeRepository.create(
        {
          company_category_id: mapping.companyCategoryId,
          default_type_id: defaultType.id,
          status: 'active',
        },
        { transaction }
      );
    }
  });

  await createAuditLog(actorId, 'CREATE', 'companies', company.id, null, company.toJSON(), ipAddress);

  await createAuditLog(
    actorId,
    'CREATE',
    'employees',
    employee.id,
    null,
    { id: employee.id, employee_code: employee.employee_code, company_id: employee.company_id, linked_user_id: admin.id },
    ipAddress
  );

  const adminSummary = {
    id: admin.id,
    email: admin.email,
    employee_id: employee.id,
    company_id: admin.company_id,
    role_id: admin.role_id,
    roles: ['BU Admin', 'Employee'],
  };
  await createAuditLog(actorId, 'CREATE', 'users', admin.id, null, adminSummary, ipAddress);

  logger.info('BU Admin created with linked Employee record and dual role assignment', {
    companyId: company.id,
    employeeId: employee.id,
    userId: admin.id,
    createdBy: actorId,
  });

  const employeeSummary = { id: employee.id, employee_code: employee.employee_code, full_name: employee.full_name, email };

  const response = { company, employee: employeeSummary, admin: adminSummary };
  // Only surface the plaintext password when we generated it — if the
  // Entity Admin supplied their own, they already know it.
  if (!password) {
    response.temporaryPassword = temporaryPassword;
  }

  return response;
};

const update = async (id, data, actorId, ipAddress = null, entityIds = []) => {
  const existing = await getById(id, entityIds);
  const oldValues = existing.toJSON();

  const updated = await companyRepository.update(id, data);

  await createAuditLog(actorId, 'UPDATE', 'companies', id, oldValues, updated.toJSON(), ipAddress);

  return updated;
};

module.exports = {
  getAll,
  getById,
  createWithAdmin,
  update,
};
