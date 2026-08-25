'use strict';

const jwt = require('jsonwebtoken');
const { getMicrosoftAuthConfig } = require('../config/microsoftAuth');
const logger = require('../utils/logger');

/**
 * Verify a Microsoft Entra ID ID token presented by the frontend after it
 * completes an Authorization Code + PKCE sign-in via MSAL — see
 * POST /auth/microsoft (authController.loginWithMicrosoft).
 *
 * Validates signature (against Microsoft's JWKS, fetched/cached via
 * config/microsoftAuth.js), issuer, audience, and expiration — all through
 * jsonwebtoken.verify() itself, never by decoding-without-verifying — AND
 * the token's `tid` claim against the configured tenant explicitly, as
 * defense in depth beyond the issuer URL alone (this app is single-tenant
 * only; see config/microsoftAuth.js's doc comment).
 *
 * @param {string} idToken - raw ID token string from the frontend
 * @returns {Promise<{ email: string, oid: string, name: string|null }>}
 *   `email` is lowercased/trimmed the same way authRepository.findEmployeeByEmail()
 *   normalises the password-login email, so lookups behave identically.
 * @throws {Error} statusCode 401 (INVALID_MICROSOFT_TOKEN or
 *   MICROSOFT_EMAIL_CLAIM_MISSING) | 503 (MICROSOFT_SSO_NOT_CONFIGURED,
 *   bubbled up from config/microsoftAuth.js)
 */
async function verifyMicrosoftIdToken(idToken) {
  const { issuer, clientId, tenantId, getSigningKey } = getMicrosoftAuthConfig();

  let decoded;
  try {
    decoded = await new Promise((resolve, reject) => {
      jwt.verify(
        idToken,
        getSigningKey,
        { issuer, audience: clientId, algorithms: ['RS256'] },
        (err, payload) => (err ? reject(err) : resolve(payload))
      );
    });
  } catch (err) {
    logger.warn('Microsoft ID token verification failed', { error: err.message });
    throw invalidMicrosoftTokenError();
  }

  // Belt-and-suspenders beyond the issuer URL (which already encodes the
  // tenant) — rejects a token whose `tid` doesn't match our configured
  // tenant even if the issuer string were ever somehow satisfied otherwise.
  if (decoded.tid !== tenantId) {
    logger.warn('Microsoft ID token from an unexpected tenant', { tid: decoded.tid });
    throw invalidMicrosoftTokenError();
  }

  if (!decoded.email) {
    logger.warn('Microsoft ID token has no email claim', { oid: decoded.oid });
    const err = new Error(
      'Your Microsoft account did not return an email address. Please contact the administrator.'
    );
    err.statusCode = 401;
    err.code = 'MICROSOFT_EMAIL_CLAIM_MISSING';
    err.isOperational = true;
    throw err;
  }

  return {
    email: decoded.email.toLowerCase().trim(),
    oid: decoded.oid,
    name: decoded.name || null,
  };
}

/**
 * @returns {Error}
 */
function invalidMicrosoftTokenError() {
  const err = new Error('Invalid or expired Microsoft sign-in. Please try again.');
  err.statusCode = 401;
  err.code = 'INVALID_MICROSOFT_TOKEN';
  err.isOperational = true;
  return err;
}

module.exports = { verifyMicrosoftIdToken };
