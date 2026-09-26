'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression: GET /clients ignored sortBy/sortOrder. The Client Master sends
// camelCase `sortBy=created_at&sortOrder=desc`, but listClientsQuerySchema only
// declared snake_case sort_by/sort_order, so validateRequest's stripUnknown
// silently dropped them and every request fell back to client_name ASC.

const { Client } = require('../src/models');
const { validate } = require('../src/middlewares/validateRequest');
const { listClientsQuerySchema } = require('../src/validations/clientValidation');
const clientRepository = require('../src/repositories/clientRepository');
const clientService = require('../src/services/clientService');

function runValidator(query) {
  return new Promise((resolve, reject) => {
    const req = { query: { ...query } };
    const res = { status: () => ({ json: (body) => reject(new Error(JSON.stringify(body))) }) };
    validate(listClientsQuerySchema, 'query')(req, res, () => resolve(req.query));
  });
}

async function capturedOrder(query) {
  const original = Client.findAndCountAll;
  let order;
  Client.findAndCountAll = async (opts) => { order = opts.order; return { rows: [], count: 0 }; };
  try {
    const validated = await runValidator(query);
    await clientService.getAll(validated, { companyId: 10, hierarchyRank: 4, employeeId: 1 });
    return order;
  } finally {
    Client.findAndCountAll = original;
  }
}


test('validator keeps camelCase sortBy/sortOrder instead of stripping them', async () => {
  const validated = await runValidator({ page: '1', limit: '10', status: 'all', sortBy: 'created_at', sortOrder: 'desc' });
  assert.equal(validated.sortBy, 'created_at');
  assert.equal(validated.sortOrder, 'desc');
});

test('sortBy=created_at&sortOrder=desc -> ORDER BY created_at DESC, id DESC', async () => {
  assert.deepEqual(await capturedOrder({ status: 'all', sortBy: 'created_at', sortOrder: 'desc' }), [['created_at', 'DESC'], ['id', 'DESC']]);
});

test('sortBy=created_at&sortOrder=asc -> ORDER BY created_at ASC, id ASC', async () => {
  assert.deepEqual(await capturedOrder({ status: 'all', sortBy: 'created_at', sortOrder: 'asc' }), [['created_at', 'ASC'], ['id', 'ASC']]);
});

test('sortBy=client_name asc/desc, client_code, status are honoured', async () => {
  assert.deepEqual(await capturedOrder({ sortBy: 'client_name', sortOrder: 'asc' }), [['client_name', 'ASC'], ['id', 'ASC']]);
  assert.deepEqual(await capturedOrder({ sortBy: 'client_name', sortOrder: 'desc' }), [['client_name', 'DESC'], ['id', 'DESC']]);
  assert.deepEqual(await capturedOrder({ sortBy: 'client_code', sortOrder: 'desc' }), [['client_code', 'DESC'], ['id', 'DESC']]);
  assert.deepEqual(await capturedOrder({ sortBy: 'status', sortOrder: 'asc' }), [['status', 'ASC'], ['id', 'ASC']]);
});

test('no sort params -> existing default client_name ASC', async () => {
  assert.deepEqual(await capturedOrder({ page: '1', limit: '10', status: 'all' }), [['client_name', 'ASC'], ['id', 'ASC']]);
});

test('snake_case sort_by/sort_order still work (existing contract)', async () => {
  assert.deepEqual(await capturedOrder({ sort_by: 'created_at', sort_order: 'DESC' }), [['created_at', 'DESC'], ['id', 'DESC']]);
});

test('unsupported sortBy / sortOrder fall back to the default — never reach SQL raw, never a 400', async () => {
  assert.deepEqual(
    await capturedOrder({ sortBy: 'client_name; DROP TABLE clients', sortOrder: 'sideways' }),
    [['client_name', 'ASC'], ['id', 'ASC']]
  );
  assert.deepEqual(await capturedOrder({ sortBy: 'password', sortOrder: 'desc' }), [['client_name', 'DESC'], ['id', 'DESC']]);
});

test('sorting is applied in the query itself, alongside LIMIT/OFFSET (not after pagination)', async () => {
  const original = Client.findAndCountAll;
  let opts;
  Client.findAndCountAll = async (o) => { opts = o; return { rows: [], count: 0 }; };
  try {
    await clientRepository.findAll({ companyId: 10 }, { limit: 10, offset: 10 }, { sortBy: 'created_at', sortOrder: 'desc' });
    assert.equal(opts.limit, 10);
    assert.equal(opts.offset, 10);
    assert.deepEqual(opts.order, [['created_at', 'DESC'], ['id', 'DESC']]);
  } finally {
    Client.findAndCountAll = original;
  }
});

