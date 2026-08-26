'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const xlsx = require('xlsx');

// Same monkey-patch style as test/servicePOImportService.buResolution.test.js —
// servicePOImportService.js calls these models/repositories directly, never
// destructured at call time, so patching the shared object/class is enough.
const { ServicePO, Client, Project, ServiceType, Employee, sequelize } = require('../src/models');
const servicePORepository = require('../src/repositories/servicePORepository');
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const servicePOImportService = require('../src/services/servicePOImportService');

const ORIGINAL = {
  servicePOFindAll: ServicePO.findAll,
  clientFindAll: Client.findAll,
  projectFindAll: Project.findAll,
  serviceTypeFindAll: ServiceType.findAll,
  employeeFindAll: Employee.findAll,
  sequelizeTransaction: sequelize.transaction,
  repoCreate: servicePORepository.create,
  hierarchyFindByServicePOIds: servicePOHierarchyRepository.findByServicePOIds,
};

function restore() {
  ServicePO.findAll = ORIGINAL.servicePOFindAll;
  Client.findAll = ORIGINAL.clientFindAll;
  Project.findAll = ORIGINAL.projectFindAll;
  ServiceType.findAll = ORIGINAL.serviceTypeFindAll;
  Employee.findAll = ORIGINAL.employeeFindAll;
  sequelize.transaction = ORIGINAL.sequelizeTransaction;
  servicePORepository.create = ORIGINAL.repoCreate;
  servicePOHierarchyRepository.findByServicePOIds = ORIGINAL.hierarchyFindByServicePOIds;
}

function stubReferenceData() {
  ServicePO.findAll = async () => [];
  Client.findAll = async () => [{ id: 10, client_code: 'CLT-1', client_name: 'Acme Corp', status: 'active' }];
  Project.findAll = async () => [{ id: 20, project_code: 'PRJ-1', project_name: 'Website Revamp', client_id: 10, status: 'active', is_deleted: false }];
  // Service Type is a single GLOBAL master (company_id IS NULL) — see
  // servicePOImportService.buResolution.test.js's identical assertion.
  ServiceType.findAll = async ({ where }) => {
    assert.equal(where.company_id, null);
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
  const filePath = path.join(os.tmpdir(), `spo_import_dh_test_${Date.now()}_${Math.random().toString(36).slice(2)}.xlsx`);
  xlsx.writeFile(wb, filePath);
  return filePath;
}

const HEADERS = ['Service PO Name', 'Client Name', 'Project Name', 'Service Type', 'PO Value', 'Start Date', 'End Date', 'Delivery Head Manager'];

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

test('import: a row with NO Delivery Head Manager succeeds — the field is optional, matching single-create', async () => {
  const createdPayloads = stubReferenceData();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, FULL_ROW({ 'Delivery Head Manager': '' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(result.skipped, 0);
  assert.equal(createdPayloads[0].delivery_head_employee_id, undefined);

  fs.unlinkSync(filePath);
  restore();
});

test('import: a row that DOES supply a Delivery Head Manager still resolves and assigns it', async () => {
  const createdPayloads = stubReferenceData();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, FULL_ROW({ 'Delivery Head Manager': 'Jane Manager' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(createdPayloads[0].delivery_head_employee_id, 40);

  fs.unlinkSync(filePath);
  restore();
});

test('import: a row that supplies a NONEXISTENT Delivery Head Manager still succeeds — best-effort, never fails the row, PO simply gets no Delivery Head', async () => {
  const createdPayloads = stubReferenceData();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, FULL_ROW({ 'Delivery Head Manager': 'Nobody Real' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(result.skipped, 0);
  assert.equal(createdPayloads[0].delivery_head_employee_id, undefined);

  fs.unlinkSync(filePath);
  restore();
});

test('import: a row supplying a Delivery Head Manager with a disallowed role still succeeds — the role gate silently omits the assignment instead of failing the row', async () => {
  const createdPayloads = stubReferenceData();
  Employee.findAll = async () => [{
    id: 41,
    full_name: 'Sam Employee',
    status: 'active',
    users: [{ id: 2, is_deleted: false, role: { id: 2, role_name: 'Employee' } }],
  }];
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, FULL_ROW({ 'Delivery Head Manager': 'Sam Employee' })),
  ]);

  const result = await servicePOImportService.importServicePOs(filePath, 7, buAdminReq(555));

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(result.skipped, 0);
  assert.equal(createdPayloads[0].delivery_head_employee_id, undefined);

  fs.unlinkSync(filePath);
  restore();
});
