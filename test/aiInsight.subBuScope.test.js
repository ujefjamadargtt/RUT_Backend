'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { sequelize, Company, AiInsight } = require('../src/models');
const companyRepository = require('../src/repositories/companyRepository');
const aiInsightRepo = require('../src/repositories/aiInsightRepository');
const aiInsightJobRepo = require('../src/repositories/aiInsightJobRepository');
const aiInsightDataRepo = require('../src/repositories/aiInsightDataRepository');
const aiGateway = require('../src/providers/gateway.provider');
const aiInsightService = require('../src/services/aiInsight.service');

/**
 * AI Insight — BU / Sub-BU scoping.
 *   - Insight units are LEAF Companies: a BU without Sub-BUs (BU-wise) or a
 *     Sub-BU; a Parent BU that has Sub-BUs never generates its own insight.
 *   - Reads/writes are bound to the caller's authorized reach (companyIds), an
 *     empty reach never reaches the database, and an out-of-reach id is a 404.
 *   - Manual runs resolve to exactly ONE unit and are limited to BU Admin+.
 */

const ORIGINAL = {
  companyFindAll: Company.findAll,
  insightFindOne: AiInsight.findOne,
  insightUpdate: AiInsight.update,
  query: sequelize.query,
  findLeaf: companyRepository.findInsightLeafCompanyIds,
  findByKey: aiInsightJobRepo.findByKey,
  recordRunResult: aiInsightJobRepo.recordRunResult,
  collector: aiInsightDataRepo.getWeeklyResourceDigestData,
  generateInsight: aiGateway.generateInsight,
};

function restore() {
  Company.findAll = ORIGINAL.companyFindAll;
  AiInsight.findOne = ORIGINAL.insightFindOne;
  AiInsight.update = ORIGINAL.insightUpdate;
  sequelize.query = ORIGINAL.query;
  companyRepository.findInsightLeafCompanyIds = ORIGINAL.findLeaf;
  aiInsightJobRepo.findByKey = ORIGINAL.findByKey;
  aiInsightJobRepo.recordRunResult = ORIGINAL.recordRunResult;
  aiInsightDataRepo.getWeeklyResourceDigestData = ORIGINAL.collector;
  aiGateway.generateInsight = ORIGINAL.generateInsight;
}

// ── findInsightLeafCompanyIds ───────────────────────────────────────────────

const COMPANIES = [
  { id: 1, parent_business_unit_id: null, status: 'active', is_deleted: false },   // Parent with 2 active Sub-BUs
  { id: 2, parent_business_unit_id: 1, status: 'active', is_deleted: false },
  { id: 3, parent_business_unit_id: 1, status: 'active', is_deleted: false },
  { id: 4, parent_business_unit_id: null, status: 'active', is_deleted: false },   // plain BU, no Sub-BUs
  { id: 5, parent_business_unit_id: null, status: 'active', is_deleted: false },   // Parent whose only Sub-BU is inactive
  { id: 6, parent_business_unit_id: 5, status: 'inactive', is_deleted: false },
  { id: 7, parent_business_unit_id: null, status: 'inactive', is_deleted: false }, // inactive Parent
  { id: 8, parent_business_unit_id: 7, status: 'active', is_deleted: false },      // active Sub-BU under inactive Parent
  { id: 9, parent_business_unit_id: null, status: 'active', is_deleted: true },    // deleted BU
];

function matches(row, where) {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && cond[Op.in]) return cond[Op.in].includes(row[key]);
    return row[key] === cond;
  });
}

function fakeCompanyTable() {
  Company.findAll = async ({ where }) => COMPANIES.filter((row) => matches(row, where));
}

test('findInsightLeafCompanyIds: BU without Sub-BUs is a unit; a Parent with active Sub-BUs is skipped in favour of its Sub-BUs', async () => {
  try {
    fakeCompanyTable();
    const ids = await companyRepository.findInsightLeafCompanyIds();
    assert.deepEqual([...ids].sort((a, b) => a - b), [2, 3, 4, 5]);
  } finally {
    restore();
  }
});

test('findInsightLeafCompanyIds: Parent whose only Sub-BU is inactive stays a unit; Sub-BU under an inactive Parent is skipped', async () => {
  try {
    fakeCompanyTable();
    const ids = await companyRepository.findInsightLeafCompanyIds([5, 6, 7, 8]);
    assert.deepEqual(ids, [5]);
  } finally {
    restore();
  }
});

