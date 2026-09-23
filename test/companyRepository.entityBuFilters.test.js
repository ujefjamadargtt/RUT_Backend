'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { Company } = require('../src/models');
const companyRepository = require('../src/repositories/companyRepository');

/**
 * Multi-Value Entity/BU Filtering pilot — GET /companies (Entity Admin/Admin
 * path, companyRepository.findAllForEntities). entityIds/businessUnitIds
 * must narrow within the caller's own owned-Entity reach, never widen past
 * it — same "narrow within scope, no-match sentinel instead of an error"
 * idiom the existing single-value entity_id filter already uses.
 */

const originalFindAndCountAll = Company.findAndCountAll;
function restore() {
  Company.findAndCountAll = originalFindAndCountAll;
}

test('no entity_ids/business_unit_ids: scoped to every owned Entity, unchanged (regression baseline)', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyRepository.findAllForEntities([1, 2, 3], {});
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [1, 2, 3] });
    assert.equal(capturedWhere.id, undefined);
  } finally {
    restore();
  }
});

test('entity_ids narrows within the owned reach, dropping ids outside it', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyRepository.findAllForEntities([1, 2, 3], { entity_ids: [2, 999] });
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [2] });
  } finally {
    restore();
  }
});

test('entity_ids where EVERY requested id is outside the owned reach resolves to the -1 no-match sentinel, never an error', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyRepository.findAllForEntities([1, 2, 3], { entity_ids: [888, 999] });
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [-1] });
  } finally {
    restore();
  }
});

test('legacy singular entity_id still works exactly as before when entity_ids is absent', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyRepository.findAllForEntities([1, 2, 3], { entity_id: 2 });
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [2] });
  } finally {
    restore();
  }
});

test('entity_ids (plural) wins over the legacy entity_id (singular) when both are somehow given', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyRepository.findAllForEntities([1, 2, 3], { entity_id: 1, entity_ids: [2, 3] });
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [2, 3] });
  } finally {
    restore();
  }
});

test('business_unit_ids filters directly by Company id, independent of the entity narrowing', async () => {
  try {
    let capturedWhere;
    Company.findAndCountAll = async ({ where }) => {
      capturedWhere = where;
      return { rows: [], count: 0 };
    };
    await companyRepository.findAllForEntities([1, 2, 3], { business_unit_ids: [10, 12] });
    assert.deepEqual(capturedWhere.id, { [Op.in]: [10, 12] });
    // entity_id scope is still the full owned reach — business_unit_ids
    // doesn't need to be a SUBSET of it (a BU Admin's own dropdown may pass
    // ids the Admin recognizes independently); the entity_id clause still
    // bounds the query via Sequelize's implicit AND across where keys.
    assert.deepEqual(capturedWhere.entity_id, { [Op.in]: [1, 2, 3] });
  } finally {
    restore();
  }
});

test('an empty owned entityIds reach short-circuits to zero rows without querying the DB at all', async () => {
  try {
    let queried = false;
    Company.findAndCountAll = async () => { queried = true; return { rows: [], count: 0 }; };
    const result = await companyRepository.findAllForEntities([], { entity_ids: [1] });
    assert.equal(queried, false);
    assert.deepEqual(result, { rows: [], count: 0 });
  } finally {
    restore();
  }
});
