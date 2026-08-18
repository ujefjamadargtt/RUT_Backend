'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch its exported
// functions — platformAdminService.js holds a live reference to this SAME
// module-cached object, never destructured at import time, so mutating a
// property here is visible to the service's own calls. Same pattern as
// test/formMasterService.test.js.
const platformAdminRepository = require('../src/repositories/platformAdminRepository');
const platformAdminService = require('../src/services/platformAdminService');

const ORIGINAL = {
  findAllCompaniesWithEntity: platformAdminRepository.findAllCompaniesWithEntity,
  findAllProjectsWithServicePOs: platformAdminRepository.findAllProjectsWithServicePOs,
  findAllUsersWithRoles: platformAdminRepository.findAllUsersWithRoles,
};

function restore() {
  platformAdminRepository.findAllCompaniesWithEntity = ORIGINAL.findAllCompaniesWithEntity;
  platformAdminRepository.findAllProjectsWithServicePOs = ORIGINAL.findAllProjectsWithServicePOs;
  platformAdminRepository.findAllUsersWithRoles = ORIGINAL.findAllUsersWithRoles;
}

test('All BUs are returned with their Entity info', async () => {
  platformAdminRepository.findAllCompaniesWithEntity = async () => [
    { id: 52, company_name: 'ABC Technologies', entity_id: 5, status: 'active', created_at: '2026-01-01', entity: { id: 5, entity_name: 'ABC Group' } },
    { id: 53, company_name: 'No Entity Loaded Co', entity_id: 9, status: 'inactive', created_at: '2026-01-02', entity: null },
  ];
  platformAdminRepository.findAllProjectsWithServicePOs = async () => [];
  platformAdminRepository.findAllUsersWithRoles = async () => [];

  const result = await platformAdminService.getOrganizationOverview();

  assert.equal(result.business_units.length, 2);
  assert.deepEqual(result.business_units[0], {
    id: 52, name: 'ABC Technologies', entity_id: 5, entity_name: 'ABC Group', status: 'active', created_at: '2026-01-01',
  });
  assert.equal(result.business_units[1].entity_name, null);
  restore();
});

test('Service PO hierarchy is flattened with correct level/parent_id, reusing node_type/parent_hierarchy_id', () => {
  const servicePO = {
    id: 293,
    service_po_code: 'PO-20260803-QH7X',
    service_po_name: 'Main PO',
    status: 'in-progress',
    client_id: 81,
    client: { id: 81, client_name: 'ABC Client' },
    company_id: 52,
    company: { id: 52, company_name: 'ABC Technologies', entity: { id: 5, entity_name: 'ABC Group' } },
    hierarchyNodes: [
      { id: 294, node_name: 'Parent PO', node_type: 'PARENT', parent_hierarchy_id: null },
      { id: 295, node_name: 'Child PO', node_type: 'CHILD', parent_hierarchy_id: 294 },
    ],
  };

  const mapped = platformAdminService.mapServicePO(servicePO);

  assert.deepEqual(mapped.hierarchy, [
    { id: 293, name: 'Main PO', node_type: 'ROOT', parent_id: null, level: 1 },
    { id: 294, name: 'Parent PO', node_type: 'PARENT', parent_id: 293, level: 2 },
    { id: 295, name: 'Child PO', node_type: 'CHILD', parent_id: 294, level: 3 },
  ]);
  assert.equal(mapped.client_name, 'ABC Client');
  assert.equal(mapped.bu.name, 'ABC Technologies');
  assert.equal(mapped.entity.name, 'ABC Group');
});

test('Service POs report their OWN Client/BU, independent of their Project\'s Client/BU', () => {
  const project = {
    id: 101,
    project_code: 'PRJ-1',
    project_name: 'RUT Portal',
    status: 'active',
    client_id: 81,
    client: { id: 81, client_name: 'Project-level Client' },
    company: { id: 52, company_name: 'Project-level BU', entity: { id: 5, entity_name: 'Project-level Entity' } },
    servicePOs: [
      {
        id: 293,
        service_po_code: 'PO-1',
        service_po_name: 'PO One',
        status: 'active',
        client_id: 99,
        client: { id: 99, client_name: 'PO-level Client' },
        company: { id: 60, company_name: 'PO-level BU', entity: { id: 7, entity_name: 'PO-level Entity' } },
        hierarchyNodes: [],
      },
    ],
  };

  const mapped = platformAdminService.mapProject(project);

  assert.equal(mapped.client_name, 'Project-level Client');
  assert.equal(mapped.bu.name, 'Project-level BU');
  assert.equal(mapped.service_pos[0].client_name, 'PO-level Client');
  assert.equal(mapped.service_pos[0].bu.name, 'PO-level BU');
});

test('User with multiple roles (primary + additional) returns a deduplicated roles array', () => {
  const user = {
    id: 428,
    email: 'john@example.com',
    status: 'active',
    employee_id: 428,
    role: { id: 8, role_name: 'Employee' },
    additionalRoles: [
      { id: 8, role_name: 'Employee' }, // duplicate of primary — must not appear twice
      { id: 4, role_name: 'BU Admin' },
    ],
    employee: { full_name: 'John Doe', company: null },
    company: { id: 52, company_name: 'ABC Technologies', entity: { id: 5, entity_name: 'ABC Group' } },
  };

  const mapped = platformAdminService.mapUser(user);

  assert.deepEqual(mapped.roles, [
    { id: 8, name: 'Employee' },
    { id: 4, name: 'BU Admin' },
  ]);
  assert.equal(mapped.name, 'John Doe');
  assert.equal(mapped.bu.id, 52);
  assert.equal(mapped.entity.id, 5);
});

test('User with no direct company_id (Platform Admin / Admin / Entity Admin) falls back to their Employee\'s Company', () => {
  const user = {
    id: 10,
    email: 'entityadmin@example.com',
    status: 'active',
    employee_id: 77,
    role: { id: 3, role_name: 'Entity Admin' },
    additionalRoles: [],
    company: null,
    employee: {
      full_name: 'Entity Admin User',
      company: { id: 61, company_name: 'Fallback BU', entity: { id: 8, entity_name: 'Fallback Entity' } },
    },
  };

  const mapped = platformAdminService.mapUser(user);

  assert.equal(mapped.bu.id, 61);
  assert.equal(mapped.entity.id, 8);
});

test('User with neither a direct Company nor an Employee Company reports null BU/Entity, never a guessed one', () => {
  const user = {
    id: 1,
    email: 'platformadmin@example.com',
    status: 'active',
    employee_id: null,
    role: { id: 1, role_name: 'Platform Admin' },
    additionalRoles: [],
    company: null,
    employee: null,
  };

  const mapped = platformAdminService.mapUser(user);

  assert.equal(mapped.bu, null);
  assert.equal(mapped.entity, null);
  assert.deepEqual(mapped.roles, [{ id: 1, name: 'Platform Admin' }]);
});

test('No password/token/security fields ever appear in the mapped user payload', () => {
  const user = {
    id: 1,
    email: 'a@example.com',
    status: 'active',
    employee_id: null,
    role: { id: 8, role_name: 'Employee' },
    additionalRoles: [],
    company: null,
    employee: null,
    // Even if a caller accidentally attached these (they never should, since
    // the repository's attribute allow-lists exclude them), the mapper only
    // reads named fields off the instance and can't leak them.
    password: 'hashed-secret',
    refresh_token: 'refresh-secret',
  };

  const mapped = platformAdminService.mapUser(user);
  const keys = Object.keys(mapped);

  assert.equal(keys.includes('password'), false);
  assert.equal(keys.includes('refresh_token'), false);
});
