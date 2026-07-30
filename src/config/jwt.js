'use strict';

const jwt = require('jsonwebtoken');

const {
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN,
} = process.env;

// Fail fast at startup if secrets are not configured
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set and at least 32 characters long.');
}
if (!JWT_REFRESH_SECRET || JWT_REFRESH_SECRET.length < 32) {
  throw new Error('JWT_REFRESH_SECRET must be set and at least 32 characters long.');
}

const ACCESS_TOKEN_EXPIRY = JWT_EXPIRES_IN || '15m';
const REFRESH_TOKEN_EXPIRY = JWT_REFRESH_EXPIRES_IN || '7d';

/**
 * Sign an access token.
 *
 * @param {object} payload  - Data to embed in the token (avoid sensitive fields).
 * @param {string} [expiresIn] - Override default expiry (e.g. '1h').
 * @returns {string} Signed JWT string.
 */
function signToken(payload, expiresIn = ACCESS_TOKEN_EXPIRY) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn,
    issuer: 'rut-portal',
    audience: 'rut-portal-client',
  });
}

/**
 * Verify an access token.
 *
 * @param {string} token
 * @returns {object} Decoded payload.
 * @throws {JsonWebTokenError|TokenExpiredError}
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: 'rut-portal',
    audience: 'rut-portal-client',
  });
}

/**
 * Sign a refresh token.
 *
 * @param {object} payload
 * @param {string} [expiresIn]
 * @returns {string} Signed refresh JWT string.
 */
function signRefreshToken(payload, expiresIn = REFRESH_TOKEN_EXPIRY) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn,
    issuer: 'rut-portal',
    audience: 'rut-portal-refresh',
  });
}

/**
 * Verify a refresh token.
 *
 * @param {string} token
 * @returns {object} Decoded payload.
 * @throws {JsonWebTokenError|TokenExpiredError}
 */
function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET, {
    issuer: 'rut-portal',
    audience: 'rut-portal-refresh',
  });
}

/**
 * Generate both access and refresh tokens for a user session.
 *
 * @param {object} user - User record (plain object or Sequelize instance).
 * @returns {{ accessToken: string, refreshToken: string, expiresIn: string }}
 */
function generateTokens(user) {
  const roleMap = new Map();

  if (user.role && user.role.id) {
    roleMap.set(user.role.id, user.role.role_name);
  }

  if (Array.isArray(user.roles)) {
    user.roles.forEach((role) => {
      if (role && role.id) {
        roleMap.set(role.id, role.role_name);
      }
    });
  }

  const roleIds = Array.from(roleMap.keys());
  const roleNames = Array.from(roleMap.values());

  const payload = {
    id: user.id,
    email: user.email,
    roleId: user.role_id,
    roleIds,
    roleNames,
    employeeId: user.employee_id,
  };

  const accessToken = signToken(payload);
  const refreshToken = signRefreshToken({ id: user.id });

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY,
    refreshExpiresIn: REFRESH_TOKEN_EXPIRY,
  };
}

/**
 * Decode a token without verification (for reading expiry on an expired token).
 *
 * @param {string} token
 * @returns {object|null} Decoded payload or null.
 */
function decodeToken(token) {
  return jwt.decode(token);
}

/**
 * Extract the bearer token from an Authorization header value.
 *
 * @param {string} authHeader - e.g. "Bearer eyJ..."
 * @returns {string|null}
 */
function extractBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

module.exports = {
  signToken,
  verifyToken,
  signRefreshToken,
  verifyRefreshToken,
  generateTokens,
  decodeToken,
  extractBearerToken,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
};
