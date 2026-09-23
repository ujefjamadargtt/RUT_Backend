'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const managementReportRepo = require('../src/repositories/managementReportRepository');
const { Company } = require('../src/models');
const managementReportService = require('../src/services/managementReportService');

/**
 * GET /management-reports/bu-performance-scorecard — the one report NOT on
 * the standard req.companyIds/entityIds pattern (Entity Admin/Admin only,
 * scoped by req.entityIds). Previously the frontend's "companyId=12,45"
 * hack silently truncated to just "12" via a bare parseInt — never a
 * working IN clause. Fixed by accepting businessUnitIds (the standard
 * convention) as the primary multi-select name, with companyId parsed as a
 * possibly comma-separated list for backward compatibility.
 */

const ORIGINAL = {
  getBUPerformanceScorecard: managementReportRepo.getBUPerformanceScorecard,
  companyFindAll: Company.findAll,
};

function restore() {
  managementReportRepo.getBUPerformanceScorecard = ORIGINAL.getBUPerformanceScorecard;
  Company.findAll = ORIGINAL.companyFindAll;
}

const QUERY = { month: 8, year: 2026 };
const REQ = { entityIds: [10, 20, 30] };

test('no businessUnitIds/companyId: every Company under the caller\'s entities is included (regression baseline)', async () => {
  try {
    let capturedWhere;
    Company.findAll = async ({ where }) => {
      capturedWhere = where;
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    };
    managementReportRepo.getBUPerformanceScorecard = async () => ({ rows: [], count: 0 });

    await managementReportService.getBUPerformanceScorecard(QUERY, REQ);

    assert.equal(capturedWhere.id, undefined);
    assert.deepEqual(capturedWhere.entity_id, [10, 20, 30]);
  } finally {
    restore();
  }
});

test('businessUnitIds (the standard multi-select convention) correctly narrows via Op.in — the actual fix', async () => {
  try {
    Company.findAll = async ({ where }) => {
      // Simulates the real Company.findAll(where) behavior for an Op.in id filter.
      const allCompanies = [{ id: 12 }, { id: 45 }, { id: 99 }];
      if (where.id && where.id[Op.in]) {
        return allCompanies.filter((c) => where.id[Op.in].includes(c.id));
      }
      return allCompanies;
    };
    managementReportRepo.getBUPerformanceScorecard = async () => ({ rows: [], count: 0 });

    let capturedFilters;
    managementReportRepo.getBUPerformanceScorecard = async (filters) => {
      capturedFilters = filters;
      return { rows: [], count: 0 };
    };

    await managementReportService.getBUPerformanceScorecard({ ...QUERY, businessUnitIds: '12,45' }, REQ);

    assert.deepEqual(capturedFilters.companyIds.sort(), [12, 45]);
  } finally {
    restore();
  }
});

test('the legacy companyId param, previously silently truncated by a bare parseInt, now correctly expands as a comma-separated list', async () => {
  try {
    Company.findAll = async ({ where }) => {
      const allCompanies = [{ id: 12 }, { id: 45 }, { id: 99 }];
      if (where.id && where.id[Op.in]) {
        return allCompanies.filter((c) => where.id[Op.in].includes(c.id));
      }
      if (where.id) return allCompanies.filter((c) => c.id === where.id);
      return allCompanies;
    };
    let capturedFilters;
    managementReportRepo.getBUPerformanceScorecard = async (filters) => {
      capturedFilters = filters;
      return { rows: [], count: 0 };
    };

    await managementReportService.getBUPerformanceScorecard({ ...QUERY, companyId: '12,45' }, REQ);

    // Before the fix: parseInt('12,45', 10) === 12 -> only company 12.
    assert.deepEqual(capturedFilters.companyIds.sort(), [12, 45]);
  } finally {
    restore();
  }
});

test('a single-value companyId (unchanged legacy behavior) still narrows to exactly that one Company', async () => {
  try {
    Company.findAll = async ({ where }) => {
      const allCompanies = [{ id: 12 }, { id: 45 }];
      if (where.id) return allCompanies.filter((c) => c.id === where.id);
      return allCompanies;
    };
    let capturedFilters;
    managementReportRepo.getBUPerformanceScorecard = async (filters) => {
      capturedFilters = filters;
      return { rows: [], count: 0 };
    };

    await managementReportService.getBUPerformanceScorecard({ ...QUERY, companyId: '12' }, REQ);

    assert.deepEqual(capturedFilters.companyIds, [12]);
  } finally {
    restore();
  }
});
