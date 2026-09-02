'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Employee } = require('../src/models');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const managerSelfServiceService = require('../src/services/managerSelfServiceService');

const originals = {
  findByManager: managerEmployeeMappingRepository.findByManager,
  findAll: Employee.findAll,
};

function restore() {
  managerEmployeeMappingRepository.findByManager = originals.findByManager;
  Employee.findAll = originals.findAll;
}

function stubTeam() {
  managerEmployeeMappingRepository.findByManager = async (managerId, companyId) => {
    assert.equal(managerId, 99);
    assert.equal(companyId, undefined, 'BU selection must use employee BU memberships, not mapping.company_id');
    return [
      { employee_id: 11, mapping_type: 'PRIMARY' },
      { employee_id: 12, mapping_type: 'SECONDARY' },
    ];
  };
  Employee.findAll = async () => [
    { id: 11, employee_code: 'EMP-0001', full_name: 'John Doe', designation: 'Software Engineer', status: 'active', businessUnits: [{ id: 1, company_name: 'Alpha' }, { id: 2, company_name: 'Beta' }] },
    { id: 12, employee_code: 'EMP-0002', full_name: 'Jane Doe', designation: 'Designer', status: 'active', businessUnits: [{ id: 3, company_name: 'Gamma' }] },
  ];
}

test('getMyEmployees returns every mapped employee and enriches each with BU ids and mapping type', async () => {
  try {
    stubTeam();
    const employees = await managerSelfServiceService.getMyEmployees(99, [1, 2, 3]);

    assert.deepEqual(employees, [
      { id: 11, employee_code: 'EMP-0001', full_name: 'John Doe', designation: 'Software Engineer', status: 'active', business_unit_ids: [1, 2], business_units: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }], mapping_type: 'PRIMARY' },
      { id: 12, employee_code: 'EMP-0002', full_name: 'Jane Doe', designation: 'Designer', status: 'active', business_unit_ids: [3], business_units: [{ id: 3, name: 'Gamma' }], mapping_type: 'SECONDARY' },
    ]);
  } finally {
    restore();
  }
});

test('getMyEmployees filters by the selected Business Unit while retaining all mapped BU ids in the response', async () => {
  try {
    stubTeam();
    const employees = await managerSelfServiceService.getMyEmployees(99, [2]);

    assert.deepEqual(employees, [
      { id: 11, employee_code: 'EMP-0001', full_name: 'John Doe', designation: 'Software Engineer', status: 'active', business_unit_ids: [1, 2], business_units: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }], mapping_type: 'PRIMARY' },
    ]);
  } finally {
    restore();
  }
});

test('getMyEmployees bypasses manager mappings for an Admin and returns only active employees in the selected BU', async () => {
  try {
    managerEmployeeMappingRepository.findByManager = async () => {
      throw new Error('Admin list must not query manager mappings');
    };
    let employeeWhere;
    Employee.findAll = async ({ where }) => {
      employeeWhere = where;
      return [
        { id: 21, employee_code: 'EMP-0021', full_name: 'Active Admin Scope', designation: 'Engineer', status: 'active', businessUnits: [{ id: 3, company_name: 'hfds' }] },
        { id: 22, employee_code: 'EMP-0022', full_name: 'Other BU', designation: 'Designer', status: 'active', businessUnits: [{ id: 4, company_name: 'Other' }] },
      ];
    };

    const employees = await managerSelfServiceService.getMyEmployees(99, [3], 2);

    assert.deepEqual(employeeWhere, { status: 'active', is_deleted: false });
    assert.deepEqual(employees, [
      { id: 21, employee_code: 'EMP-0021', full_name: 'Active Admin Scope', designation: 'Engineer', status: 'active', business_unit_ids: [3], business_units: [{ id: 3, name: 'hfds' }], mapping_type: null },
    ]);
  } finally {
    restore();
  }
});
