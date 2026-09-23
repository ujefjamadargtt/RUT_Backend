'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { Company } = require('../src/models');
const companyService = require('../src/services/companyService');
const { listCompaniesQuerySchema } = require('../src/validations/companyValidation');

/**
 * GET /companies uses its own snake_case convention (entity_id, sort_by,
 * ...) — entity_ids/business_unit_ids (snake_case) is the primary accepted
 * multi-select name; entityIds/businessUnitIds (camelCase, the Report
 * endpoints' convention) is also accepted for compatibility.
 */

const originalFindAndCountAll = Company.findAndCountAll;
function restore() {
  Company.findAndCountAll = originalFindAndCountAll;
}

test('entity_ids (snake_case) narrows the entity scope', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyService.getAll({ entity_ids: '2,999' }, [1, 2, 3]);
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [2] });
  } finally {
    restore();
  }
});

test('entityIds (camelCase) is also accepted for compatibility', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyService.getAll({ entityIds: '2' }, [1, 2, 3]);
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [2] });
  } finally {
    restore();
  }
});

test('entity_ids (snake_case) wins over entityIds (camelCase) when both are given', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyService.getAll({ entity_ids: '3', entityIds: '2' }, [1, 2, 3]);
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [3] });
  } finally {
    restore();
  }
});

test('listCompaniesQuerySchema: entity_ids/business_unit_ids and entityIds/businessUnitIds are all accepted, not stripped', () => {
  const { error, value } = listCompaniesQuerySchema.validate({
    entity_ids: '1,4', business_unit_ids: '10', entityIds: '2', businessUnitIds: '20',
  });
  assert.equal(error, undefined);
  assert.equal(value.entity_ids, '1,4');
  assert.equal(value.business_unit_ids, '10');
  assert.equal(value.entityIds, '2');
  assert.equal(value.businessUnitIds, '20');
});
