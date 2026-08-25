'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regression test for the mapped-employees dropdown, after the Resource
// Budget module's policy reversal: cross-BU staffing (an Employee mapped to
// a Service PO in a company other than their own) is a supported pattern,
// so GET /resource-budgets/service-po/:servicePoId/mapped-employees must
// return every actively-mapped employee — NOT filtered down to employees
// who additionally hold a Business Unit grant matching the PO's company.
// An earlier version of this endpoint added exactly that filter (to paper
// over create()/bulkUpsert() rejecting cross-BU-mapped employees); once
// those write paths stopped requiring the extra BU match, filtering here
// too would just hide legitimately mapped employees again (confirmed live
// with Rajkumar/PO1: mapped but only holds a Business Unit grant for a
// DIFFERENT company than the PO).
const servicePORepository = require('../src/repositories/servicePORepository');
const resourceBudgetRepository = require('../src/repositories/resourceBudgetRepository');
const entityRepository = require('../src/repositories/entityRepository');
const { Company } = require('../src/models');
const resourceBudgetService = require('../src/services/resourceBudgetService');

const ORIGINAL = {
  poFindById: servicePORepository.findById,
  findMappedEmployees: resourceBudgetRepository.findMappedEmployees,
  findIdsOwnedByAdmin: entityRepository.findIdsOwnedByAdmin,
  companyFindAll: Company.findAll,
};

function restore() {
  servicePORepository.findById = ORIGINAL.poFindById;
  resourceBudgetRepository.findMappedEmployees = ORIGINAL.findMappedEmployees;
  entityRepository.findIdsOwnedByAdmin = ORIGINAL.findIdsOwnedByAdmin;
  Company.findAll = ORIGINAL.companyFindAll;
}

function fakeAdminReq() {
  return { companyId: undefined, hierarchyRank: 2, employeeId: 900, headers: {}, ip: '127.0.0.1' };
}

function stubAdminOwnsCompany88() {
  entityRepository.findIdsOwnedByAdmin = async () => [6];
  Company.findAll = async () => [{ id: 88 }];
}

test('getMappedEmployees(): returns every actively-mapped employee, including one whose own Business Unit differs from the Service PO\'s company', async () => {
  stubAdminOwnsCompany88();

  servicePORepository.findById = async () => ({ id: 375, company_id: 88 });

  // Mirrors the live repro: employee 592 is mapped to PO 375 (company 88)
  // but their own Business Unit grant is for company 87.
  const mapped = [{ id: 592, employee_code: 'EMP125432', full_name: 'Rajkumar Ainapures', designation: 'Dev', status: 'active' }];
  resourceBudgetRepository.findMappedEmployees = async (servicePOId, companyId) => {
    assert.equal(servicePOId, 375);
    assert.equal(companyId, 88); // narrowed to the PO's own company
    return mapped;
  };

  const result = await resourceBudgetService.getMappedEmployees(375, fakeAdminReq());

  assert.deepEqual(result.map((e) => e.id), [592]);
  restore();
});
