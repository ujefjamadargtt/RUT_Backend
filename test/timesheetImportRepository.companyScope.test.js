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
const { TimesheetImportHistory, TimesheetImportError, sequelize } = require('../src/models');
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

// Regression tests for GET /timesheets/import/history's authenticateReadMultiBU
// migration: findAllImports/getEmployeeCountsByImportIds must accept an
// ARRAY companyId (every Business Unit the caller can reach) alongside the
// pre-existing plain-number case, so a just-confirmed import under ANY of
// the caller's Business Units shows up — not just whichever one happened to
// be the frozen/active one.
test('findAllImports: companyId as an array -> IN filter (multi-BU reach, never a single frozen BU)', async () => {
  await withStub(TimesheetImportHistory, 'findAndCountAll', async ({ where }) => {
    const { Op } = require('sequelize');
    assert.deepEqual([...where.company_id[Op.in]], [10, 20]);
    return { rows: [], count: 0 };
  }, async () => {
    await timesheetImportRepository.findAllImports({}, { companyId: [10, 20] });
  });
});

test('findAllImports: a real numeric companyId still scopes by plain equality (no regression for a single explicitly-selected BU)', async () => {
  await withStub(TimesheetImportHistory, 'findAndCountAll', async ({ where }) => {
    assert.equal(where.company_id, 10);
    return { rows: [], count: 0 };
  }, async () => {
    await timesheetImportRepository.findAllImports({}, { companyId: 10 });
  });
});

// Two different Business Units' same-month imports both display as e.g.
// "Aug.xlsx" (see runImportPreview()'s file-naming convention) — visually
// indistinguishable in a combined "All BU" list unless each row also
// carries which Company it belongs to. findAllImports() only pays for that
// extra join when it's actually needed (more than one BU in scope).
test('findAllImports: companyId as a MULTI-element array -> joins Company (as "company") so same-named rows across BUs are distinguishable', async () => {
  await withStub(TimesheetImportHistory, 'findAndCountAll', async ({ include }) => {
    const companyInclude = include.find((inc) => inc.as === 'company');
    assert.ok(companyInclude, 'Company must be joined in as "company" for a multi-BU scope');
    assert.deepEqual(companyInclude.attributes, ['id', 'company_code', 'company_name']);
    return { rows: [], count: 0 };
  }, async () => {
    await timesheetImportRepository.findAllImports({}, { companyId: [10, 20] });
  });
});

test('findAllImports: companyId as a SINGLE-element array -> no Company join (unambiguous, response shape unchanged)', async () => {
  await withStub(TimesheetImportHistory, 'findAndCountAll', async ({ include }) => {
    assert.equal(include.find((inc) => inc.as === 'company'), undefined);
    return { rows: [], count: 0 };
  }, async () => {
    await timesheetImportRepository.findAllImports({}, { companyId: [10] });
  });
});

test('findAllImports: a plain numeric companyId -> no Company join (unambiguous, response shape unchanged)', async () => {
  await withStub(TimesheetImportHistory, 'findAndCountAll', async ({ include }) => {
    assert.equal(include.find((inc) => inc.as === 'company'), undefined);
    return { rows: [], count: 0 };
  }, async () => {
    await timesheetImportRepository.findAllImports({}, { companyId: 10 });
  });
});

test('getEmployeeCountsByImportIds: companyId as an array -> IN filter, not a single company_id equality', async () => {
  const original = sequelize.query;
  sequelize.query = async (sql, options) => {
    assert.match(sql, /company_id IN \(:companyIds\)/);
    assert.deepEqual(options.replacements.companyIds, [10, 20]);
    return [];
  };
  try {
    await timesheetImportRepository.getEmployeeCountsByImportIds([1, 2], [10, 20]);
  } finally {
    sequelize.query = original;
  }
});

test('getEmployeeCountsByImportIds: a plain numeric companyId is wrapped into a single-element array', async () => {
  const original = sequelize.query;
  sequelize.query = async (sql, options) => {
    assert.deepEqual(options.replacements.companyIds, [10]);
    return [];
  };
  try {
    await timesheetImportRepository.getEmployeeCountsByImportIds([1, 2], 10);
  } finally {
    sequelize.query = original;
  }
});
