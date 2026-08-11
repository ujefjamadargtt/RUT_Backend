'use strict';

const jwt = require('jsonwebtoken');
const { verifyToken } = require('../config/jwt');
const { User, Role, Employee } = require('../models');
const roleHierarchyService = require('../services/roleHierarchyService');
const userAdditionalRoleRepository = require('../repositories/userAdditionalRoleRepository');
const logger = require('../utils/logger');
const resolveCompany = require('./resolveCompany');

/**
 * Routes Platform Admin may reach despite being platform-only by default
 * (see the block in authenticate() below). Platform Admin's own
 * responsibilities under the new hierarchy are: create Admin, manage the
 * platform, manage Role Master, manage Form Master — never Entity/BU-level
 * business routes (creating an Entity Admin or BU Admin directly is now
 * Admin's job, not Platform Admin's — see src/config/roleHierarchy.js).
 *
 * role.routes.js and rbac.routes.js are both mounted at the same
 * `/api/v1/roles` baseUrl (see app.js), so req.path (the part after baseUrl)
 * is what distinguishes Role Master CRUD (`/`, `/:id`) and role-form-mapping
 * endpoints (`/forms`, `/forms/mapping`, `/form-mappings...`) from
 * `/user-mappings/...` (obsolete — removed with the user_roles table).
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isPlatformAdminAllowedRoute(req) {
  if (req.baseUrl.endsWith('/admins')) return true;
  if (req.baseUrl.endsWith('/forms')) return true;
  if (req.baseUrl.endsWith('/roles')) return true;
  return false;
}

/**
 * JWT Authentication Middleware
 * Extracts Bearer token, verifies it, loads the user, and attaches to req.user.
 *
 * Single identity table (`users`) for every account tier, including
 * Employees — see database/migrations/20260842_employees_drop_login_columns.sql
 * and authService.js. There is no longer a separate Employee token/audience.
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
        code: 'NO_TOKEN',
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token || token.trim() === '') {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Token is empty.',
        code: 'EMPTY_TOKEN',
      });
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        return res.status(401).json({
          success: false,
          message: 'Token has expired. Please log in again.',
          code: 'TOKEN_EXPIRED',
          expiredAt: err.expiredAt,
        });
      }
      if (err instanceof jwt.JsonWebTokenError) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token. Please log in again.',
          code: 'INVALID_TOKEN',
        });
      }
      // NotBeforeError or any other JWT error
      return res.status(401).json({
        success: false,
        message: 'Token verification failed.',
        code: 'TOKEN_ERROR',
      });
    }

    const user = await User.findOne({
      where: { id: decoded.id, status: 'active' },
      include: [
        {
          model: Role,
          as: 'role',
          attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
        },
        {
          model: Employee,
          as: 'employee',
          attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
          required: false,
        },
      ],
      attributes: { exclude: ['password'] },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found or account is inactive.',
        code: 'USER_INACTIVE',
      });
    }

    if (!user.role || user.role.status !== 'active') {
      return res.status(401).json({
        success: false,
        message: 'No active role is assigned to this account. Please contact the administrator.',
        code: 'NO_ACTIVE_ROLE',
      });
    }

    // req.hierarchyRank / req.userRoleName below are ALWAYS derived from the
    // PRIMARY role only (user.role) — the sole source of truth for
    // hierarchy/scoping decisions (resolveCompany, requireAdmin, etc.).
    // req.capabilities is the UNION of the primary role's capabilities plus
    // every ADDITIONAL operational role the user holds (see
    // database/migrations/20260850_add_user_additional_roles.sql) — extra
    // roles only ever expand what authorize() lets through, never the
    // hierarchy/company scope a request resolves to.
    const additionalRoles = await userAdditionalRoleRepository.findRolesByUserId(user.id);
    const activeAdditionalRoles = additionalRoles.filter((role) => role.status === 'active');

    const effectiveCapabilities = await roleHierarchyService.getEffectiveCapabilitiesForRoleIds([
      user.role.id,
      ...activeAdditionalRoles.map((role) => role.id),
    ]);

    // Attach user and convenience fields to request. req.userRoles/
    // req.userRole/req.activeRoles now reflect every role the user holds
    // (primary + additional) — most existing call sites only ever read the
    // first element or treat these as a general role list, so this is
    // additive/backward-compatible; new code should prefer req.userRoleName
    // / req.hierarchyRank (primary-only) or req.capabilities (unioned)
    // below depending on whether it's a hierarchy or a capability question.
    req.user = user;
    req.userId = user.id;
    req.employeeId = user.employee_id || null;
    req.userRoleName = user.role.role_name;
    req.hierarchyRank = user.role.hierarchy_rank;
    req.capabilities = effectiveCapabilities;
    req.userRoles = [user.role.role_name, ...activeAdditionalRoles.map((role) => role.role_name)];
    req.userRole = user.role.role_name;
    req.activeRoles = [user.role, ...activeAdditionalRoles];

    // Platform Admin (hierarchy_rank === 1) is platform-only — see
    // isPlatformAdminAllowedRoute() above. Most business routes rely solely
    // on per-route authorize([...]) calls for gating, but many read (GET)
    // endpoints have no authorize() call at all and are open to any
    // authenticated role. Since resolveCompany deliberately no-ops for
    // Platform Admin (it has no company_id to resolve), req.companyId would
    // stay undefined on those routes — crashing repositories that require
    // it, or silently returning unscoped, cross-tenant data. Block here,
    // centrally, before that gap can be reached.
    if (user.role.hierarchy_rank === 1 && !isPlatformAdminAllowedRoute(req)) {
      logger.warn('Platform Admin blocked from business route', {
        userId: user.id,
        path: req.originalUrl,
        method: req.method,
      });
      return res.status(403).json({
        success: false,
        message: 'Platform Admin cannot access business routes.',
        code: 'PLATFORM_ADMIN_FORBIDDEN',
      });
    }

    return resolveCompany(req, res, next);
  } catch (error) {
    logger.error('Authentication middleware error', {
      error: error.message,
      stack: error.stack,
      path: req.path,
      method: req.method,
    });
    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication.',
      code: 'AUTH_ERROR',
    });
  }
};

module.exports = authenticate;
