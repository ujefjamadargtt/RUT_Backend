'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Employee, sequelize } = require('../src/models');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePORepository = require('../src/repositories/servicePORepository');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const managerSelfServiceService = require('../src/services/managerSelfServiceService');

/**
 * Timesheet Approval redesign — Project Manager approval is now
 * Service-PO-based (reusing the EXISTING employee_servicepo_mapping table),
 * NOT manager_employee_mappings-based. These tests cover the new
 * hierarchyRank===6 (Project Manager) branch added to getMyEmployees() and
 * assertOwnEmployeeForApproval() (approveTimesheet/rejectWorkLogEntry/
 * bulkApproveTimesheets/getTimesheets/getApprovalSummary), and confirm every
 * OTHER tier (Admin, BU Admin, Team Lead/Project Admin) is unaffected —
 * same monkeypatch-the-module pattern as
 * managerSelfServiceService.getMyEmployees.businessUnit.test.js.
 */

const ORIGINAL = {
  findByManager: managerEmployeeMappingRepository.findByManager,
  findByManagerAndEmployee: managerEmployeeMappingRepository.findByManagerAndEmployee,
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findByServicePOs: employeeServicePOMappingRepository.findByServicePOs,
  findCentralisedIdsAmong: servicePORepository.findCentralisedIdsAmong,
  getActiveCentralisedPOIds: servicePORepository.getActiveCentralisedPOIds,
  existsForEmployeeAndServicePOIds: employeeWorkLogRepository.existsForEmployeeAndServicePOIds,
  findById: employeeWorkLogRepository.findById,
  approveById: employeeWorkLogRepository.approveById,
  rejectById: employeeWorkLogRepository.rejectById,
  approveByEmployeeAndDates: employeeWorkLogRepository.approveByEmployeeAndDates,
  approveByEmployeeAndMonths: employeeWorkLogRepository.approveByEmployeeAndMonths,
  employeeFindById: employeeRepository.findById,
  employeeFindAll: Employee.findAll,
  transaction: sequelize.transaction,
};

function restore() {
  managerEmployeeMappingRepository.findByManager = ORIGINAL.findByManager;
  managerEmployeeMappingRepository.findByManagerAndEmployee = ORIGINAL.findByManagerAndEmployee;
  employeeServicePOMappingRepository.findAllByEmployee = ORIGINAL.findAllByEmployee;
  employeeServicePOMappingRepository.findByServicePOs = ORIGINAL.findByServicePOs;
  servicePORepository.findCentralisedIdsAmong = ORIGINAL.findCentralisedIdsAmong;
  servicePORepository.getActiveCentralisedPOIds = ORIGINAL.getActiveCentralisedPOIds;
  employeeWorkLogRepository.existsForEmployeeAndServicePOIds = ORIGINAL.existsForEmployeeAndServicePOIds;
  employeeWorkLogRepository.findById = ORIGINAL.findById;
  employeeWorkLogRepository.approveById = ORIGINAL.approveById;
  employeeWorkLogRepository.rejectById = ORIGINAL.rejectById;
  employeeWorkLogRepository.approveByEmployeeAndDates = ORIGINAL.approveByEmployeeAndDates;
  employeeWorkLogRepository.approveByEmployeeAndMonths = ORIGINAL.approveByEmployeeAndMonths;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  Employee.findAll = ORIGINAL.employeeFindAll;
  sequelize.transaction = ORIGINAL.transaction;
}

const PROJECT_MANAGER_RANK = 6;
const TEAM_LEAD_RANK = 7;

// PO1 -> employees A(101), B(102), C(103) actively MAPPED to it. PO2 ->
// employee A(101) only. (Renamed from the pre-fix WORKLOG_BY_PO: "My
// Employees" is now driven by employee_servicepo_mapping, not by whether the
// employee has ever logged work — see the bug fix this file was updated
// for. existsForEmployeeAndServicePOIds below is unrelated: it backs the
// approve/reject actions, which legitimately require a real logged entry to
// act on, and reuses this same fixture data for convenience.)
const MAPPED_EMPLOYEES_BY_PO = {
  201: [101, 102, 103], // PO1
  202: [101],           // PO2
};

