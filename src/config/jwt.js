'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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
 * Generate both access and refresh tokens for a user session. Every
 * account tier (including Employees, who now authenticate exclusively
 * through User Master — see database/migrations/20260842_employees_drop_login_columns.sql)
 * shares this one token shape; there is no longer a separate Employee
 * audience/payload.
 *
 * The refresh token payload previously carried ONLY `{ id: user.id }` — with
 * no unique claim, `jwt.sign` (HS256) is a deterministic function of
 * header+payload+secret, so a login immediately followed by a refresh
 * inside the same one-second `iat` window produced a BYTE-IDENTICAL
 * refresh JWT to the one just consumed. Every refresh token now embeds a
 * fresh, cryptographically random `jti` (guaranteeing uniqueness
 * regardless of timing) and a `familyId` — shared across every token
 * descended from one login, so authRepository/authService can detect an
 * already-rotated token being replayed and revoke the whole lineage. See
 * database/migrations/20260857_add_refresh_token_rotation.sql.
 *
 * @param {object} user - User record (plain object or Sequelize instance), with `role` included.
 * @param {object} [options]
 * @param {string} [options.familyId] - reuse an existing session family
 *   (rotation); omit to start a new one (login).
 * @returns {{ accessToken: string, refreshToken: string, expiresIn: string, refreshExpiresIn: string, jti: string, familyId: string }}
 */
function generateTokens(user, options = {}) {
  const payload = {
    id: user.id,
    email: user.email,
    roleId: user.role_id,
    roleName: user.role ? user.role.role_name : null,
    hierarchyRank: user.role ? user.role.hierarchy_rank : null,
    employeeId: user.employee_id,
  };

  const jti = crypto.randomUUID();
  const familyId = options.familyId || crypto.randomUUID();

  const accessToken = signToken(payload);
  const refreshToken = signRefreshToken({ id: user.id, jti, familyId });

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY,
    refreshExpiresIn: REFRESH_TOKEN_EXPIRY,
    jti,
    familyId,
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
