'use strict';

const serviceCategoryRepository = require('../repositories/serviceCategoryRepository');
const logger = require('../utils/logger');

// Service Categories are now a single GLOBAL master (company_id IS NULL
// rows — see database/migrations/20260890_seed_global_service_types_categories.sql),
// shared by every Business Unit instead of being duplicated per-BU. Every
// operation below targets that one global set; `authContext`/any
// body-supplied `company_id` is no longer used to scope it.
const GLOBAL_COMPANY_ID = null;

const getAll = async (query = {}, authContext) => {
  return serviceCategoryRepository.findAll({
    search: query.search,
    status: query.status,
    companyId: GLOBAL_COMPANY_ID,
  });
};

const getById = async (id, authContext) => {
  const category = await serviceCategoryRepository.findById(id, GLOBAL_COMPANY_ID);
  if (!category) {
    const err = new Error('Service category not found.');
    err.statusCode = 404;
    throw err;
  }
  return category;
};

const create = async (data, userId, authContext) => {
  // `company_id` may still be sent by an older client — accepted but
  // ignored now that Service Category is a single global master.
  const { company_id: _bodyCompanyId, ...fields } = data;
  const companyId = GLOBAL_COMPANY_ID;

  const existing = await serviceCategoryRepository.findByName(fields.name, companyId);
  if (existing) {
    const err = new Error(`Service category "${fields.name}" already exists.`);
    err.statusCode = 409;
    throw err;
  }

  // A previously soft-deleted row still holds this name in the DB's unique
  // (company_id, name) index — the findByName() check above deliberately
  // excludes deleted rows, so recreating a deleted name would otherwise
  // reach Postgres and crash with a raw SequelizeUniqueConstraintError
  // instead of succeeding. Revive that row (and reactivate it — softDelete
  // sets status to 'inactive') rather than inserting a new one.
  const deleted = await serviceCategoryRepository.findDeletedByName(fields.name, companyId);
  if (deleted) {
    const revived = await serviceCategoryRepository.update(
      deleted.id,
      { ...fields, status: fields.status || 'active', is_deleted: false, updated_by: userId },
      companyId
    );

    logger.info('Service category revived (was soft-deleted)', { categoryId: revived.id, name: revived.name, userId });

    return revived;
  }

  const payload = { ...fields, company_id: companyId, created_by: userId, updated_by: userId };
  const category = await serviceCategoryRepository.create(payload);

  logger.info('Service category created', { categoryId: category.id, name: category.name, userId });

  return category;
};

const update = async (id, data, userId, authContext) => {
  const existing = await serviceCategoryRepository.findById(id, GLOBAL_COMPANY_ID);
  if (!existing) {
    const err = new Error('Service category not found.');
    err.statusCode = 404;
    throw err;
  }

  if (data.name && data.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
    const conflict = await serviceCategoryRepository.findByName(data.name, existing.company_id);
    if (conflict) {
      const err = new Error(`Service category "${data.name}" already exists.`);
      err.statusCode = 409;
      throw err;
    }
  }

  const payload = { ...data, updated_by: userId };
  const updated = await serviceCategoryRepository.update(id, payload, existing.company_id);

  logger.info('Service category updated', { categoryId: id, userId });

  return updated;
};

const deleteCategory = async (id, userId, authContext) => {
  const existing = await serviceCategoryRepository.findById(id, GLOBAL_COMPANY_ID);
  if (!existing) {
    const err = new Error('Service category not found.');
    err.statusCode = 404;
    throw err;
  }

  await serviceCategoryRepository.softDelete(id, userId, existing.company_id);

  logger.info('Service category soft-deleted', { categoryId: id, userId });
};

module.exports = { getAll, getById, create, update, delete: deleteCategory };
