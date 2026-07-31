'use strict';

const jwt = require('jsonwebtoken');
const { verifyToken, verifyEmployeeToken } = require('../config/jwt');
const { User, Employee } = require('../models');
const logger = require('../utils/logger');

/**
 * Dual-account JWT authentication — accepts EITHER a User access token or an
 * Employee access token (the two are distinguished by JWT audience, see
 * config/jwt.js) and normalises the result to req.authId / req.userType /
 * req.companyId.
 *
 * Built for routes like PUT /auth/change-password that must serve both
 * account types through one endpoint. This is a dispatcher over the exact
 * same verifyToken()/verifyEmployeeToken() functions and User/Employee
 * models `authenticate` and `employeeAuth` already use (and the same
 * try-User-then-Employee idiom authService.refreshToken() already applies
 * to refresh tokens) — no new verification mechanism, just routed to
 * whichever token type the caller actually presented.
 *
 * Every other authenticated route keeps using `authenticate` (User-only) or
 * `employeeAuth` (Employee-only) exactly as before — this middleware is
 * additive, only wired into routes that explicitly need both.
 */
const dualAuth = async (req, res, next) => {
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
    let userType;
    let userErr;
    let employeeErr;

    try {
      decoded = verifyToken(token);
      userType = 'user';
    } catch (err) {
      userErr = err;
      try {
        decoded = verifyEmployeeToken(token);
        userType = 'employee';
      } catch (err2) {
        employeeErr = err2;
      }
    }

    if (!decoded) {
      const expiredErr = [userErr, employeeErr].find((e) => e instanceof jwt.TokenExpiredError);
      if (expiredErr) {
        return res.status(401).json({
          success: false,
          message: 'Token has expired. Please log in again.',
          code: 'TOKEN_EXPIRED',
          expiredAt: expiredErr.expiredAt,
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please log in again.',
        code: 'INVALID_TOKEN',
      });
    }

    if (userType === 'user') {
      const user = await User.findOne({ where: { id: decoded.id, status: 'active' } });

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User not found or account is inactive.',
          code: 'USER_INACTIVE',
        });
      }

      req.authId = user.id;
      req.userType = 'user';
      req.companyId = user.company_id;
    } else {
      if (!decoded.employeeId) {
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

      req.authId = employee.id;
      req.userType = 'employee';
      req.companyId = employee.company_id;
    }

    return next();
  } catch (error) {
    logger.error('Dual authentication middleware error', {
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

module.exports = dualAuth;
