'use strict';

const servicePOHierarchyService = require('../services/servicePOHierarchyService');
const { sendSuccess, sendCreated, sendNoContent, sendNotFound, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Service PO Hierarchy Controller
 * Thin layer: parse request, delegate to service, format response.
 * Completely independent of servicePOController.js — never calls
 * servicePOService.create()/update().
 */

function parsePositiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * GET /api/v1/service-pos/:servicePoId/hierarchy
 */
const getHierarchy = async (req, res) => {
  try {
    const servicePOId = parsePositiveInt(req.params.servicePoId);
    if (!servicePOId) return sendError(res, 'Invalid Service PO ID.', 400);

    const tree = await servicePOHierarchyService.getTree(servicePOId, req);
    return sendSuccess(res, tree, 'Service PO hierarchy fetched successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service PO');
    logger.error('getHierarchy error', { error: error.message, servicePoId: req.params.servicePoId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-pos/:servicePoId/hierarchy/parent — create a Parent node
 */
const createParent = async (req, res) => {
  try {
    const servicePOId = parsePositiveInt(req.params.servicePoId);
    if (!servicePOId) return sendError(res, 'Invalid Service PO ID.', 400);

    const node = await servicePOHierarchyService.createParent(servicePOId, req.body, req.userId, req);
    return sendCreated(res, node, 'Parent node created successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service PO');
    logger.error('createParent error', { error: error.message, servicePoId: req.params.servicePoId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * POST /api/v1/service-pos/:servicePoId/hierarchy/:parentId/child — create a Child node
 */
const createChild = async (req, res) => {
  try {
    const servicePOId = parsePositiveInt(req.params.servicePoId);
    const parentId = parsePositiveInt(req.params.parentId);
    if (!servicePOId || !parentId) return sendError(res, 'Invalid Service PO or Parent node ID.', 400);

    const node = await servicePOHierarchyService.createChild(servicePOId, parentId, req.body, req.userId, req);
    return sendCreated(res, node, 'Child node created successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Service PO or Parent node');
    logger.error('createChild error', {
      error: error.message,
      servicePoId: req.params.servicePoId,
      parentId: req.params.parentId,
    });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * PUT /api/v1/service-pos/hierarchy/:hierarchyId — rename (and/or reorder)
 * a Parent or Child node
 */
const renameNode = async (req, res) => {
  try {
    const hierarchyId = parsePositiveInt(req.params.hierarchyId);
    if (!hierarchyId) return sendError(res, 'Invalid hierarchy node ID.', 400);

    const node = await servicePOHierarchyService.rename(hierarchyId, req.body, req.userId, req);
    return sendSuccess(res, node, 'Hierarchy node updated successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Hierarchy node');
    logger.error('renameNode error', { error: error.message, hierarchyId: req.params.hierarchyId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

/**
 * DELETE /api/v1/service-pos/hierarchy/:hierarchyId — delete a Parent
 * (and all its Children) or a Child node
 */
const deleteNode = async (req, res) => {
  try {
    const hierarchyId = parsePositiveInt(req.params.hierarchyId);
    if (!hierarchyId) return sendError(res, 'Invalid hierarchy node ID.', 400);

    await servicePOHierarchyService.remove(hierarchyId, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Hierarchy node');
    logger.error('deleteNode error', { error: error.message, hierarchyId: req.params.hierarchyId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getHierarchy,
  createParent,
  createChild,
  renameNode,
  deleteNode,
};
