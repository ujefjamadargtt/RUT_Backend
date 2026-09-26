'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { Op } = require('sequelize');

// BU Hierarchy / Sub-BU support for the Excel imports: when a row's Business
// Unit has Sub-BUs the "Sub BU" column is mandatory (and the record lands on
// that Sub-BU); when it has none, the column must stay blank.

const {
  resolveRowSubBusinessUnit,
  resolveOwnedBusinessUnitByName,
} = require('../src/services/importSubBusinessUnitService');
const { Company, Client, Project } = require('../src/models');
const entityRepository = require('../src/repositories/entityRepository');
const clientImportService = require('../src/services/clientImportService');
const projectImportService = require('../src/services/projectImportService');

const DATA_AI = { id: 23, company_name: 'DATA + AI' };
const UV = { id: 41, company_name: 'SG&A-UVTECH' };
const CHILDREN = new Map([[23, [{ id: 42, company_name: 'DASS' }, { id: 43, company_name: 'IBM' }]]]);

// ── Pure rule ────────────────────────────────────────────────────────────────

test('BU with Sub-BUs: "Sub BU" is mandatory', () => {
  const r = resolveRowSubBusinessUnit(DATA_AI, '', CHILDREN);
  assert.equal(r.companyId, null);
  assert.match(r.error, /has Sub-BUs — "Sub BU" is required \(one of: DASS, IBM\)/);
});

test('BU with Sub-BUs: a valid Sub BU (case-insensitive) targets that Sub-BU', () => {
  assert.deepEqual(resolveRowSubBusinessUnit(DATA_AI, ' ibm ', CHILDREN), { companyId: 43, error: null });
});

test('BU with Sub-BUs: an unknown Sub BU is rejected, listing the valid ones', () => {
  assert.match(resolveRowSubBusinessUnit(DATA_AI, 'XYZ', CHILDREN).error, /Sub BU "XYZ" not found under Business Unit "DATA \+ AI" \(valid: DASS, IBM\)/);
});

test('BU with Sub-BUs: two Sub-BUs sharing a name are reported, never guessed', () => {
  const dup = new Map([[27, [{ id: 51, company_name: 'DAS' }, { id: 54, company_name: 'DAS' }]]]);
  assert.match(resolveRowSubBusinessUnit({ id: 27, company_name: 'DATA + AI' }, 'DAS', dup).error, /matches more than one Sub-BU/);
});

test('BU without Sub-BUs: blank "Sub BU" targets the BU itself; a filled one is an error', () => {
  assert.deepEqual(resolveRowSubBusinessUnit(UV, '', CHILDREN), { companyId: 41, error: null });
  assert.match(resolveRowSubBusinessUnit(UV, 'DASS', CHILDREN).error, /has no Sub-BUs — leave "Sub BU" blank/);
});

test('No BU at all (BU-less row): blank is fine, a filled "Sub BU" is an error', () => {
  assert.deepEqual(resolveRowSubBusinessUnit(null, '', CHILDREN), { companyId: null, error: null });
  assert.match(resolveRowSubBusinessUnit(null, 'DASS', CHILDREN).error, /needs a Business Unit/);
});

test('BU Name shared by two Entities is ambiguous unless "Entity Name" narrows it', () => {
  const byName = new Map([['data + ai', [
    { id: 23, company_name: 'DATA + AI', entity_name: 'Alpharithm' },
    { id: 27, company_name: 'DATA + AI', entity_name: 'CRG' },
  ]]]);
  assert.match(resolveOwnedBusinessUnitByName('DATA + AI', '', byName).error, /more than one Entity \(Alpharithm, CRG\)/);
  assert.equal(resolveOwnedBusinessUnitByName('data + ai', 'crg', byName).businessUnit.id, 27);
  assert.match(resolveOwnedBusinessUnitByName('DATA + AI', 'Nope', byName).error, /not found under Entity "Nope"/);
});

test('BU Name / Entity Name swapped in the sheet → the error says so (real case from a user upload)', () => {
  const byName = new Map([['data + ai', [{ id: 23, company_name: 'DATA + AI', entity_name: 'Alpharithm' }]]]);
  assert.match(
    resolveOwnedBusinessUnitByName('Alpharithm', 'DATA + AI', byName).error,
    /look swapped — put "DATA \+ AI" in BU Name and "Alpharithm" in Entity Name/
  );
  assert.match(resolveOwnedBusinessUnitByName('Alpharithm', '', byName).error, /"Alpharithm" is an Entity/);
});

// ── Client / Project import wiring (models stubbed) ──────────────────────────

