'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch its exported
// function — managementReportService.js holds a live reference to this
// SAME module-cached object. Same pattern as
// test/employeeService.duplicateCode.test.js.
const managementReportRepo = require('../src/repositories/managementReportRepository');
const managementReportService = require('../src/services/managementReportService');

const ORIGINAL = {
  getServicePOTimelineRiskRaw: managementReportRepo.getServicePOTimelineRiskRaw,
};

function restore() {
  managementReportRepo.getServicePOTimelineRiskRaw = ORIGINAL.getServicePOTimelineRiskRaw;
}

function stubRepo(capture) {
  managementReportRepo.getServicePOTimelineRiskRaw = async (filters) => {
    Object.assign(capture, filters);
    return { rows: [], count: 0 };
  };
}

test('getServicePOTimelineRisk() reads clientId/poId/status/search case-insensitively — the actual bug: exact-case reads silently dropped a differently-cased param', async () => {
  const capture = {};
  stubRepo(capture);

  await managementReportService.getServicePOTimelineRisk(
    { clientid: 104, poid: 345, status: 'in-progress', search: 'Analytics', page: 1, limit: 10 },
    54
  );

  assert.equal(capture.clientId, 104);
  assert.equal(capture.poId, 345);
  assert.equal(capture.status, 'in-progress');
  assert.equal(capture.search, 'Analytics');
  restore();
});

test('getServicePOTimelineRisk() still reads the documented camelCase names (no regression)', async () => {
  const capture = {};
  stubRepo(capture);

  await managementReportService.getServicePOTimelineRisk(
    { clientId: 104, poId: 345, status: 'in-progress', search: 'Analytics', page: 1, limit: 10 },
    54
  );

  assert.equal(capture.clientId, 104);
  assert.equal(capture.poId, 345);
  restore();
});

test('getServicePOTimelineRisk() reads asOfDate case-insensitively and uses it (not always "today") for the timeline calculation', async () => {
  managementReportRepo.getServicePOTimelineRiskRaw = async () => ({
    rows: [{
      service_po_id: 345, status: 'in-progress',
      start_date: '2026-08-01', end_date: '2026-08-28',
      expected_man_hours: 27, hours_delivered_to_date: 0,
    }],
    count: 1,
  });

  const result = await managementReportService.getServicePOTimelineRisk({ asofdate: '2026-08-10' }, 54);

  assert.equal(result.as_of_date, '2026-08-10');
  // 9 elapsed days / 27 total days * 100 = 33.33 — proves asOfDate actually
  // drove the calculation, not a silently-defaulted "today".
  assert.equal(result.data[0].elapsed_time_pct, 33.33);
  restore();
});

test('getServicePOTimelineRisk() defaults asOfDate to "now" only when genuinely omitted', async () => {
  managementReportRepo.getServicePOTimelineRiskRaw = async () => ({ rows: [], count: 0 });

  const result = await managementReportService.getServicePOTimelineRisk({}, 54);

  assert.equal(result.as_of_date, new Date().toISOString().slice(0, 10));
  restore();
});
