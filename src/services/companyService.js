'use strict';

const { sequelize } = require('../models');
const companyRepository = require('../repositories/companyRepository');
const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const serviceCategoryRepository = require('../repositories/serviceCategoryRepository');
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
 * Company Service
 * Platform-level provisioning: create/list/update companies, and the
 * transactional "company + its first Company Admin" creation flow. A
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
 * Create a company and its first Company Admin user in one transaction.
 * @param {object} data - { company_code, company_name, admin_email, admin_password, admin_full_name }
 * @param {number} actorId - the platform admin creating this company
 * @param {string} ipAddress
 * @returns {Promise<{ company: Company, admin: User }>}
 */
const createWithAdmin = async (data, actorId, ipAddress = null) => {
  const { company_code, company_name, admin_email, admin_password } = data;

  const existingCompany = await companyRepository.findByCode(company_code);
  if (existingCompany) {
    fail(`Company code "${company_code}" already exists.`, 409);
  }

  const existingUser = await userRepository.findByEmail(admin_email);
  if (existingUser) {
    fail(`A user with email "${admin_email}" already exists.`, 409);
  }

  const companyAdminRole = await roleRepository.findByName('Company Admin');
  if (!companyAdminRole) {
    fail('The "Company Admin" role is not seeded. Run database/migrations/20260729_seed_platform_roles.sql first.', 500);
  }

  let company, admin;
  await sequelize.transaction(async (transaction) => {
    company = await companyRepository.create(
      { company_code, company_name, created_by: actorId, updated_by: actorId },
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

    for (const category of DEFAULT_SERVICE_CATEGORIES) {
      await serviceCategoryRepository.create(
        {
          ...category,
          company_id: company.id,
          status: 'active',
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
