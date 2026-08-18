'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch their exported
// functions — rbacService.js holds live references to these SAME
// module-cached objects, never destructuring at import time, so mutating a
// property here is visible to the service's own calls. Consistent with this
// repo's plain node:test setup (see test/servicePOHierarchyService.deleteGuard.test.js).
const rbacRepository = require('../src/repositories/rbacRepository');
const formRepository = require('../src/repositories/formMasterRepository');
const rbacService = require('../src/services/rbacService');

const ORIGINAL = {
  findAllFormsWithMappingStatus: rbacRepository.findAllFormsWithMappingStatus,
  findAccessibleForms: rbacRepository.findAccessibleForms,
  findAllActiveForms: rbacRepository.findAllActiveForms,
  findModules: formRepository.findModules,
};

function restore() {
  rbacRepository.findAllFormsWithMappingStatus = ORIGINAL.findAllFormsWithMappingStatus;
  rbacRepository.findAccessibleForms = ORIGINAL.findAccessibleForms;
  rbacRepository.findAllActiveForms = ORIGINAL.findAllActiveForms;
  formRepository.findModules = ORIGINAL.findModules;
}

// Modules seeded out of alphabetical order on purpose — every assertion
// below only passes if ordering comes from seq, never from module_name.
const MODULES = [
  { form_name: 'Reports', seq: 1 },
  { form_name: 'Administration', seq: 2 },
  { form_name: 'Business', seq: 3 },
];

test('1. getActiveFormsForRoles orders modules by seq, not alphabetically', async () => {
  formRepository.findModules = async () => MODULES;
  rbacRepository.findAccessibleForms = async () => [
    { id: 1, module_name: 'Administration', form_name: 'Roles', seq: 1 },
    { id: 2, module_name: 'Reports', form_name: 'PO Report', seq: 2 },
    { id: 3, module_name: 'Reports', form_name: 'Client Report', seq: 1 },
    { id: 4, module_name: 'Business', form_name: 'Client Master', seq: 1 },
  ];

  const result = await rbacService.getActiveFormsForRoles([1]);

  assert.deepEqual(Object.keys(result), ['Reports', 'Administration', 'Business']);
  // Within Reports, form seq 1 (Client Report) must come before seq 2 (PO Report).
  assert.deepEqual(result.Reports.map((f) => f.name), ['Client Report', 'PO Report']);
  assert.deepEqual(result.Administration.map((f) => f.name), ['Roles']);
  restore();
});

test('2. getActiveFormsForRoles drops forms whose module has been deactivated', async () => {
  formRepository.findModules = async () => MODULES; // "Reports"/"Administration"/"Business" only — no "Legacy"
  rbacRepository.findAccessibleForms = async () => [
    { id: 1, module_name: 'Reports', form_name: 'PO Report', seq: 1 },
    { id: 2, module_name: 'Legacy', form_name: 'Old Screen', seq: 1 }, // orphaned: its module is inactive/gone
  ];

  const result = await rbacService.getActiveFormsForRoles([1]);

  assert.deepEqual(Object.keys(result), ['Reports']);
  assert.equal(result.Legacy, undefined);
  restore();
});

test('3. getActiveFormsForRoles Platform Admin bypass also orders by module/form seq', async () => {
  formRepository.findModules = async () => MODULES;
  rbacRepository.findAllActiveForms = async () => [
    { id: 1, module_name: 'Business', form_name: 'Project Master', seq: 1 },
    { id: 2, module_name: 'Reports', form_name: 'PO Report', seq: 1 },
  ];

  const result = await rbacService.getActiveFormsForRoles([1], 1);

  assert.deepEqual(Object.keys(result), ['Reports', 'Business']);
  restore();
});

test('4. getFormsWithMappingStatus orders by seq and keeps the status field', async () => {
  formRepository.findModules = async () => MODULES;
  rbacRepository.findAllFormsWithMappingStatus = async () => [
    { id: 1, module_name: 'Administration', form_name: 'Roles', seq: 1, status: true },
    { id: 2, module_name: 'Reports', form_name: 'PO Report', seq: 1, status: false },
  ];

  const result = await rbacService.getFormsWithMappingStatus([1]);

  assert.deepEqual(Object.keys(result), ['Reports', 'Administration']);
  assert.deepEqual(result.Reports[0], { id: 2, name: 'PO Report', status: false });
  restore();
});
