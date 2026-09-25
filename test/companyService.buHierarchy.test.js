'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const companyRepository = require('../src/repositories/companyRepository');
const companyService = require('../src/services/companyService');
const { createCompanySchema, updateCompanySchema } = require('../src/validations/companyValidation');

/**
 * BU Hierarchy / Sub-BU support — companyService.create()/update()'s
 * parent_business_unit_id validation (validateParentBusinessUnit): depth
 * capped at 2 levels (Parent BU -> Sub-BU), no self-parent, an
 * inactive/deleted parent blocks new active children, a Sub-BU inherits its
 * parent's entity_id (never a client-supplied one), and createCompanySchema/
 * updateCompanySchema's own entity_id-optional-when-parent-given contract.
 */

const originals = {
  findByIdForEntities: companyRepository.findByIdForEntities,
  hasChildren: companyRepository.hasChildren,
  findByCode: companyRepository.findByCode,
  create: companyRepository.create,
};
function restore() {
  companyRepository.findByIdForEntities = originals.findByIdForEntities;
  companyRepository.hasChildren = originals.hasChildren;
  companyRepository.findByCode = originals.findByCode;
  companyRepository.create = originals.create;
}

test('create: parent_business_unit_id given — Sub-BU inherits the PARENT\'s entity_id, not a client-supplied one', async () => {
  try {
    companyRepository.findByIdForEntities = async (id) =>
      id === 1 ? { id: 1, entity_id: 7, status: 'active', parent_business_unit_id: null, toJSON: () => ({ id: 1 }) } : null;
    companyRepository.findByCode = async () => null;
    let created;
    companyRepository.create = async (data) => {
      created = data;
      return { id: 2, toJSON: () => data };
    };

    await companyService.create(
      { entity_id: 999, company_code: 'DEV', company_name: 'Development', parent_business_unit_id: 1 },
      42,
      null,
      [7]
    );

    assert.equal(created.entity_id, 7); // parent's entity_id, not the bogus 999 in the body
    assert.equal(created.parent_business_unit_id, 1);
  } finally {
    restore();
  }
});

test('create: parent not found/outside caller\'s own entities -> 404', async () => {
  try {
    companyRepository.findByIdForEntities = async () => null;
    await assert.rejects(
      () => companyService.create(
        { entity_id: 7, company_code: 'DEV', company_name: 'Development', parent_business_unit_id: 999 },
        42, null, [7]
      ),
      (err) => err.statusCode === 404
    );
  } finally {
    restore();
  }
});

test('create: inactive parent blocks creation of a new active Sub-BU', async () => {
  try {
    companyRepository.findByIdForEntities = async () => ({
      id: 1, entity_id: 7, status: 'inactive', parent_business_unit_id: null, toJSON: () => ({ id: 1 }),
    });
    await assert.rejects(
      () => companyService.create(
        { entity_id: 7, company_code: 'DEV', company_name: 'Development', parent_business_unit_id: 1 },
        42, null, [7]
      ),
      (err) => err.statusCode === 422
    );
  } finally {
    restore();
  }
});

test('create: a Sub-BU cannot itself be a parent (depth capped at 2 levels)', async () => {
  try {
    companyRepository.findByIdForEntities = async () => ({
      id: 2, entity_id: 7, status: 'active', parent_business_unit_id: 1, toJSON: () => ({ id: 2 }),
    });
    await assert.rejects(
      () => companyService.create(
        { entity_id: 7, company_code: 'QA', company_name: 'QA', parent_business_unit_id: 2 },
        42, null, [7]
      ),
      (err) => err.statusCode === 422
    );
  } finally {
    restore();
  }
});

test('update: a Business Unit cannot be its own parent', async () => {
  try {
    // getById() inside update() resolves the existing row first.
    companyRepository.findByIdForEntities = async () => ({
      id: 5, entity_id: 7, status: 'active', parent_business_unit_id: null, toJSON: () => ({ id: 5 }),
    });
    await assert.rejects(
      () => companyService.update(5, { parent_business_unit_id: 5 }, 42, null, [7]),
      (err) => err.statusCode === 422
    );
  } finally {
    restore();
  }
});

