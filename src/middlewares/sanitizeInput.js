'use strict';

const xss = require('xss');

/**
 * Request Sanitization Middleware
 *
 * Two independent passes, applied globally to req.body/req.query/req.params
 * before any route-specific validation:
 *
 * 1. Dangerous KEY shapes are rejected outright (not cleaned). This app has
 *    no NoSQL datastore, so operators like `$gt`/`$ne` can't reach a raw
 *    Mongo-style query — but the same object shapes are also the classic
 *    vector for JS prototype pollution (`__proto__`, `constructor`,
 *    `prototype` keys smuggled into a body that later gets merged/assigned
 *    somewhere), and accepting them silently is never correct regardless of
 *    datastore. A request with any such key, at any nesting depth, is
 *    rejected with 400 — legitimate requests never contain these key
 *    shapes, so this has no effect on normal traffic.
 *
 * 2. Every string VALUE is trimmed and passed through the `xss` library,
 *    which HTML-entity-escapes dangerous tags/attributes (`<script>`,
 *    `onerror=`, `javascript:` URIs, etc.) while leaving plain text
 *    untouched — this is what actually neutralizes stored-XSS payloads in
 *    free-text fields (remarks, task/project/client names, search terms).
 *    Unlike the key check, this transforms rather than rejects: a `<`/`>`
 *    that happens to appear in otherwise-legitimate text becomes its HTML
 *    entity instead of failing the request. SQL-injection-shaped strings
 *    (`' OR 1=1 --`) and path-traversal-shaped strings (`../../../etc/passwd`)
 *    are deliberately left untouched here — neither is an HTML/script
 *    concern, and rewriting them would just corrupt legitimate data (e.g. a
 *    search term that happens to contain "--" or "/"). SQL injection is
 *    prevented at the query layer (Sequelize parameterized queries /
 *    `:replacements`, never raw string concatenation — see the SQL
 *    injection audit), and path traversal is prevented at the file-upload
 *    layer (server-generated filenames in src/middlewares/upload.js, never
 *    the client-supplied original filename).
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function findDangerousKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDangerousKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || DANGEROUS_KEYS.has(key)) return key;
    const found = findDangerousKey(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// Password-shaped fields are secrets, not display text — trimming or
// HTML-escaping them would silently store/compare a different string than
// what the user actually typed (e.g. a password containing "<" or ">"
// would hash as "&lt;"/"&gt;" on write but be compared against the escaped
// form again on every future read, which happens to still match... except
// when the value was NEVER sanitized on write, such as employeeService.js's
// server-generated temporary password, hashed raw). Left untouched here.
const PASSWORD_KEY_PATTERN = /password/i;

/**
 * Recursively trim + HTML-sanitize every string in a body/query/params
 * value, leaving numbers/booleans/null/dates and object/array shape intact.
 * A key matching PASSWORD_KEY_PATTERN is passed through unchanged instead.
 */
function sanitizeValue(value, depth = 0, isPasswordField = false) {
  if (depth > 10) return value;
  if (typeof value === 'string') return isPasswordField ? value : xss(value.trim());
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1, isPasswordField));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = sanitizeValue(value[key], depth + 1, PASSWORD_KEY_PATTERN.test(key));
    }
    return out;
  }
  return value;
}

const sanitizeInput = (req, res, next) => {
  const badKey = findDangerousKey(req.body) || findDangerousKey(req.query) || findDangerousKey(req.params);

  if (badKey) {
    return res.status(400).json({
      success: false,
      message: 'Request contains an invalid field name and was rejected.',
      code: 'INVALID_INPUT_KEY',
    });
  }

  if (req.body) req.body = sanitizeValue(req.body);
  if (req.query) req.query = sanitizeValue(req.query);
  if (req.params) req.params = sanitizeValue(req.params);

  next();
};

module.exports = sanitizeInput;
