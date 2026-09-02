'use strict';

const serviceCategoryService = require('../services/serviceCategoryService');
const { sendSuccess, sendCreated, sendNoContent, sendNotFound, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * The object-level scoping context Service Category WRITES need for
 * company-less actors (Admin/Entity Admin) — see companyAccessControlService.js.
 * Built only from server-verified req fields, never from body/query.
 *
 * @param {import('express').Request} req
 */
function buildAuthContext(req) {
  return { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };
}

/**
 * Same purpose, for the 2 READ endpoints below only. These run
 * authenticateReadMultiBU (serviceCategory.routes.js), not the single-
 * req.companyId `authenticate` chain writes above still use — req.companyIds
 * is always a pre-resolved ARRAY, every BU the caller is mapped to when
 * X-Company-Id is omitted (see resolveReportCompanyScope.js). Passed
 * through as `companyId` since resolveActorCompanyScope()/
 * serviceCategoryRepository's companyScope() both already accept an array
 * as-is.
 *
 * @param {import('express').Request} req
 */
function buildReadAuthContext(req) {
  return { companyId: req.companyIds, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };
}

const getAllServiceCategories = async (req, res) => {
  try {
    const categories = await serviceCategoryService.getAll(req.query, buildReadAuthContext(req));
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

    const category = await serviceCategoryService.getById(id, buildReadAuthContext(req));
    return sendSuccess(res, category, 'Service category fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service category');
    logger.error('getServiceCategoryById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const createServiceCategory = async (req, res) => {
  try {
    const category = await serviceCategoryService.create(req.body, req.userId, buildAuthContext(req));
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

    const category = await serviceCategoryService.update(id, req.body, req.userId, buildAuthContext(req));
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

    await serviceCategoryService.delete(id, req.userId, buildAuthContext(req));
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
