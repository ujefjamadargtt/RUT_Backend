'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const xlsx = require('xlsx');

const { ServicePO, Client, Project, ServiceType, Employee, Company, sequelize } = require('../src/models');
const servicePORepository = require('../src/repositories/servicePORepository');
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const entityRepository = require('../src/repositories/entityRepository');
const servicePOImportService = require('../src/services/servicePOImportService');

const ORIGINAL = {
  servicePOFindAll: ServicePO.findAll,
  clientFindAll: Client.findAll,
  projectFindAll: Project.findAll,
  serviceTypeFindAll: ServiceType.findAll,
  employeeFindAll: Employee.findAll,
  companyFindAll: Company.findAll,
  sequelizeTransaction: sequelize.transaction,
  repoCreate: servicePORepository.create,
  hierarchyFindByServicePOIds: servicePOHierarchyRepository.findByServicePOIds,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
};

function restore() {
  ServicePO.findAll = ORIGINAL.servicePOFindAll;
  Client.findAll = ORIGINAL.clientFindAll;
  Project.findAll = ORIGINAL.projectFindAll;
  ServiceType.findAll = ORIGINAL.serviceTypeFindAll;
  Employee.findAll = ORIGINAL.employeeFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
  sequelize.transaction = ORIGINAL.sequelizeTransaction;
  servicePORepository.create = ORIGINAL.repoCreate;
  servicePOHierarchyRepository.findByServicePOIds = ORIGINAL.hierarchyFindByServicePOIds;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
}

// A fixed Client/Project/ServiceType/Employee reference fixture, identical
// across every companyId used in these tests — only the resolved Business
// Unit itself is what's under test here, not the pre-existing per-row
// validation (Client/Project/Service Type/Delivery Head), which is already
// covered elsewhere and deliberately left untouched by this change.
function stubReferenceData({ ownedEntityIds = [], ownedCompanies = [] } = {}) {
  ServicePO.findAll = async () => [];
  Client.findAll = async () => [{ id: 10, client_code: 'CLT-1', client_name: 'Acme Corp', status: 'active' }];
  Project.findAll = async () => [{ id: 20, project_code: 'PRJ-1', project_name: 'Website Revamp', client_id: 10, status: 'active', is_deleted: false }];
  // Service Type is a single GLOBAL master (company_id IS NULL) — asserting
  // the query here catches a regression back to the old per-company scoping
  // bug, which silently made every Service Type fail to resolve on import.
  ServiceType.findAll = async ({ where }) => {
    assert.equal(where.company_id, null, 'ServiceType.findAll must always query company_id: null (global), never a resolved Business Unit id');
    return [{
      id: 30,
      service_type_name: 'Consulting',
      serviceCategory: { id: 1, name: 'Billable Work', report_bucket_key: 'billable' },
    }];
  };
  Employee.findAll = async () => [{
    id: 40,
    full_name: 'Jane Manager',
    status: 'active',
    users: [{ id: 1, is_deleted: false, role: { id: 1, role_name: 'Team Lead' } }],
  }];

  entityRepository.findIdsOwnedByAdmin = async () => ownedEntityIds;
  Company.findAll = async ({ where }) => {
    if (where && where.entity_id) {
      // resolveOwnedCompanyIds()'s own internal lookup: entity -> owned Company ids.
      return ownedCompanies.map((c) => ({ id: c.id }));
    }
    if (where && where.id) {
      const { Op } = require('sequelize');
      const requestedIds = where.id[Op.in];
      return ownedCompanies.filter((c) => requestedIds.includes(c.id));
    }
    return [];
  };

  sequelize.transaction = async (fn) => fn({});
  servicePOHierarchyRepository.findByServicePOIds = async () => [];

  const createdPayloads = [];
  servicePORepository.create = async (payload) => {
    createdPayloads.push(payload);
    return { id: createdPayloads.length, ...payload };
  };
  return createdPayloads;
}

