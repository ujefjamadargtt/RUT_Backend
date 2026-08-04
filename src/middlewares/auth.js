'use strict';

const jwt = require('jsonwebtoken');
const { verifyToken } = require('../config/jwt');
const { User, Role, Employee } = require('../models');
const logger = require('../utils/logger');
const resolveCompany = require('./resolveCompany');

/**
 * Routes Platform Admin may reach despite being platform-only by default
 * (see the block in authenticate() below). Grown alongside RBAC restricting
 * the "Roles" and "Forms" admin screens — Form Master, Role Master, and
 * their role_form_mapping rows — to Platform Admin ONLY (see
 * rbacService.js's assertFormRoleMappingAllowed() and
 * database/migrations/20260807_restrict_admin_forms_to_platform_admin.sql):
 * Platform Admin must be able to reach the routes that manage those two
 * screens, not just company provisioning.
 *
 * role.routes.js and rbac.routes.js are both mounted at the same
 * `/api/v1/roles` baseUrl (see app.js), so req.path (the part after baseUrl)
 * is what distinguishes Role Master CRUD (`/`, `/:id`) and role-form-mapping
 * endpoints (`/forms`, `/forms/mapping`, `/form-mappings...`) from
 * `/user-mappings/...` — assigning roles to business users is a business-data
 * concern, not part of Form/Role Master, and stays blocked.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isPlatformAdminAllowedRoute(req) {
  if (req.baseUrl.endsWith('/companies')) return true;
  if (req.baseUrl.endsWith('/forms')) return true;
  if (req.baseUrl.endsWith('/roles') && !req.path.startsWith('/user-mappings')) return true;
  return false;
}

/**
 * JWT Authentication Middleware
 * Extracts Bearer token, verifies it, loads the user, and attaches to req.user.
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
      // MUST check audience here (config/jwt.js's verifyToken(), not a raw
      // jwt.verify()) — a User token and an Employee token are signed with
      // the SAME JWT_SECRET but different audiences ('rut-portal-client'
      // vs 'rut-portal-employee-client') and payload shapes (a User token
      // has `id`; an Employee token has `employeeId`, no `id` at all). An
      // unchecked jwt.verify() lets an Employee token pass signature
      // verification here, then `decoded.id` is undefined and the
      // `User.findOne({ where: { id: undefined } })` below throws a raw
      // Sequelize error instead of a clean 401 — this previously crashed
      // POST /auth/logout with a 500 whenever an Employee called it.
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

    // Load user with role and employee data
    const user = await User.findOne({
      where: { id: decoded.id, status: 'active' },
      include: [
        {
          model: Role,
          as: 'role',
          attributes: ['id', 'role_name', 'permission', 'status'],
        },
        {
          model: Role,
          as: 'roles',
          attributes: ['id', 'role_name', 'permission', 'status'],
          through: { attributes: [] },
          required: false,
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

    const activeRolesMap = new Map();

    if (user.role && user.role.status === 'active') {
      activeRolesMap.set(user.role.id, user.role);
    }

    if (Array.isArray(user.roles)) {
      user.roles.forEach((role) => {
        if (role && role.status === 'active') {
          activeRolesMap.set(role.id, role);
        }
      });
    }

    const activeRoles = Array.from(activeRolesMap.values());

    if (activeRoles.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'No active roles are assigned to this account. Please contact the administrator.',
        code: 'NO_ACTIVE_ROLE',
      });
    }

    // Attach user and convenience fields to request
    req.user = user;
    req.userId = user.id;
    req.userRoles = activeRoles.map((role) => role.role_name);
    req.userRole = req.userRoles[0] || null;
    // Full role records (id, role_name, permission, status) for this user,
    // combining the legacy single role_id column with the user_roles
    // many-to-many mapping and de-duplicated by id — the canonical
    // "what roles does this user actually have" list. Prefer this over
    // req.user.roles (which only reflects the many-to-many association and
    // misses a user whose only assignment is still the legacy role_id
    // column) wherever a handler needs role id/permission, not just the name.
    req.activeRoles = activeRoles;

    // Platform Admin is platform-only (provisions companies, plus manages
    // Form/Role Master and their mappings — see isPlatformAdminAllowedRoute()
    // above — nothing else). Most business routes rely solely on per-route
    // authorize([...]) arrays for role gating, but many read (GET) endpoints
    // have no authorize() call at all and are open to any authenticated
    // role. Since resolveCompany deliberately no-ops for is_platform_admin
    // (it has no company_id to resolve), req.companyId would stay undefined
    // on those routes — crashing repositories that require it, or silently
    // returning unscoped, cross-company data in the ones with an
    // optional-companyId fallback. Block here, centrally, before that gap
    // can be reached, rather than adding authorize() to every unprotected
    // route. requirePlatformAdmin still separately gates /companies from
    // everyone else; the Form/Role Master routes rely on
    // rbacService.assertFormRoleMappingAllowed for the equivalent guarantee
    // on the role_form_mapping side.
    if (user.is_platform_admin && !isPlatformAdminAllowedRoute(req)) {
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
