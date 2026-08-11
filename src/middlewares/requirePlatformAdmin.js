'use strict';

const logger = require('../utils/logger');

/**
 * Gate for platform-level endpoints (e.g. creating an Admin). Must run
 * after authenticate. Checks role.hierarchy_rank === 1 (Platform Admin) —
 * NOT a role-name string check — since "Platform Admin" is now a rank in
 * the hierarchy, not a separate boolean flag (see
 * database/migrations/20260841_drop_users_is_platform_admin.sql).
 */
const requirePlatformAdmin = (req, res, next) => {
  if (!req.user || req.hierarchyRank !== 1) {
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
