'use strict';

const logger = require('../utils/logger');
const roleHierarchyService = require('../services/roleHierarchyService');

/**
 * Capability-based Authorization Middleware Factory
 *
 * @param {string|string[]} capabilities - one or more capability keys (see
 *   database/migrations/20260836_seed_target_roles_and_capabilities.sql);
 *   passing any one of them is sufficient (OR, not AND). An empty array
 *   means "any authenticated user."
 * @returns {Function} Express middleware
 *
 * Usage:
 *   router.post('/', authenticate, authorize('bu.create_client'), handler)
 *
 * Replaces the old role-name-string version and its hardcoded
 * SUPERUSER_ROLES bypass list with req.capabilities (computed once per
 * request by auth.js via roleHierarchyService — the single place
 * inheritance logic lives) plus a generic, rank-based senior-tier bypass
 * (see roleHierarchyService.isSeniorTier) — Platform Admin/Admin/Entity
 * Admin/BU Admin manage everything within their own scope, the same
 * privilege the old bypass granted 'super admin'/'bu admin' specifically,
 * generalized to the new hierarchy instead of hardcoded by name.
 */
const authorize = (capabilities = []) => {
  const requiredCapabilities = typeof capabilities === 'string' ? [capabilities] : capabilities;

  return (req, res, next) => {
    if (!req.user) {
      logger.warn('authorize() called without req.user — ensure authenticate middleware runs first', {
        path: req.path,
        method: req.method,
      });
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
        code: 'NOT_AUTHENTICATED',
      });
    }

    if (roleHierarchyService.isSeniorTier(req.hierarchyRank)) {
      return next();
    }

    if (requiredCapabilities.length === 0) {
      // No capability specified means any authenticated user is allowed
      return next();
    }

    const isAuthorized = roleHierarchyService.hasCapability(req.capabilities || new Set(), requiredCapabilities);

    if (!isAuthorized) {
      logger.warn('Unauthorized access attempt', {
        userId: req.userId,
        userRole: req.userRoleName,
        requiredCapabilities,
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
      return res.status(403).json({
        success: false,
        message: `Access denied. This action requires one of: ${requiredCapabilities.join(', ')}.`,
        code: 'FORBIDDEN',
      });
    }

    next();
  };
};

module.exports = authorize;
