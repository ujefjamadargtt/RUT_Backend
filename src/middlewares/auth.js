'use strict';

const jwt = require('jsonwebtoken');
const { verifyToken, ROLE_SELECTION_TICKET_TYPE } = require('../config/jwt');
const { Employee, Role, Company } = require('../models');
const roleHierarchyService = require('../services/roleHierarchyService');
const logger = require('../utils/logger');
const resolveCompany = require('./resolveCompany');

/**
 * Routes Platform Admin may reach despite being platform-only by default
 * (see the block in authenticate() below). Platform Admin's own
 * responsibilities: create Admin, manage the platform, manage Role
 * Master, manage Form Master — never Entity/BU-level business routes.
 *
 * role.routes.js and rbac.routes.js are both mounted at the same
 * `/api/v1/roles` baseUrl (see app.js), so req.path (the part after baseUrl)
 * is what distinguishes Role Master CRUD from role-form-mapping endpoints.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isPlatformAdminAllowedRoute(req) {
  if (req.baseUrl.endsWith('/admins')) return true;
  if (req.baseUrl.endsWith('/forms')) return true;
  if (req.baseUrl.endsWith('/forms/categories')) return true;
  if (req.baseUrl.endsWith('/roles')) return true;
  if (req.baseUrl.endsWith('/platform-admin')) return true;
  return false;
}

const ROLES_INCLUDE = {
  model: Role,
  as: 'roles',
  attributes: ['id', 'role_name', 'permission', 'status', 'hierarchy_rank', 'inherits_role_id'],
  through: { attributes: ['status'] },
};

const BUSINESS_UNITS_INCLUDE = {
  model: Company,
  as: 'businessUnits',
  attributes: ['id', 'company_code', 'company_name', 'status', 'is_original_data_visible'],
  through: { attributes: ['status'] },
};

/**
 * An employee's currently-active roles (both roles.status and
 * employee_roles.status must be 'active') — see authService.js's
 * identical helper.
 * @param {object} employee
 * @returns {object[]}
 */
function getActiveRoles(employee) {
  return (employee.roles || []).filter(
    (role) => role.status === 'active' && role.EmployeeRole && role.EmployeeRole.status === 'active'
  );
}

/**
 * An employee's currently-active Business Units.
 * @param {object} employee
 * @returns {object[]}
 */
function getActiveBusinessUnits(employee) {
  return (employee.businessUnits || []).filter(
    (bu) => bu.EmployeeBusinessUnit && bu.EmployeeBusinessUnit.status === 'active'
  );
}

/**
 * Effective hierarchy rank = MIN(hierarchy_rank) across active roles;
 * NULL-rank roles are excluded from the MIN.
 * @param {object[]} activeRoles
 * @returns {number|null}
 */
function getEffectiveHierarchyRank(activeRoles) {
  const ranks = activeRoles.map((role) => role.hierarchy_rank).filter((rank) => Number.isInteger(rank));
  return ranks.length === 0 ? null : Math.min(...ranks);
}

/**
 * JWT Authentication Middleware
 * Extracts Bearer token, verifies it, loads the Employee, and attaches to
 * req.user. Employee is the sole login identity now — see the
 * Employee-as-Identity redesign (database/migrations/20260864-20260880).
 *
 * Composed of authenticateIdentity() (below) followed by resolveCompany() —
 * kept as two pieces so a route that genuinely doesn't need company/BU
 * context yet (e.g. GET /employees/:id/business-units's self-lookup case,
 * which exists precisely so a multi-BU actor can discover their own BU list
 * BEFORE they have anything to put in X-Company-Id) can use
 * authenticateIdentity alone. Every other route keeps using this default
 * export, completely unchanged.
 */
const authenticate = async (req, res, next) => {
  return authenticateIdentity(req, res, () => resolveCompany(req, res, next));
};

/**
 * Identity/role/capability resolution only — everything authenticate() does
 * EXCEPT the final resolveCompany() call. See authenticate()'s doc comment
 * above for why this is split out.
 */
