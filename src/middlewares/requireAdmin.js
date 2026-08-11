'use strict';

const logger = require('../utils/logger');
const entityRepository = require('../repositories/entityRepository');

/**
 * Gate for Admin-ONLY endpoints — specifically Entity Master management
 * (create/update/delete an Entity, and assigning/reassigning its Entity
 * Admin owner). Checks role.hierarchy_rank === 2 (Admin) exactly — NOT
 * Platform Admin, NOT Entity Admin, NOT BU Admin.
 *
 * Deliberately NOT routed through the generic authorize() middleware:
 * authorize()'s rank-based senior-tier bypass (roleHierarchyService.isSeniorTier,
 * ranks 1-4) would let Entity Admin (rank 3) straight through ANY capability
 * check here, which is exactly the privilege this gate exists to deny —
 * Entity Admin must never create/edit/delete Entity Master records. A
 * direct, unconditional rank check instead, mirroring requirePlatformAdmin.js
 * and requireEntityAdmin.js's same reasoning.
 *
 * On success, also populates req.entityIds — the Entities this Admin
 * already owns (via entityRepository.findIdsOwnedByAdmin), needed by
 * entityService.update()/deleteEntity() to scope which existing Entity the
 * caller may modify, the same way requireEntityAdminOrAdmin.js does for
 * read access.
 */
const requireAdmin = async (req, res, next) => {
  if (!req.user || req.hierarchyRank !== 2) {
    logger.warn('Non-Admin attempted an Admin-only endpoint', {
      userId: req.userId,
      hierarchyRank: req.hierarchyRank,
      path: req.path,
      method: req.method,
    });
    return res.status(403).json({
      success: false,
      message: 'Access denied. This action is restricted to Admin.',
      code: 'ADMIN_REQUIRED',
    });
  }

  try {
    req.entityIds = await entityRepository.findIdsOwnedByAdmin(req.userId);
    next();
  } catch (error) {
    logger.error('requireAdmin failed to resolve owned entities', {
      userId: req.userId,
      error: error.message,
    });
    next(error);
  }
};

module.exports = requireAdmin;
