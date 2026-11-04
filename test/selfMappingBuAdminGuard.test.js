'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const employeeService = require('../src/services/employeeService');

const { assertNotSelfMappingForBuAdmin, SELF_MAPPING_NOT_ALLOWED_MESSAGE } = employeeAccessControlService;
const BU_ADMIN = { employeeId: 7, roleNames: ['BU Admin'], hierarchyRank: 4, companyId: 10 };

const isSelfMappingError = (err) =>
  err.statusCode === 403 && err.code === 'SELF_MAPPING_NOT_ALLOWED' && err.message === SELF_MAPPING_NOT_ALLOWED_MESSAGE;

test('helper: blocks a BU Admin on their own id (number/string ids compare equal)', () => {
  assert.throws(() => assertNotSelfMappingForBuAdmin(BU_ADMIN, 7), isSelfMappingError);
  assert.throws(() => assertNotSelfMappingForBuAdmin(BU_ADMIN, '7'), isSelfMappingError);
  assert.throws(() => assertNotSelfMappingForBuAdmin({ ...BU_ADMIN, employeeId: '7' }, 7), isSelfMappingError);
});

test('helper: allows another employee, and every other role on their own record', () => {
  assert.doesNotThrow(() => assertNotSelfMappingForBuAdmin(BU_ADMIN, 8));
  for (const roleNames of [['Admin'], ['Entity Admin'], ['Platform Admin'], ['HR'], ['BU Head'], ['Project Manager'], ['Employee']]) {
    assert.doesNotThrow(() => assertNotSelfMappingForBuAdmin({ ...BU_ADMIN, roleNames }, 7), roleNames.join());
  }
  assert.doesNotThrow(() => assertNotSelfMappingForBuAdmin(null, 7));
  assert.doesNotThrow(() => assertNotSelfMappingForBuAdmin(BU_ADMIN, null));
});

test('helper: the ACTIVE role decides — a BU Admin who logged in as another role is not blocked', () => {
  assert.doesNotThrow(() => assertNotSelfMappingForBuAdmin({ ...BU_ADMIN, roleNames: ['Project Manager'] }, 7));
});

test('PUT /employees/:id: role_ids or business_unit_ids on the own record is rejected before any write', async () => {
  const orig = { find: employeeRepository.findByIdWithEmail, update: employeeRepository.update };
  let wrote = false;
  employeeRepository.findByIdWithEmail = async (id) => ({ id, company_id: 10, employee_code: 'E7', toJSON() { return this; } });
  employeeRepository.update = async () => { wrote = true; };
  try {
    await assert.rejects(employeeService.update(7, { role_ids: [2] }, 1, '127.0.0.1', BU_ADMIN), isSelfMappingError);
    await assert.rejects(employeeService.update(7, { business_unit_ids: [10] }, 1, '127.0.0.1', BU_ADMIN), isSelfMappingError);
    assert.equal(wrote, false);
  } finally {
    employeeRepository.findByIdWithEmail = orig.find;
    employeeRepository.update = orig.update;
  }
});

test('PUT /employees/:id: a profile-only body on the own record is NOT blocked by the guard', async () => {
  const orig = { find: employeeRepository.findByIdWithEmail };
  employeeRepository.findByIdWithEmail = async (id) => ({ id, company_id: 10, employee_code: 'E7', toJSON() { return this; } });
  try {
    // Gets past the guard (any later failure is unrelated to self mapping).
    await employeeService.update(7, { designation: 'Lead' }, 1, '127.0.0.1', BU_ADMIN).catch((err) => {
      assert.notEqual(err.code, 'SELF_MAPPING_NOT_ALLOWED');
    });
  } finally {
    employeeRepository.findByIdWithEmail = orig.find;
  }
});

test('Service PO mapping: replace / assign / delete / activate / deactivate / PM flag on the own record are rejected', async () => {
  const origFind = employeeServicePOMappingRepository.findByIdUnscoped;
  employeeServicePOMappingRepository.findByIdUnscoped = async (id) => ({
    id,
    employee_id: 7,
    service_po_id: 1,
    destroy: async () => { throw new Error('must not write'); },
    update: async () => { throw new Error('must not write'); },
  });
  try {
    await assert.rejects(employeeServicePOMappingService.saveEmployeeServicePOMappings(7, [{ service_po_id: 1, is_project_manager: true }], 1, BU_ADMIN), isSelfMappingError);
    await assert.rejects(employeeServicePOMappingService.assign(7, 1, 1, 10, false, BU_ADMIN), isSelfMappingError);
    await assert.rejects(employeeServicePOMappingService.removeMapping(5, 10, BU_ADMIN), isSelfMappingError);
    await assert.rejects(employeeServicePOMappingService.activateMapping(5, 1, 10, BU_ADMIN), isSelfMappingError);
    await assert.rejects(employeeServicePOMappingService.deactivateMapping(5, 1, 10, BU_ADMIN), isSelfMappingError);
    await assert.rejects(employeeServicePOMappingService.setMappingProjectManagerFlag(5, true, 1, 10, BU_ADMIN), isSelfMappingError);
  } finally {
    employeeServicePOMappingRepository.findByIdUnscoped = origFind;
  }
});

test('Service PO mapping: a mapping row of ANOTHER employee passes the guard', async () => {
  const origFind = employeeServicePOMappingRepository.findByIdUnscoped;
  employeeServicePOMappingRepository.findByIdUnscoped = async (id) => ({ id, employee_id: 8, service_po_id: 1 });
  try {
    await employeeServicePOMappingService.removeMapping(5, 10, BU_ADMIN).catch((err) => {
      assert.notEqual(err.code, 'SELF_MAPPING_NOT_ALLOWED'); // proceeds to the normal scope checks
    });
  } finally {
    employeeServicePOMappingRepository.findByIdUnscoped = origFind;
  }
});
