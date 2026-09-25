'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for a real bug report: after moving a Client to a
// different Business Unit (clientService.update()'s own BU-reassignment
// fix), updating one of that Client's Projects started returning "Project
// not found". Same root cause as the Client bug: projectService.update()/
// deleteProject() resolved their existence-check scope via
// resolveActorCompanyScope({ companyId: req.companyId, ... }) — the
// caller's single CURRENTLY ACTIVE Business Unit (X-Company-Id) — while
// GET /projects/GET /projects/:id (which the Edit form's list is populated
// from) already span every Business Unit the caller manages
// (authenticateReadMultiBU + resolveActorFullReach, see getProjectById's
// own fix). Opening/editing any Project from a DIFFERENT BU than whichever
// one happened to be currently selected 404'd on Save. Fixed by switching
// update()/deleteProject() to resolveActorFullReach() too, matching
// getProjectById() — same fix, same shape, as clientService's own fix.
//
// Also covers the accompanying feature: Business Unit reassignment via PUT
// (company_id in the body), authorized the same way create() already
// authorizes it.
const projectRepository = require('../src/repositories/projectRepository');
const clientRepository = require('../src/repositories/clientRepository');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const projectService = require('../src/services/projectService');

const ORIGINAL = {
  findById: projectRepository.findById,
  findByCode: projectRepository.findByCode,
  findByName: projectRepository.findByName,
  update: projectRepository.update,
  softDelete: projectRepository.softDelete,
  countServicePOsByProject: projectRepository.countServicePOsByProject,
  clientFindByIdUnscoped: clientRepository.findByIdUnscoped,
  resolveOwnedCompanyIds: companyAccessControlService.resolveOwnedCompanyIds,
};

function restore() {
  projectRepository.findById = ORIGINAL.findById;
  projectRepository.findByCode = ORIGINAL.findByCode;
  projectRepository.findByName = ORIGINAL.findByName;
  projectRepository.update = ORIGINAL.update;
  projectRepository.softDelete = ORIGINAL.softDelete;
  projectRepository.countServicePOsByProject = ORIGINAL.countServicePOsByProject;
  clientRepository.findByIdUnscoped = ORIGINAL.clientFindByIdUnscoped;
  companyAccessControlService.resolveOwnedCompanyIds = ORIGINAL.resolveOwnedCompanyIds;
}

// A BU Admin mapped to BUs 3 and 7, currently active on BU 3 — the exact
// "Global BU selector on a different BU than the target record" scenario
// this bug report hit (its Client having just moved to BU 7). The Project
// being edited lives in BU 7.
const MULTI_BU_REQ = {
  companyId: 3,
  hierarchyRank: 4,
  employeeId: 900,
  employeeBusinessUnits: [{ id: 3 }, { id: 7 }],
  headers: {},
};

test('update(): a Project in the caller\'s OTHER managed BU (7, not the active companyId 3) is found and updated — THE BUG FIX', async () => {
  try {
    let capturedFindByIdScope;
    projectRepository.findById = async (id, scope) => {
      capturedFindByIdScope = scope;
      return { id: 5, client_id: 10, project_code: 'PRJ-1', project_name: 'Old Name', project_description: '', status: 'active', company_id: 7 };
    };
    projectRepository.findByName = async () => null;
    let updatedPayload;
    projectRepository.update = async (id, payload) => { updatedPayload = payload; return { id, ...payload }; };

    const updated = await projectService.update(5, { project_name: 'New Name' }, 900, MULTI_BU_REQ);

    assert.deepEqual(capturedFindByIdScope.slice().sort(), [3, 7]); // full reach, not just active BU 3
    assert.equal(updatedPayload.project_name, 'New Name');
    assert.equal(updated.project_name, 'New Name');
  } finally {
    restore();
  }
});

