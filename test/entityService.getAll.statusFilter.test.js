'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the GET /entities "All" status filter bug: with no
// status query param (or status=all), the endpoint must return every
// non-deleted Entity (active AND inactive), not just active ones.
//
// Two separate bugs stacked to cause this:
//  1. validations/entityValidation.js's listEntitiesQuerySchema defaulted
//     status to 'active' instead of 'all' when the query param was omitted
//     entirely.
//  2. entityService.getAll() ALSO applied its own `query.status || 'active'`
//     fallback — the exact "status || 'active'" anti-pattern that silently
//     coerces a missing/falsy status back to 'active' regardless of what the
//     route validation resolved.
// entityRepository.findAll()'s own WHERE-clause guard
// (`if (status && status !== 'all')`) was already correct and is NOT part of
// this regression — see the passthrough assertions below confirming it still
// receives 'all' untouched.
const entityRepository = require('../src/repositories/entityRepository');
const entityService = require('../src/services/entityService');
const { listEntitiesQuerySchema } = require('../src/validations/entityValidation');

const ORIGINAL_FIND_ALL = entityRepository.findAll;

function restore() {
  entityRepository.findAll = ORIGINAL_FIND_ALL;
}

function stubFindAll() {
  const captured = { filters: null };
  entityRepository.findAll = async (filters) => {
    captured.filters = filters;
    return { rows: [], count: 0 };
  };
  return captured;
}

test.after(() => restore());

test('listEntitiesQuerySchema: status omitted -> defaults to "all", not "active"', () => {
  const { value, error } = listEntitiesQuerySchema.validate({});
  assert.equal(error, undefined);
  assert.equal(value.status, 'all');
});

test('listEntitiesQuerySchema: status=all is preserved untouched', () => {
  const { value, error } = listEntitiesQuerySchema.validate({ status: 'all' });
  assert.equal(error, undefined);
  assert.equal(value.status, 'all');
});

test('entityService.getAll(): no status in query -> passes status "all" through to the repository (both active AND inactive returned)', async () => {
  const captured = stubFindAll();

  await entityService.getAll({}, [1, 2]);

  assert.equal(captured.filters.status, 'all');
});

test('entityService.getAll(): status: "all" explicitly in query -> passes "all" through unchanged', async () => {
  const captured = stubFindAll();

  await entityService.getAll({ status: 'all' }, [1, 2]);

  assert.equal(captured.filters.status, 'all');
});

test('entityService.getAll(): status: "active" explicitly in query -> still filters to active only (unchanged behavior)', async () => {
  const captured = stubFindAll();

  await entityService.getAll({ status: 'active' }, [1, 2]);

  assert.equal(captured.filters.status, 'active');
});

test('entityService.getAll(): status: "inactive" explicitly in query -> still filters to inactive only (unchanged behavior)', async () => {
  const captured = stubFindAll();

  await entityService.getAll({ status: 'inactive' }, [1, 2]);

  assert.equal(captured.filters.status, 'inactive');
});