function stubPMMapping(pmEmployeeId, servicePoIds) {
  servicePORepository.findCentralisedIdsAmong = async () => []; // none of these test POs are Centralised
  servicePORepository.getActiveCentralisedPOIds = async () => []; // no Centralised POs exist, by default
  employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status) => {
    assert.equal(status, 'active');
    if (employeeId !== pmEmployeeId) return [];
    return servicePoIds.map((service_po_id) => ({ service_po_id }));
  };
}

function stubWorkLogQueries() {
  employeeServicePOMappingRepository.findByServicePOs = async (poIds, status) => {
    assert.equal(status, 'active');
    const ids = new Set();
    poIds.forEach((poId) => (MAPPED_EMPLOYEES_BY_PO[poId] || []).forEach((empId) => ids.add(empId)));
    return [...ids].map((employee_id) => ({ employee_id }));
  };
  employeeWorkLogRepository.existsForEmployeeAndServicePOIds = async (employeeId, poIds) => {
    return poIds.some((poId) => (MAPPED_EMPLOYEES_BY_PO[poId] || []).includes(employeeId));
  };
}

test('getMyEmployees (Project Manager, one PO): returns every employee actively MAPPED to that PO, regardless of logged work', async () => {
  try {
    stubPMMapping(501, [201]);
    stubWorkLogQueries();
    Employee.findAll = async ({ where }) => {
      assert.deepEqual(new Set(where.id), new Set([101, 102, 103]));
      return where.id.map((id) => ({ id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [] }));
    };

    const employees = await managerSelfServiceService.getMyEmployees(501, [], PROJECT_MANAGER_RANK, null);

    assert.deepEqual(employees.map((e) => e.id).sort(), [101, 102, 103]);
    assert.ok(employees.every((e) => e.mapping_type === null), 'mapping_type does not apply to Service-PO-based PM scope');
  } finally {
    restore();
  }
});

// Regression test for a real bug: a newly-mapped Employee with ZERO
// employee_work_logs rows must still appear immediately after POST
// /my-team/employees(-equivalent Service PO mapping) succeeds. The prior
// implementation derived this list from
// employeeWorkLogRepository.findDistinctEmployeeIdsByServicePOIds (an
// employee_work_logs query), which silently dropped any mapped employee who
// had not yet logged any work. It must now come from the mapping table
// (employee_servicepo_mapping) alone.
test('getMyEmployees (Project Manager): a freshly-mapped employee with NO work log entries still appears', async () => {
  try {
    stubPMMapping(501, [201]);
    // Employee 104 is actively MAPPED to PO 201 but has never logged any
    // work — deliberately absent from MAPPED_EMPLOYEES_BY_PO/any work-log
    // fixture, to prove this path never consults work logs at all.
    employeeServicePOMappingRepository.findByServicePOs = async (poIds, status) => {
      assert.deepEqual(poIds, [201]);
      assert.equal(status, 'active');
      return [{ employee_id: 104 }];
    };
    Employee.findAll = async ({ where }) => {
      assert.deepEqual(where.id, [104]);
      return where.id.map((id) => ({ id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [] }));
    };

    const employees = await managerSelfServiceService.getMyEmployees(501, [], PROJECT_MANAGER_RANK, null);

    assert.deepEqual(employees.map((e) => e.id), [104]);
  } finally {
    restore();
  }
});

test('getMyEmployees (Project Manager, multiple POs): returns the union of employees across every mapped PO', async () => {
  try {
    stubPMMapping(501, [201, 202]);
    stubWorkLogQueries();
    Employee.findAll = async ({ where }) => where.id.map((id) => ({ id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [] }));

    const employees = await managerSelfServiceService.getMyEmployees(501, [], PROJECT_MANAGER_RANK, null);

    assert.deepEqual(employees.map((e) => e.id).sort(), [101, 102, 103]);
  } finally {
    restore();
  }
});

