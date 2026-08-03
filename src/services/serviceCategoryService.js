'use strict';

const serviceCategoryRepository = require('../repositories/serviceCategoryRepository');
const logger = require('../utils/logger');

const getAll = async (query = {}, companyId) => {
  return serviceCategoryRepository.findAll({
    search: query.search,
    status: query.status,
    companyId,
  });
};

const getById = async (id, companyId) => {
  const category = await serviceCategoryRepository.findById(id, companyId);
  if (!category) {
    const err = new Error('Service category not found.');
    err.statusCode = 404;
    throw err;
  }
  return category;
};

const create = async (data, userId, companyId) => {
  const existing = await serviceCategoryRepository.findByName(data.name, companyId);
  if (existing) {
    const err = new Error(`Service category "${data.name}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

  // A previously soft-deleted row still holds this name in the DB's unique
  // (company_id, name) index — the findByName() check above deliberately
  // excludes deleted rows, so recreating a deleted name would otherwise
  // reach Postgres and crash with a raw SequelizeUniqueConstraintError
  // instead of succeeding. Revive that row (and reactivate it — softDelete
  // sets status to 'inactive') rather than inserting a new one.
  const deleted = await serviceCategoryRepository.findDeletedByName(data.name, companyId);
  if (deleted) {
    const revived = await serviceCategoryRepository.update(
      deleted.id,
      { ...data, status: data.status || 'active', is_deleted: false, updated_by: userId },
      companyId
    );

    logger.info('Service category revived (was soft-deleted)', { categoryId: revived.id, name: revived.name, userId });

    return revived;
  }

  const payload = { ...data, company_id: companyId, created_by: userId, updated_by: userId };
  const category = await serviceCategoryRepository.create(payload);

  logger.info('Service category created', { categoryId: category.id, name: category.name, userId });

  return category;
};

const update = async (id, data, userId, companyId) => {
  const existing = await serviceCategoryRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Service category not found.');
    err.statusCode = 404;
    throw err;
  }

  if (data.name && data.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
    const conflict = await serviceCategoryRepository.findByName(data.name, companyId);
    if (conflict) {
      const err = new Error(`Service category "${data.name}" already exists.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const payload = { ...data, updated_by: userId };
  const updated = await serviceCategoryRepository.update(id, payload, companyId);

  logger.info('Service category updated', { categoryId: id, userId });

  return updated;
};

const deleteCategory = async (id, userId, companyId) => {
  const existing = await serviceCategoryRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error('Service category not found.');
    err.statusCode = 404;
    throw err;
  }

  await serviceCategoryRepository.softDelete(id, userId, companyId);

  logger.info('Service category soft-deleted', { categoryId: id, userId });
};

module.exports = { getAll, getById, create, update, delete: deleteCategory };
