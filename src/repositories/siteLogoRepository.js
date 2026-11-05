'use strict';

const { SiteLogo, Employee } = require('../models');

/**
 * Site Logo Repository — all direct database access for site_logos.
 * Listing queries never select `image_data` (the model's default scope excludes it);
 * only findImageById loads the bytes.
 */

const LIST_ATTRIBUTES = [
  'id', 'file_name', 'mime_type', 'file_size', 'is_active', 'uploaded_by', 'created_at', 'updated_at',
];

const findActive = () =>
  SiteLogo.findOne({ where: { is_active: true }, attributes: ['id', 'file_name', 'updated_at'] });

const findAll = () =>
  SiteLogo.findAll({
    attributes: LIST_ATTRIBUTES,
    include: [{ model: Employee, as: 'uploader', attributes: ['id', 'full_name'], required: false }],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });

const findById = (id, options = {}) =>
  SiteLogo.findByPk(id, { attributes: LIST_ATTRIBUTES, include: [{ model: Employee, as: 'uploader', attributes: ['id', 'full_name'], required: false }], ...options });

/** The only query that loads the bytes. */
const findImageById = (id) =>
  SiteLogo.unscoped().findByPk(id, { attributes: ['id', 'mime_type', 'file_size', 'image_data'] });

const create = (values) => SiteLogo.create(values);

const deactivateAll = (transaction) =>
  SiteLogo.update({ is_active: false }, { where: { is_active: true }, transaction });

const activateById = (id, transaction) =>
  SiteLogo.update({ is_active: true }, { where: { id }, transaction });

const exists = (id, transaction) => SiteLogo.count({ where: { id }, transaction }).then((n) => n > 0);

module.exports = { findActive, findAll, findById, findImageById, create, deactivateAll, activateById, exists };
