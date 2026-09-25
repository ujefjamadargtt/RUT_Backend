'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const clientRepository = require('../src/repositories/clientRepository');
const projectRepository = require('../src/repositories/projectRepository');
const { Company } = require('../src/models');
const clientService = require('../src/services/clientService');
const projectService = require('../src/services/projectService');

/**
 * BU Hierarchy / Sub-BU support — real bug report: a BU Admin mapped to
 * only ONE Sub-BU (e.g. "DAS", under Parent "DATA + AI") got "Business Unit
 * #X is not one of your mapped Business Units" creating/updating a Client
 * or Project under a SIBLING Sub-BU (e.g. "IBM"), even though they hold the
 * BU Admin role for that whole family. Root cause: clientService.js/
 * projectService.js create()/update() had their OWN hand-copied duplicate
 * of the mapped-BU check that never received the family-expansion fix
 * applied to the shared resolveCreateCompanyIdForActor(). Fixed by routing
 * create() through that shared function and applying the same
 * expandBusinessUnitIdsToFamily() expansion to update()'s inline check.
 */

const ORIGINAL = {
  clientFindByName: clientRepository.findByName,
  clientCreate: clientRepository.create,
  clientFindById: clientRepository.findById,
  clientUpdate: clientRepository.update,
  clientFindByIdUnscoped: clientRepository.findByIdUnscoped,
  projectFindByName: projectRepository.findByName,
  projectFindByCode: projectRepository.findByCode,
  projectCreate: projectRepository.create,
  projectFindById: projectRepository.findById,
  projectUpdate: projectRepository.update,
  companyFindAll: Company.findAll,
};

function restore() {
  clientRepository.findByName = ORIGINAL.clientFindByName;
  clientRepository.create = ORIGINAL.clientCreate;
  clientRepository.findById = ORIGINAL.clientFindById;
  clientRepository.update = ORIGINAL.clientUpdate;
  clientRepository.findByIdUnscoped = ORIGINAL.clientFindByIdUnscoped;
  projectRepository.findByName = ORIGINAL.projectFindByName;
  projectRepository.findByCode = ORIGINAL.projectFindByCode;
  projectRepository.create = ORIGINAL.projectCreate;
  projectRepository.findById = ORIGINAL.projectFindById;
  projectRepository.update = ORIGINAL.projectUpdate;
  Company.findAll = ORIGINAL.companyFindAll;
}

// A BU Admin mapped ONLY to "DAS" (42, Parent "DATA + AI" 23), currently
// active on it. Picking "IBM" (43, DAS's sibling) explicitly in a form.
const BU_ADMIN_REQ = {
  companyId: 42,
  hierarchyRank: 4,
  employeeId: 900,
  employeeBusinessUnits: [{ id: 42 }],
  headers: {},
};

function mockFamily() {
  Company.findAll = async ({ where }) => (
    where.id
      ? [{ id: 42, parent_business_unit_id: 23 }]
      : [
        { id: 23, parent_business_unit_id: null },
        { id: 42, parent_business_unit_id: 23 },
        { id: 43, parent_business_unit_id: 23 },
        { id: 44, parent_business_unit_id: 23 },
      ]
  );
}

test('clientService.create(): a BU Admin mapped to only "DAS" (42) can create a Client under sibling "IBM" (43) — THE BUG FIX', async () => {
  try {
    mockFamily();
    clientRepository.findByName = async () => null;
    let created;
    clientRepository.create = async (data) => { created = data; return { id: 1, ...data, toJSON() { return this; } }; };

    await clientService.create(
      { company_id: 43, client_name: 'Alpharithm', client_code: 'ALPHA' },
      1, BU_ADMIN_REQ
    );

    assert.equal(created.company_id, 43);
  } finally {
    restore();
  }
});

test('clientService.create(): rejects a Business Unit entirely outside the actor\'s family, with 403', async () => {
  try {
    mockFamily();
    await assert.rejects(
      () => clientService.create({ company_id: 999, client_name: 'X', client_code: 'X1' }, 1, BU_ADMIN_REQ),
      (err) => { assert.equal(err.statusCode, 403); return true; }
    );
  } finally {
    restore();
  }
});

test('clientService.update(): a BU Admin mapped to only "DAS" (42) can reassign a Client to sibling "IBM" (43)', async () => {
  try {
    mockFamily();
    clientRepository.findById = async () => ({ id: 5, company_id: 42, client_name: 'Old', client_code: 'OLD', status: 'active', toJSON() { return this; } });
    clientRepository.findByName = async () => null;
    let updated;
    clientRepository.update = async (id, data) => { updated = data; return { id, ...data, toJSON() { return this; } }; };

    await clientService.update(5, { company_id: 43 }, 900, BU_ADMIN_REQ);

    assert.equal(updated.company_id, 43);
  } finally {
    restore();
  }
});

test('projectService.create(): a BU Admin mapped to only "DAS" (42) can create a Project under sibling "IBM" (43)', async () => {
  try {
    mockFamily();
    projectRepository.findByName = async () => null;
    // The referenced Client lives in the destination BU (43) — validated by
    // areSameOrRelatedBusinessUnits()'s own exact-match branch, unrelated to
    // this fix.
    clientRepository.findByIdUnscoped = async () => ({ id: 10, status: 'active', company_id: 43 });
    let created;
    projectRepository.create = async (data) => { created = data; return { id: 1, ...data, toJSON() { return this; } }; };

    await projectService.create(
      { company_id: 43, client_id: 10, project_name: 'New Project', project_code: 'NP1' },
      1, BU_ADMIN_REQ
    );

    assert.equal(created.company_id, 43);
  } finally {
    restore();
  }
});

test('projectService.update(): a BU Admin mapped to only "DAS" (42) can reassign a Project to sibling "IBM" (43)', async () => {
  try {
    mockFamily();
    projectRepository.findById = async () => ({ id: 5, company_id: 42, client_id: 10, project_name: 'Old', project_code: 'OLD', status: 'active' });
    projectRepository.findByName = async () => null;
    let updated;
    projectRepository.update = async (id, data) => { updated = data; return { id, ...data }; };

    await projectService.update(5, { company_id: 43 }, 900, { ...BU_ADMIN_REQ, headers: {} });

    assert.equal(updated.company_id, 43);
  } finally {
    restore();
  }
});
