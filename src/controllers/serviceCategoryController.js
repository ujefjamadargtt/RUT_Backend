'use strict';

const serviceCategoryService = require('../services/serviceCategoryService');
const { sendSuccess, sendCreated, sendNoContent, sendNotFound, sendError } = require('../utils/response');
const logger = require('../utils/logger');

const getAllServiceCategories = async (req, res) => {
  try {
    const categories = await serviceCategoryService.getAll(req.query, req.companyId);
    return sendSuccess(res, categories, 'Service categories fetched successfully.');
  } catch (error) {
    logger.error('getAllServiceCategories error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getServiceCategoryById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return sendError(res, 'Invalid service category ID.', 400);

    const category = await serviceCategoryService.getById(id, req.companyId);
    return sendSuccess(res, category, 'Service category fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service category');
    logger.error('getServiceCategoryById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const createServiceCategory = async (req, res) => {
  try {
    const category = await serviceCategoryService.create(req.body, req.userId, req.companyId);
    return sendCreated(res, category, 'Service category created successfully.');
  } catch (error) {
    if (error.statusCode === 409) return sendError(res, error.message, 409);
    logger.error('createServiceCategory error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const updateServiceCategory = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return sendError(res, 'Invalid service category ID.', 400);

    const category = await serviceCategoryService.update(id, req.body, req.userId, req.companyId);
    return sendSuccess(res, category, 'Service category updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service category');
    if (error.statusCode === 409) return sendError(res, error.message, 409);
    logger.error('updateServiceCategory error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const deleteServiceCategory = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return sendError(res, 'Invalid service category ID.', 400);

    await serviceCategoryService.delete(id, req.userId, req.companyId);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service category');
    logger.error('deleteServiceCategory error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getAllServiceCategories,
  getServiceCategoryById,
  createServiceCategory,
  updateServiceCategory,
  deleteServiceCategory,
};