// Real bug report: a Project Manager mapped to one real project PO (201)
// was ALSO auto-mapped to a Centralised utility PO (999, e.g. "Leaves") —
// every employee who ever logged a Leave was pulling into their "My
// Employees" approval scope. Centralised POs must never count toward a
// Project Manager's approval scope.
test('getMyEmployees (Project Manager): a Centralised PO (e.g. "Leaves") the PM is auto-mapped to does NOT pull in unrelated employees', async () => {
  try {
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId) => {
      if (employeeId !== 501) return [];
      return [{ service_po_id: 201 }, { service_po_id: 999 }]; // 201 = real project, 999 = Leaves
    };
    servicePORepository.findCentralisedIdsAmong = async (ids) => {
      assert.deepEqual(ids.slice().sort((a, b) => a - b), [201, 999]);
      return [999];
    };
    employeeServicePOMappingRepository.findByServicePOs = async (poIds, status) => {
      assert.equal(status, 'active');
      assert.deepEqual(poIds, [201], 'the Centralised PO (999) must already be filtered out before this query runs');
      return MAPPED_EMPLOYEES_BY_PO[201].map((employee_id) => ({ employee_id }));
    };
    Employee.findAll = async ({ where }) => where.id.map((id) => ({ id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [] }));

    const employees = await managerSelfServiceService.getMyEmployees(501, [], PROJECT_MANAGER_RANK, null);

    assert.deepEqual(employees.map((e) => e.id).sort(), [101, 102, 103]);
  } finally {
    restore();
  }
});

test('getMyEmployees (Project Manager): a second PM mapped to the SAME PO sees the SAME employees', async () => {
  try {
    stubWorkLogQueries();
    Employee.findAll = async ({ where }) => where.id.map((id) => ({ id, employee_code: `EMP-${id}`, full_name: `Employee ${id}`, designation: 'x', status: 'active', businessUnits: [] }));

    stubPMMapping(501, [201]);
    const pm1Employees = await managerSelfServiceService.getMyEmployees(501, [], PROJECT_MANAGER_RANK, null);

    stubPMMapping(777, [201]);
    const pm2Employees = await managerSelfServiceService.getMyEmployees(777, [], PROJECT_MANAGER_RANK, null);

    assert.deepEqual(pm1Employees.map((e) => e.id).sort(), pm2Employees.map((e) => e.id).sort());
    assert.deepEqual(pm1Employees.map((e) => e.id).sort(), [101, 102, 103]);
  } finally {
    restore();
  }
});

test('getMyEmployees (Project Manager with no Service PO mappings): returns empty, never queries manager_employee_mappings', async () => {
  try {
    stubPMMapping(501, []);
    managerEmployeeMappingRepository.findByManager = async () => {
      throw new Error('Project Manager scope must not fall back to manager_employee_mappings');
    };

    const employees = await managerSelfServiceService.getMyEmployees(501, [], PROJECT_MANAGER_RANK, null);

    assert.deepEqual(employees, []);
  } finally {
    restore();
  }
});

test('approveTimesheet (Project Manager): can approve an entry under a Service PO they are mapped to', async () => {
  try {
    stubPMMapping(501, [201]);
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 101, service_po_id: 201, status: 'pending' });
    employeeWorkLogRepository.approveById = async (id) => ({ id, status: 'approved' });

    const result = await managerSelfServiceService.approveTimesheet(501, 55, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []);

    assert.equal(result.status, 'approved');
  } finally {
    restore();
  }
});