// "PO Number" is required for a new Service PO — derived here from each
// row's Service PO Name (rows of the same PO share one number), unless the
// test supplies its own column.
function withPoNumber(headers, dataRows) {
  if (headers.includes('PO Number')) return [headers, ...dataRows];
  const nameIdx = headers.indexOf('Service PO Name');
  const code = (row) => ('T-' + String(row[nameIdx] || 'X').toUpperCase().replace(/[^A-Z0-9]/g, '-')).slice(0, 30);
  return [['PO Number', ...headers], ...dataRows.map((row) => [code(row), ...row])];
}

function writeWorkbook(headers, dataRows) {
  const aoa = withPoNumber(headers, dataRows);
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Service POs');
  const filePath = path.join(os.tmpdir(), `spo_import_test_${Date.now()}_${Math.random().toString(36).slice(2)}.xlsx`);
  xlsx.writeFile(wb, filePath);
  return filePath;
}

const FULL_ROW = (overrides = {}) => ({
  'Service PO Name': 'Website Support PO',
  'Client Name': 'Acme Corp',
  'Project Name': 'Website Revamp',
  'Service Type': 'Consulting',
  'PO Value': 100000,
  'Start Date': '01/08/2026',
  'End Date': '31/08/2026',
  'Delivery Head Manager': 'Jane Manager',
  ...overrides,
});

function rowToArray(headers, rowObj) {
  return headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : ''));
}

function buAdminReq(companyId) {
  return { companyId, hierarchyRank: 4, employeeId: 99, headers: {}, body: {} };
}

function adminReq() {
  return { companyId: undefined, hierarchyRank: 2, employeeId: 1, headers: {}, body: {} };
}

test('BU Admin import: a blank "BU Name" uses the actor\'s own active BU', async () => {
  const createdPayloads = stubReferenceData();
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [rowToArray(headers, FULL_ROW({ 'BU Name': '' }))]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(createdPayloads[0].company_id, 555);

  fs.unlinkSync(filePath);
  restore();
});

test('BU Admin import: a "BU Name" outside the actor\'s own mapped BUs is rejected — never silently swapped for the active BU', async () => {
  const createdPayloads = stubReferenceData();
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [rowToArray(headers, FULL_ROW({ 'BU Name': 'Some Other BU' }))]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));

  assert.equal(result.imported, 0);
  assert.match(result.error_rows[0].errors[0], /BU "Some Other BU" not found/);
  assert.equal(createdPayloads.length, 0);

  fs.unlinkSync(filePath);
  restore();
});

test('Multi-BU BU Admin import: rows name two of their own mapped BUs; same-named BUs need "Entity Name"', async () => {
  const createdPayloads = stubReferenceData({
    ownedCompanies: [
      { id: 555, company_name: 'Delivery', entity: { entity_name: 'Alpha' } },
      { id: 556, company_name: 'Delivery', entity: { entity_name: 'Beta' } },
      { id: 557, company_name: 'Finance', entity: { entity_name: 'Alpha' } },
    ],
  });
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name', 'Entity Name'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW({ 'Service PO Name': 'PO Finance', 'BU Name': 'Finance' })),
    rowToArray(headers, FULL_ROW({ 'Service PO Name': 'PO Delivery Beta', 'BU Name': 'Delivery', 'Entity Name': 'Beta' })),
  ]);
  // Same shape auth.js puts on req.employeeBusinessUnits.
  const req = {
    ...buAdminReq(555),
    employeeBusinessUnits: [
      { id: 555, company_name: 'Delivery', entity: { entity_name: 'Alpha' } },
      { id: 556, company_name: 'Delivery', entity: { entity_name: 'Beta' } },
      { id: 557, company_name: 'Finance', entity: { entity_name: 'Alpha' } },
    ],
  };

  const result = await servicePOImportService.importServicePOs(filePath, 7, req);
  assert.equal(result.imported, 2, JSON.stringify(result.error_rows));
  assert.deepEqual(createdPayloads.map((p) => p.company_id).sort(), [556, 557]);
  fs.unlinkSync(filePath);
  restore();

  // Same sheet without Entity Name on the "Delivery" row -> ambiguous, nothing imported (all-or-nothing).
  const created2 = stubReferenceData({
    ownedCompanies: [
      { id: 555, company_name: 'Delivery', entity: { entity_name: 'Alpha' } },
      { id: 556, company_name: 'Delivery', entity: { entity_name: 'Beta' } },
    ],
  });
  const file2 = writeWorkbook(headers, [rowToArray(headers, FULL_ROW({ 'BU Name': 'Delivery' }))]);
  const result2 = await servicePOImportService.importServicePOs(file2, 7, {
    ...buAdminReq(555),
    employeeBusinessUnits: [
      { id: 555, company_name: 'Delivery', entity: { entity_name: 'Alpha' } },
      { id: 556, company_name: 'Delivery', entity: { entity_name: 'Beta' } },
    ],
  });
  assert.equal(result2.imported, 0);
  assert.match(result2.error_rows[0].errors[0], /more than one Entity \(Alpha, Beta\)/);
  assert.equal(created2.length, 0);
  fs.unlinkSync(file2);
  restore();
});

