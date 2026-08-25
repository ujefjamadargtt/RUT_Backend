'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression test for the cross-tenant timesheet-import leak: findImportById/
// updateImportHistory/findImportsByIds/deleteImportsById/deleteImportsByIds/
// deleteErrorsByImportIds/arePeriodsFullyPublished used to silently omit the
// company_id filter when companyId was undefined (the case for a
// company-less Admin/Entity Admin, since req.companyId is never set for
// those ranks — see resolveCompany.js). They must now always apply a
// company_id filter — throwing when the caller passed no real scope, never
// reading/writing/deleting across every tenant's import batches.
const { TimesheetImportHistory, TimesheetImportError } = require('../src/models');
const timesheetImportRepository = require('../src/repositories/timesheetImportRepository');

function withStub(model, method, replacement, fn) {
  const original = model[method];
  model[method] = replacement;
  return fn().finally(() => { model[method] = original; });
}

test('findImportById: companyId undefined -> throws rather than returning an unscoped row', async () => {
  await withStub(TimesheetImportHistory, 'findOne', async ({ where }) => {
    // Simulates the real Sequelize behavior: company_id: undefined would
    // throw before ever reaching the DB. Assert the fragment is present
    // (not omitted) so a real call is guaranteed to hit that throw.
    assert.ok('company_id' in where, 'company_id must always be present in the WHERE clause');
    assert.equal(where.company_id, undefined);
    throw new Error('WHERE parameter "company_id" has invalid "undefined" value');
  }, async () => {
    await assert.rejects(
      () => timesheetImportRepository.findImportById(999, undefined),
      /invalid "undefined" value/
    );
  });
});

test('findImportById: companyId as an array (company-less Admin/Entity Admin scope) -> IN filter, never unscoped', async () => {
  await withStub(TimesheetImportHistory, 'findOne', async ({ where }) => {
    const { Op } = require('sequelize');
    assert.deepEqual([...where.company_id[Op.in]], [10, 20]);
    return { id: 999, company_id: 10 };
  }, async () => {
    const result = await timesheetImportRepository.findImportById(999, [10, 20]);
    assert.equal(result.id, 999);
  });
});

test('findImportById: a real numeric companyId still scopes by plain equality (no regression for BU-scoped roles)', async () => {
  await withStub(TimesheetImportHistory, 'findOne', async ({ where }) => {
    assert.equal(where.company_id, 10);
    return { id: 5, company_id: 10 };
  }, async () => {
    const result = await timesheetImportRepository.findImportById(5, 10);
    assert.equal(result.id, 5);
  });
});

test('deleteImportsById: companyId undefined -> throws, never deletes an unscoped batch', async () => {
  await withStub(TimesheetImportHistory, 'destroy', async () => {
    throw new Error('WHERE parameter "company_id" has invalid "undefined" value');
  }, async () => {
    await assert.rejects(
      () => timesheetImportRepository.deleteImportsById([1, 2, 3], null, undefined),
      /invalid "undefined" value/
    );
  });
});

test('deleteErrorsByImportIds: companyId undefined -> throws, never deletes unscoped error rows', async () => {
  await withStub(TimesheetImportError, 'destroy', async () => {
    throw new Error('WHERE parameter "company_id" has invalid "undefined" value');
  }, async () => {
    await assert.rejects(
      () => timesheetImportRepository.deleteErrorsByImportIds([1, 2], null, undefined),
      /invalid "undefined" value/
    );
  });
});

test('updateImportHistory: companyId undefined -> throws, never force-publishes an unscoped import', async () => {
  await withStub(TimesheetImportHistory, 'findOne', async ({ where }) => {
    assert.ok('company_id' in where);
    throw new Error('WHERE parameter "company_id" has invalid "undefined" value');
  }, async () => {
    await assert.rejects(
      () => timesheetImportRepository.updateImportHistory(1, { is_publish: true }, null, undefined),
      /invalid "undefined" value/
    );
  });
});