const ORIGINAL = {
  companyFindAll: Company.findAll,
  clientFindAll: Client.findAll,
  clientCreate: Client.create,
  projectFindAll: Project.findAll,
  projectCreate: Project.create,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
};

function restore() {
  Company.findAll = ORIGINAL.companyFindAll;
  Client.findAll = ORIGINAL.clientFindAll;
  Client.create = ORIGINAL.clientCreate;
  Project.findAll = ORIGINAL.projectFindAll;
  Project.create = ORIGINAL.projectCreate;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
}

// Admin 3 owns BUs 23 (DATA + AI → DASS 42, IBM 43) and 41 (no Sub-BUs).
const COMPANIES = [
  { id: 23, company_name: 'DATA + AI', entity_id: 3, parent_business_unit_id: null, entity: { entity_name: 'Alpharithm' } },
  { id: 41, company_name: 'SG&A-UVTECH', entity_id: 5, parent_business_unit_id: null, entity: { entity_name: 'UV Tech' } },
  { id: 42, company_name: 'DASS', entity_id: 3, parent_business_unit_id: 23, entity: { entity_name: 'Alpharithm' } },
  { id: 43, company_name: 'IBM', entity_id: 3, parent_business_unit_id: 23, entity: { entity_name: 'Alpharithm' } },
];

function inList(cond, value) {
  if (cond == null) return true;
  if (typeof cond === 'object' && Op.in in cond) return cond[Op.in].includes(value);
  if (Array.isArray(cond)) return cond.includes(value);
  return cond === value;
}

function stubCompanies() {
  entityRepository.findIdsOwnedByAdmin = async () => [3, 5];
  Company.findAll = async ({ where = {} }) => COMPANIES.filter((c) => (
    inList(where.id, c.id) && inList(where.entity_id, c.entity_id) && inList(where.parent_business_unit_id, c.parent_business_unit_id)
  ));
}

