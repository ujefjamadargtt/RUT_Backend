'use strict';

const { Op } = require('sequelize');
const { ServiceCategory } = require('../models');

/**
 * ServiceCategory Repository
 * All direct database interaction for the service_categories table.
 */

/**
 * Builds a `company_id` WHERE fragment. Accepts a single number (BU-scoped
 * actor's own `req.companyId`) or an array (a company-less actor's
 * resolved list of owned Company ids — see
 * companyAccessControlService.resolveActorCompanyScope; empty array
 * correctly matches nothing). Same pattern as clientRepository.js.
 *
 * @param {number|number[]} companyId
 * @returns {object}
 */
function companyScope(companyId) {
  if (Array.isArray(companyId)) {
    return { company_id: { [Op.in]: companyId } };
  }
  return { company_id: companyId };
}

const findAll = async (filters = {}) => {
  const { search, status, companyId } = filters;

  const where = { is_deleted: false, ...companyScope(companyId) };

  if (search && search.trim()) {
    where.name = { [Op.iLike]: `%${search.trim()}%` };
  }

  if (status && status !== 'all') {
    where.status = status;
  }

  return ServiceCategory.findAll({
    where,
    attributes: ['id', 'name', 'status', 'created_at', 'updated_at', 'created_by', 'updated_by'],
    order: [['name', 'ASC']],
  });
};

const findById = async (id, companyId) => {
  return ServiceCategory.findOne({
    where: { id, is_deleted: false, ...companyScope(companyId) },
    attributes: ['id', 'name', 'status', 'created_at', 'updated_at', 'created_by', 'updated_by'],
  });
};

/**
 * Find a service category by name, scoped to one company (uniqueness is
 * per-company — see uq_service_categories_company_name).
 */
const findByName = async (name, companyId) => {
  return ServiceCategory.findOne({
    where: { name: { [Op.iLike]: name.trim() }, is_deleted: false, ...companyScope(companyId) },
    attributes: ['id', 'name'],
  });
};

/**
 * Find a soft-deleted category occupying this name for this company.
 * uq_service_categories_company_name is a plain (company_id, name) unique
 * index with no is_deleted-aware condition, so a soft-deleted row still
 * blocks a fresh INSERT of the same name at the DB level even though
 * findByName() (which excludes is_deleted rows) reports no conflict.
 * Callers use this to revive the row instead of inserting a new one and
 * hitting a raw SequelizeUniqueConstraintError.
 */
const findDeletedByName = async (name, companyId) => {
  return ServiceCategory.findOne({
    where: { name: { [Op.iLike]: name.trim() }, is_deleted: true, ...companyScope(companyId) },
  });
};

const softDelete = async (id, updatedBy, companyId) => {
  const record = await ServiceCategory.findOne({ where: { id, is_deleted: false, ...companyScope(companyId) } });
  if (!record) return null;
  return record.update({ status: 'inactive', is_deleted: true, updated_by: updatedBy });
};

const create = async (data, options = {}) => {
  return ServiceCategory.create(data, options);
};

const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await ServiceCategory.update(data, {
    where: { id, ...companyScope(companyId) },
    returning: true,
  });

  if (affectedRows === 0) return null;

  return updated;
};

module.exports = {
  findAll,
  findById,
  findByName,
  findDeletedByName,
  create,
  update,
  softDelete,
};
