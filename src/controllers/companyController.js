'use strict';

const companyService = require('../services/companyService');
const { sendSuccess, sendCreated, sendError, sendNotFound } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');

/**
 * Company Controller
 * Platform-level only — every route here is gated by requirePlatformAdmin.
 */

const getAll = async (req, res, next) => {
  try {
    const companies = await companyService.getAll(req.query);
    return sendSuccess(res, companies, 'Companies fetched successfully.');
  } catch (err) {
    next(err);
  }
};

const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid company ID.', 400);
    }
    const company = await companyService.getById(id);
    return sendSuccess(res, company, 'Company fetched successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Company');
    }
    next(err);
  }
};

/**
 * POST /api/v1/companies
 * Creates a company and its first Company Admin in one transaction.
 */
const create = async (req, res, next) => {
  try {
    const result = await companyService.createWithAdmin(req.body, req.userId, getIpAddress(req));
    return sendCreated(res, result, 'Company and its first Company Admin created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    if (err.statusCode === 500) {
      return sendError(res, err.message, 500);
    }
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid company ID.', 400);
    }
    const company = await companyService.update(id, req.body, req.userId, getIpAddress(req));
    return sendSuccess(res, company, 'Company updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Company');
    }
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
};
