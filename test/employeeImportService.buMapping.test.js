'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const xlsx = require('xlsx');
const { Op } = require('sequelize');

const { Role, Company, sequelize } = require('../src/models');
const employeeRepository = require('../src/repositories/employeeRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const entityRepository = require('../src/repositories/entityRepository');
const employeeImportService = require('../src/services/employeeImportService');

const ORIGINAL = {
  roleFindOne: Role.findOne,
  companyFindAll: Company.findAll,
  sequelizeTransaction: sequelize.transaction,
  repoCreate: employeeRepository.create,
  findAllForImport: employeeRepository.findAllForImport,
  findAllEmails: employeeRepository.findAllEmails,
  replaceForEmployee: employeeBusinessUnitRepository.replaceForEmployee,
  autoMapCentralisedServicePOs: employeeServicePOMappingService.autoMapCentralisedServicePOs,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
};

function restore() {
  Role.findOne = ORIGINAL.roleFindOne;
  Company.findAll = ORIGINAL.companyFindAll;
  sequelize.transaction = ORIGINAL.sequelizeTransaction;
  employeeRepository.create = ORIGINAL.repoCreate;
  employeeRepository.findAllForImport = ORIGINAL.findAllForImport;
  employeeRepository.findAllEmails = ORIGINAL.findAllEmails;
  employeeBusinessUnitRepository.replaceForEmployee = ORIGINAL.replaceForEmployee;
  employeeServicePOMappingService.autoMapCentralisedServicePOs = ORIGINAL.autoMapCentralisedServicePOs;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
}

function stubCommon({ ownedCompanies = [] } = {}) {
  Role.findOne = async () => ({ id: 5, role_name: 'Employee' });
  sequelize.transaction = async (fn) => fn({});
  employeeRepository.findAllForImport = async () => [];
  employeeRepository.findAllEmails = async () => [];
  employeeServicePOMappingService.autoMapCentralisedServicePOs = async () => {};

  entityRepository.findIdsOwnedByAdmin = async () => (ownedCompanies.length ? [900] : []);
  Company.findAll = async ({ where }) => {
    if (where && where.entity_id) {
      // resolveOwnedCompanyIds()'s own internal entity -> company lookup.
      return ownedCompanies.map((c) => ({ id: c.id }));
    }
    if (where && where.id) {
      const requestedIds = where.id[Op.in];
      return ownedCompanies.filter((c) => requestedIds.includes(c.id));
    }
    return [];
  };

  const createdEmployees = [];
  employeeRepository.create = async (data) => {
    const employee = { id: createdEmployees.length + 1, ...data };
    createdEmployees.push(employee);
    return employee;
  };

  const mappingCalls = [];
  employeeBusinessUnitRepository.replaceForEmployee = async (employeeId, businessUnitIds) => {
    mappingCalls.push({ employeeId, businessUnitIds });
  };

  return { createdEmployees, mappingCalls };
}

function writeWorkbook(headers, dataRows) {
  const aoa = [headers, ...dataRows];
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Employees');
  const filePath = path.join(os.tmpdir(), `emp_import_test_${Date.now()}_${Math.random().toString(36).slice(2)}.xlsx`);
  xlsx.writeFile(wb, filePath);
  return filePath;
}

function rowToArray(headers, rowObj) {
  return headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : ''));
}

const HEADERS = ['Employee Code', 'Full Name', 'Business Units'];

function buAdminReq(companyId, employeeBusinessUnits) {
  return {
    companyId,
    hierarchyRank: 4,
    employeeId: 120,
    employeeBusinessUnits,
    headers: {},
    body: {},
  };
}

function adminReq() {
  return { companyId: undefined, hierarchyRank: 2, employeeId: 1, employeeBusinessUnits: [], headers: {}, body: {} };
}

test('TEST 1 — BU present: employee is imported and mapped to the named Business Unit', async () => {
  const { createdEmployees, mappingCalls } = stubCommon();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, { 'Employee Code': 'EMP-0076', 'Full Name': 'aa', 'Business Units': 'DATAAI44' }),
  ]);

  const req = buAdminReq(555, [{ id: 555, company_name: 'DATAAI44' }]);
  const result = await employeeImportService.importEmployees(filePath, 7, req);

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(result.skipped, 0);
  assert.equal(createdEmployees.length, 1);
  assert.equal(mappingCalls.length, 1);
  assert.deepEqual(mappingCalls[0], { employeeId: createdEmployees[0].id, businessUnitIds: [555] });

  fs.unlinkSync(filePath);
  restore();
});

