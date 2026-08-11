'use strict';

const teamMappingService = require('../services/teamMappingService');
const { sendSuccess, sendCreated, sendNoContent, sendNotFound, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Team Mapping Controller — Service PO Admin's own "My Team" screen.
 */

const getMyTeam = async (req, res) => {
  try {
    const team = await teamMappingService.getMyTeam(req.userId, req.companyId);
    return sendSuccess(res, team, 'My team fetched successfully.');
  } catch (error) {
    logger.error('getMyTeam error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getAvailableManagers = async (req, res) => {
  try {
    const managers = await teamMappingService.getAvailableManagers(req.companyId);
    return sendSuccess(res, managers, 'Managers fetched successfully.');
  } catch (error) {
    logger.error('getAvailableManagers error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const addManager = async (req, res) => {
  try {
    const mapping = await teamMappingService.addManager(
      req.userId, req.body.manager_user_id, req.companyId, req.userId, req
    );
    return sendCreated(res, mapping, 'Manager added to your team successfully.');
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Manager');
    if (error.statusCode === 409 || error.statusCode === 400) return sendError(res, error.message, error.statusCode);
    logger.error('addManager error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const removeManager = async (req, res) => {
  try {
    const managerUserId = parseInt(req.params.managerUserId, 10);
    if (isNaN(managerUserId)) return sendError(res, 'Invalid Manager ID.', 400);

    await teamMappingService.removeManager(req.userId, managerUserId, req.companyId, req.userId, req);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 404) return sendNotFound(res, 'Mapping');
    logger.error('removeManager error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const getMyTeamServicePOGrants = async (req, res) => {
  try {
    const grants = await teamMappingService.getMyTeamServicePOGrants(req.userId, req.companyId);
    return sendSuccess(res, grants, 'Team Service PO grants fetched successfully.');
  } catch (error) {
    logger.error('getMyTeamServicePOGrants error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const grantServicePO = async (req, res) => {
  try {
    const managerUserId = parseInt(req.params.managerUserId, 10);
    if (isNaN(managerUserId)) return sendError(res, 'Invalid Manager ID.', 400);

    const grant = await teamMappingService.grantServicePO(
      req.userId, managerUserId, req.body.service_po_id, req.companyId, req.userId
    );
    return sendCreated(res, grant, 'Service PO granted successfully.');
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    if (error.statusCode === 404) return sendNotFound(res, 'Manager or Service PO');
    if (error.statusCode === 409) return sendError(res, error.message, 409);
    logger.error('grantServicePO error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

const revokeServicePO = async (req, res) => {
  try {
    const managerUserId = parseInt(req.params.managerUserId, 10);
    const servicePOId = parseInt(req.params.servicePOId, 10);
    if (isNaN(managerUserId) || isNaN(servicePOId)) return sendError(res, 'Invalid ID.', 400);

    await teamMappingService.revokeServicePO(req.userId, managerUserId, servicePOId, req.companyId);
    return sendNoContent(res);
  } catch (error) {
    if (error.statusCode === 403) return sendError(res, error.message, 403);
    if (error.statusCode === 404) return sendNotFound(res, 'Grant');
    logger.error('revokeServicePO error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = {
  getMyTeam,
  getAvailableManagers,
  addManager,
  removeManager,
  getMyTeamServicePOGrants,
  grantServicePO,
  revokeServicePO,
};