test('approveTimesheet (Project Manager): CANNOT approve the same employee\'s entry under a Service PO they do NOT manage', async () => {
  try {
    // PM 501 is mapped to PO1 (201) only; employee 101 also has an entry
    // under PO2 (202), which this PM does not manage.
    stubPMMapping(501, [201]);
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 101, service_po_id: 202, status: 'pending' });
    let approveCalled = false;
    employeeWorkLogRepository.approveById = async () => { approveCalled = true; };

    await assert.rejects(
      () => managerSelfServiceService.approveTimesheet(501, 55, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []),
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
    assert.equal(approveCalled, false, 'must never flip the row when the entry\'s PO is out of this PM\'s scope');
  } finally {
    restore();
  }
});

// Real feature request: "if I'm mapped to Ambulance and I log a Leave, my
// Leave entry should reach Ambulance's own Project Manager(s)." A Centralised
// PO (Leaves/On Bench/etc.) has no genuine Project Manager of its own, but
// an Employee who's genuinely on the PM's real project should still have
// their Centralised-PO entries approvable by that same PM.
test('approveTimesheet (Project Manager): CAN approve a Centralised PO entry (e.g. Leaves) for an employee who genuinely has real project work under this PM', async () => {
  try {
    stubPMMapping(501, [201]); // PM's only real project is PO 201
    stubWorkLogQueries(); // employee 101 has real work logged against PO 201 (MAPPED_EMPLOYEES_BY_PO)
    // findCentralisedIdsAmong is called once to filter the PM's own mapped
    // POs ([201], via getProjectManagerServicePOIds) and again for the
    // entry's own servicePoId ([999]) — behave like a real filter, not a
    // single fixed-input assertion.
    const CENTRALISED = new Set([999]);
    servicePORepository.findCentralisedIdsAmong = async (ids) => ids.filter((id) => CENTRALISED.has(id));
    // entry.service_po_id = 999 (Leaves), employee_id = 101 (genuinely on PO 201)
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 101, service_po_id: 999, status: 'pending' });
    employeeWorkLogRepository.approveById = async (id) => ({ id, status: 'approved' });

    const result = await managerSelfServiceService.approveTimesheet(501, 55, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []);

    assert.equal(result.status, 'approved');
  } finally {
    restore();
  }
});

test('approveTimesheet (Project Manager): CANNOT approve a Centralised PO entry (Leaves) for an employee who has no real project work under this PM — a stranger\'s Leave', async () => {
  try {
    stubPMMapping(501, [201]);
    stubWorkLogQueries(); // employee 999 never appears under PO 201 in MAPPED_EMPLOYEES_BY_PO
    servicePORepository.findCentralisedIdsAmong = async () => [999];
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 999, service_po_id: 999, status: 'pending' });
    let approveCalled = false;
    employeeWorkLogRepository.approveById = async () => { approveCalled = true; };

    await assert.rejects(
      () => managerSelfServiceService.approveTimesheet(501, 55, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []),
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
    assert.equal(approveCalled, false, 'a Centralised-PO entry from an employee unrelated to this PM\'s real project must never be approvable');
  } finally {
    restore();
  }
});

test('rejectWorkLogEntry (Project Manager): same Service-PO-scoped gate as approve', async () => {
  try {
    stubPMMapping(501, [201]);
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 101, service_po_id: 201, status: 'pending' });
    employeeWorkLogRepository.rejectById = async (id, { remark }) => ({ id, status: 'rejected', rejection_remark: remark });

    const result = await managerSelfServiceService.rejectWorkLogEntry(501, 55, 'Hours look wrong', 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []);

    assert.equal(result.status, 'rejected');
  } finally {
    restore();
  }
});

