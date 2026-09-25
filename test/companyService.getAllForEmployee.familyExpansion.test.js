'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const companyRepository = require('../src/repositories/companyRepository');
const companyService = require('../src/services/companyService');

/**
 * BU Hierarchy / Sub-BU support — companyService.getAllForEmployee() (the
 * "load BUs" dropdown for a BU-scoped caller, e.g. GET /companies for the
 * Add Client screen's Business Unit / Sub Business Unit fields): a BU Admin
 * with a foothold anywhere in a Parent + Sub-BU family must see the WHOLE
 * family, not just the specific node(s) they're individually mapped to.
 */

const ORIGINAL = {
  findBusinessUnitsByEmployeeId: employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId,
  findFamilyMembers: companyRepository.findFamilyMembers,
};

function restore() {
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = ORIGINAL.findBusinessUnitsByEmployeeId;
  companyRepository.findFamilyMembers = ORIGINAL.findFamilyMembers;
}

test('getAllForEmployee(): mapped to only ONE Sub-BU ("DAS") — also sees its sibling Sub-BUs and shared Parent', async () => {
  try {
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [
      { id: 42, company_name: 'DAS', company_code: 'DAS', status: 'active', parent_business_unit_id: 23 },
    ];
    let capturedRootIds;
    companyRepository.findFamilyMembers = async (rootIds) => {
      capturedRootIds = rootIds;
      return [
        { id: 23, company_name: 'DATA + AI', company_code: 'DAI', status: 'active', parent_business_unit_id: null },
        { id: 42, company_name: 'DAS', company_code: 'DAS', status: 'active', parent_business_unit_id: 23 },
        { id: 43, company_name: 'IBM', company_code: 'IBM', status: 'active', parent_business_unit_id: 23 },
        { id: 44, company_name: 'NON IBM', company_code: 'NIBM', status: 'active', parent_business_unit_id: 23 },
      ];
    };

    const result = await companyService.getAllForEmployee({}, 900);

    assert.deepEqual(capturedRootIds, [23]); // resolved DAS's own parent as the family root
    assert.deepEqual(result.map((bu) => bu.id).sort((a, b) => a - b), [23, 42, 43, 44]);
  } finally {
    restore();
  }
});

test('getAllForEmployee(): mapped directly to a top-level Parent BU with no children — unaffected (regression baseline)', async () => {
  try {
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [
      { id: 10, company_name: 'Corporate', company_code: 'CORP', status: 'active', parent_business_unit_id: null },
    ];
    companyRepository.findFamilyMembers = async (rootIds) => {
      assert.deepEqual(rootIds, [10]);
      return [
        { id: 10, company_name: 'Corporate', company_code: 'CORP', status: 'active', parent_business_unit_id: null },
      ];
    };

    const result = await companyService.getAllForEmployee({}, 900);

    assert.deepEqual(result.map((bu) => bu.id), [10]);
  } finally {
    restore();
  }
});

test('getAllForEmployee(): mapped to TWO Sub-BUs across two different families — sees both whole families, no duplicates', async () => {
  try {
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [
      { id: 42, company_name: 'DAS', company_code: 'DAS', status: 'active', parent_business_unit_id: 23 },
      { id: 46, company_name: 'kk', company_code: 'KK', status: 'active', parent_business_unit_id: 45 },
    ];
    companyRepository.findFamilyMembers = async (rootIds) => {
      assert.deepEqual(rootIds.slice().sort((a, b) => a - b), [23, 45]);
      return [
        { id: 23, company_name: 'DATA + AI', company_code: 'DAI', status: 'active', parent_business_unit_id: null },
        { id: 42, company_name: 'DAS', company_code: 'DAS', status: 'active', parent_business_unit_id: 23 },
        { id: 43, company_name: 'IBM', company_code: 'IBM', status: 'active', parent_business_unit_id: 23 },
        { id: 45, company_name: 'kkkk', company_code: 'KKKK', status: 'active', parent_business_unit_id: null },
        { id: 46, company_name: 'kk', company_code: 'KK', status: 'active', parent_business_unit_id: 45 },
      ];
    };

    const result = await companyService.getAllForEmployee({}, 900);

    assert.deepEqual(result.map((bu) => bu.id).sort((a, b) => a - b), [23, 42, 43, 45, 46]);
  } finally {
    restore();
  }
});

test('getAllForEmployee(): status/search filters still apply to the expanded (family-wide) set', async () => {
  try {
    employeeBusinessUnitRepository.findBusinessUnitsByEmployeeId = async () => [
      { id: 42, company_name: 'DAS', company_code: 'DAS', status: 'active', parent_business_unit_id: 23 },
    ];
    companyRepository.findFamilyMembers = async () => [
      { id: 23, company_name: 'DATA + AI', company_code: 'DAI', status: 'active', parent_business_unit_id: null },
      { id: 42, company_name: 'DAS', company_code: 'DAS', status: 'active', parent_business_unit_id: 23 },
      { id: 43, company_name: 'IBM', company_code: 'IBM', status: 'inactive', parent_business_unit_id: 23 },
    ];

    const result = await companyService.getAllForEmployee({ status: 'active' }, 900);

    assert.deepEqual(result.map((bu) => bu.id).sort((a, b) => a - b), [23, 42]); // IBM (inactive) excluded
  } finally {
    restore();
  }
});
