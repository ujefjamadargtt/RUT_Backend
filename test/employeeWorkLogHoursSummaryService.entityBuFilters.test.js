'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const employeeRepository = require('../src/repositories/employeeRepository');
const { Employee, Company } = require('../src/models');
const summaryService = require('../src/services/employeeWorkLogHoursSummaryService');
const summaryRepository = require('../src/repositories/employeeWorkLogHoursSummaryRepository');
const {
  employeeWorkLogHoursSummaryQuerySchema,
  employeeWorkLogHoursSummaryDetailQuerySchema,
} = require('../src/validations/employeeWorkLogHoursSummaryValidation');

/**
 * The frontend now sends this report's BU/Entity narrowing as literal query
 * fields (company_ids, entity_ids, business_unit_ids — all comma-separated,
 * snake_case) rather than relying on the X-Company-Id header. Both getSummary
 * and getDetails must honor all three, composable, on top of the legacy
 * singular entityId.
 */

const ORIGINAL = {
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
  employeeScope: employeeRepository.employeeScope,
  employeeFindAll: Employee.findAll,
  companyFindAll: Company.findAll,
  getSummary: summaryRepository.getSummary,
};

function restore() {
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  employeeRepository.employeeScope = ORIGINAL.employeeScope;
  Employee.findAll = ORIGINAL.employeeFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
  summaryRepository.getSummary = ORIGINAL.getSummary;
}

const AUTH_CONTEXT = { userId: 1, employeeId: 99, hierarchyRank: 7, roleNames: [] };

test('getSummary: company_ids (snake_case) narrows companyIds, dropping ids outside the caller\'s reach', async () => {
  const receivedCompanyIds = [];
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds.push(companyId);
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [];
  summaryRepository.getSummary = async () => ({ rows: [], count: 0 });

  try {
    await summaryService.getSummary({ date: '2026-08-01', company_ids: '2,999' }, AUTH_CONTEXT, [1, 2, 3]);
    assert.deepEqual(receivedCompanyIds, [2]);
  } finally {
    restore();
  }
});

test('getSummary: business_unit_ids (snake_case) is accepted as an equivalent BU-narrowing filter', async () => {
  const receivedCompanyIds = [];
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds.push(companyId);
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [];
  summaryRepository.getSummary = async () => ({ rows: [], count: 0 });

  try {
    await summaryService.getSummary({ date: '2026-08-01', business_unit_ids: '3' }, AUTH_CONTEXT, [1, 2, 3]);
    assert.deepEqual(receivedCompanyIds, [3]);
  } finally {
    restore();
  }
});

test('getSummary: entity_ids (snake_case) narrows via a real Entity->Company lookup, superseding the legacy entityId', async () => {
  const receivedCompanyIds = [];
  Company.findAll = async () => [{ id: 1 }, { id: 2 }];
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds.push(companyId);
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [];
  summaryRepository.getSummary = async () => ({ rows: [], count: 0 });

  try {
    await summaryService.getSummary({ date: '2026-08-01', entity_ids: '5,6', entityId: '999' }, AUTH_CONTEXT, [1, 2, 3]);
    assert.deepEqual(receivedCompanyIds.sort(), [1, 2]);
  } finally {
    restore();
  }
});

test('getDetails: company_ids narrows companyIds the same way as getSummary', async () => {
  const receivedCompanyIds = [];
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds.push(companyId);
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [{ id: 42 }];

  try {
    // Employee.findOne (not mocked here) runs after the authorization check
    // — we only care that the authorization step itself used the narrowed
    // companyIds ([2]), asserted below, regardless of what happens after.
    try {
      await summaryService.getDetails(42, { date: '2026-08-01', company_ids: '2,999' }, AUTH_CONTEXT, [1, 2, 3]);
    } catch (_) {
      // ignore — only the pre-DB-lookup narrowing is under test here
    }
    assert.deepEqual(receivedCompanyIds, [2]);
  } finally {
    restore();
  }
});

test('employeeWorkLogHoursSummaryQuerySchema: entity_ids/company_ids/business_unit_ids are all accepted, not stripped', () => {
  const { error, value } = employeeWorkLogHoursSummaryQuerySchema.validate({
    date: '2026-08-01', entity_ids: '1,4', company_ids: '10,12', business_unit_ids: '20',
  });
  assert.equal(error, undefined);
  assert.equal(value.entity_ids, '1,4');
  assert.equal(value.company_ids, '10,12');
  assert.equal(value.business_unit_ids, '20');
});

test('employeeWorkLogHoursSummaryDetailQuerySchema: entity_ids/company_ids/business_unit_ids are all accepted, not stripped', () => {
  const { error, value } = employeeWorkLogHoursSummaryDetailQuerySchema.validate({
    date: '2026-08-01', entity_ids: '1,4', company_ids: '10,12', business_unit_ids: '20',
  });
  assert.equal(error, undefined);
  assert.equal(value.entity_ids, '1,4');
  assert.equal(value.company_ids, '10,12');
  assert.equal(value.business_unit_ids, '20');
});