test('Admin import: valid "BU Name" resolves to that owned Company and the PO is created under it', async () => {
  const createdPayloads = stubReferenceData({ ownedEntityIds: [900], ownedCompanies: [{ id: 101, company_name: 'BU 1' }, { id: 102, company_name: 'BU 2' }] });
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW({ 'BU Name': 'BU 2' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, adminReq());

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(result.skipped, 0);
  assert.equal(createdPayloads[0].company_id, 102);

  fs.unlinkSync(filePath);
  restore();
});

test('Admin import: two rows naming two different owned BUs both succeed, each under its own Business Unit', async () => {
  const createdPayloads = stubReferenceData({ ownedEntityIds: [900], ownedCompanies: [{ id: 101, company_name: 'BU 1' }, { id: 102, company_name: 'BU 2' }] });
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW({ 'Service PO Name': 'PO One', 'BU Name': 'BU 1' })),
    rowToArray(headers, FULL_ROW({ 'Service PO Name': 'PO Two', 'BU Name': 'BU 2' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, adminReq());

  assert.equal(result.imported, 2, JSON.stringify(result.error_rows));
  assert.equal(result.skipped, 0);
  const companiesUsed = createdPayloads.map((p) => p.company_id).sort();
  assert.deepEqual(companiesUsed, [101, 102]);

  fs.unlinkSync(filePath);
  restore();
});

test('Admin import: missing BU Name on a row is rejected, and (all-or-nothing) nothing is inserted', async () => {
  stubReferenceData({ ownedEntityIds: [900], ownedCompanies: [{ id: 101, company_name: 'BU 1' }] });
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW({ 'BU Name': '' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, adminReq());

  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.match(result.error_rows[0].errors.join(' '), /BU Name is required/);

  fs.unlinkSync(filePath);
  restore();
});

test('Admin import: a BU Name that does not exist among the actor\'s own Companies is rejected as not found', async () => {
  stubReferenceData({ ownedEntityIds: [900], ownedCompanies: [{ id: 101, company_name: 'BU 1' }] });
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW({ 'BU Name': 'Nonexistent BU' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, adminReq());

  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.match(result.error_rows[0].errors.join(' '), /not found/i);

  fs.unlinkSync(filePath);
  restore();
});

test('Admin import: a BU Name belonging to a DIFFERENT tenant (not owned by this actor) never resolves — company security', async () => {
  // "BU 3" genuinely exists as a real Company somewhere on the platform,
  // but this Admin's own ownedCompanies fixture never includes it — proves
  // resolveRowBusinessUnits() can't accidentally resolve another tenant's
  // Business Unit just because the name string matches.
  stubReferenceData({ ownedEntityIds: [900], ownedCompanies: [{ id: 101, company_name: 'BU 1' }] });
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW({ 'BU Name': 'BU 3' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, adminReq());

  assert.equal(result.imported, 0);
  assert.match(result.error_rows[0].errors.join(' '), /not found/i);

  fs.unlinkSync(filePath);
  restore();
});

test('Admin import: sheet with no "BU Name" column at all is rejected up front (422), before any row is processed', async () => {
  stubReferenceData({ ownedEntityIds: [900], ownedCompanies: [{ id: 101, company_name: 'BU 1' }] });
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW()),
  ]);

  await assert.rejects(
    () => servicePOImportService.importServicePOs(filePath, 7, adminReq()),
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /BU Name/);
      return true;
    }
  );

  fs.unlinkSync(filePath);
  restore();
});

