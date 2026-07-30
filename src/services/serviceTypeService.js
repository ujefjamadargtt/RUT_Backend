'use strict';

const serviceTypeRepository = require('../repositories/serviceTypeRepository');
const logger = require('../utils/logger');

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
const getAll = async (query = {}, companyId) => {
  return serviceTypeRepository.findAll({
    search: query.search,
    service_category_id: query.service_category_id,
    companyId,
  });
};

/**
 * Return a single service type by ID.
 *
 * @param {number} id
 * @returns {Promise<ServiceType>}
 */
const getById = async (id, companyId) => {
  const serviceType = await serviceTypeRepository.findById(id, companyId);

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
 * @param {object} data   - { service_type_name }
 * @param {number} userId
 * @returns {Promise<ServiceType>}
 */
const create = async (data, userId, companyId) => {
  const existing = await serviceTypeRepository.findByName(data.service_type_name, companyId);
  if (existing) {
    const err = new Error(`Service type "${data.service_type_name}" already exists.`);
    err.statusCode = 409;
    throw err;
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
 * @returns {Promise<ServiceType>}
 */
const update = async (id, data, userId, companyId) => {
  const existing = await serviceTypeRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Service type not found.');
    err.statusCode = 404;
    throw err;
  }

  if (
    data.service_type_name &&
    data.service_type_name.trim().toLowerCase() !== existing.service_type_name.toLowerCase()
  ) {
    const conflict = await serviceTypeRepository.findByName(data.service_type_name, companyId);
    if (conflict) {
      const err = new Error(`Service type "${data.service_type_name}" already exists.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const payload = { ...data, updated_by: userId };
  const updated = await serviceTypeRepository.update(id, payload, companyId);

  logger.info('Service type updated', { serviceTypeId: id, userId });

  return updated;
};

const deleteServiceType = async (id, userId, companyId) => {
  const existing = await serviceTypeRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Service type not found.');
    err.statusCode = 404;
    throw err;
  }

  await serviceTypeRepository.softDelete(id, userId, companyId);

  logger.info('Service type soft-deleted', { serviceTypeId: id, userId });
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteServiceType,
};
