'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// auth.js requires config/jwt.js, which reads JWT_SECRET from process.env
// at require-time and throws if unset — load .env directly here so this
// file runs standalone, the same way src/models/index.js already does for
// itself rather than relying on another test file having required it first.
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { isPlatformAdminAllowedRoute } = require('../src/middlewares/auth');

/**
 * Regression coverage for the Platform Admin route allowlist (auth.js).
 * Platform Admin (hierarchy_rank 1) has no company_id and is blocked from
 * every route except this allowlist — see the 403 in authenticate().
 * Form Master (including its nested Category routes) is explicitly one of
 * Platform Admin's own responsibilities, so it must stay allowed even when
 * mounted via a nested router (which changes req.baseUrl — see
 * category.routes.js's mount comment in formMaster.routes.js).
 */

test('allows the base Form Master routes', () => {
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/forms' }), true);
});

test('allows nested Category routes despite their different baseUrl', () => {
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/forms/categories' }), true);
});

test('allows Role Master, Admin management, and Platform Admin routes', () => {
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/roles' }), true);
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/admins' }), true);
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/platform-admin' }), true);
});

test('blocks company-scoped business routes', () => {
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/employees' }), false);
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/service-pos' }), false);
  assert.equal(isPlatformAdminAllowedRoute({ baseUrl: '/api/v1/timesheets' }), false);
});
