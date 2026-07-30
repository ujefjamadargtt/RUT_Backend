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
 * GET /api/v1/clients
 * List clients with pagination, search, and filters.
 */
const getAllClients = async (req, res) => {
  try {
    const { data, meta } = await clientService.getAll(req.query, req.companyId);
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

    const client = await clientService.getById(id, req.companyId);
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
    const clients = await clientService.getActiveClients(req.companyId);
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
    const result = await clientImportService.importClients(filePath, req.userId, req.companyId);

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
