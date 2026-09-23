'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Employee } = require('../src/models');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const offDayWorkRequestRepository = require('../src/repositories/offDayWorkRequestRepository');
const managerSelfServiceService = require('../src/services/managerSelfServiceService');
const offDayWorkRequestService = require('../src/services/offDayWorkRequestService');

/**
 * Regression tests for a real bug report: a Manager/Project Manager who has
 * also logged work hours against a Service PO (or Employee) they themselves
 * manage/are mapped to saw their OWN name/employee_id in GET
 * /my-team/employees — and, since Approve/Reject only checks "is this
 * Employee one of your mapped Employees", could go on to approve their own
 * submitted hours. Fixed in two places: getMyEmployees() now drops the
 * caller's own Employee row from every tier's result, and
 * assertOwnEmployeeForApproval() — the shared guard reused by
 * getTimesheets/getApprovalSummary/approveTimesheet/rejectWorkLogEntry/
 * bulkApproveTimesheets AND offDayWorkRequestService's queue/approve/reject —
 * now rejects outright whenever the target employeeId is the caller's own
 * (req.userId === req.employeeId post-identity-redesign, see middlewares/auth.js).
 */

const ORIGINAL = {
  findByManager: managerEmployeeMappingRepository.findByManager,
  findByManagerAndEmployee: managerEmployeeMappingRepository.findByManagerAndEmployee,
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findDistinctEmployeeIdsByServicePOIds: employeeWorkLogRepository.findDistinctEmployeeIdsByServicePOIds,
  workLogFindById: employeeWorkLogRepository.findById,
  approveById: employeeWorkLogRepository.approveById,
  employeeFindById: employeeRepository.findById,
  employeeFindAll: Employee.findAll,
  offDayFindAllForQueue: offDayWorkRequestRepository.findAllForQueue,
};

function restore() {
  managerEmployeeMappingRepository.findByManager = ORIGINAL.findByManager;
  managerEmployeeMappingRepository.findByManagerAndEmployee = ORIGINAL.findByManagerAndEmployee;
  employeeServicePOMappingRepository.findAllByEmployee = ORIGINAL.findAllByEmployee;
  employeeWorkLogRepository.findDistinctEmployeeIdsByServicePOIds = ORIGINAL.findDistinctEmployeeIdsByServicePOIds;
  employeeWorkLogRepository.findById = ORIGINAL.workLogFindById;
  employeeWorkLogRepository.approveById = ORIGINAL.approveById;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  Employee.findAll = ORIGINAL.employeeFindAll;
  offDayWorkRequestRepository.findAllForQueue = ORIGINAL.offDayFindAllForQueue;
}

const PROJECT_MANAGER_RANK = 6;
const TEAM_LEAD_RANK = 7;
const BU_ADMIN_RANK = 4;
const ADMIN_RANK = 2;

test('getMyEmployees (Team Lead tier): the caller\'s own Employee row is excluded even though a manager_employee_mappings row maps it to them', async () => {
  try {
    managerEmployeeMappingRepository.findByManager = async () => [
      { employee_id: 42, mapping_type: 'PRIMARY' }, // the manager's own employee id, self-mapped
      { employee_id: 11, mapping_type: 'SECONDARY' },
    ];
    Employee.findAll = async ({ where }) => where.id.map((id) => ({
      id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [],
    }));

    const employees = await managerSelfServiceService.getMyEmployees(42, [], TEAM_LEAD_RANK, null);

    assert.deepEqual(employees.map((e) => e.id), [11]);
  } finally {
    restore();
  }
});

test('getMyEmployees (Project Manager tier): the caller\'s own Employee row is excluded even though they logged work against their own managed Service PO', async () => {
  try {
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId) => (employeeId === 501 ? [{ service_po_id: 201 }] : []);
    employeeWorkLogRepository.findDistinctEmployeeIdsByServicePOIds = async () => [501, 101, 102]; // PM 501 logged hours too
    Employee.findAll = async ({ where }) => where.id.map((id) => ({
      id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [],
    }));

    const employees = await managerSelfServiceService.getMyEmployees(501, [], PROJECT_MANAGER_RANK, null);

    assert.deepEqual(employees.map((e) => e.id).sort(), [101, 102]);
  } finally {
    restore();
  }
});

