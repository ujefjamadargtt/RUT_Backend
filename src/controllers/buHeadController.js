'use strict';

const buHeadService = require('../services/buHeadService');
const { sendSuccess, sendCreated, sendPaginated, sendNotFound, sendError } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * BU Head Controller — "BU Head Master" screen. Every action is scoped to
 * req.entityIds (see requireEntityAdminOrAdmin.js), mirroring
 * entityBuAdminController.js.
 */

const create = async (req, res, next) => {
  try {
    const result = await buHeadService.createBuHead(req.body, req.userId, getIpAddress(req), req.entityIds);
    return sendCreated(res, result, 'BU Head created successfully.');
  } catch (err) {
    if (err.statusCode === 409 || err.statusCode === 403) {
      return sendError(res, err.message, err.statusCode);
    }
    if (err.statusCode === 500) {
      return sendError(res, err.message, 500);
    }
    next(err);
  }
};

const getAll = async (req, res, next) => {
  try {
    const { data, meta } = await buHeadService.getAll(req.entityIds, req.query);
    return sendPaginated(res, data, meta, 'BU Heads fetched successfully.');
  } catch (err) {
    logger.error('buHead getAll error', { error: err.message, userId: req.userId });
    next(err);
  }
};

const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Head ID.', 400);
    }
    const user = await buHeadService.getById(id, req.entityIds);
    return sendSuccess(res, user, 'BU Head fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'BU Head');
    }
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Head ID.', 400);
    }
    const user = await buHeadService.update(id, req.body, req.entityIds, req.userId, req);
    return sendSuccess(res, user, 'BU Head updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'BU Head');
    }
    next(err);
  }
};

const setStatus = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Head ID.', 400);
    }
    const user = await buHeadService.setStatus(id, req.body.status, req.entityIds, req.userId, req);
    return sendSuccess(res, user, `BU Head ${req.body.status === 'active' ? 'activated' : 'deactivated'} successfully.`);
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'BU Head');
    }
    next(err);
  }
};

const getMappedCompanies = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Head ID.', 400);
    }
    const mappings = await buHeadService.getMappedCompanies(id, req.entityIds);
    return sendSuccess(res, mappings, 'Mapped BUs fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'BU Head');
    }
    next(err);
  }
};

const mapCompanies = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid BU Head ID.', 400);
    }
    const mappings = await buHeadService.mapCompanies(id, req.body.company_ids, req.entityIds, req.userId, req);
    return sendCreated(res, mappings, 'BUs mapped successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'BU Head');
    }
    if (err.statusCode === 403 || err.statusCode === 409) {
      return sendError(res, err.message, err.statusCode);
    }
    next(err);
  }
};

const unmapCompany = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const companyId = parseInt(req.params.companyId, 10);
    if (isNaN(id) || id < 1 || isNaN(companyId) || companyId < 1) {
      return sendError(res, 'Invalid BU Head ID or Company ID.', 400);
    }
    await buHeadService.unmapCompany(id, companyId, req.entityIds, req.userId, req);
    return sendSuccess(res, null, 'BU unmapped successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, err.message.includes('BU Head') ? 'BU Head' : 'Mapping');
    }
    next(err);
  }
};

module.exports = {
  create,
  getAll,
  getById,
  update,
  setStatus,
  getMappedCompanies,
  mapCompanies,
  unmapCompany,
};
