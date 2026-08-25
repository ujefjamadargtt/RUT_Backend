'use strict';

const logger = require('../utils/logger');
const { Entity } = require('../models');
const entityRepository = require('../repositories/entityRepository');

/**
 * Gate for the "BU Admin Master" screens (company.routes.js's
 * create-company-with-admin flow, entityBuAdmin.routes.js) — reachable by
 * BOTH Entity Admin (its own owned Entities only) and Admin (its own
 * isolated scope — see below). Must run after authenticate.
 *
 * Deliberately NOT routed through the generic authorize() middleware —
 * same reasoning as requireEntityAdmin.js, which this wraps: a direct,
 * unconditional check, so a lower-tier role can never slip through here.
 *
 * On success, populates req.entityIds:
 *   - Admin (hierarchy_rank === 2): only the Entities owned by Entity
 *     Admins THIS Admin created (entityRepository.findIdsOwnedByAdmin —
 *     derived from entities.entity_admin_user_id + users.created_by, no
 *     new ownership table). An Admin who hasn't created any Entity Admin
 *     (or whose created Entity Admins haven't created an Entity yet) gets
 *     an empty array here, NOT every Entity in the system — fixes the bug
 *     where a freshly-created Admin could see every other Admin's Entity
 *     Admins/BU Admins.
 *   - Entity Admin: only the Entities this caller owns (entities.entity_admin_user_id
 *     = req.userId) — identical to requireEntityAdmin.js.
 * Downstream code (companyService.createWithAdmin's ownership check,
 * entityBuAdminService's company-scoping) needs no Admin-vs-Entity-Admin
 * branching at all — it just trusts req.entityIds, which is already the
 * right scope for either caller.
 */
const requireEntityAdminOrAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. This action is restricted to Admin or Entity Admin.',
      code: 'ENTITY_ADMIN_OR_ADMIN_REQUIRED',
    });
  }

  try {
    if (req.hierarchyRank === 2) {
      req.entityIds = await entityRepository.findIdsOwnedByAdmin(req.userId);
      return next();
    }

    const isEntityAdmin = req.userRoleName && req.userRoleName.toLowerCase() === 'entity admin';
    if (!isEntityAdmin) {
      logger.warn('Caller is neither Admin nor Entity Admin', {
        userId: req.userId,
        userRoleName: req.userRoleName,
        path: req.path,
        method: req.method,
      });
      return res.status(403).json({
        success: false,
        message: 'Access denied. This action is restricted to Admin or Entity Admin.',
        code: 'ENTITY_ADMIN_OR_ADMIN_REQUIRED',
      });
    }

    const entities = await Entity.findAll({
      where: { entity_admin_employee_id: req.employeeId, is_deleted: false },
      attributes: ['id'],
    });
    req.entityIds = entities.map((e) => e.id);
    next();
  } catch (error) {
    logger.error('requireEntityAdminOrAdmin failed to resolve entity scope', {
      userId: req.userId,
      error: error.message,
    });
    next(error);
  }
};

module.exports = requireEntityAdminOrAdmin;
