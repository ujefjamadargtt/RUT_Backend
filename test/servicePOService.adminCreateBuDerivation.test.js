'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression: an Admin (company-less, rank 2) creating a normal Service PO
// for their own Client/Project with no company_id in the body got
// "company_id (Business Unit) is required to create a Service PO." —
// servicePOService.create()'s documented X-Company-Id fallback was never
// implemented, and the Client/Project BU was only derived for BU-scoped
// actors. Now: body company_id -> Client BU -> Project BU -> Global BU
// selector (X-Company-Id) / only owned BU, always validated as one of the
// Admin's OWN Business Units.

const { Company } = require('../src/models');
const entityRepository = require('../src/repositories/entityRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const clientRepository = require('../src/repositories/clientRepository');
const projectRepository = require('../src/repositories/projectRepository');
const aiInsightService = require('../src/services/aiInsight.service');
const servicePOService = require('../src/services/servicePOService');

const ORIGINAL = {
  companyFindAll: Company.findAll,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
  findByCode: servicePORepository.findByCode,
  findByName: servicePORepository.findByName,
  create: servicePORepository.create,
  clientFindByIdUnscoped: clientRepository.findByIdUnscoped,
  projectFindByIdUnscoped: projectRepository.findByIdUnscoped,
  runJob: aiInsightService.runJob,
};

function restore() {
  Company.findAll = ORIGINAL.companyFindAll;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
  servicePORepository.findByCode = ORIGINAL.findByCode;
  servicePORepository.findByName = ORIGINAL.findByName;
  servicePORepository.create = ORIGINAL.create;
  clientRepository.findByIdUnscoped = ORIGINAL.clientFindByIdUnscoped;
  projectRepository.findByIdUnscoped = ORIGINAL.projectFindByIdUnscoped;
  aiInsightService.runJob = ORIGINAL.runJob;
}

// Admin 3 owns BUs 10 and 11 (one Entity).
function stubAdmin({ clientBu = null, projectBu = null, ownedBUs = [10, 11] } = {}) {
  entityRepository.findIdsOwnedByAdmin = async () => [1];
  Company.findAll = async () => ownedBUs.map((id) => ({ id }));
  clientRepository.findByIdUnscoped = async () => ({ id: 37, status: 'active', company_id: clientBu });
  projectRepository.findByIdUnscoped = async () => ({ id: 88, status: 'active', client_id: 37, company_id: projectBu });
  servicePORepository.findByCode = async () => null;
  servicePORepository.findByName = async () => null;
  aiInsightService.runJob = async () => {};
  let captured;
  servicePORepository.create = async (payload) => {
    captured = payload;
    return { id: 900, ...payload };
  };
  return () => captured;
}

function adminReq(headers = {}) {
  return { companyId: undefined, hierarchyRank: 2, employeeId: 3, headers, ip: '127.0.0.1' };
}

// The exact payload from the bug report (no company_id).
function payload(overrides = {}) {
  return {
    service_po_name: 'IKOoffff',
    service_po_code: '777555',
    client_id: 37,
    project_id: 88,
    service_type_id: 13,
    start_date: '2026-09-01',
    end_date: '2026-09-08',
    status: 'in-progress',
    is_centralised: false,
    is_billable: true,
    ...overrides,
  };
}

test('Admin, BU-less Client/Project, Global BU selected (X-Company-Id: 11) -> PO created in BU 11', async () => {
  const captured = stubAdmin();
  try {
    await servicePOService.create(payload(), 3, adminReq({ 'x-company-id': '11' }));
    assert.equal(captured().company_id, 11);
  } finally {
    restore();
  }
});

test('Admin owning exactly ONE BU, BU-less Client/Project, no header -> that BU is used automatically', async () => {
  const captured = stubAdmin({ ownedBUs: [10] });
  try {
    await servicePOService.create(payload(), 3, adminReq());
    assert.equal(captured().company_id, 10);
  } finally {
    restore();
  }
});

test('Admin, Client in BU 10 -> PO follows the Client\'s BU (no header needed)', async () => {
  const captured = stubAdmin({ clientBu: 10, projectBu: 10 });
  try {
    await servicePOService.create(payload(), 3, adminReq({ 'x-company-id': '11' }));
    assert.equal(captured().company_id, 10);
  } finally {
    restore();
  }
});

test('Admin, BU-less Client but Project in BU 11 -> PO follows the Project\'s BU', async () => {
  const captured = stubAdmin({ projectBu: 11 });
  try {
    await servicePOService.create(payload(), 3, adminReq());
    assert.equal(captured().company_id, 11);
  } finally {
    restore();
  }
});

test('Admin, explicit body company_id still wins', async () => {
  const captured = stubAdmin({ clientBu: 10 });
  try {
    await servicePOService.create(payload({ company_id: 11 }), 3, adminReq());
    assert.equal(captured().company_id, 11);
  } finally {
    restore();
  }
});

test('Admin, Global BU header naming ANOTHER tenant\'s BU -> 403, never created', async () => {
  const captured = stubAdmin();
  try {
    await assert.rejects(
      () => servicePOService.create(payload(), 3, adminReq({ 'x-company-id': '99' })),
      (err) => err.statusCode === 403
    );
    assert.equal(captured(), undefined);
  } finally {
    restore();
  }
});

test('Admin, Client stamped with ANOTHER tenant\'s BU -> 403 (derived BU is still ownership-checked)', async () => {
  const captured = stubAdmin({ clientBu: 99 });
  try {
    await assert.rejects(
      () => servicePOService.create(payload(), 3, adminReq()),
      (err) => err.statusCode === 403
    );
    assert.equal(captured(), undefined);
  } finally {
    restore();
  }
});

test('Admin, Centralised PO with no company_id stays BU-less (unchanged)', async () => {
  const captured = stubAdmin();
  const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
  const originalAutoMap = employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO;
  employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO = async () => {};
  try {
    await servicePOService.create(payload({ is_centralised: true, end_date: undefined }), 3, adminReq({ 'x-company-id': '11' }));
    assert.equal(captured().company_id, null);
  } finally {
    employeeServicePOMappingService.autoMapExistingEmployeesToCentralisedServicePO = originalAutoMap;
    restore();
  }
});
