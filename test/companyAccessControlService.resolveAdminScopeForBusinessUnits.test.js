'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Company } = require('../src/models');
const entityRepository = require('../src/repositories/entityRepository');
const { resolveAdminScopeForBusinessUnits } = require('../src/services/companyAccessControlService');

// resolveAdminScopeForBusinessUnits() — the "BU Admin operates under the
// Admin's scope" fix: given the Business Unit(s) an actor (BU Admin/
// Service PO Admin/Delivery Head) is personally mapped to, resolve UP to
// the Admin who owns them, then back DOWN to that Admin's FULL tenant
// scope — which may span many more Business Units than the actor
// personally manages. This is what makes a BU Admin managing only 2 of 5
// BUs under the same Admin still see all 5 BUs' worth of Employees.

const ORIGINAL = {
  companyFindOne: Company.findOne,
  entityFindOne: Entity.findOne,
  entityFindAll: Entity.findAll,
  companyFindAll: Company.findAll,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
};

function restore() {
  Company.findOne = ORIGINAL.companyFindOne;
  Entity.findOne = ORIGINAL.entityFindOne;
  Entity.findAll = ORIGINAL.entityFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
}

// BU 3 belongs to Entity 60, which was created by Admin 500. That Admin
// owns Entities 60 and 61, spanning Companies 1-5 in total — far more
// than the single BU (3) the caller personally manages.
function stubOwningAdminWithBroadScope() {
  Company.findOne = async ({ where }) => {
    if (where.id === 3) return { id: 3, entity_id: 60 };
    return null;
  };
  Entity.findOne = async ({ where }) => {
    if (where.id === 60) return { id: 60, created_by: 500 };
    return null;
  };
  entityRepository.findIdsOwnedByAdmin = async (adminId) => (adminId === 500 ? [60, 61] : []);
  Entity.findAll = async () => [{ id: 60 }, { id: 61 }];
  Company.findAll = async () => [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
}

test('a BU Admin managing only ONE of an Admin\'s several Business Units gets the Admin\'s FULL scope, not just their own BU', async () => {
  stubOwningAdminWithBroadScope();

  const scope = await resolveAdminScopeForBusinessUnits([3]);

  assert.deepEqual(new Set(scope), new Set([1, 2, 3, 4, 5]));
  restore();
});

test('multiple own Business Units owned by the SAME Admin still resolve to that one Admin\'s scope, not duplicated', async () => {
  Company.findOne = async ({ where }) => {
    if ([3, 4].includes(where.id)) return { id: where.id, entity_id: 60 };
    return null;
  };
  Entity.findOne = async ({ where }) => (where.id === 60 ? { id: 60, created_by: 500 } : null);
  entityRepository.findIdsOwnedByAdmin = async () => [60];
  Entity.findAll = async () => [{ id: 60 }];
  Company.findAll = async () => [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];

  const scope = await resolveAdminScopeForBusinessUnits([3, 4]);

  assert.deepEqual(new Set(scope), new Set([1, 2, 3, 4, 5]));
  restore();
});

test('a Business Unit whose owning Admin cannot be resolved falls back to the actor\'s own Business Unit ids (never empty/unrestricted)', async () => {
  Company.findOne = async () => null; // no such Company found at all

  const scope = await resolveAdminScopeForBusinessUnits([999]);

  assert.deepEqual(scope, [999]);
  restore();
});

test('a Company with no entity_id (BU-less/legacy) also falls back to the actor\'s own ids', async () => {
  Company.findOne = async () => ({ id: 7, entity_id: null });

  const scope = await resolveAdminScopeForBusinessUnits([7]);

  assert.deepEqual(scope, [7]);
  restore();
});

test('empty input returns empty output, no DB calls made', async () => {
  let called = false;
  Company.findOne = async () => { called = true; return null; };

  const scope = await resolveAdminScopeForBusinessUnits([]);

  assert.deepEqual(scope, []);
  assert.equal(called, false);
  restore();
});