test('bulkApproveTimesheets (Project Manager): the Project Manager\'s own Service PO ids are passed down to the repository, scoping the bulk approve', async () => {
  try {
    stubPMMapping(501, [201]);
    stubWorkLogQueries();
    sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });

    let capturedPoIds;
    employeeWorkLogRepository.approveByEmployeeAndDates = async (employeeId, dates, transaction, servicePoIds) => {
      assert.equal(employeeId, 101);
      capturedPoIds = servicePoIds;
      return { total_rows_approved: 2, buckets: dates.map((date) => ({ date, rows_approved: 1, already_settled: false })) };
    };

    const result = await managerSelfServiceService.bulkApproveTimesheets(
      501,
      { employee_id: 101, dates: ['2026-08-01', '2026-08-02'] },
      10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []
    );

    assert.deepEqual(capturedPoIds, [201]);
    assert.equal(result.total_rows_approved, 2);
  } finally {
    restore();
  }
});

test('bulkApproveTimesheets (Project Manager): scope is widened to include every Centralised PO once the target employee is confirmed to be genuinely theirs, so their Leave/Bench entries in the same range are swept up too', async () => {
  try {
    stubPMMapping(501, [201]);
    stubWorkLogQueries(); // employee 101 genuinely has work logged against PO 201
    servicePORepository.getActiveCentralisedPOIds = async () => [{ id: 56 }, { id: 52 }]; // Leaves, On Bench
    sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });

    let capturedPoIds;
    employeeWorkLogRepository.approveByEmployeeAndDates = async (employeeId, dates, transaction, servicePoIds) => {
      capturedPoIds = servicePoIds;
      return { total_rows_approved: 3, buckets: [{ date: '2026-08-01', rows_approved: 3, already_settled: false }] };
    };

    const result = await managerSelfServiceService.bulkApproveTimesheets(
      501,
      { employee_id: 101, dates: ['2026-08-01'] },
      10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []
    );

    assert.deepEqual(capturedPoIds.slice().sort((a, b) => a - b), [56, 52, 201].sort((a, b) => a - b));
    assert.equal(result.total_rows_approved, 3);
  } finally {
    restore();
  }
});

test('bulkApproveTimesheets (Project Manager): rejected up front when the employee has no logged work against any of this PM\'s Service POs', async () => {
  try {
    stubPMMapping(501, [201]);
    stubWorkLogQueries();
    sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
    let repoCalled = false;
    employeeWorkLogRepository.approveByEmployeeAndDates = async () => { repoCalled = true; return { total_rows_approved: 0, buckets: [] }; };

    // Employee 999 never appears in MAPPED_EMPLOYEES_BY_PO for PO1.
    await assert.rejects(
      () => managerSelfServiceService.bulkApproveTimesheets(501, { employee_id: 999, dates: ['2026-08-01'] }, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []),
      (err) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
    assert.equal(repoCalled, false);
  } finally {
    restore();
  }
});

// Real bug report: a Project Manager's "My Employees" list includes an
// Employee actively MAPPED to one of their Service POs who has not logged
// work there yet (getMyEmployees() is mapping-based). Opening that Employee
// on Timesheet Approval (GET /my-team/timesheets/approval-summary?employee_id=)
// 403'd "This Employee has not logged work against any Service PO you
// manage." — the list and the check disagreed, and the approval screen broke.
test('Project Manager: an Employee MAPPED to my Service PO but with no work logged there yet is allowed, scoped to MY Service POs only (no Centralised widening)', async () => {
  try {
    stubPMMapping(501, [201]);
    stubWorkLogQueries();
    // Employee 104: actively mapped to PO 201, zero work logs under it.
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status) => {
      assert.equal(status, 'active');
      if (employeeId === 501) return [{ service_po_id: 201 }];
      if (employeeId === 104) return [{ service_po_id: 201 }, { service_po_id: 56 }];
      return [];
    };
    servicePORepository.getActiveCentralisedPOIds = async () => { throw new Error('Centralised widening requires real logged work'); };
    sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });

    let capturedPoIds;
    employeeWorkLogRepository.approveByEmployeeAndDates = async (employeeId, dates, transaction, servicePoIds) => {
      capturedPoIds = servicePoIds;
      return { total_rows_approved: 0, buckets: [] };
    };

    await managerSelfServiceService.bulkApproveTimesheets(
      501, { employee_id: 104, dates: ['2026-08-01'] }, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []
    );

    assert.deepEqual(capturedPoIds, [201]);
  } finally {
    restore();
  }
});