// ── PO Number (required, taken from the sheet) / PO Value (optional) ─────────
const PO_HEADERS = ['PO Number', 'Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date'];

test('PO Number from the sheet is used as the Service PO code (uppercased); a blank PO Value is fine', async () => {
  const createdPayloads = stubReferenceData();
  const filePath = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'abc-2026/01', 'PO Value': '' }))]);
  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));
  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(createdPayloads[0].service_po_code, 'ABC-2026/01');
  assert.equal(createdPayloads[0].po_value, undefined);
  fs.unlinkSync(filePath);
  restore();
});

test('A new Service PO without a PO Number is rejected — never auto-generated', async () => {
  const createdPayloads = stubReferenceData();
  const filePath = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': '' }))]);
  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));
  assert.equal(result.imported, 0);
  assert.match(result.error_rows[0].errors[0], /PO Number is required/);
  assert.equal(createdPayloads.length, 0);
  fs.unlinkSync(filePath);
  restore();
});

test('PO Number already used in the BU, or twice in the file, is rejected; a non-numeric PO Value still errors', async () => {
  stubReferenceData();
  ServicePO.findAll = async () => [{ id: 9, service_po_code: 'TAKEN-1', service_po_name: 'Old PO', client_id: 99, project_id: 99 }];
  const taken = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'taken-1' }))]);
  const r1 = await servicePOImportService.importServicePOs(taken, 7, buAdminReq(555));
  assert.match(r1.error_rows[0].errors[0], /PO Number "TAKEN-1" already exists in this Business Unit/);
  fs.unlinkSync(taken);
  restore();

  stubReferenceData();
  const dup = writeWorkbook(PO_HEADERS, [
    rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'SAME-1', 'Service PO Name': 'PO A' })),
    rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'SAME-1', 'Service PO Name': 'PO B' })),
  ]);
  const r2 = await servicePOImportService.importServicePOs(dup, 7, buAdminReq(555));
  assert.equal(r2.imported, 0);
  assert.match(r2.error_rows[0].errors[0], /used for two different Service POs in this file/);
  fs.unlinkSync(dup);
  restore();

  stubReferenceData();
  const badValue = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'VAL-1', 'PO Value': 'abc' }))]);
  const r3 = await servicePOImportService.importServicePOs(badValue, 7, buAdminReq(555));
  assert.match(r3.error_rows[0].errors.join(' '), /PO value "abc" is not a valid number/);
  fs.unlinkSync(badValue);
  restore();
});

// ── Importer auto-mapping (parity with a panel create) ───────────────────────
test('Project Manager / BU Admin importer is auto-mapped to each NEW Service PO; Admin is not', async () => {
  const mappingRepo = require('../src/repositories/employeeServicePOMappingRepository');
  const originalBulkCreate = mappingRepo.bulkCreate;
  const run = async (userRoles) => {
    const createdPayloads = stubReferenceData();
    const mapped = [];
    mappingRepo.bulkCreate = async (records) => { mapped.push(...records); return records; };
    const filePath = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'MAP-1' }))]);
    try {
      const result = await servicePOImportService.importServicePOs(filePath, 268, { ...buAdminReq(555), employeeId: 268, userRoles });
      assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
      return { mapped, createdPayloads };
    } finally {
      fs.unlinkSync(filePath);
      mappingRepo.bulkCreate = originalBulkCreate;
      restore();
    }
  };

  const pm = await run(['Project Manager']);
  assert.equal(pm.mapped.length, 1);
  assert.deepEqual(
    { employee_id: pm.mapped[0].employee_id, service_po_id: pm.mapped[0].service_po_id, company_id: pm.mapped[0].company_id, status: pm.mapped[0].status },
    { employee_id: 268, service_po_id: 1, company_id: 555, status: 'active' }
  );
  assert.equal((await run(['BU Admin'])).mapped.length, 1);
  assert.equal((await run(['Admin'])).mapped.length, 0);
  assert.equal((await run([])).mapped.length, 0);
});

