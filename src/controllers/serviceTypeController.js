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
 * The object-level scoping context Service Type reads/writes need for
 * company-less actors (Admin/Entity Admin) — see companyAccessControlService.js.
 * Built only from server-verified req fields, never from body/query.
 *
 * @param {import('express').Request} req
 */
function buildAuthContext(req) {
  return { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };
}

/**
 * GET /api/v1/service-types
 * Return all service types.
 */
const getAllServiceTypes = async (req, res) => {
  try {
    const serviceTypes = await serviceTypeService.getAll(req.query, buildAuthContext(req));
    return sendSuccess(res, serviceTypes, 'Service types fetched successfully.');
  } catch (error) {
    logger.error('getAllServiceTypes error', { error: error.message, stack: error.stack });
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

    const serviceType = await serviceTypeService.getById(id, buildAuthContext(req));
    return sendSuccess(res, serviceType, 'Service type fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service type');
    }
    logger.error('getServiceTypeById error', { error: error.message, stack: error.stack, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-types
 */
const createServiceType = async (req, res) => {
  try {
    const serviceType = await serviceTypeService.create(req.body, req.userId, buildAuthContext(req));
    return sendCreated(res, serviceType, 'Service type created successfully.');
  } catch (error) {
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('createServiceType error', { error: error.message, stack: error.stack, userId: req.userId });
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

    const serviceType = await serviceTypeService.update(id, req.body, req.userId, buildAuthContext(req));
    return sendSuccess(res, serviceType, 'Service type updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service type');
    }
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('updateServiceType error', { error: error.message, stack: error.stack, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const deleteServiceType = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return sendError(res, 'Invalid service type ID.', 400);

    await serviceTypeService.delete(id, req.userId, buildAuthContext(req));
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service type');
    logger.error('deleteServiceType error', { error: error.message, stack: error.stack, id: req.params.id });
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
