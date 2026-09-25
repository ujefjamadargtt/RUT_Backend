'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

// Regression: a second Admin could see Centralised Service POs created/
// configured by a different Admin. Commit cce09f7 OR'd an unconditional
// `{ is_centralised: true }` into every Service PO read (PO Master list,
// dropdown, mapping screens) and auto-mapped Centralised POs to every
// Employee platform-wide. A Centralised PO is now visible only inside its
// own Admin tenant (companyAccessControlService.
// resolveCentralisedServicePOTenant() + servicePORepository.
// centralisedTenantScope()).
//
// These tests run the REAL resolver/repository/service code against an
// in-memory two-Admin dataset (only the Sequelize model calls are stubbed),
// so they assert which POs each actor actually ends up seeing.

const { ServicePO, Company, Entity } = require('../src/models');
const entityRepository = require('../src/repositories/entityRepository');
const employeeRoleRepository = require('../src/repositories/employeeRoleRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const servicePOService = require('../src/services/servicePOService');
const { resolveCentralisedServicePOTenant } = require('../src/services/companyAccessControlService');
const { buLessServicePOInTenantSql } = require('../src/utils/servicePOTenantSql');

// ── Minimal Sequelize-where evaluator (Op.or / Op.and / Op.in / equality) ──
function matches(row, where) {
  if (!where) return true;
  for (const sym of Object.getOwnPropertySymbols(where)) {
    if (sym === Op.or && !where[sym].some((w) => matches(row, w))) return false;
    if (sym === Op.and && !where[sym].every((w) => matches(row, w))) return false;
  }
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond !== null && typeof cond === 'object') {
      if (Op.in in cond && !cond[Op.in].includes(value)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

// ── Fixture: Admin A (100) and Admin B (200), two separate tenants ─────────
// Admin A -> Entity 1 -> BUs 10, 11.  Admin B -> Entity 2 -> BU 20.
let entities;
let companies;
function resetTenants() {
  entities = [
    { id: 1, created_by: 100, entity_admin_employee_id: null, is_deleted: false },
    { id: 2, created_by: 200, entity_admin_employee_id: null, is_deleted: false },
  ];
  companies = [
    { id: 10, entity_id: 1, is_deleted: false },
    { id: 11, entity_id: 1, is_deleted: false },
    { id: 20, entity_id: 2, is_deleted: false },
  ];
}

const PO = (id, fields) => ({ id, is_deleted: false, status: 'in-progress', service_po_name: `PO ${id}`, ...fields });
const SERVICE_POS = [
  PO(1, { is_centralised: true, company_id: null, created_by: 100 }), // Admin A, BU-less
  PO(2, { is_centralised: true, company_id: 10, created_by: 100 }),   // Admin A, BU 10
  PO(3, { is_centralised: true, company_id: 11, created_by: 150 }),   // Admin A tenant, BU 11 (by a BU Admin)
  PO(4, { is_centralised: true, company_id: null, created_by: 200 }), // Admin B, BU-less
  PO(5, { is_centralised: true, company_id: 20, created_by: 200 }),   // Admin B, BU 20
  PO(6, { is_centralised: false, company_id: 10, created_by: 100 }),  // normal, Admin A
  PO(7, { is_centralised: false, company_id: 20, created_by: 200 }),  // normal, Admin B
];

const ORIGINAL = {
  companyFindAll: Company.findAll,
  entityFindAll: Entity.findAll,
  poFindAndCountAll: ServicePO.findAndCountAll,
  poFindAll: ServicePO.findAll,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
  findRolesByEmployeeId: employeeRoleRepository.findRolesByEmployeeId,
};

function install() {
  resetTenants();
  Company.findAll = async ({ where }) => companies.filter((c) => matches(c, where));
  Entity.findAll = async ({ where }) => entities.filter((e) => matches(e, where));
  entityRepository.findIdsOwnedByAdmin = async (adminId) => entities.filter((e) => e.created_by === adminId && !e.is_deleted).map((e) => e.id);
  employeeRoleRepository.findRolesByEmployeeId = async () => [{ role_name: 'Admin' }];
  ServicePO.findAndCountAll = async ({ where }) => {
    const rows = SERVICE_POS.filter((po) => matches(po, where));
    return { rows, count: rows.length };
  };
  ServicePO.findAll = async ({ where }) => SERVICE_POS.filter((po) => matches(po, where));
}

function restore() {
  Company.findAll = ORIGINAL.companyFindAll;
  Entity.findAll = ORIGINAL.entityFindAll;
  ServicePO.findAndCountAll = ORIGINAL.poFindAndCountAll;
  ServicePO.findAll = ORIGINAL.poFindAll;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
  employeeRoleRepository.findRolesByEmployeeId = ORIGINAL.findRolesByEmployeeId;
}

// authContext as servicePOController.buildAuthContext builds it — companyId
// is req.companyIds (resolveReportCompanyScope's array).
const ADMIN_A = { companyId: [10, 11], hierarchyRank: 2, employeeId: 100, roleNames: ['Admin'] };
const ADMIN_B = { companyId: [20], hierarchyRank: 2, employeeId: 200, roleNames: ['Admin'] };
const BU_ADMIN_A11 = { companyId: [11], hierarchyRank: 4, employeeId: 150, roleNames: ['BU Admin'] };
const PLATFORM_ADMIN = { companyId: [10, 11, 20], hierarchyRank: 1, employeeId: 1, roleNames: ['Platform Admin'] };

async function listIds(authContext) {
  const { data } = await servicePOService.getAll({ status: 'all' }, authContext, null);
  return data.map((po) => po.id).sort((a, b) => a - b);
}
async function dropdownIds(authContext) {
  const pos = await servicePOService.getActivePOs(authContext);
  return pos.map((po) => po.id).sort((a, b) => a - b);
}
const centralisedOnly = (ids) => ids.filter((id) => SERVICE_POS.find((po) => po.id === id).is_centralised);

test('TEST 1: Admin B never sees Admin A\'s Centralised POs (PO Master list + active dropdown)', async () => {
  install();
  try {
    assert.deepEqual(centralisedOnly(await listIds(ADMIN_B)), [4, 5]);
    assert.deepEqual(centralisedOnly(await dropdownIds(ADMIN_B)), [4, 5]);
  } finally {
    restore();
  }
});

test('TEST 2: Admin A never sees Admin B\'s Centralised POs, and still sees all of their own', async () => {
  install();
  try {
    assert.deepEqual(centralisedOnly(await listIds(ADMIN_A)), [1, 2, 3]);
    assert.deepEqual(centralisedOnly(await dropdownIds(ADMIN_A)), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('TEST 3: actors sharing the same Admin tenant (Admin A and a BU Admin of one of A\'s BUs) both see the tenant\'s Centralised POs, incl. sibling-BU ones', async () => {
  install();
  try {
    assert.deepEqual(centralisedOnly(await listIds(BU_ADMIN_A11)), [1, 2, 3]);
    assert.deepEqual(centralisedOnly(await listIds(ADMIN_A)), [1, 2, 3]);
  } finally {
    restore();
  }
});

test('TEST 4: Platform Admin (reach = every Company) keeps global Centralised visibility', async () => {
  install();
  try {
    assert.deepEqual(centralisedOnly(await listIds(PLATFORM_ADMIN)), [1, 2, 3, 4, 5]);
  } finally {
    restore();
  }
});

test('TEST 5: a Centralised PO stamped with another tenant\'s Company (PO 5 / BU 20) never reaches Admin A', async () => {
  install();
  try {
    const ids = await listIds(ADMIN_A);
    assert.ok(!ids.includes(5));
    assert.ok(!ids.includes(4));
  } finally {
    restore();
  }
});

test('TEST 6: normal (non-Centralised) POs keep their existing BU visibility', async () => {
  install();
  try {
    assert.deepEqual((await listIds(ADMIN_A)).filter((id) => !centralisedOnly([id]).length), [6]);
    assert.deepEqual((await listIds(ADMIN_B)).filter((id) => !centralisedOnly([id]).length), [7]);
  } finally {
    restore();
  }
});

test('TEST 7: a scope change is honoured on the very next request (no Service PO cache)', async () => {
  install();
  try {
    assert.ok((await listIds(BU_ADMIN_A11)).includes(1));
    // BU 11 is moved under Admin B's Entity — its BU Admin's tenant is now B's.
    companies.find((c) => c.id === 11).entity_id = 2;
    assert.deepEqual(centralisedOnly(await listIds(BU_ADMIN_A11)), [3, 4, 5]);
  } finally {
    restore();
  }
});

test('resolveCentralisedServicePOTenant(): expands to the owning Admin\'s whole tenant, owners never include another Admin', async () => {
  install();
  try {
    const tenant = await resolveCentralisedServicePOTenant([11], 150);
    assert.deepEqual(tenant.companyIds.sort(), [10, 11]);
    assert.deepEqual(tenant.ownerIds.sort(), [100, 150]);
    assert.ok(!tenant.ownerIds.includes(200));
  } finally {
    restore();
  }
});

test('Employee Service PO mapping eligibility and auto-map lookup are tenant-bounded too', async () => {
  install();
  try {
    const tenantB = await resolveCentralisedServicePOTenant([20], 200);
    const eligible = await servicePORepository.getEligibleForMapping({
      companyId: [20], createdBy: 200, unrestricted: true, centralisedTenant: tenantB,
    });
    assert.deepEqual(eligible.map((po) => po.id).sort(), [4, 5, 7]);

    const autoMap = await servicePORepository.getActiveCentralisedPOIds(tenantB);
    assert.deepEqual(autoMap.map((po) => po.id).sort(), [4, 5]);
    assert.deepEqual(await servicePORepository.getActiveCentralisedPOIds(null), []);
  } finally {
    restore();
  }
});

test('findById(): Admin B cannot open Admin A\'s Centralised PO by id (hierarchy/mapping lookups go through this)', async () => {
  install();
  ServicePO.findOne = async ({ where }) => SERVICE_POS.find((po) => matches(po, where)) || null;
  try {
    const tenantB = await resolveCentralisedServicePOTenant([20], 200);
    assert.equal(await servicePORepository.findById(1, [20], 200, null, null, tenantB), null);
    assert.equal(await servicePORepository.findById(2, [20], 200, null, null, tenantB), null);
    assert.equal((await servicePORepository.findById(4, [20], 200, null, null, tenantB)).id, 4);
  } finally {
    delete ServicePO.findOne;
    restore();
  }
});

// ── Raw-SQL dashboards/reports ────────────────────────────────────────────

test('buLessServicePOInTenantSql(): bounds company_id NULL rows by the viewer\'s tenant owners, from the same :companyIds binding', () => {
  const sql = buLessServicePOInTenantSql('sp', 'companyIds').replace(/\s+/g, ' ');
  assert.match(sql, /^\(sp\.company_id IS NULL AND sp\.created_by IN \(/);
  assert.match(sql, /tenant_c\.id IN \(:companyIds\)/);
  assert.match(sql, /tenant_e\.created_by/);
  assert.match(sql, /tenant_e\.entity_admin_employee_id/);
});

test('no dashboard/report repository scopes Service POs with a bare `OR sp.company_id IS NULL` any more', () => {
  const files = ['aiInsightDataRepository', 'dashboardRepository', 'managementReportRepository', 'pmDashboardRepository', 'reportRepository'];
  for (const file of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'repositories', `${file}.js`), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(code, /OR (sp\.)?company_id IS NULL\)/, `${file}.js still has a bare BU-less Service PO scope`);
  }
});
