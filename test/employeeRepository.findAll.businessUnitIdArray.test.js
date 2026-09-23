'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { Employee, EmployeeBusinessUnit } = require('../src/models');
const employeeRepository = require('../src/repositories/employeeRepository');

/**
 * employeeRepository.findAll()'s businessUnitId filter, extended to accept
 * an array (entityIds/businessUnitIds multi-select) alongside the existing
 * single-value form (?business_unit_id=).
 */

const ORIGINAL = {
  employeeBusinessUnitFindAll: EmployeeBusinessUnit.findAll,
  employeeFindAndCountAll: Employee.findAndCountAll,
};

function restore() {
  EmployeeBusinessUnit.findAll = ORIGINAL.employeeBusinessUnitFindAll;
  Employee.findAndCountAll = ORIGINAL.employeeFindAndCountAll;
}

test('a single-number businessUnitId still queries EmployeeBusinessUnit with a plain equality match (unchanged)', async () => {
  try {
    let capturedWhere;
    EmployeeBusinessUnit.findAll = async ({ where }) => {
      capturedWhere = where;
      return [];
    };
    Employee.findAndCountAll = async () => ({ rows: [], count: 0 });

    await employeeRepository.findAll({ accessWhere: {}, businessUnitId: 44 }, {}, {});

    assert.equal(capturedWhere.business_unit_id, 44);
  } finally {
    restore();
  }
});

test('an array businessUnitId queries EmployeeBusinessUnit with Op.in', async () => {
  try {
    let capturedWhere;
    EmployeeBusinessUnit.findAll = async ({ where }) => {
      capturedWhere = where;
      return [];
    };
    Employee.findAndCountAll = async () => ({ rows: [], count: 0 });

    await employeeRepository.findAll({ accessWhere: {}, businessUnitId: [10, 12] }, {}, {});

    assert.deepEqual(capturedWhere.business_unit_id, { [Op.in]: [10, 12] });
  } finally {
    restore();
  }
});

test('an empty array businessUnitId still queries (Op.in with an empty array), never throws — resolves to zero matching employees', async () => {
  try {
    let queried = false;
    EmployeeBusinessUnit.findAll = async ({ where }) => {
      queried = true;
      assert.deepEqual(where.business_unit_id, { [Op.in]: [] });
      return [];
    };
    let capturedEmployeeWhere;
    Employee.findAndCountAll = async ({ where }) => {
      capturedEmployeeWhere = where;
      return { rows: [], count: 0 };
    };

    await employeeRepository.findAll({ accessWhere: {}, businessUnitId: [] }, {}, {});

    assert.equal(queried, true);
    // The resulting employee id IN-list is empty too — ORM Op.in safely
    // degrades to "match nothing" rather than a raw-SQL "IN ()" syntax error.
    assert.deepEqual(capturedEmployeeWhere[Op.and], [{ id: { [Op.in]: [] } }]);
  } finally {
    restore();
  }
});