function writeWorkbook(headers, rows) {
  const ws = xlsx.utils.aoa_to_sheet([headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const file = path.join(os.tmpdir(), `subbu_${Date.now()}_${Math.random().toString(36).slice(2)}.xlsx`);
  xlsx.writeFile(wb, file);
  return file;
}

const ADMIN_REQ = (body = {}) => ({ companyId: undefined, hierarchyRank: 2, employeeId: 3, employeeBusinessUnits: [], headers: {}, body });
const BU_ADMIN_REQ = (companyId) => ({ companyId, hierarchyRank: 4, employeeId: 340, employeeBusinessUnits: [{ id: companyId }], headers: {}, body: {} });

test('Client import (Admin, per-row BU Name + Sub BU): Sub-BU target, missing Sub BU rejected, no-Sub-BU BU and BU-less rows work', async () => {
  stubCompanies();
  Client.findAll = async () => [];
  const created = [];
  Client.create = async (data) => { created.push(data); return data; };
  const file = writeWorkbook(['Client Name', 'BU Name', 'Sub BU'], [
    { 'Client Name': 'Acme DASS', 'BU Name': 'DATA + AI', 'Sub BU': 'DASS' },
    { 'Client Name': 'Acme NoSub', 'BU Name': 'DATA + AI' },
    { 'Client Name': 'Acme UV', 'BU Name': 'SG&A-UVTECH' },
    { 'Client Name': 'Acme BU-less' },
  ]);
  try {
    const result = await clientImportService.importClients(file, 3, ADMIN_REQ());
    assert.deepEqual(created.map((c) => [c.client_name, c.company_id]), [['Acme DASS', 42], ['Acme UV', 41], ['Acme BU-less', null]]);
    assert.equal(result.error_rows.length, 1);
    assert.match(result.error_rows[0].errors[0], /"Sub BU" is required/);
  } finally {
    fs.unlinkSync(file);
    restore();
  }
});

test('Client import (BU Admin, active BU with Sub-BUs): blank BU Name uses the active BU + mandatory Sub BU; an unmapped BU Name is rejected', async () => {
  stubCompanies();
  Client.findAll = async () => [];
  const created = [];
  Client.create = async (data) => { created.push(data); return data; };
  const file = writeWorkbook(['Client Name', 'BU Name', 'Sub BU'], [
    { 'Client Name': 'Beta IBM', 'Sub BU': 'IBM' },
    { 'Client Name': 'Beta NoSub' },
    { 'Client Name': 'Beta Other', 'BU Name': 'SG&A-UVTECH' },
  ]);
  try {
    const result = await clientImportService.importClients(file, 340, BU_ADMIN_REQ(23));
    assert.deepEqual(created.map((c) => [c.client_name, c.company_id]), [['Beta IBM', 43]]);
    assert.match(result.error_rows[0].errors[0], /"Sub BU" is required/);
    assert.match(result.error_rows[1].errors[0], /BU "SG&A-UVTECH" not found/);
  } finally {
    fs.unlinkSync(file);
    restore();
  }
});

test('Client import (multi-BU BU Admin): one sheet targets several of their own BUs; a Sub-BU can be named directly as BU Name', async () => {
  stubCompanies();
  Client.findAll = async () => [];
  const created = [];
  Client.create = async (data) => { created.push(data); return data; };
  const file = writeWorkbook(['Client Name', 'BU Name', 'Sub BU'], [
    { 'Client Name': 'Gamma DASS', 'BU Name': 'DATA + AI', 'Sub BU': 'DASS' },
    { 'Client Name': 'Gamma UV', 'BU Name': 'SG&A-UVTECH' },
    { 'Client Name': 'Gamma IBM direct', 'BU Name': 'IBM' },
  ]);
  const req = { ...BU_ADMIN_REQ(23), employeeBusinessUnits: [
    { id: 23, company_name: 'DATA + AI', entity: { entity_name: 'Alpharithm' } },
    { id: 41, company_name: 'SG&A-UVTECH', entity: { entity_name: 'UV Tech' } },
  ] };
  try {
    const result = await clientImportService.importClients(file, 340, req);
    assert.deepEqual(created.map((c) => [c.client_name, c.company_id]), [['Gamma DASS', 42], ['Gamma UV', 41], ['Gamma IBM direct', 43]]);
    assert.equal(result.error_rows.length, 0);
  } finally {
    fs.unlinkSync(file);
    restore();
  }
});

test('Project import (Admin): row with no BU Name follows its Client\'s BU (+ Sub BU rule); BU Name + Sub BU targets the Sub-BU', async () => {
  stubCompanies();
  const CLIENTS = [
    { id: 1, client_name: 'Acme UV', client_code: 'C-UV', company_id: 41, status: 'active' },
    { id: 2, client_name: 'Acme DASS', client_code: 'C-DASS', company_id: 42, status: 'active' },
  ];
  Client.findAll = async ({ where }) => CLIENTS.filter((c) => (where.client_code ? c.client_code === where.client_code : c.client_name.toLowerCase() === String(where.client_name[Op.iLike]).toLowerCase()));
  Project.findAll = async () => [];
  const created = [];
  Project.create = async (data) => { created.push(data); return data; };
  const file = writeWorkbook(['Project Name', 'Client Name', 'BU Name', 'Sub BU'], [
    { 'Project Name': 'P UV', 'Client Name': 'Acme UV' },
    { 'Project Name': 'P DASS', 'Client Name': 'Acme DASS', 'BU Name': 'DATA + AI', 'Sub BU': 'DASS' },
    { 'Project Name': 'P NoSub', 'Client Name': 'Acme DASS', 'BU Name': 'DATA + AI' },
  ]);
  try {
    const result = await projectImportService.importProjects(file, 3, ADMIN_REQ());
    assert.deepEqual(created.map((p) => [p.project_name, p.company_id]), [['P UV', 41], ['P DASS', 42]]);
    assert.equal(result.error_rows.length, 1);
    assert.match(result.error_rows[0].errors[0], /"Sub BU" is required/);
  } finally {
    fs.unlinkSync(file);
    restore();
  }
});

test('Client import (multi-BU BU Admin): blank BU Name is a row error, never the active / Global BU', async () => {
  stubCompanies();
  Client.findAll = async () => [];
  const created = [];
  Client.create = async (data) => { created.push(data); return data; };
  const file = writeWorkbook(['Client Name', 'BU Name', 'Sub BU'], [
    { 'Client Name': 'Delta Blank', 'Sub BU': 'DASS' },
    { 'Client Name': 'Delta UV', 'BU Name': 'SG&A-UVTECH' },
  ]);
  const req = { ...BU_ADMIN_REQ(23), employeeBusinessUnits: [
    { id: 23, company_name: 'DATA + AI', entity: { entity_name: 'Alpharithm' } },
    { id: 41, company_name: 'SG&A-UVTECH', entity: { entity_name: 'UV Tech' } },
  ] };
  try {
    const result = await clientImportService.importClients(file, 340, req);
    assert.deepEqual(created.map((c) => [c.client_name, c.company_id]), [['Delta UV', 41]]);
    assert.match(result.error_rows[0].errors[0], /BU Name is required — you are mapped to more than one Business Unit \(DATA \+ AI, SG&A-UVTECH\)/);
  } finally {
    fs.unlinkSync(file);
    restore();
  }
});
