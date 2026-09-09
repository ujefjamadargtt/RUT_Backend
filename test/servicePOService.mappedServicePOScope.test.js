'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

// Regression coverage for the "Project Manager (renamed from Service PO
// Admin) / Delivery Head see only their INDIVIDUALLY-mapped Service POs"
// change — previously
// servicePORepository.companyScope() UNIONED mappedServicePOIds alongside
// the actor's normal BU-based company_id match, so these two roles still saw
// every Service PO in their own mapped Business Unit(s), on top of whatever
// else was individually mapped to them outside those BUs. The reported
// requirement: stop showing "every SPO in a mapped BU" entirely for these
// two roles — show ONLY individually-mapped POs, whether inside or outside
// their mapped BU(s). See servicePOService.resolveIndividuallyMappedServicePOIds's
// doc comment.

const { ServicePO } = require('../src/models');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePOService = require('../src/services/servicePOService');

// companyScope() itself isn't exported (internal helper) — exercised
// indirectly through findAll()/findById(), stubbing the Sequelize model
// call to capture the exact `where` fragment it builds.
const ORIGINAL_MODEL = {
  findAndCountAll: ServicePO.findAndCountAll,
  findOne: ServicePO.findOne,
};

function restoreModel() {
  ServicePO.findAndCountAll = ORIGINAL_MODEL.findAndCountAll;
  ServicePO.findOne = ORIGINAL_MODEL.findOne;
}

test('findAll(): mappedServicePOIds omitted (null) -> normal BU-based company_id scope, completely unaffected', async () => {
  let capturedWhere;
  ServicePO.findAndCountAll = async ({ where }) => {
    capturedWhere = where;
    return { rows: [], count: 0 };
  };

  await servicePORepository.findAll({ companyId: 10 }, {}, {});

  assert.deepEqual(capturedWhere[Op.and][0], { company_id: 10 });
  restoreModel();
});

test('findAll(): mappedServicePOIds given (non-null) OVERRIDES companyId/centralisedOwnerIds entirely, never unions', async () => {
  let capturedWhere;
  ServicePO.findAndCountAll = async ({ where }) => {
    capturedWhere = where;
    return { rows: [], count: 0 };
  };

  await servicePORepository.findAll(
    { companyId: 10, createdBy: 900, centralisedOwnerIds: [5, 6], mappedServicePOIds: [1, 2, 3] }, {}, {}
  );

  assert.deepEqual(capturedWhere[Op.and][0], { id: { [Op.in]: [1, 2, 3] } });
  restoreModel();
});

test('findAll(): mappedServicePOIds given as an EMPTY array (qualifying role, zero active mappings) -> matches nothing, not "fall back to BU scope"', async () => {
  let capturedWhere;
  ServicePO.findAndCountAll = async ({ where }) => {
    capturedWhere = where;
    return { rows: [], count: 0 };
  };

  await servicePORepository.findAll({ companyId: 10, mappedServicePOIds: [] }, {}, {});

  assert.deepEqual(capturedWhere[Op.and][0], { id: { [Op.in]: [] } });
  restoreModel();
});

test('findById(): mappedServicePOIds override also applies when companyId is an array (company-less actor shape)', async () => {
  let capturedWhere;
  ServicePO.findOne = async ({ where }) => {
    capturedWhere = where;
    return null;
  };

  await servicePORepository.findById(555, [46, 47], 1, [5], [1, 2, 3]);

  // The requested id (555) must survive alongside the scope's own `id IN
  // (...)` fragment — Op.and, not a colliding object key (see findById()'s
  // doc comment on this).
  assert.deepEqual(capturedWhere.id, 555);
  assert.deepEqual(capturedWhere[Op.and], [{ id: { [Op.in]: [1, 2, 3] } }]);
  restoreModel();
});

const ORIGINAL = {
  findRolesByEmployeeId: employeeRoleRepository.findRolesByEmployeeId,
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findAll: servicePORepository.findAll,
  findById: servicePORepository.findById,
};

function restore() {
  employeeRoleRepository.findRolesByEmployeeId = ORIGINAL.findRolesByEmployeeId;
  employeeServicePOMappingRepository.findAllByEmployee = ORIGINAL.findAllByEmployee;
  servicePORepository.findAll = ORIGINAL.findAll;
  servicePORepository.findById = ORIGINAL.findById;
}

function stubRoles(roleNames) {
  employeeRoleRepository.findRolesByEmployeeId = async () => roleNames.map((role_name) => ({ role_name }));
}

function stubMappedServicePOs(servicePoIds) {
  employeeServicePOMappingRepository.findAllByEmployee = async () =>
    servicePoIds.map((service_po_id) => ({ service_po_id }));
}

function stubFindAllCapture() {
  let captured;
  servicePORepository.findAll = async (filters) => {
    captured = filters;
    return { rows: [], count: 0 };
  };
  return () => captured;
}

test('getAll(): a non-qualifying role (e.g. BU Admin) -> filters.mappedServicePOIds is null, normal BU scope untouched', async () => {
  stubRoles(['BU Admin']);
  const getCaptured = stubFindAllCapture();

  await servicePOService.getAll({}, { companyId: 10, hierarchyRank: 4, employeeId: 900 }, null);

  assert.equal(getCaptured().mappedServicePOIds, null);
  assert.equal(getCaptured().companyId, 10);
  restore();
});

test('getAll(): Project Manager (renamed from Service PO Admin) -> filters.mappedServicePOIds is exactly their active mappings, regardless of companyId', async () => {
  stubRoles(['Project Manager']);
  stubMappedServicePOs([101, 202]);
  const getCaptured = stubFindAllCapture();

  await servicePOService.getAll({}, { companyId: 10, hierarchyRank: 6, employeeId: 900 }, null);

  assert.deepEqual(getCaptured().mappedServicePOIds, [101, 202]);
  restore();
});

test('getAll(): Project Manager with ZERO active mappings -> filters.mappedServicePOIds is [] (sees nothing), not null (which would fall back to BU scope)', async () => {
  stubRoles(['Project Manager']);
  stubMappedServicePOs([]);
  const getCaptured = stubFindAllCapture();

  await servicePOService.getAll({}, { companyId: 10, hierarchyRank: 6, employeeId: 900 }, null);

  assert.deepEqual(getCaptured().mappedServicePOIds, []);
  restore();
});

test('getAll(): the retired "Service PO Admin"/"Delivery Head" role names no longer qualify -> filters.mappedServicePOIds is null', async () => {
  stubRoles(['Service PO Admin']);
  const getCaptured1 = stubFindAllCapture();
  await servicePOService.getAll({}, { companyId: 10, hierarchyRank: 6, employeeId: 900 }, null);
  assert.equal(getCaptured1().mappedServicePOIds, null);
  restore();

  stubRoles(['Delivery Head']);
  const getCaptured2 = stubFindAllCapture();
  await servicePOService.getAll({}, { companyId: 10, hierarchyRank: 6, employeeId: 900 }, null);
  assert.equal(getCaptured2().mappedServicePOIds, null);
  restore();
});

test('getById(): mappedServicePOIds is threaded through to servicePORepository.findById\'s 5th argument', async () => {
  stubRoles(['Project Manager']);
  stubMappedServicePOs([555]);
  let capturedArgs;
  servicePORepository.findById = async (...args) => {
    capturedArgs = args;
    return { id: 555, toJSON: () => ({ id: 555 }) };
  };

  await servicePOService.getById(555, { companyId: 10, hierarchyRank: 6, employeeId: 900 });

  assert.deepEqual(capturedArgs[4], [555]);
  restore();
});
