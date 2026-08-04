'use strict';

const { sequelize } = require('../models');
const companyRepository = require('../repositories/companyRepository');
const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const serviceCategoryRepository = require('../repositories/serviceCategoryRepository');
const serviceTypeRepository = require('../repositories/serviceTypeRepository');
const { createAuditLog } = require('../middlewares/auditLog');

/**
 * Every new company starts with these 3 categories, matching the default
 * GTT company's existing set exactly (name + report_bucket_key) — the
 * Dashboard/Analytics report-bucket logic reads report_bucket_key, not the
 * name string, so this is what makes those tiles/charts work for a new
 * company on day one instead of everything falling into "Uncategorized".
 */
const DEFAULT_SERVICE_CATEGORIES = [
  { name: 'Billable', report_bucket_key: 'billable' },
  { name: 'Non-Billable', report_bucket_key: 'non_billable' },
  { name: 'Customer Non-Billable', report_bucket_key: 'customer_non_billable' },
];

/**
 * Every new company also starts with these default service types, each
 * linked to one of the categories above by NAME — never by ID. Category IDs
 * are per-company (auto-generated on insert below), so the same "Billable"
 * category has a different ID for every company; hardcoding an ID here
 * would silently link a new company's service types to some other
 * company's category row.
 */
const DEFAULT_SERVICE_TYPES = [
  { name: 'Project', category: 'Billable' },
  { name: 'Service Pack', category: 'Billable' },
  { name: 'Staff Augmentation', category: 'Billable' },
  { name: 'AMC', category: 'Billable' },
  { name: 'Internal Support', category: 'Non-Billable' },
  { name: 'Team Management', category: 'Non-Billable' },
  { name: 'Leaves', category: 'Non-Billable' },
  { name: 'L&D', category: 'Non-Billable' },
  { name: 'Others', category: 'Non-Billable' },
  { name: 'Customer Work', category: 'Customer Non-Billable' },
  { name: 'Complimentary Hours', category: 'Customer Non-Billable' },
  { name: 'Product/Solution/Framework Development', category: 'Customer Non-Billable' },
];

/**
 * Company Service
 * Platform-level provisioning: create/list/update companies, and the
 * transactional "company + its first BU Admin" creation flow. A
 * company is never created without an owner — if admin creation fails, the
 * company insert rolls back too.
 */

const fail = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

const getAll = async (query = {}) => {
  return companyRepository.findAll({ search: query.search, status: query.status });
};

const getById = async (id) => {
  const company = await companyRepository.findById(id);
  if (!company) fail(`Company with ID ${id} not found.`, 404);
  return company;
};

/**
 * Create a company and its first BU Admin user in one transaction.
 * @param {object} data - { company_code, company_name, admin_email, admin_password, admin_full_name }
 * @param {number} actorId - the platform admin creating this company
 * @param {string} ipAddress
 * @returns {Promise<{ company: Company, admin: User }>}
 */
const createWithAdmin = async (data, actorId, ipAddress = null) => {
  const { company_code, company_name, admin_email, admin_password, is_original_data_visible } = data;

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
      { company_code, company_name, is_original_data_visible, created_by: actorId, updated_by: actorId },
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

    // Insert categories first and capture their freshly generated IDs —
    // never assume/hardcode an ID, each company gets its own.
    const categoryMap = {};
    for (const category of DEFAULT_SERVICE_CATEGORIES) {
      const created = await serviceCategoryRepository.create(
        {
          ...category,
          company_id: company.id,
          status: 'active',
          created_by: actorId,
          updated_by: actorId,
        },
        { transaction }
      );
      categoryMap[category.name] = created.id;
    }

    // Then link each default service type to this company's own category ID
    // via the map above, resolved by name.
    for (const serviceType of DEFAULT_SERVICE_TYPES) {
      await serviceTypeRepository.create(
        {
          service_type_name: serviceType.name,
          service_category_id: categoryMap[serviceType.category],
          company_id: company.id,
          created_by: actorId,
          updated_by: actorId,
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

const update = async (id, data, actorId, ipAddress = null) => {
  const existing = await getById(id);
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
