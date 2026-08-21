'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ROLE_CREATION_MATRIX, canActorCreateRole, getCreatableRoleNames } = require('../src/config/roleHierarchy');

test('Admin can create BU Head, mirroring BU Admin', () => {
  assert.equal(canActorCreateRole('Admin', 'BU Head'), true);
});

test('Entity Admin can create BU Head, mirroring BU Admin', () => {
  assert.equal(canActorCreateRole('Entity Admin', 'BU Head'), true);
});

test('BU Head itself has no user-creation rights (not a key in the matrix)', () => {
  assert.equal(getCreatableRoleNames('BU Head'), null);
});

test('Every pre-existing ROLE_CREATION_MATRIX entry is unchanged', () => {
  assert.deepEqual(ROLE_CREATION_MATRIX['Platform Admin'], ['Admin']);
  assert.deepEqual(ROLE_CREATION_MATRIX['BU Admin'], ['Project Admin', 'Service PO Admin', 'Manager', 'Employee', 'HR']);
  assert.deepEqual(ROLE_CREATION_MATRIX['Project Admin'], ['Service PO Admin']);
  assert.deepEqual(ROLE_CREATION_MATRIX['Service PO Admin'], ['Manager']);
  // Admin/Entity Admin keep every previously-creatable role too — BU Head is
  // an ADDITION to these lists, not a replacement.
  assert.ok(ROLE_CREATION_MATRIX['Admin'].includes('Entity Admin'));
  assert.ok(ROLE_CREATION_MATRIX['Admin'].includes('BU Admin'));
  assert.ok(ROLE_CREATION_MATRIX['Entity Admin'].includes('BU Admin'));
});
