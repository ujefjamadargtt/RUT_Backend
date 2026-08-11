'use strict';

const { sequelize, DefaultCategory, DefaultType } = require('../models');
const companyRepository = require('../repositories/companyRepository');
const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const serviceCategoryRepository = require('../repositories/serviceCategoryRepository');
const serviceTypeRepository = require('../repositories/serviceTypeRepository');
const companyCategoryRepository = require('../repositories/companyCategoryRepository');
const companyTypeRepository = require('../repositories/companyTypeRepository');
const { createAuditLog } = require('../middlewares/auditLog');

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
 * Create a company and its first BU Admin user in one transaction, under
 * one of the calling Entity Admin's own owned Entities.
 * @param {object} data - { entity_id, company_code, company_name, admin_email, admin_password }
 * @param {number} actorId - the Entity Admin creating this company
 * @param {string} ipAddress
 * @param {number[]} entityIds - the calling Entity Admin's own owned Entities (req.entityIds)
 * @returns {Promise<{ company: Company, admin: User }>}
 */
const createWithAdmin = async (data, actorId, ipAddress = null, entityIds = []) => {
  const { entity_id, company_code, company_name, admin_email, admin_password, is_original_data_visible } = data;

  // "Entity Admin cannot access Entities belonging to another Entity
  // Admin" — enforced here before anything else runs.
  if (!entityIds.includes(entity_id)) {
    fail(`Entity #${entity_id} is not one of your own entities.`, 403);
  }

  const existingCompany = await companyRepository.findByCode(company_code);
  if (existingCompany) {
    fail(`Company code "${company_code}" already exists.`, 409);
  }

  const existingUser = await userRepository.findByEmail(admin_email);
  if (existingUser) {
    fail(`A user with email "${admin_email}" already exists.`, 409);
  }

  const companyAdminRole = await roleRepository.findByName('BU Admin');
  if (!companyAdminRole) {
    fail('The "BU Admin" role is not seeded. Run database/migrations/20260729_seed_platform_roles.sql and 20260807_rename_company_admin_to_bu_admin.sql first.', 500);
  }

  let company, admin;
  await sequelize.transaction(async (transaction) => {
    company = await companyRepository.create(
      { entity_id, company_code, company_name, is_original_data_visible, created_by: actorId, updated_by: actorId },
      { transaction }
    );

    admin = await userRepository.create(
      {
        email: admin_email,
        password: admin_password,
        role_id: companyAdminRole.id,
        company_id: company.id,
        status: 'active',
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction }
    );

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

  const adminSummary = { id: admin.id, email: admin.email, role_id: admin.role_id, company_id: admin.company_id };
  await createAuditLog(actorId, 'CREATE', 'users', admin.id, null, adminSummary, ipAddress);

  return { company, admin: adminSummary };
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
