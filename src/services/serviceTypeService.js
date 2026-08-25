'use strict';

const serviceTypeRepository = require('../repositories/serviceTypeRepository');
const serviceCategoryRepository = require('../repositories/serviceCategoryRepository');
const logger = require('../utils/logger');

// Service Types are now a single GLOBAL master (company_id IS NULL rows —
// see database/migrations/20260890_seed_global_service_types_categories.sql),
// shared by every Business Unit instead of being duplicated per-BU. Every
// operation below targets that one global set; `authContext`/any
// body-supplied `company_id` is no longer used to scope it.
const GLOBAL_COMPANY_ID = null;

/**
 * Throw a clean 422 if service_category_id is set but doesn't refer to a
 * real, non-deleted category for this company. Without this check, a bad ID
 * reaches Postgres as a raw, uncaught foreign-key-violation error — which in
 * production comes back to the caller as an opaque, unlogged-to-console 500
 * (see src/utils/response.js's prod redaction) instead of a clear 422.
 */
const assertCategoryExists = async (serviceCategoryId, companyId) => {
  if (!serviceCategoryId) return;

  const category = await serviceCategoryRepository.findById(serviceCategoryId, companyId);
  if (!category) {
    const err = new Error(`Service category ${serviceCategoryId} not found.`);
    err.statusCode = 422;
    throw err;
  }
};

/**
 * ServiceType Service
 * Business logic for service types.
 * Service types are a small, stable reference dataset (Project, Service Pack,
 * Resource Outsourcing, Managed Services) so pagination is not applied here —
 * a flat list is sufficient for the entire expected dataset volume.
 */

/**
 * Return all service types, with an optional search filter.
 *
 * @param {object} query - { search, service_category_id }
 * @returns {Promise<ServiceType[]>}
 */
const getAll = async (query = {}, authContext) => {
  return serviceTypeRepository.findAll({
    search: query.search,
    service_category_id: query.service_category_id,
    companyId: GLOBAL_COMPANY_ID,
  });
};

/**
 * Return a single service type by ID.
 *
 * @param {number} id
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<ServiceType>}
 */
const getById = async (id, authContext) => {
  const serviceType = await serviceTypeRepository.findById(id, GLOBAL_COMPANY_ID);

  if (!serviceType) {
    const err = new Error('Service type not found.');
    err.statusCode = 404;
    throw err;
  }

  return serviceType;
};

/**
 * Create a new service type.
 * Enforces uniqueness of service_type_name (case-insensitive).
 *
 * @param {object} data   - { service_type_name, [company_id] }
 * @param {number} userId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<ServiceType>}
 */
const create = async (data, userId, authContext) => {
  // `company_id` may still be sent by an older client — accepted but
  // ignored now that Service Type is a single global master.
  const { company_id: _bodyCompanyId, ...fields } = data;
  const companyId = GLOBAL_COMPANY_ID;
  data = fields;

  const existing = await serviceTypeRepository.findByName(data.service_type_name, companyId);
  if (existing) {
    const err = new Error(`Service type "${data.service_type_name}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

  await assertCategoryExists(data.service_category_id, companyId);

  // A previously soft-deleted row still holds this name in the DB's unique
  // (company_id, service_type_name) index — the findByName() check above
  // deliberately excludes deleted rows, so recreating a deleted name would
  // otherwise reach Postgres and crash with a raw SequelizeUniqueConstraintError
  // instead of succeeding. Revive that row rather than inserting a new one.
  const deleted = await serviceTypeRepository.findDeletedByName(data.service_type_name, companyId);
  if (deleted) {
    const revived = await serviceTypeRepository.update(
      deleted.id,
      { ...data, is_deleted: false, updated_by: userId },
      companyId
    );

    logger.info('Service type revived (was soft-deleted)', { serviceTypeId: revived.id, name: revived.service_type_name, userId });

    return revived;
  }

  const payload = {
    ...data,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const serviceType = await serviceTypeRepository.create(payload);

  logger.info('Service type created', { serviceTypeId: serviceType.id, name: serviceType.service_type_name, userId });

  return serviceType;
};

/**
 * Update an existing service type.
 * Prevents renaming to an already-used name.
 *
 * @param {number} id
 * @param {object} data   - { service_type_name }
 * @param {number} userId
 * @param {object} authContext - { companyId, hierarchyRank, employeeId }
 * @returns {Promise<ServiceType>}
 */
const update = async (id, data, userId, authContext) => {
  const existing = await serviceTypeRepository.findById(id, GLOBAL_COMPANY_ID);
  if (!existing) {
    const err = new Error('Service type not found.');
    err.statusCode = 404;
    throw err;
  }

  if (
    data.service_type_name &&
    data.service_type_name.trim().toLowerCase() !== existing.service_type_name.toLowerCase()
  ) {
    const conflict = await serviceTypeRepository.findByName(data.service_type_name, existing.company_id);
    if (conflict) {
      const err = new Error(`Service type "${data.service_type_name}" already exists.`);
      err.statusCode = 409;
      throw err;
    }
  }

  await assertCategoryExists(data.service_category_id, existing.company_id);

  const payload = { ...data, updated_by: userId };
  const updated = await serviceTypeRepository.update(id, payload, existing.company_id);

  logger.info('Service type updated', { serviceTypeId: id, userId });

  return updated;
};

const deleteServiceType = async (id, userId, authContext) => {
  const existing = await serviceTypeRepository.findById(id, GLOBAL_COMPANY_ID);
  if (!existing) {
    const err = new Error('Service type not found.');
    err.statusCode = 404;
    throw err;
  }

  await serviceTypeRepository.softDelete(id, userId, existing.company_id);

  logger.info('Service type soft-deleted', { serviceTypeId: id, userId });
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteServiceType,
};
