'use strict';

const serviceTypeService = require('../services/serviceTypeService');
const {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendNotFound,
  sendError,
} = require('../utils/response');
const logger = require('../utils/logger');

/**
 * ServiceType Controller
 * Thin layer: parse request, delegate to service, format response.
 */

/**
 * GET /api/v1/service-types
 * Return all service types.
 */
const getAllServiceTypes = async (req, res) => {
  try {
    const serviceTypes = await serviceTypeService.getAll(req.query, req.companyId);
    return sendSuccess(res, serviceTypes, 'Service types fetched successfully.');
  } catch (error) {
    logger.error('getAllServiceTypes error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/service-types/:id
 */
const getServiceTypeById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid service type ID.', 400);
    }

    const serviceType = await serviceTypeService.getById(id, req.companyId);
    return sendSuccess(res, serviceType, 'Service type fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service type');
    }
    logger.error('getServiceTypeById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-types
 */
const createServiceType = async (req, res) => {
  try {
    const serviceType = await serviceTypeService.create(req.body, req.userId, req.companyId);
    return sendCreated(res, serviceType, 'Service type created successfully.');
  } catch (error) {
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('createServiceType error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * PUT /api/v1/service-types/:id
 */
const updateServiceType = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid service type ID.', 400);
    }

    const serviceType = await serviceTypeService.update(id, req.body, req.userId, req.companyId);
    return sendSuccess(res, serviceType, 'Service type updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service type');
    }
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('updateServiceType error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const deleteServiceType = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return sendError(res, 'Invalid service type ID.', 400);

    await serviceTypeService.delete(id, req.userId, req.companyId);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service type');
    logger.error('deleteServiceType error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getAllServiceTypes,
  getServiceTypeById,
  createServiceType,
  updateServiceType,
  deleteServiceType,
};