test('findInsightLeafCompanyIds: restricts to the candidate set (Parent 1 -> excluded, plain BU 4 -> kept)', async () => {
  try {
    fakeCompanyTable();
    assert.deepEqual(await companyRepository.findInsightLeafCompanyIds([1, 4]), [4]);
    assert.deepEqual(await companyRepository.findInsightLeafCompanyIds([2]), [2]);
  } finally {
    restore();
  }
});

test('findInsightLeafCompanyIds: deleted company and empty candidate set yield nothing, empty set never queries', async () => {
  try {
    fakeCompanyTable();
    assert.deepEqual(await companyRepository.findInsightLeafCompanyIds([9]), []);

    let queried = false;
    Company.findAll = async () => { queried = true; return []; };
    assert.deepEqual(await companyRepository.findInsightLeafCompanyIds([]), []);
    assert.equal(queried, false);
  } finally {
    restore();
  }
});

// ── repository: scope binding ───────────────────────────────────────────────

test('aiInsightRepository: an empty reach never touches the database', async () => {
  try {
    let touched = false;
    sequelize.query = async () => { touched = true; return []; };
    AiInsight.findOne = async () => { touched = true; return null; };
    AiInsight.update = async () => { touched = true; return [1]; };

    assert.deepEqual(await aiInsightRepo.findAll({ companyIds: [], limit: 10, offset: 0 }), { rows: [], count: 0 });
    assert.deepEqual(await aiInsightRepo.findByRoles(['Admin'], { companyIds: [], limit: 10, offset: 0 }), { rows: [], count: 0 });
    assert.equal(await aiInsightRepo.findById(1, []), null);
    assert.deepEqual(await aiInsightRepo.markAsRead(1, []), [0]);
    assert.deepEqual(await aiInsightRepo.dismiss(1, []), [0]);
    assert.equal(await aiInsightRepo.findAll({ limit: 10, offset: 0 }).then((r) => r.count), 0); // undefined reach too
    assert.equal(touched, false);
  } finally {
    restore();
  }
});

test('aiInsightRepository: list queries are bound to the caller companyIds (and role overlap) only', async () => {
  try {
    const calls = [];
    sequelize.query = async (sql, opts) => {
      calls.push({ sql, replacements: opts.replacements });
      return /COUNT\(\*\)/.test(sql) ? [{ total: '0' }] : [];
    };

    await aiInsightRepo.findAll({ companyIds: [11, 12], limit: 10, offset: 0 });
    await aiInsightRepo.findByRoles(['BU Admin'], { companyIds: [11], limit: 10, offset: 0 });

    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.match(call.sql, /ai\.company_id IN \(:companyIds\)/);
      assert.doesNotMatch(call.sql, /company_id = :companyId\b/);
    }
    assert.deepEqual(calls[0].replacements.companyIds, [11, 12]);
    assert.deepEqual(calls[2].replacements.companyIds, [11]);
    assert.match(calls[2].sql, /ai\.audience_roles \?\| ARRAY\[:role0\]::text\[\]/);
  } finally {
    restore();
  }
});

test('aiInsightRepository: single-record lookup/update are restricted to the caller reach', async () => {
  try {
    let findWhere;
    let updateWhere;
    AiInsight.findOne = async ({ where }) => { findWhere = where; return null; };
    AiInsight.update = async (_values, { where }) => { updateWhere = where; return [0]; };

    await aiInsightRepo.findById(5, [21, 22]);
    await aiInsightRepo.markAsRead(5, [21, 22]);

    assert.equal(findWhere.id, 5);
    assert.deepEqual(findWhere.company_id[Op.in], [21, 22]);
    assert.deepEqual(updateWhere.company_id[Op.in], [21, 22]);
  } finally {
    restore();
  }
});

test('aiInsightService.getInsightById: an insight outside the caller reach is a 404', async () => {
  try {
    AiInsight.findOne = async () => null; // the scoped WHERE matched nothing
    await assert.rejects(
      () => aiInsightService.getInsightById(99, [1]),
      (err) => err.statusCode === 404
    );
  } finally {
    restore();
  }
});

// ── runJob leaf rule ────────────────────────────────────────────────────────

