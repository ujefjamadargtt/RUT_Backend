'use strict';

const { Op } = require('sequelize');
const { Entity, Company } = require('../models');
const roleHierarchyService = require('./roleHierarchyService');

/**
 * Centralized User Master (User Management) authorization — fixes GET
 * /users and GET /users/:id, which previously had only `authenticate`, no
 * function-level OR object-level check at all: any authenticated role,
 * including plain Employee, could list every user in the company (or,
 * for Admin/Entity Admin, every company — company_id is never populated
 * for them, see resolveCompany.js) and enumerate GET /users/:id freely.
 *
 * Two-step, in that order, mirroring the "authorization before controller"
 * flow: (1) does this caller have User Management permission AT ALL —
 * function-level, entirely independent of which user is requested; (2) IF
 * so, which Users are they actually in scope for — object-level.
 *
 * FUNCTION-LEVEL: reuses the EXACT existing rule this same User Master
 * already applies to its admin-only actions (see
 * userController.js's changePassword/resetPassword) — no new capability
 * invented:
 *   - roleHierarchyService.isSeniorTier(role) — Platform Admin/Admin/
 *     Entity Admin/BU Admin (hierarchy_rank 1-4) manage everything within
 *     their own scope, same bypass authorize() already grants elsewhere.
 *   - 'hr.manage_employee' capability — HR's existing, seeded grant.
 * Project Admin/Service PO Admin/Manager/Employee hold NEITHER, so they
 * are denied outright — no user data is loaded for them at all. Note this
 * is DELIBERATELY narrower than the ROLE_CREATION_MATRIX
 * (src/config/roleHierarchy.js) that lets Project Admin/Service PO Admin
 * CREATE specific subordinate role accounts (POST /users) — creating one
 * named account you're handed is a different, narrower permission than
 * browsing/reading the whole User Master, which the brief for this fix
 * explicitly says must NOT be inferred from the creation matrix.
 *
 * OBJECT-LEVEL (only reached once function-level passes):
 *   - Admin (rank 2)        - platform-wide (no single company; see resolveCompany.js)
 *   - Entity Admin (rank 3) - Users whose Company sits under an Entity they own
 *   - BU Admin (rank 4)     - own Company only
 *   - HR (no rank)          - own Company only
 */

const USER_MANAGEMENT_CAPABILITY = 'hr.manage_employee';

/**
 * @param {import('express').Request} req - must already carry req.user/req.capabilities (auth.js)
 * @returns {boolean}
 */
const hasUserManagementPermission = (req) => {
  return roleHierarchyService.isSeniorTier(req.user.role)
    || roleHierarchyService.hasCapability(req.capabilities || new Set(), USER_MANAGEMENT_CAPABILITY);
};

/**
 * @param {object} authContext
 * @param {number} authContext.userId - req.userId
 * @param {number|null} authContext.companyId - req.companyId (undefined/null for Admin/Entity Admin)
 * @param {number|null} authContext.hierarchyRank - req.hierarchyRank
 * @returns {Promise<object>} a Sequelize `where` fragment; `{}` means unrestricted
 */
const resolveUserAccessWhere = async ({ userId, companyId, hierarchyRank }) => {
  // Admin (rank 2) — platform-wide, same as its existing Employee-record scope.
  if (hierarchyRank === 2) {
    return {};
  }

  // Entity Admin (rank 3) — Users whose Company is under an Entity they own.
  if (hierarchyRank === 3) {
    const entities = await Entity.findAll({
      where: { entity_admin_user_id: userId, is_deleted: false },
      attributes: ['id'],
    });
    const entityIds = entities.map((e) => e.id);
    if (entityIds.length === 0) return { id: -1 };

    const companies = await Company.findAll({
      where: { entity_id: { [Op.in]: entityIds }, is_deleted: false },
      attributes: ['id'],
    });
    const companyIds = companies.map((c) => c.id);
    if (companyIds.length === 0) return { id: -1 };

    return { company_id: { [Op.in]: companyIds } };
  }

  // BU Admin (rank 4) and HR (no rank, gated above by capability) — own Company only.
  return companyId ? { company_id: companyId } : { id: -1 };
};

module.exports = { hasUserManagementPermission, resolveUserAccessWhere };