test('Importer is NOT mapped when the row only reuses an existing Service PO (same as panel: create only)', async () => {
  const mappingRepo = require('../src/repositories/employeeServicePOMappingRepository');
  const originalBulkCreate = mappingRepo.bulkCreate;
  stubReferenceData();
  ServicePO.findAll = async () => [{ id: 9, service_po_code: 'EXIST-1', service_po_name: 'Website Support PO', client_id: 10, project_id: 20 }];
  const mapped = [];
  mappingRepo.bulkCreate = async (records) => { mapped.push(...records); return records; };
  const filePath = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'EXIST-1' }))]);
  try {
    await servicePOImportService.importServicePOs(filePath, 268, { ...buAdminReq(555), employeeId: 268, userRoles: ['Project Manager'] });
    assert.equal(mapped.length, 0);
  } finally {
    fs.unlinkSync(filePath);
    mappingRepo.bulkCreate = originalBulkCreate;
    restore();
  }
});

// ── Continuation rows (Module/Task only, PO Number + Name left blank) ─────────
test('A hierarchy-only row with blank PO Number / Name / BU (even just spaces) belongs to the PO row above', async () => {
  const createdPayloads = stubReferenceData();
  const created = [];
  const originalCreate = servicePOHierarchyRepository.create;
  servicePOHierarchyRepository.create = async (data) => { created.push(data); return { id: created.length + 100, ...data }; };
  const headers = ['PO Number', 'Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'Start Date', 'End Date', 'BU Name', 'Sub BU', 'Hierarchy Parent', 'Hierarchy Child'];
  const filePath = writeWorkbook(headers, [
    ['PO-FD-1', 'Fill Down PO', 'Acme Corp', 'Website Revamp', 'Consulting', '01/08/2026', '31/08/2026', '', ' ', 'Development', 'Frontend'],
    [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', 'Development', 'Backend'],
    ['', '', '', '', '', '', '', '', '', 'Testing', ''],
  ]);
  try {
    const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));
    assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
    assert.equal(createdPayloads.length, 1);
    const names = created.map((n) => `${n.node_type}:${n.node_name}`).sort();
    assert.deepEqual(names, ['CHILD:Backend', 'CHILD:Frontend', 'PARENT:Development', 'PARENT:Testing']);
  } finally {
    fs.unlinkSync(filePath);
    servicePOHierarchyRepository.create = originalCreate;
    restore();
  }
});

// ── Multi-BU BU Admin: blank "BU Name" never falls back to the Global BU ──────
test('Multi-BU BU Admin: a blank "BU Name" is a row error (no Global BU default); single-BU still defaults', async () => {
  const multiReq = {
    ...buAdminReq(555),
    employeeBusinessUnits: [
      { id: 555, company_name: 'Delivery', entity: { entity_name: 'Alpha' } },
      { id: 557, company_name: 'Finance', entity: { entity_name: 'Alpha' } },
    ],
  };
  const created = stubReferenceData();
  const file = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'MB-1' }))]);
  const r = await servicePOImportService.importServicePOs(file, 7, multiReq);
  assert.equal(r.imported, 0);
  assert.match(r.error_rows[0].errors[0], /BU Name is required — you are mapped to more than one Business Unit \(Delivery, Finance\)/);
  assert.equal(created.length, 0);
  fs.unlinkSync(file);
  restore();

  const created2 = stubReferenceData();
  const file2 = writeWorkbook(PO_HEADERS, [rowToArray(PO_HEADERS, FULL_ROW({ 'PO Number': 'SB-1' }))]);
  const r2 = await servicePOImportService.importServicePOs(file2, 7, { ...buAdminReq(555), employeeBusinessUnits: [{ id: 555, company_name: 'Delivery' }] });
  assert.equal(r2.imported, 1, JSON.stringify(r2.error_rows));
  assert.equal(created2[0].company_id, 555);
  fs.unlinkSync(file2);
  restore();
});