test('TEST 2 — BU blank: employee is imported, no BU mapping created', async () => {
  const { createdEmployees, mappingCalls } = stubCommon();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, { 'Employee Code': 'EMP-0082', 'Full Name': 'eee', 'Business Units': '' }),
  ]);

  const req = buAdminReq(555, [{ id: 555, company_name: 'DATAAI44' }]);
  const result = await employeeImportService.importEmployees(filePath, 7, req);

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(createdEmployees.length, 1);
  assert.equal(mappingCalls.length, 0);

  fs.unlinkSync(filePath);
  restore();
});

test('TEST 3 — invalid BU: row validation error, no employee created for that row', async () => {
  const { createdEmployees, mappingCalls } = stubCommon();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, { 'Employee Code': 'EMP-0090', 'Full Name': 'zz', 'Business Units': 'INVALID_BU' }),
  ]);

  const req = buAdminReq(555, [{ id: 555, company_name: 'DATAAI44' }]);
  const result = await employeeImportService.importEmployees(filePath, 7, req);

  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.match(result.error_rows[0].errors.join(' '), /Business Unit "INVALID_BU" not found/);
  assert.equal(createdEmployees.length, 0);
  assert.equal(mappingCalls.length, 0);

  fs.unlinkSync(filePath);
  restore();
});

test('TEST 4 — Global BU must not override Excel BU: actor\'s active BU is 555, Excel names a DIFFERENT owned/mapped BU (556) and that one wins', async () => {
  const { mappingCalls } = stubCommon();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, { 'Employee Code': 'EMP-0100', 'Full Name': 'bb', 'Business Units': 'BU2' }),
  ]);

  // Active/Global BU is 555 ("DATAAI44"), but this multi-BU actor is ALSO
  // actively mapped to 556 ("BU2") — the Excel value must resolve to 556,
  // never silently forced to the Global BU (555).
  const req = buAdminReq(555, [
    { id: 555, company_name: 'DATAAI44' },
    { id: 556, company_name: 'BU2' },
  ]);
  const result = await employeeImportService.importEmployees(filePath, 7, req);

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.equal(mappingCalls.length, 1);
  assert.deepEqual(mappingCalls[0].businessUnitIds, [556]);

  fs.unlinkSync(filePath);
  restore();
});

test('TEST 5 — multiple BU names in one cell resolve to multiple mappings, deduplicated', async () => {
  const { mappingCalls } = stubCommon();
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, { 'Employee Code': 'EMP-0110', 'Full Name': 'cc', 'Business Units': 'DATAAI44, BU2, DATAAI44' }),
  ]);

  const req = buAdminReq(555, [
    { id: 555, company_name: 'DATAAI44' },
    { id: 556, company_name: 'BU2' },
  ]);
  const result = await employeeImportService.importEmployees(filePath, 7, req);

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.deepEqual(mappingCalls[0].businessUnitIds, [555, 556]);

  fs.unlinkSync(filePath);
  restore();
});

test('Company-less actor (Admin): BU Name resolves within owned Companies only, never a different tenant\'s BU', async () => {
  const { mappingCalls } = stubCommon({ ownedCompanies: [{ id: 101, company_name: 'BU 1' }] });
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, { 'Employee Code': 'EMP-0120', 'Full Name': 'dd', 'Business Units': 'BU 1' }),
  ]);

  const result = await employeeImportService.importEmployees(filePath, 7, adminReq());

  assert.equal(result.imported, 1, JSON.stringify(result.error_rows));
  assert.deepEqual(mappingCalls[0].businessUnitIds, [101]);

  fs.unlinkSync(filePath);
  restore();
});

test('Company-less actor (Admin): a BU Name not in their owned set is rejected, even if it exists elsewhere', async () => {
  stubCommon({ ownedCompanies: [{ id: 101, company_name: 'BU 1' }] });
  const filePath = writeWorkbook(HEADERS, [
    rowToArray(HEADERS, { 'Employee Code': 'EMP-0121', 'Full Name': 'ee', 'Business Units': 'Someone Elses BU' }),
  ]);

  const result = await employeeImportService.importEmployees(filePath, 7, adminReq());

  assert.equal(result.imported, 0);
  assert.match(result.error_rows[0].errors.join(' '), /not found/i);

  fs.unlinkSync(filePath);
  restore();
});
