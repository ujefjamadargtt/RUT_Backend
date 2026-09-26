'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// GET /projects "Created By" + creator-derived Business Unit:
// creator.company_id/company_name is the BU the Project was created under
// when the creator belongs to it, else the creator's first BU, else null
// (e.g. an Admin with no BU); business_units lists all of them.
const projectRepository = require('../src/repositories/projectRepository');
const employeeBusinessUnitRepository = require('../src/repositories/employeeBusinessUnitRepository');
const projectService = require('../src/services/projectService');

const ORIGINAL = {
  findAll: projectRepository.findAll,
  countServicePOsByProjectIds: projectRepository.countServicePOsByProjectIds,
  findBusinessUnitsByEmployeeIds: employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds,
};

function restore() {
  projectRepository.findAll = ORIGINAL.findAll;
  projectRepository.countServicePOsByProjectIds = ORIGINAL.countServicePOsByProjectIds;
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds = ORIGINAL.findBusinessUnitsByEmployeeIds;
}

function row(plain) {
  return { ...plain, get: () => plain };
}

test('getAll(): creator carries name + the BU the project was created under (multi-BU creator), batched in one lookup', async () => {
  projectRepository.findAll = async () => ({
    count: 3,
    rows: [
      row({ id: 1, company_id: 23, created_by: 9, creator: { id: 9, full_name: 'Sriram' } }),   // multi-BU, created under 23
      row({ id: 2, company_id: 99, created_by: 9, creator: { id: 9, full_name: 'Sriram' } }),   // created under a BU they no longer hold
      row({ id: 3, company_id: 40, created_by: 3, creator: { id: 3, full_name: 'superadmin' } }), // Admin, no BU
    ],
  });
  projectRepository.countServicePOsByProjectIds = async () => new Map();
  let lookups = 0;
  employeeBusinessUnitRepository.findBusinessUnitsByEmployeeIds = async (ids) => {
    lookups += 1;
    assert.deepEqual(ids.slice().sort(), [3, 9]);
    return [
      { employee_id: 9, id: 24, name: 'ERP' },
      { employee_id: 9, id: 23, name: 'DATA + AI' },
    ];
  };

  try {
    const { data } = await projectService.getAll({}, { companyId: 23, hierarchyRank: 4, employeeId: 9, employeeBusinessUnits: [23] });

    assert.equal(lookups, 1);
    assert.deepEqual(
      { id: data[0].creator.id, full_name: data[0].creator.full_name, company_id: data[0].creator.company_id, company_name: data[0].creator.company_name },
      { id: 9, full_name: 'Sriram', company_id: 23, company_name: 'DATA + AI' }
    );
    assert.equal(data[0].creator.business_units.length, 2);
    assert.equal(data[1].creator.company_id, 24); // falls back to creator's first BU
    assert.equal(data[2].creator.full_name, 'superadmin');
    assert.equal(data[2].creator.company_id, null); // Admin without a BU
    assert.deepEqual(data[2].creator.business_units, []);
  } finally {
    restore();
  }
});
