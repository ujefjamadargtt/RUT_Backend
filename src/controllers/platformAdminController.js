'use strict';

const platformAdminService = require('../services/platformAdminService');
const { sendSuccess } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Platform Admin Controller — Platform-level only, gated by
 * requirePlatformAdmin (see platformAdmin.routes.js).
 */

const getOrganizationOverview = async (req, res, next) => {
  try {
    const data = await platformAdminService.getOrganizationOverview();
    return sendSuccess(res, data, 'Platform organization overview fetched successfully.');
  } catch (err) {
    logger.error('platformAdmin getOrganizationOverview error', { error: err.message, userId: req.userId });
    next(err);
  }
};

module.exports = {
  getOrganizationOverview,
};