const authenticateIdentity = async (req, res, next) => {
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
      return res.status(401).json({
        success: false,
        message: 'Token verification failed.',
        code: 'TOKEN_ERROR',
      });
    }

    // A role-selection ticket (authService.login()'s multi-role response,
    // exchanged via POST /auth/select-role) carries no role/capability
    // information at all — never usable as a Bearer token on an ordinary
    // request, see config/jwt.js's ROLE_SELECTION_TICKET_TYPE doc comment.
    if (decoded.type === ROLE_SELECTION_TICKET_TYPE) {
      return res.status(401).json({
        success: false,
        message: 'Please complete role selection before continuing.',
        code: 'ROLE_SELECTION_REQUIRED',
      });
    }

    const employee = await Employee.findOne({
      where: { id: decoded.id, status: 'active', is_deleted: false },
      include: [ROLES_INCLUDE, BUSINESS_UNITS_INCLUDE],
    });

    if (!employee) {
      return res.status(401).json({
        success: false,
        message: 'Account not found or inactive.',
        code: 'USER_INACTIVE',
      });
    }

    let activeRoles = getActiveRoles(employee);
    if (activeRoles.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'No active role is assigned to this account. Please contact the administrator.',
        code: 'NO_ACTIVE_ROLE',
      });
    }

    // Role-Based Login: this session is scoped to the ONE role picked (or
    // auto-assigned, for a single-role employee) at login time —
    // `decoded.activeRoleId`, carried in the access token since
    // config/jwt.js's generateTokens(). Every downstream permission check
    // below (hierarchyRank/capabilities/userRoles) must reflect ONLY that
    // role, not every role this employee currently holds — otherwise
    // picking "Manager" at login would still grant whatever a
    // simultaneously-held "BU Admin" role can do. `null` only for a
    // pre-existing session issued before this feature shipped; that one
    // token keeps its original all-roles behavior until it's replaced by a
    // fresh login.
    if (decoded.activeRoleId != null) {
      const selectedRole = activeRoles.find((role) => role.id === decoded.activeRoleId);
      if (!selectedRole) {
        return res.status(401).json({
          success: false,
          message: 'Your selected role is no longer active. Please log in again.',
          code: 'ROLE_NO_LONGER_ACTIVE',
        });
      }
      activeRoles = [selectedRole];
    }

    const hierarchyRank = getEffectiveHierarchyRank(activeRoles);
    const activeBusinessUnits = getActiveBusinessUnits(employee);
    const roleIds = activeRoles.map((role) => role.id);

    const effectiveCapabilities = await roleHierarchyService.getEffectiveCapabilitiesForRoleIds(roleIds);

    // req.user is kept as the loaded Employee for existing call sites that
    // read req.user.role/req.user.company etc. (being migrated off in
    // Phase F) — req.employeeId/req.employeeRoleNames/req.hierarchyRank
    // below are the preferred, Employee-native fields.
    req.user = employee;
    req.userId = employee.id; // temporary alias for req.employeeId — scheduled for removal
    req.employeeId = employee.id;
    req.employeeRoleNames = activeRoles.map((role) => role.role_name);
    req.userRoleName = req.employeeRoleNames[0] || null;
    req.hierarchyRank = hierarchyRank;
    req.capabilities = effectiveCapabilities;
    req.employeeBusinessUnits = activeBusinessUnits;
    req.userRoles = req.employeeRoleNames;
    req.userRole = req.userRoleName;
    req.activeRoles = activeRoles;

    // Platform Admin (effective hierarchy_rank === 1) is platform-only —
    // see isPlatformAdminAllowedRoute() above.
    // Temporarily disabled per request (2026-08-23) — revisit/re-enable
    // after further discussion.
    // if (hierarchyRank === 1 && !isPlatformAdminAllowedRoute(req)) {
    //   logger.warn('Platform Admin blocked from business route', {
    //     employeeId: employee.id,
    //     path: req.originalUrl,
    //     method: req.method,
    //   });
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Platform Admin cannot access business routes.',
    //     code: 'PLATFORM_ADMIN_FORBIDDEN',
    //   });
    // }

    return next();
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
// Exposed purely for unit testing (see test/authPlatformAdminRoutes.test.js)
// — every route file still uses module.exports directly as middleware,
// unaffected by this extra property.
module.exports.isPlatformAdminAllowedRoute = isPlatformAdminAllowedRoute;
// Identity-only variant (no resolveCompany) — see authenticate()'s doc
// comment above. Used by employee.routes.js's GET /:id/business-units
// self-lookup case only; every other route keeps using the default export.
module.exports.authenticateIdentity = authenticateIdentity;
