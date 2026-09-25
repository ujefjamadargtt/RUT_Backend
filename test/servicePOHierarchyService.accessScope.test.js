'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression: a BU Admin on a Parent BU (PO lives in a Sub-BU) and a Project
// Manager individually mapped to a PO could open GET /service-pos/:id, but
// every hierarchy call returned "Service PO not found." because the
// hierarchy scoped to only the ONE active X-Company-Id BU. The hierarchy now
// goes through servicePOService.getAccessibleById() — same gate as GET /:id.
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const servicePOService = require('../src/services/servicePOService');
const companyAccessControlService = require('../src/services/companyAccessControlService');
const servicePOHierarchyService = require('../src/services/servicePOHierarchyService');

const ORIGINAL = {
  getAccessibleById: servicePOService.getAccessibleById,
  findByServicePO: servicePOHierarchyRepository.findByServicePO,
  create: servicePOHierarchyRepository.create,
  hierarchyFindById: servicePOHierarchyRepository.findById,
  poFindById: servicePORepository.findById,
};

function restore() {
  servicePOService.getAccessibleById = ORIGINAL.getAccessibleById;
  servicePOHierarchyRepository.findByServicePO = ORIGINAL.findByServicePO;
  servicePOHierarchyRepository.create = ORIGINAL.create;
  servicePOHierarchyRepository.findById = ORIGINAL.hierarchyFindById;
  servicePORepository.findById = ORIGINAL.poFindById;
}

const REQ = { companyId: 23, hierarchyRank: 4, employeeId: 9, employeeBusinessUnits: [{ id: 23 }, { id: 24 }], headers: {}, ip: '127.0.0.1' };

test('getTree(): resolves the PO via servicePOService.getAccessibleById with the full req (not just req.companyId)', async () => {
  let seen;
  servicePOService.getAccessibleById = async (id, req) => {
    seen = { id, req };
    return { id, company_id: 42 };
  };
  servicePOHierarchyRepository.findByServicePO = async () => [];

  try {
    const tree = await servicePOHierarchyService.getTree(152, REQ);
    assert.deepEqual(tree, []);
    assert.equal(seen.id, 152);
    assert.equal(seen.req, REQ);
  } finally {
    restore();
  }
});

test('createParent(): allowed when the PO is outside the active BU but inside the actor\'s reach', async () => {
  servicePOService.getAccessibleById = async (id) => ({ id, company_id: 42 });
  let created;
  servicePOHierarchyRepository.create = async (data) => {
    created = data;
    return { id: 1, ...data };
  };

  try {
    await servicePOHierarchyService.createParent(152, { node_name: 'Phase 1' }, 9, REQ);
    assert.equal(created.service_po_id, 152);
    assert.equal(created.node_type, 'PARENT');
  } finally {
    restore();
  }
});

test('getTree(): a PO outside the actor\'s reach still 404s', async () => {
  servicePOService.getAccessibleById = async () => {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  };

  try {
    await assert.rejects(servicePOHierarchyService.getTree(999, REQ), (err) => err.statusCode === 404);
  } finally {
    restore();
  }
});

test('rename(): a node whose PO is outside the actor\'s reach 404s as "node not found"', async () => {
  servicePOHierarchyRepository.findById = async () => ({ id: 5, service_po_id: 999, node_type: 'PARENT' });
  servicePOService.getAccessibleById = async () => {
    const err = new Error('Service PO not found.');
    err.statusCode = 404;
    throw err;
  };

  try {
    await assert.rejects(
      servicePOHierarchyService.rename(5, { node_name: 'x' }, 9, REQ),
      (err) => err.statusCode === 404 && /Hierarchy node #5/.test(err.message)
    );
  } finally {
    restore();
  }
});

test('servicePOService.getAccessibleById(): uses full reach (not the active BU) and the PM mapped-PO override', async () => {
  const originalFullReach = companyAccessControlService.resolveActorFullReach;
  let capturedArgs;
  servicePORepository.findById = async (...args) => {
    capturedArgs = args;
    return { id: 152, company_id: 42 };
  };

  try {
    // Real resolveActorFullReach expands BUs 23/24 (+ Sub-BUs) from
    // employeeBusinessUnits — the scope passed down must be an array, never
    // the plain active req.companyId (23).
    const po = await servicePOService.getAccessibleById(152, { ...REQ, employeeRoleNames: ['BU Admin'] });
    assert.equal(po.id, 152);
    assert.ok(Array.isArray(capturedArgs[1]), 'scope must be the full-reach array');
    assert.ok(capturedArgs[1].includes(23) && capturedArgs[1].includes(24));
    assert.equal(capturedArgs[4], null); // BU Admin: no mapped-PO override
  } finally {
    companyAccessControlService.resolveActorFullReach = originalFullReach;
    restore();
  }
});
