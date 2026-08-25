'use strict';

const jwksClient = require('jwks-rsa');

/**
 * Microsoft Entra ID (Azure AD) SSO configuration — single-tenant only. See
 * services/microsoftAuthService.js's explicit `tid` claim check for why
 * issuer-string validation alone isn't treated as sufficient tenant
 * restriction on its own.
 *
 * Deliberately does NOT fail fast at require-time the way config/jwt.js's
 * JWT_SECRET check does. Microsoft SSO is an additive, optionally-configured
 * feature layered on top of the already-working email/password login, and
 * this module is required from authService.js — the same file every
 * existing login request already goes through. Crashing server boot over a
 * missing MICROSOFT_* env var would take down email/password login for
 * every deployment that hasn't configured Entra yet. Instead,
 * getMicrosoftAuthConfig() throws only when something actually calls it
 * (i.e. only when POST /auth/microsoft is hit), so an unconfigured
 * environment keeps running everything else normally.
 */

let cachedJwksClient = null;

/**
 * @returns {{
 *   tenantId: string,
 *   clientId: string,
 *   issuer: string,
 *   getSigningKey: (header: object, callback: (err: Error|null, key?: string) => void) => void
 * }}
 * @throws {Error} statusCode 503, code MICROSOFT_SSO_NOT_CONFIGURED — when
 *   MICROSOFT_TENANT_ID/MICROSOFT_CLIENT_ID are not set.
 */
function getMicrosoftAuthConfig() {
  const { MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID } = process.env;

  if (!MICROSOFT_TENANT_ID || !MICROSOFT_CLIENT_ID) {
    const err = new Error('Microsoft SSO is not configured on this server.');
    err.statusCode = 503;
    err.code = 'MICROSOFT_SSO_NOT_CONFIGURED';
    err.isOperational = true;
    throw err;
  }

  if (!cachedJwksClient) {
    cachedJwksClient = jwksClient({
      jwksUri: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 24 * 60 * 60 * 1000, // Microsoft rotates signing keys infrequently
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }

  return {
    tenantId: MICROSOFT_TENANT_ID,
    clientId: MICROSOFT_CLIENT_ID,
    issuer: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/v2.0`,
    getSigningKey: (header, callback) => {
      cachedJwksClient.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
      });
    },
  };
}

module.exports = { getMicrosoftAuthConfig };