test('update(): reassigning company_id to a BU the caller IS mapped to succeeds, and uniqueness checks run against the DESTINATION BU', async () => {
  try {
    projectRepository.findById = async () => ({ id: 5, client_id: 10, project_code: 'PRJ-1', project_name: 'Acme Project', project_description: '', status: 'active', company_id: 7 });
    projectRepository.findByName = async () => null;
    let updatedPayload;
    projectRepository.update = async (id, payload) => { updatedPayload = payload; return { id, ...payload }; };

    const updated = await projectService.update(5, { company_id: 3 }, 900, MULTI_BU_REQ);

    assert.equal(updatedPayload.company_id, 3);
    assert.equal(updated.company_id, 3);
  } finally {
    restore();
  }
});

test('update(): reassigning company_id to a BU the caller is NOT mapped to is rejected with 403, and nothing is written', async () => {
  try {
    projectRepository.findById = async () => ({ id: 5, client_id: 10, project_code: 'PRJ-1', project_name: 'Acme Project', project_description: '', status: 'active', company_id: 7 });
    let wroteAnything = false;
    projectRepository.update = async () => { wroteAnything = true; };

    await assert.rejects(
      () => projectService.update(5, { company_id: 99 }, 900, MULTI_BU_REQ),
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
    assert.equal(wroteAnything, false);
  } finally {
    restore();
  }
});

test('update(): a company-less actor (Admin) reassigning company_id validates against their OWN owned Companies, not employeeBusinessUnits', async () => {
  try {
    projectRepository.findById = async () => ({ id: 5, client_id: 10, project_code: 'PRJ-1', project_name: 'Acme Project', project_description: '', status: 'active', company_id: 5 });
    projectRepository.findByName = async () => null;
    let updatedPayload;
    projectRepository.update = async (id, payload) => { updatedPayload = payload; return { id, ...payload }; };
    companyAccessControlService.resolveOwnedCompanyIds = async () => [5, 6, 7];

    const adminReq = { companyId: null, hierarchyRank: 2, employeeId: 1, employeeBusinessUnits: [], headers: {} };
    const updated = await projectService.update(5, { company_id: 6 }, 1, adminReq);

    assert.equal(updatedPayload.company_id, 6);
    assert.equal(updated.company_id, 6);
  } finally {
    restore();
  }
});

test('update(): client_id reassignment validates the new Client against the DESTINATION company (the BU being moved to, not the Project\'s old BU)', async () => {
  try {
    projectRepository.findById = async () => ({ id: 5, client_id: 10, project_code: 'PRJ-1', project_name: 'Acme Project', project_description: '', status: 'active', company_id: 7 });
    let capturedClientId;
    // The Client lives in BU 3 (the destination), NOT BU 7 (the Project's
    // old BU) — if the code mistakenly checked against the old company_id
    // (7) instead, this would 404 ("Client not found").
    clientRepository.findByIdUnscoped = async (clientId) => {
      capturedClientId = clientId;
      return { id: 20, status: 'active', company_id: 3 };
    };
    projectRepository.update = async (id, payload) => ({ id, ...payload });

    // Move the Project to BU 3 AND reassign it to a Client that lives in BU 3.
    const updated = await projectService.update(5, { company_id: 3, client_id: 20 }, 900, MULTI_BU_REQ);

    assert.equal(capturedClientId, 20);
    assert.equal(updated.client_id, 20);
  } finally {
    restore();
  }
});

test('deleteProject(): a Project in the caller\'s OTHER managed BU (7, not the active companyId 3) is found and deleted', async () => {
  try {
    let capturedFindByIdScope;
    projectRepository.findById = async (id, scope) => {
      capturedFindByIdScope = scope;
      return { id: 5, project_name: 'Acme Project', status: 'active', company_id: 7 };
    };
    projectRepository.countServicePOsByProject = async () => 0;
    let softDeleted = false;
    projectRepository.softDelete = async () => { softDeleted = true; return true; };

    await projectService.deleteProject(5, 900, MULTI_BU_REQ);

    assert.deepEqual(capturedFindByIdScope.slice().sort(), [3, 7]);
    assert.equal(softDeleted, true);
  } finally {
    restore();
  }
});