test('Project Manager: an Employee neither mapped to nor working on my Service POs is still rejected with 403', async () => {
  try {
    stubPMMapping(501, [201]);
    stubWorkLogQueries();
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId) => {
      if (employeeId === 501) return [{ service_po_id: 201 }];
      if (employeeId === 105) return [{ service_po_id: 777 }]; // someone else's PO
      return [];
    };
    sequelize.transaction = async (fn) => fn({ __fakeTransaction: true });
    employeeWorkLogRepository.approveByEmployeeAndDates = async () => assert.fail('must not run');

    await assert.rejects(
      () => managerSelfServiceService.bulkApproveTimesheets(501, { employee_id: 105, dates: ['2026-08-01'] }, 10, 501, '127.0.0.1', PROJECT_MANAGER_RANK, []),
      (err) => err.statusCode === 403
    );
  } finally {
    restore();
  }
});

test('Team Lead (rank 7) approval is completely unaffected by the Project Manager redesign — still manager_employee_mappings-based', async () => {
  try {
    let mappingLookupArgs = null;
    managerEmployeeMappingRepository.findByManagerAndEmployee = async (managerUserId, employeeId, companyId) => {
      mappingLookupArgs = { managerUserId, employeeId, companyId };
      return { id: 1, manager_employee_id: managerUserId, employee_id: employeeId, mapping_type: 'PRIMARY', status: 'active' };
    };
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 101, service_po_id: 999, status: 'pending' });
    employeeWorkLogRepository.approveById = async (id) => ({ id, status: 'approved' });

    const result = await managerSelfServiceService.approveTimesheet(301, 55, 10, 301, '127.0.0.1', TEAM_LEAD_RANK, []);

    assert.equal(result.status, 'approved');
    assert.deepEqual(mappingLookupArgs, { managerUserId: 301, employeeId: 101, companyId: 10 });
  } finally {
    restore();
  }
});

test('Admin (rank <= 3) approval bypasses BOTH the manager_employee_mappings AND the Service-PO checks entirely — unchanged', async () => {
  try {
    managerEmployeeMappingRepository.findByManagerAndEmployee = async () => {
      throw new Error('Admin must not query manager_employee_mappings');
    };
    employeeServicePOMappingRepository.findAllByEmployee = async () => {
      throw new Error('Admin must not query employee_servicepo_mapping either');
    };
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 101, service_po_id: 999, status: 'pending' });
    employeeWorkLogRepository.approveById = async (id) => ({ id, status: 'approved' });

    const result = await managerSelfServiceService.approveTimesheet(1, 55, 10, 1, '127.0.0.1', 2, []);

    assert.equal(result.status, 'approved');
  } finally {
    restore();
  }
});

test('BU Admin (rank 4) approval keeps using employeeRepository.findById(employeeId, buIds) — unchanged', async () => {
  try {
    employeeServicePOMappingRepository.findAllByEmployee = async () => {
      throw new Error('BU Admin must not query employee_servicepo_mapping');
    };
    let buLookupArgs = null;
    employeeRepository.findById = async (employeeId, scopeIds) => {
      buLookupArgs = { employeeId, scopeIds };
      return { id: employeeId };
    };
    employeeWorkLogRepository.findById = async (id) => ({ id, employee_id: 101, service_po_id: 999, status: 'pending' });
    employeeWorkLogRepository.approveById = async (id) => ({ id, status: 'approved' });

    const result = await managerSelfServiceService.approveTimesheet(1, 55, 10, 1, '127.0.0.1', 4, [7, 8]);

    assert.equal(result.status, 'approved');
    assert.deepEqual(buLookupArgs, { employeeId: 101, scopeIds: [7, 8] });
  } finally {
    restore();
  }
});