test('getMyEmployees (Admin/BU Admin tier): the caller\'s own Employee row is excluded from the BU-wide listing too', async () => {
  try {
    managerEmployeeMappingRepository.findByManager = async () => {
      throw new Error('Admin/BU Admin tier must not query manager_employee_mappings');
    };
    Employee.findAll = async () => [
      { id: 7, employee_code: 'EMP-0007', full_name: 'The Admin', designation: 'x', status: 'active', businessUnits: [{ id: 3, company_name: 'BU3', entity_id: null, entity: null }] },
      { id: 21, employee_code: 'EMP-0021', full_name: 'Someone Else', designation: 'x', status: 'active', businessUnits: [{ id: 3, company_name: 'BU3', entity_id: null, entity: null }] },
    ];

    const employees = await managerSelfServiceService.getMyEmployees(7, [3], BU_ADMIN_RANK, null);

    assert.deepEqual(employees.map((e) => e.id), [21]);
  } finally {
    restore();
  }
});

test('getMyEmployees: caller with no active Employees other than themselves gets an empty list, not their own row', async () => {
  try {
    managerEmployeeMappingRepository.findByManager = async () => [{ employee_id: 42, mapping_type: 'PRIMARY' }];
    Employee.findAll = async ({ where }) => where.id.map((id) => ({
      id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [],
    }));

    const employees = await managerSelfServiceService.getMyEmployees(42, [], TEAM_LEAD_RANK, null);

    assert.deepEqual(employees, []);
  } finally {
    restore();
  }
});

test('assertOwnEmployeeForApproval rejects the caller\'s own employee id with 403 before any tier-specific check runs', async () => {
  const ranks = [null, ADMIN_RANK, BU_ADMIN_RANK, PROJECT_MANAGER_RANK, TEAM_LEAD_RANK];
  for (const hierarchyRank of ranks) {
    try {
      managerEmployeeMappingRepository.findByManager = async () => { throw new Error('must not be reached'); };
      employeeServicePOMappingRepository.findAllByEmployee = async () => { throw new Error('must not be reached'); };
      employeeRepository.findById = async () => { throw new Error('must not be reached'); };

      await assert.rejects(
        () => managerSelfServiceService.assertOwnEmployeeForApproval(42, 42, 10, hierarchyRank, []),
        (err) => {
          assert.equal(err.statusCode, 403);
          return true;
        },
        `rank ${hierarchyRank} must reject self-targeting`
      );
    } finally {
      restore();
    }
  }
});

test('approveTimesheet: a Manager cannot approve their own work log entry even when it is otherwise their own managed Service PO', async () => {
  try {
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId) => (employeeId === 501 ? [{ service_po_id: 201 }] : []);
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 501, service_po_id: 201, status: 'pending' });
    let approveCalled = false;
    employeeWorkLogRepository.approveById = async () => { approveCalled = true; };

    await assert.rejects(
      () => managerSelfServiceService.approveTimesheet(501, 55, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []),
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
    assert.equal(approveCalled, false);
  } finally {
    restore();
  }
});

test('offDayWorkRequestService.listPendingQueue: a pending request raised by the caller\'s own employee id is silently dropped from their own queue', async () => {
  try {
    offDayWorkRequestRepository.findAllForQueue = async () => ({
      rows: [
        { id: 1, employee_id: 42, service_po_id: 201 }, // the manager's own request
        { id: 2, employee_id: 11, service_po_id: 201 }, // a genuine mapped employee's request
      ],
      count: 2,
    });
    managerEmployeeMappingRepository.findByManagerAndEmployee = async (managerUserId, employeeId) => (
      employeeId === 11 ? { id: 1, manager_employee_id: managerUserId, employee_id: 11, status: 'active' } : null
    );

    const { data, meta } = await offDayWorkRequestService.listPendingQueue(42, 10, TEAM_LEAD_RANK, []);

    assert.deepEqual(data.map((r) => r.id), [2]);
    assert.equal(meta.total, 1);
  } finally {
    restore();
  }
});
