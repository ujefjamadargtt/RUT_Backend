'use strict';

const { Op } = require('sequelize');
const { ServiceCategory } = require('../models');

/**
 * ServiceCategory Repository
 * All direct database interaction for the service_categories table.
 */

const findAll = async (filters = {}) => {
  const { search, status, companyId } = filters;

  const where = { is_deleted: false, company_id: companyId };

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
    where: { id, is_deleted: false, company_id: companyId },
    attributes: ['id', 'name', 'status', 'created_at', 'updated_at', 'created_by', 'updated_by'],
  });
};

/**
 * Find a service category by name, scoped to one company (uniqueness is
 * per-company — see uq_service_categories_company_name).
 */
const findByName = async (name, companyId) => {
  return ServiceCategory.findOne({
    where: { name: { [Op.iLike]: name.trim() }, is_deleted: false, company_id: companyId },
    attributes: ['id', 'name'],
  });
};

const softDelete = async (id, updatedBy, companyId) => {
  const record = await ServiceCategory.findOne({ where: { id, is_deleted: false, company_id: companyId } });
  if (!record) return null;
  return record.update({ status: 'inactive', is_deleted: true, updated_by: updatedBy });
};

const create = async (data, options = {}) => {
  return ServiceCategory.create(data, options);
};

const update = async (id, data, companyId) => {
  const [affectedRows, [updated]] = await ServiceCategory.update(data, {
    where: { id, company_id: companyId },
    returning: true,
  });

  if (affectedRows === 0) return null;

  return updated;
};

module.exports = {
  findAll,
  findById,
  findByName,
  create,
  update,
  softDelete,
};
