'use strict';

const jwt = require('jsonwebtoken');
const { verifyEmployeeToken } = require('../config/jwt');
const { Employee } = require('../models');
const logger = require('../utils/logger');

/**
 * Employee JWT Authentication Middleware
 *
 * Parallels src/middlewares/auth.js but for the Employee Self Timesheet
 * module: verifies an Employee access token (distinct secret audience —
 * see config/jwt.js), re-fetches the Employee row fresh from the DB, and
 * attaches req.employee / req.employeeId / req.companyId / req.loginType.
 *
 * Employee-facing routes (Phases 3-4) use this middleware instead of
 * `authenticate` — a User token is rejected here (wrong audience/payload
 * shape) and vice versa, so the two token types can never be interchanged.
 */
const employeeAuth = async (req, res, next) => {
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
      decoded = verifyEmployeeToken(token);
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

    if (decoded.loginType !== 'employee' || !decoded.employeeId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please log in again.',
        code: 'INVALID_TOKEN',
      });
    }

    const employee = await Employee.findOne({
      where: { id: decoded.employeeId, status: 'active', is_deleted: false },
    });

    if (!employee) {
      return res.status(401).json({
        success: false,
        message: 'Employee not found or account is inactive.',
        code: 'EMPLOYEE_INACTIVE',
      });
    }

    req.employee = employee;
    req.employeeId = employee.id;
    // Trust the freshly-fetched DB value, not the (possibly stale) JWT claim
    // — same trust model resolveCompany.js uses for Users.
    req.companyId = employee.company_id;
    req.loginType = 'employee';

    return next();
  } catch (error) {
    logger.error('Employee authentication middleware error', {
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

module.exports = employeeAuth;
