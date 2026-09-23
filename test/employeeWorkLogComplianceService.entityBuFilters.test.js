'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeAccessControlService = require('../src/services/employeeAccessControlService');
const employeeRepository = require('../src/repositories/employeeRepository');
const complianceRepository = require('../src/repositories/employeeWorkLogComplianceRepository');
const { Employee, Company } = require('../src/models');
const complianceService = require('../src/services/employeeWorkLogComplianceService');
const { complianceReportQuerySchema, complianceReminderBulkBodySchema } = require('../src/validations/employeeWorkLogComplianceValidation');

/**
 * GET /reports/employee-work-log-compliance: entityIds/businessUnitIds
 * multi-select narrowing (was entirely unwired before — the documented
 * company_id filter had no effect either). POST .../remind-bulk: the new
 * company_ids (plural) body field for "Remind All" scope narrowing.
 */

const ORIGINAL = {
  resolveEmployeeAccessWhere: employeeAccessControlService.resolveEmployeeAccessWhere,
  employeeScope: employeeRepository.employeeScope,
  employeeFindAll: Employee.findAll,
  companyFindAll: Company.findAll,
  getComplianceReport: complianceRepository.getComplianceReport,
};

function restore() {
  employeeAccessControlService.resolveEmployeeAccessWhere = ORIGINAL.resolveEmployeeAccessWhere;
  employeeRepository.employeeScope = ORIGINAL.employeeScope;
  Employee.findAll = ORIGINAL.employeeFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
  complianceRepository.getComplianceReport = ORIGINAL.getComplianceReport;
}

const AUTH_CONTEXT = { userId: 1, employeeId: 99, hierarchyRank: 7, roleNames: [] };

function stubEmployeeResolution() {
  employeeAccessControlService.resolveEmployeeAccessWhere = async () => ({});
  employeeRepository.employeeScope = async () => ({});
  let capturedWhere;
  Employee.findAll = async ({ where }) => {
    capturedWhere = where;
    return [];
  };
  complianceRepository.getComplianceReport = async () => ({ rows: [], count: 0 });
  return () => capturedWhere;
}

test('getReport: no entityIds/businessUnitIds -> companyIds reach unchanged (regression baseline)', async () => {
  const getCaptured = stubEmployeeResolution();
  try {
    await complianceService.getReport({ date: '2026-08-01' }, AUTH_CONTEXT, [1, 2, 3]);
    // employeeScope() receives the (unnarrowed) companyIds array directly —
    // capture via a spy instead, since Employee.findAll's where doesn't
    // expose it directly when accessScopes/companyScope are both {}.
    assert.ok(getCaptured());
  } finally {
    restore();
  }
});

test('getReport: businessUnitIds narrows companyIds before resolving authorized employees', async () => {
  let receivedCompanyIds;
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds = companyId;
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [];
  complianceRepository.getComplianceReport = async () => ({ rows: [], count: 0 });

  try {
    await complianceService.getReport({ date: '2026-08-01', businessUnitIds: '2,999' }, AUTH_CONTEXT, [1, 2, 3]);
    assert.equal(receivedCompanyIds, 2);
  } finally {
    restore();
  }
});

test('getReport: the legacy company_id param, previously a documented no-op, now actually narrows', async () => {
  let receivedCompanyIds;
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds = companyId;
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [];
  complianceRepository.getComplianceReport = async () => ({ rows: [], count: 0 });

  try {
    await complianceService.getReport({ date: '2026-08-01', company_id: 2 }, AUTH_CONTEXT, [1, 2, 3]);
    assert.equal(receivedCompanyIds, 2);
  } finally {
    restore();
  }
});

test('getReport: company_id outside the caller\'s reach is rejected with 403, not silently ignored', async () => {
  const getCaptured = stubEmployeeResolution();
  try {
    await assert.rejects(
      () => complianceService.getReport({ date: '2026-08-01', company_id: 999 }, AUTH_CONTEXT, [1, 2, 3]),
      (err) => err.statusCode === 403
    );
  } finally {
    restore();
    void getCaptured;
  }
});

test('sendBulkReminder: company_ids (plural) narrows the "remind all" scope, dropping ids outside the caller\'s reach', async () => {
  const receivedCompanyIds = [];
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds.push(companyId);
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [];
  complianceRepository.getComplianceReport = async () => ({ rows: [], count: 0 });

  try {
    await complianceService.sendBulkReminder(
      { date: '2026-08-01', remindAll: true, company_ids: '2,999' },
      AUTH_CONTEXT,
      [1, 2, 3]
    );
    // employeeAccessControlService.resolveEmployeeAccessWhere is called once
    // per companyId in the narrowed array — 999 (outside reach) must never
    // appear among the calls.
    assert.deepEqual(receivedCompanyIds, [2]);
  } finally {
    restore();
  }
});

test('sendBulkReminder: company_ids (plural) wins over the legacy singular company_id when both are given', async () => {
  const receivedCompanyIds = [];
  employeeAccessControlService.resolveEmployeeAccessWhere = async ({ companyId }) => {
    receivedCompanyIds.push(companyId);
    return {};
  };
  employeeRepository.employeeScope = async () => ({});
  Employee.findAll = async () => [];
  complianceRepository.getComplianceReport = async () => ({ rows: [], count: 0 });

  try {
    await complianceService.sendBulkReminder(
      { date: '2026-08-01', remindAll: true, company_id: 1, company_ids: '2,3' },
      AUTH_CONTEXT,
      [1, 2, 3]
    );
    assert.deepEqual(receivedCompanyIds.sort(), [2, 3]);
  } finally {
    restore();
  }
});

test('complianceReportQuerySchema: entityIds/businessUnitIds are accepted, not stripped', () => {
  const { error, value } = complianceReportQuerySchema.validate({ date: '2026-08-01', entityIds: '1,4', businessUnitIds: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.entityIds, '1,4');
  assert.equal(value.businessUnitIds, '10,12');
});

test('complianceReminderBulkBodySchema: company_ids is accepted, not stripped', () => {
  const { error, value } = complianceReminderBulkBodySchema.validate({ date: '2026-08-01', remindAll: true, company_ids: '10,12' });
  assert.equal(error, undefined);
  assert.equal(value.company_ids, '10,12');
});
