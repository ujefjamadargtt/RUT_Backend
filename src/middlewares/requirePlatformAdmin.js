'use strict';

const logger = require('../utils/logger');

/**
 * Gate for platform-level endpoints (company provisioning). Must run after
 * authenticate. Checks users.is_platform_admin directly — NOT a role-name
 * check via authorize() — since gating "is this the platform operator" is
 * orthogonal to the RBAC role/forms system entirely.
 */
const requirePlatformAdmin = (req, res, next) => {
  if (!req.user || !req.user.is_platform_admin) {
    logger.warn('Non-platform-admin attempted a platform-only endpoint', {
      userId: req.userId,
      path: req.path,
      method: req.method,
    });
    return res.status(403).json({
      success: false,
      message: 'Access denied. This action is restricted to the platform administrator.',
      code: 'PLATFORM_ADMIN_REQUIRED',
    });
  }
  next();
};

module.exports = requirePlatformAdmin;
