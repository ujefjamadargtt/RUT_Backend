'use strict';

const servicePOService = require('../services/servicePOService');
const servicePOImportService = require('../services/servicePOImportService');
const {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendPaginated,
  sendNotFound,
  sendError,
} = require('../utils/response');
const logger = require('../utils/logger');

/**
 * ServicePO Controller
 * Thin layer: parse request, delegate to service, format response.
 */

/**
 * The object-level scoping context Service PO reads need for company-less
 * actors (Admin/Entity Admin) — see companyAccessControlService.js. Built
 * only from server-verified req fields, never from body/query. Mirrors
 * projectController.js's buildAuthContext().
 *
 * @param {import('express').Request} req
 */
function buildAuthContext(req) {
  return { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };
}

/**
 * GET /api/v1/service-pos
 *
 * Passes the raw X-Company-Id header through so a company-less actor
 * (Admin/Entity Admin) gets the list narrowed to their currently selected
 * Global Business Unit when one is sent — same as getActivePOs() below.
 * Optional: omitting the header keeps the existing full-owned-scope
 * behavior, so this is not a breaking change for any other caller.
 */
const getAllServicePOs = async (req, res) => {
  try {
    const rawHeader = req.headers['x-company-id'];
    const headerCompanyId = rawHeader ? parseInt(rawHeader, 10) : null;
    const { data, meta } = await servicePOService.getAll(req.query, buildAuthContext(req), headerCompanyId);
    return sendPaginated(res, data, meta, 'Service POs fetched successfully.');
  } catch (error) {
    logger.error('getAllServicePOs error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/service-pos/active/list
 *
 * Passes the raw X-Company-Id header through so a company-less actor
 * (Admin/Entity Admin) gets the list narrowed to their currently selected
 * Global Business Unit when one is sent — see servicePOService.getActivePOs'
 * doc comment. Optional: omitting the header keeps the existing full-owned-
 * scope behavior, so this is not a breaking change for any other caller of
 * this endpoint.
 */
const getActivePOs = async (req, res) => {
  try {
    const rawHeader = req.headers['x-company-id'];
    const headerCompanyId = rawHeader ? parseInt(rawHeader, 10) : null;
    const pos = await servicePOService.getActivePOs(buildAuthContext(req), headerCompanyId);
    return sendSuccess(res, pos, 'Active Service POs fetched successfully.');
  } catch (error) {
    logger.error('getActivePOs error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/service-pos/:id
 */
const getServicePOById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    const po = await servicePOService.getById(id, buildAuthContext(req));
    return sendSuccess(res, po, 'Service PO fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    logger.error('getServicePOById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-pos
 */
const createServicePO = async (req, res) => {
  try {
    const po = await servicePOService.create(req.body, req.userId, req);
    return sendCreated(res, po, 'Service PO created successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      // create() can 404 on Client, Project, or Delivery Head — the service
      // already produces a precise message for each, so surface it as-is
      // rather than guessing which entity failed.
      return sendError(res, error.message, 404);
    }
    const details = error.errors ? error.errors.map((e) => e.message) : [];
    logger.error('createServicePO error', {
      error: error.message,
      details,
      fields: error.errors ? error.errors.map((e) => e.path) : [],
      userId: req.userId,
    });
    return sendError(res, error.message, error.statusCode || 500, details);
  }
};

/**
 * PUT /api/v1/service-pos/:id
 */
const updateServicePO = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    const po = await servicePOService.update(id, req.body, req.userId, req);
    return sendSuccess(res, po, 'Service PO updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      // update() can 404 on the Service PO itself, or on Client/Project/
      // Delivery Head when those are being changed — surface the service's
      // precise message rather than always assuming it's the Service PO.
      return sendError(res, error.message, 404);
    }
    logger.error('updateServicePO error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-pos/:id/close
 */
const closeServicePO = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    await servicePOService.close(id, req.userId, req);
    return sendSuccess(res, null, 'Service PO closed successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    logger.error('closeServicePO error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-pos/:id/allocate
 * Body: { employee_ids: number[] }
 */
const allocateResources = async (req, res) => {
  try {
    const poId = parseInt(req.params.id, 10);
    if (isNaN(poId) || poId < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    const { employee_ids } = req.body;
    await servicePOService.allocateResources(poId, employee_ids, req.userId, req);
    return sendSuccess(res, null, 'Resources allocated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('allocateResources error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * DELETE /api/v1/service-pos/:id/resources/:employeeId
 */
const deallocateResource = async (req, res) => {
  try {
    const poId = parseInt(req.params.id, 10);
    const employeeId = parseInt(req.params.employeeId, 10);

    if (isNaN(poId) || poId < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }
    if (isNaN(employeeId) || employeeId < 1) {
      return sendError(res, 'Invalid employee ID.', 400);
    }

    await servicePOService.deallocateResource(poId, employeeId, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendError(res, error.message, 404);
    }
    logger.error('deallocateResource error', { error: error.message, poId: req.params.id, employeeId: req.params.employeeId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/service-pos/:id/utilisation
 */
const getUtilisation = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid Service PO ID.', 400);
    }

    const utilisation = await servicePOService.getUtilisation(id, buildAuthContext(req));
    return sendSuccess(res, utilisation, 'Utilisation data fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Service PO');
    }
    logger.error('getUtilisation error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const deleteServicePO = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return sendError(res, 'Invalid Service PO ID.', 400);

    await servicePOService.delete(id, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service PO');
    logger.error('deleteServicePO error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-pos/import
 * Upload an Excel/CSV file and bulk-import Service POs, plus their
 * Hierarchy (Parent/Child) nodes.
 * Validation-first: every row/Service-PO-group is validated before any
 * insert happens. If any row/group fails, nothing is inserted and the
 * row-wise reasons are returned; only when every group passes does the
 * insert step run.
 */
const importServicePOs = async (req, res) => {
  try {
    const result = await servicePOImportService.importServicePOs(req.file.path, req.userId, req);
    const message = (result.imported > 0 || result.existing_po_reused > 0)
      ? `Import complete. ${result.imported} Service PO(s) created, ${result.existing_po_reused} existing Service PO(s) reused, ${result.hierarchy_created} hierarchy node(s) created.`
      : `Import aborted. ${result.skipped} row(s) failed validation — no rows were inserted.`;
    return sendSuccess(res, result, message);
  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('importServicePOs error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, 500);
  }
};

module.exports = {
  getAllServicePOs,
  getActivePOs,
  getServicePOById,
  createServicePO,
  updateServicePO,
  closeServicePO,
  deleteServicePO,
  allocateResources,
  deallocateResource,
  getUtilisation,
  importServicePOs,
};
