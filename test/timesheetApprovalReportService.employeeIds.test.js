'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const { resolveEmployeeScope } = require('../src/services/timesheetApprovalReportService');
const { timesheetApprovalStatusQuerySchema } = require('../src/validations/employeeReportValidation');

// The caller (user 1, own employee 100) manages employees 12, 45 and 78.
const originalFindByManager = managerEmployeeMappingRepository.findByManager;
const originalPoTeam = employeeServicePOMappingRepository.findEmployeeIdsOnProjectManagerPOs;
const stubTeam = (poTeam = []) => {
  managerEmployeeMappingRepository.findByManager = async () => ([12, 45, 78].map((employee_id) => ({ employee_id })));
  employeeServicePOMappingRepository.findEmployeeIdsOnProjectManagerPOs = async () => poTeam;
};
const restore = () => {
  managerEmployeeMappingRepository.findByManager = originalFindByManager;
  employeeServicePOMappingRepository.findEmployeeIdsOnProjectManagerPOs = originalPoTeam;
};

test('resolveEmployeeScope: a Project Manager also reaches employees on the Service POs they are PM of', async () => {
  stubTeam([100, 201, 202]);
  try {
    assert.deepEqual(await resolveEmployeeScope(1, 100, undefined, 5), [12, 45, 78, 100, 201, 202]);
    assert.deepEqual(await resolveEmployeeScope(1, 100, [201], 5), [201]);
  } finally { restore(); }
});

test('resolveEmployeeScope: several requested ids inside the team are all returned', async () => {
  stubTeam();
  try {
    assert.deepEqual(await resolveEmployeeScope(1, 100, [12, 78], 5), [12, 78]);
  } finally { restore(); }
});

test('resolveEmployeeScope: a single employee_id (number) still behaves exactly as before', async () => {
  stubTeam();
  try {
    assert.deepEqual(await resolveEmployeeScope(1, 100, 45, 5), [45]);
  } finally { restore(); }
});

test('resolveEmployeeScope: no ids -> the whole scope (team plus own record), unchanged', async () => {
  stubTeam();
  try {
    assert.deepEqual(await resolveEmployeeScope(1, 100, undefined, 5), [12, 45, 78, 100]);
  } finally { restore(); }
});

test('resolveEmployeeScope: ONE id outside the team rejects the whole request with 403', async () => {
  stubTeam();
  try {
    await assert.rejects(
      () => resolveEmployeeScope(1, 100, [12, 999, 45], 5),
      (err) => err.statusCode === 403 && /999/.test(err.message)
    );
  } finally { restore(); }
});

test('resolveEmployeeScope: duplicate ids are collapsed', async () => {
  stubTeam();
  try {
    assert.deepEqual(await resolveEmployeeScope(1, 100, [12, 12, 45], 5), [12, 45]);
  } finally { restore(); }
});

test('query schema accepts employee_ids as a comma-separated list, alongside the legacy employee_id', () => {
  const ok = timesheetApprovalStatusQuerySchema.validate({ month: 9, year: 2026, employee_ids: '12,45, 78' });
  assert.equal(ok.error, undefined);
  const legacy = timesheetApprovalStatusQuerySchema.validate({ month: 9, year: 2026, employee_id: 12 });
  assert.equal(legacy.error, undefined);
});

test('query schema rejects a malformed employee_ids', () => {
  for (const bad of ['12,abc', '0', '12,,45', '-3']) {
    const r = timesheetApprovalStatusQuerySchema.validate({ month: 9, year: 2026, employee_ids: bad });
    assert.ok(r.error, `expected "${bad}" to be rejected`);
  }
});
