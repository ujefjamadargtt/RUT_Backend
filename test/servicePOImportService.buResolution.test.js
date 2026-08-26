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
    users: [{ id: 1, is_deleted: false, role: { id: 1, role_name: 'Manager' } }],
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

function writeWorkbook(headers, dataRows) {
  const aoa = [headers, ...dataRows];
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

test('BU Admin import: every row uses the actor\'s own active BU; a stray "BU Name" column is ignored', async () => {
  stubReferenceData();
  const headers = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager', 'BU Name'];
  const filePath = writeWorkbook(headers, [
    rowToArray(headers, FULL_ROW({ 'BU Name': 'Some Other BU — should be ignored' })),
  ]);

  const createdPayloads = stubReferenceData();
  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(result.skipped, 0);
  assert.equal(createdPayloads[0].company_id, 555);

  fs.unlinkSync(filePath);
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
