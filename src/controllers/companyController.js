'use strict';

const companyService = require('../services/companyService');
const { sendSuccess, sendCreated, sendPaginated, sendError, sendNotFound } = require('../utils/response');
const { getIpAddress } = require('../middlewares/auditLog');

/**
 * Company Controller
 * Entity Admin/Admin — every route here except GET / is gated by
 * requireEntityAdminOrAdmin and scoped to req.entityIds (the caller's own
 * owned Entities). GET / (the "load BUs" dropdown, also used by the Service
 * PO creation flow) additionally allows a BU Admin through — see
 * company.routes.js's allowCompanyListing — in which case req.employeeBUsOnly
 * is set and this returns only their own mapped BUs instead.
 */

const getAll = async (req, res, next) => {
  try {
    if (req.employeeBUsOnly) {
      const companies = await companyService.getAllForEmployee(req.query, req.employeeId);
      return sendSuccess(res, companies, 'Companies fetched successfully.');
    }
    const { data, meta } = await companyService.getAll(req.query, req.entityIds);
    return sendPaginated(res, data, meta, 'Companies fetched successfully.');
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
    const company = await companyService.getById(id, req.entityIds);
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
 * Creates a company under one of the calling Entity Admin's own owned
 * Entities. Decoupled from admin-minting — assign a BU Admin afterward via
 * ordinary Employee Master create/update (role_ids + business_unit_ids).
 */
const create = async (req, res, next) => {
  try {
    const result = await companyService.create(req.body, req.userId, getIpAddress(req), req.entityIds);
    return sendCreated(res, result, 'Company created successfully.');
  } catch (err) {
    if (err.statusCode === 409) {
      return sendError(res, err.message, 409);
    }
    if (err.statusCode === 403) {
      return sendError(res, err.message, 403);
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
    const company = await companyService.update(id, req.body, req.userId, getIpAddress(req), req.entityIds);
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