function stubRunJobDeps({ leafIds }) {
  const seen = { leafArgs: null, collectorCalls: 0, gatewayCalls: 0, recorded: 0 };
  companyRepository.findInsightLeafCompanyIds = async (ids) => { seen.leafArgs = ids; return leafIds; };
  aiInsightJobRepo.findByKey = async () => ({ id: 1, job_key: 'weekly_resource_digest', title: 'Weekly', audience_roles: ['Admin'] });
  aiInsightJobRepo.recordRunResult = async () => { seen.recorded += 1; };
  aiInsightDataRepo.getWeeklyResourceDigestData = async () => { seen.collectorCalls += 1; return null; };
  aiGateway.generateInsight = async () => { seen.gatewayCalls += 1; return {}; };
  return seen;
}

test('runJob: a Parent BU that has Sub-BUs (not a leaf) is skipped — no data collection, no AI call', async () => {
  try {
    const seen = stubRunJobDeps({ leafIds: [] });
    const result = await aiInsightService.runJob('weekly_resource_digest', {}, 1);

    assert.equal(result, null);
    assert.deepEqual(seen.leafArgs, [1]);
    assert.equal(seen.collectorCalls, 0);
    assert.equal(seen.gatewayCalls, 0);
  } finally {
    restore();
  }
});

test('runJob: a missing company (e.g. a Centralised PO without a BU) is skipped, never run unscoped', async () => {
  try {
    const seen = stubRunJobDeps({ leafIds: [] });
    const result = await aiInsightService.runJob('weekly_resource_digest', {}, null);

    assert.equal(result, null);
    assert.deepEqual(seen.leafArgs, []);
    assert.equal(seen.collectorCalls, 0);
  } finally {
    restore();
  }
});

test('runJob: a leaf company (BU without Sub-BUs / a Sub-BU) is collected for with its own id only', async () => {
  try {
    const seen = stubRunJobDeps({ leafIds: [2] });
    let collectorArg;
    aiInsightDataRepo.getWeeklyResourceDigestData = async (companyId) => { seen.collectorCalls += 1; collectorArg = companyId; return null; };

    await aiInsightService.runJob('weekly_resource_digest', {}, 2);

    assert.equal(seen.collectorCalls, 1);
    assert.equal(collectorArg, 2);
  } finally {
    restore();
  }
});

// ── manual run target ───────────────────────────────────────────────────────

test('resolveManualRunCompanyId: exactly one insight unit in reach is used', async () => {
  try {
    companyRepository.findInsightLeafCompanyIds = async () => [4];
    assert.equal(await aiInsightService.resolveManualRunCompanyId([4]), 4);
  } finally {
    restore();
  }
});

test('resolveManualRunCompanyId: several units in reach -> 400 (caller must select one); none -> 403', async () => {
  try {
    companyRepository.findInsightLeafCompanyIds = async () => [2, 3];
    await assert.rejects(() => aiInsightService.resolveManualRunCompanyId([1, 2, 3]), (err) => err.statusCode === 400);

    companyRepository.findInsightLeafCompanyIds = async () => [];
    await assert.rejects(() => aiInsightService.resolveManualRunCompanyId([]), (err) => err.statusCode === 403);
  } finally {
    restore();
  }
});

// ── run endpoints: BU Admin and above only ──────────────────────────────────

test('run endpoints: ranks below BU Admin are rejected with 403, BU Admin and above pass', () => {
  const router = require('../src/routes/aiInsight.routes');

  for (const path of ['/run-all', '/run/:jobKey']) {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
    assert.ok(layer, `POST ${path} is registered`);
    const gate = layer.route.stack.map((s) => s.handle).find((h) => h.name === 'requireSeniorTier');
    assert.ok(gate, `POST ${path} has the senior-tier gate`);

    for (const rank of [5, 6, 7, null]) {
      let status;
      let nexted = false;
      gate({ hierarchyRank: rank }, { status(code) { status = code; return { json() {} }; } }, () => { nexted = true; });
      assert.equal(status, 403, `rank ${rank} blocked on ${path}`);
      assert.equal(nexted, false);
    }
    for (const rank of [1, 2, 3, 4]) {
      let nexted = false;
      gate({ hierarchyRank: rank }, { status() { throw new Error('should not reject'); } }, () => { nexted = true; });
      assert.equal(nexted, true, `rank ${rank} allowed on ${path}`);
    }
  }
});
