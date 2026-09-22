'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// GET /projects with no ?status= param must return projects of EVERY status,
// not just 'active'. The Projects list page's "All" filter deliberately
// omits the status param (ProjectList.jsx:111) rather than sending
// status=all, so the service must pass that absence straight through as
// null/undefined rather than defaulting to 'active' — projectRepository.
// findAll() already only applies `where.status` when status is truthy and
// not 'all' (projectRepository.js:84-86).
const projectRepository = require('../src/repositories/projectRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const projectService = require('../src/services/projectService');
const { listProjectsQuerySchema } = require('../src/validations/projectValidation');

const ORIGINAL = {
  findAll: projectRepository.findAll,
  countServicePOsByProjectIds: projectRepository.countServicePOsByProjectIds,
  resolveActorCompanyScope: companyAccessControlService.resolveActorCompanyScope,
};

function restore() {
  projectRepository.findAll = ORIGINAL.findAll;
  projectRepository.countServicePOsByProjectIds = ORIGINAL.countServicePOsByProjectIds;
  companyAccessControlService.resolveActorCompanyScope = ORIGINAL.resolveActorCompanyScope;
}

function stubFilterCapture() {
  let capturedFilters;
  projectRepository.findAll = async (filters) => {
    capturedFilters = filters;
    return { rows: [], count: 0 };
  };
  projectRepository.countServicePOsByProjectIds = async () => new Map();
  companyAccessControlService.resolveActorCompanyScope = async () => 3;
  return () => capturedFilters;
}

const AUTH_CONTEXT = { userId: 1, employeeId: 1, companyId: 3, hierarchyRank: 4, roleNames: [], employeeBusinessUnits: [3] };

test('no status query param: status filter is not defaulted to "active"', async () => {
  const getCaptured = stubFilterCapture();

  await projectService.getAll({}, AUTH_CONTEXT);

  assert.equal(getCaptured().status, null);
  restore();
});

test('status=active explicitly sent: passed through unchanged', async () => {
  const getCaptured = stubFilterCapture();

  await projectService.getAll({ status: 'active' }, AUTH_CONTEXT);

  assert.equal(getCaptured().status, 'active');
  restore();
});

test('status=inactive explicitly sent: passed through unchanged', async () => {
  const getCaptured = stubFilterCapture();

  await projectService.getAll({ status: 'inactive' }, AUTH_CONTEXT);

  assert.equal(getCaptured().status, 'inactive');
  restore();
});

// The actual bug the QA report caught: express-level validate() runs Joi on
// req.query BEFORE the controller/service ever see it and overwrites
// req.query with the validated value (validateRequest.js:40). A .default()
// on this schema means "absent" never reaches getAll() as absent — it
// arrives as 'active' regardless of what getAll() itself does with a
// missing status. The projectService.getAll() tests above pass {} directly
// to the service and so cannot catch this; only validating through the
// actual Joi schema can.
test('listProjectsQuerySchema: status omitted from the query string is NOT defaulted to "active"', () => {
  const { error, value } = listProjectsQuerySchema.validate({});

  assert.equal(error, undefined);
  assert.equal(value.status, undefined);
});

test('listProjectsQuerySchema: status=active/inactive/all still validate and pass through', () => {
  for (const status of ['active', 'inactive', 'all']) {
    const { error, value } = listProjectsQuerySchema.validate({ status });
    assert.equal(error, undefined);
    assert.equal(value.status, status);
  }
});
