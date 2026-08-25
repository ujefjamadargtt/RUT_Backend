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

// Marks a token as a short-lived role-selection ticket (Role-Based Login —
// an employee holding multiple roles gets one of these instead of real
// tokens, exchanged for real tokens once they pick a role via
// POST /auth/select-role) rather than a normal access token. authService.js
// checks this claim on presentation to the ticket-exchange endpoint;
// middlewares/auth.js checks it to REJECT such a ticket if presented as a
// Bearer token on an ordinary request — it carries no role information at
// all, so letting it through would authenticate the caller with zero
// capability checks in place.
const ROLE_SELECTION_TICKET_TYPE = 'role_selection';
const ROLE_SELECTION_TICKET_EXPIRY = '5m';

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
 * Generate both access and refresh tokens for an Employee login session.
 * Employee is the sole login identity now — see the Employee-as-Identity
 * redesign (database/migrations/20260864-20260880) — replacing the old
 * single-role `users` payload with a flat roles[] shape (no primary/
 * additional split; effective hierarchy rank = MIN(hierarchy_rank) across
 * every active role, computed by the caller and passed in as
 * `hierarchyRank`).
 *
 * `activeRoleId` (Role-Based Login) is the ONE role this specific session
 * is scoped to — either the employee's sole active role, or whichever one
 * they picked via POST /auth/select-role when they hold several. It rides
 * in BOTH the access token and the refresh token so a later rotation
 * (authService.refreshToken) can restore the exact same role scope without
 * a DB schema change to remember it. `null` only for a pre-existing session
 * issued before this feature shipped.
 *
 * The refresh token payload carries a fresh, cryptographically random
 * `jti` (guaranteeing uniqueness regardless of timing) and a `familyId` —
 * shared across every token descended from one login, so
 * authRepository/authService can detect an already-rotated token being
 * replayed and revoke the whole lineage. See database/migrations/
 * 20260857_add_refresh_token_rotation.sql.
 *
 * @param {object} employee - Employee record (plain object or Sequelize
 *   instance) with `roleIds`/`roleNames`/`hierarchyRank`/`activeRoleId`
 *   already resolved by the caller (authService.js).
 * @param {object} [options]
 * @param {string} [options.familyId] - reuse an existing session family
 *   (rotation); omit to start a new one (login).
 * @returns {{ accessToken: string, refreshToken: string, expiresIn: string, refreshExpiresIn: string, jti: string, familyId: string }}
 */
function generateTokens(employee, options = {}) {
  const activeRoleId = employee.activeRoleId ?? null;
  const payload = {
    id: employee.id,
    email: employee.email,
    roleIds: employee.roleIds || [],
    roleNames: employee.roleNames || [],
    hierarchyRank: employee.hierarchyRank ?? null,
    activeRoleId,
    employeeId: employee.id,
  };

  const jti = crypto.randomUUID();
  const familyId = options.familyId || crypto.randomUUID();

  const accessToken = signToken(payload);
  const refreshToken = signRefreshToken({ id: employee.id, jti, familyId, activeRoleId });

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
 * Sign a short-lived role-selection ticket (Role-Based Login) — issued by
 * authService.login() in place of real tokens when the employee holds more
 * than one active role, and exchanged for real tokens by
 * authService.selectRole() once they pick one. Deliberately carries NO
 * role/capability information — see ROLE_SELECTION_TICKET_TYPE's doc
 * comment for why middlewares/auth.js must reject it as a Bearer token.
 *
 * @param {number} employeeId
 * @returns {string} signed JWT string, expires in ROLE_SELECTION_TICKET_EXPIRY
 */
function signRoleSelectionTicket(employeeId) {
  return signToken({ id: employeeId, type: ROLE_SELECTION_TICKET_TYPE }, ROLE_SELECTION_TICKET_EXPIRY);
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
  signRoleSelectionTicket,
  decodeToken,
  extractBearerToken,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
  ROLE_SELECTION_TICKET_TYPE,
};
