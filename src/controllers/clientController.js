'use strict';

const clientService       = require('../services/clientService');
const clientImportService = require('../services/clientImportService');
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
 * Client Controller
 * Thin layer: parse request, delegate to service, format response.
 * All business logic lives in clientService.js.
 */

/**
 * The object-level scoping context the 3 Client READ endpoints below
 * (getAllClients/getClientById/getActiveClients) need. Unlike the write
 * endpoints (create/update/delete, which keep the single-req.companyId
 * `authenticate` chain and resolve scope via
 * clientService.js's resolveActorRecordAccessScope()), these 3 routes run
 * authenticateReadMultiBU (client.routes.js) instead — req.companyIds is
 * always a pre-resolved ARRAY (never req.companyId): every BU the caller
 * is mapped to when X-Company-Id is omitted, not just one, per
 * resolveReportCompanyScope.js. Passed straight through as `companyId`
 * here since resolveActorRecordAccessScope()/clientRepository.companyScope()
 * both already accept an array as-is.
 *
 * Known trade-off: a company-less actor's own Clients left with NO
 * Business Unit (`company_id IS NULL AND created_by = them` — see
 * resolveActorRecordAccessScope()'s doc comment) are not specially
 * surfaced on these 3 read routes the way they still are on write routes,
 * since a non-null array here short-circuits that fallback. Narrow,
 * pre-existing edge case; revisit if it turns out to matter in practice.
 *
 * Built only from server-verified req fields, never from the request body/query.
 *
 * @param {import('express').Request} req
 * @returns {{ companyId: number[], hierarchyRank: number|null, employeeId: number|null }}
 */
function buildClientAuthContext(req) {
  // selectedCompanyId: ONLY from explicit ?company_id query param — signals
  // the caller wants just that BU's records (BU-less records excluded).
  // The X-Company-Id header is session context, NOT a filter intent, so it
  // must NOT be used here. When no query param is present, selectedCompanyId
  // stays null → Admin gets their BU-less clients plus all BU clients.
  const rawQp = req.query.company_id;
  const selectedCompanyId = rawQp ? parseInt(rawQp, 10) : null;
  return {
    companyId: req.companyIds,
    hierarchyRank: req.hierarchyRank,
    employeeId: req.employeeId,
    selectedCompanyId: Number.isFinite(selectedCompanyId) && selectedCompanyId > 0 ? selectedCompanyId : null,
  };
}

/**
 * GET /api/v1/clients
 * List clients with pagination, search, and filters.
 */
const getAllClients = async (req, res) => {
  try {
    const { data, meta } = await clientService.getAll(req.query, buildClientAuthContext(req));
    return sendPaginated(res, data, meta, 'Clients fetched successfully.');
  } catch (error) {
    logger.error('getAllClients error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/clients/:id
 * Fetch a single client by ID.
 */
const getClientById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid client ID.', 400);
    }

    const client = await clientService.getById(id, buildClientAuthContext(req));
    return sendSuccess(res, client, 'Client fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Client');
    }
    logger.error('getClientById error', { error: error.message, id: req.params.id });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/clients
 * Create a new client.
 */
const createClient = async (req, res) => {
  try {
    const client = await clientService.create(req.body, req.userId, req);
    return sendCreated(res, client, 'Client created successfully.');
  } catch (error) {
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('createClient error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * PUT /api/v1/clients/:id
 * Update an existing client.
 */
const updateClient = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid client ID.', 400);
    }

    const client = await clientService.update(id, req.body, req.userId, req);
    return sendSuccess(res, client, 'Client updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Client');
    }
    if (error.statusCode === 409) {
      return sendError(res, error.message, 409);
    }
    logger.error('updateClient error', { error: error.message, id: req.params.id, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * DELETE /api/v1/clients/:id
 * Soft-delete a client (sets status to inactive).
 */
const deleteClient = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid client ID.', 400);
    }

    await clientService.deleteClient(id, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendNotFound(res, 'Client');
    }
    if (error.statusCode === 409 || error.statusCode === 400) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('deleteClient error', { error: error.message, id: req.params.id, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * GET /api/v1/clients/active/list
 * Return a lightweight list of active clients for dropdowns.
 */
const getActiveClients = async (req, res) => {
  try {
    const clients = await clientService.getActiveClients(buildClientAuthContext(req));
    return sendSuccess(res, clients, 'Active clients fetched successfully.');
  } catch (error) {
    logger.error('getActiveClients error', { error: error.message });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/clients/import
 * Import clients from an uploaded Excel/CSV file.
 * Returns a summary: total rows, imported, skipped, and any error rows.
 */
const importClients = async (req, res) => {
  try {
    const { path: filePath } = req.file;
    const result = await clientImportService.importClients(filePath, req.userId, req);

    const message =
      `Import complete. ${result.imported} client(s) imported, ` +
      `${result.skipped} duplicate(s) skipped, ` +
      `${result.error_rows.length - result.skipped} error(s).`;

    return sendSuccess(res, result, message, 200);
  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.message, error.statusCode);
    }
    logger.error('importClients error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, 500);
  }
};

module.exports = {
  getAllClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  getActiveClients,
  importClients,
};