test('update: a Business Unit that already has Sub-BUs cannot be made a Sub-BU of another Business Unit', async () => {
  try {
    let call = 0;
    companyRepository.findByIdForEntities = async (id) => {
      call += 1;
      // 1st call: getById(5) (the existing row being updated).
      // 2nd call: validateParentBusinessUnit resolving the requested new parent (10).
      return call === 1
        ? { id: 5, entity_id: 7, status: 'active', parent_business_unit_id: null, toJSON: () => ({ id: 5 }) }
        : { id: 10, entity_id: 7, status: 'active', parent_business_unit_id: null, toJSON: () => ({ id: 10 }) };
    };
    companyRepository.hasChildren = async (id) => id === 5; // 5 already has its own Sub-BUs
    await assert.rejects(
      () => companyService.update(5, { parent_business_unit_id: 10 }, 42, null, [7]),
      (err) => err.statusCode === 422
    );
  } finally {
    restore();
  }
});

test('create: parent given, no company_code supplied -> auto-generated from company_name', async () => {
  try {
    companyRepository.findByIdForEntities = async () => ({
      id: 1, entity_id: 7, status: 'active', parent_business_unit_id: null, saturday_off_rule: 'ALT_1_3', toJSON: () => ({ id: 1 }),
    });
    companyRepository.findByCode = async () => null; // no collision
    let created;
    companyRepository.create = async (data) => {
      created = data;
      return { id: 2, toJSON: () => data };
    };

    await companyService.create(
      { company_name: 'Development', parent_business_unit_id: 1 },
      42, null, [7]
    );

    assert.equal(created.company_code, 'DEVELOPMENT');
  } finally {
    restore();
  }
});

test('create: parent given, auto-generated company_code appends a numeric suffix on collision', async () => {
  try {
    companyRepository.findByIdForEntities = async () => ({
      id: 1, entity_id: 7, status: 'active', parent_business_unit_id: null, saturday_off_rule: 'ALL', toJSON: () => ({ id: 1 }),
    });
    let findByCodeCalls = 0;
    companyRepository.findByCode = async (code) => {
      findByCodeCalls += 1;
      // First candidate ("QA") collides, second ("QA1") is free.
      return code === 'QA' ? { id: 999 } : null;
    };
    let created;
    companyRepository.create = async (data) => {
      created = data;
      return { id: 2, toJSON: () => data };
    };

    await companyService.create({ company_name: 'QA', parent_business_unit_id: 1 }, 42, null, [7]);

    assert.equal(created.company_code, 'QA1');
    assert.ok(findByCodeCalls >= 2);
  } finally {
    restore();
  }
});

test('create: parent given -> saturday_off_rule ("off day") is always the PARENT\'s, ignoring any body value', async () => {
  try {
    companyRepository.findByIdForEntities = async () => ({
      id: 1, entity_id: 7, status: 'active', parent_business_unit_id: null, saturday_off_rule: 'ALT_2_4', toJSON: () => ({ id: 1 }),
    });
    companyRepository.findByCode = async () => null;
    let created;
    companyRepository.create = async (data) => {
      created = data;
      return { id: 2, toJSON: () => data };
    };

    await companyService.create(
      { company_code: 'DEV', company_name: 'Development', parent_business_unit_id: 1, saturday_off_rule: 'NONE' },
      42, null, [7]
    );

    assert.equal(created.saturday_off_rule, 'ALT_2_4'); // parent's value, not the 'NONE' sent in the body
  } finally {
    restore();
  }
});

test('createCompanySchema: company_code is optional when parent_business_unit_id is given', () => {
  const { error } = createCompanySchema.validate({
    company_name: 'Development', parent_business_unit_id: 1,
  });
  assert.equal(error, undefined);
});

test('createCompanySchema: company_code is still required for a top-level Parent BU (no parent given)', () => {
  const { error } = createCompanySchema.validate({ entity_id: 7, company_name: 'Development' });
  assert.ok(error);
  assert.match(error.message, /Company code is required/);
});

test('createCompanySchema: entity_id is optional when parent_business_unit_id is given', () => {
  const { error } = createCompanySchema.validate({
    company_code: 'DEV', company_name: 'Development', parent_business_unit_id: 1,
  });
  assert.equal(error, undefined);
});

test('createCompanySchema: entity_id is still required for a top-level Parent BU (no parent given)', () => {
  const { error } = createCompanySchema.validate({ company_code: 'DEV', company_name: 'Development' });
  assert.ok(error);
  assert.match(error.message, /Entity is required/);
});

test('updateCompanySchema: parent_business_unit_id accepts null (detach back to top-level) or a positive id', () => {
  assert.equal(updateCompanySchema.validate({ parent_business_unit_id: null }).error, undefined);
  assert.equal(updateCompanySchema.validate({ parent_business_unit_id: 3 }).error, undefined);
  assert.ok(updateCompanySchema.validate({ parent_business_unit_id: -1 }).error);
});
