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
  getResourceStaffingPlanAccuracy: managementReportRepo.getResourceStaffingPlanAccuracy,
  getEmployeeCapacityForecast: managementReportRepo.getEmployeeCapacityForecast,
};

function restore() {
  managementReportRepo.getResourceStaffingPlanAccuracy = ORIGINAL.getResourceStaffingPlanAccuracy;
  managementReportRepo.getEmployeeCapacityForecast = ORIGINAL.getEmployeeCapacityForecast;
}

test('getResourceStaffingPlanAccuracy() forwards varianceThresholdPct to the repository (previously dropped — computed only as a display flag)', async () => {
  let receivedThreshold;
  managementReportRepo.getResourceStaffingPlanAccuracy = async (filters) => {
    receivedThreshold = filters.varianceThresholdPct;
    return { rows: [], count: 0 };
  };

  await managementReportService.getResourceStaffingPlanAccuracy(
    { month: 7, year: 2026, varianceThresholdPct: '567' },
    54
  );

  assert.equal(receivedThreshold, 567);
  restore();
});

test('getResourceStaffingPlanAccuracy() forwards undefined (no filtering) when the param is omitted entirely — unchanged pre-fix behavior', async () => {
  let receivedThreshold = 'not set';
  managementReportRepo.getResourceStaffingPlanAccuracy = async (filters) => {
    receivedThreshold = filters.varianceThresholdPct;
    return { rows: [], count: 0 };
  };

  await managementReportService.getResourceStaffingPlanAccuracy({ month: 7, year: 2026 }, 54);

  assert.equal(receivedThreshold, undefined);
  restore();
});

test('getResourceStaffingPlanAccuracy() still flags at_risk using the existing formula on whatever rows the repo returns', async () => {
  managementReportRepo.getResourceStaffingPlanAccuracy = async () => ({
    rows: [
      { variance_pct: '-100.00', planned_hours: 10, actual_hours: 0 },
      { variance_pct: null, planned_hours: 0, actual_hours: 5 },
    ],
    count: 2,
  });

  const result = await managementReportService.getResourceStaffingPlanAccuracy(
    { month: 7, year: 2026, varianceThresholdPct: '5' },
    54
  );

  assert.equal(result.data[0].at_risk, true); // |-100| >= 5
  assert.equal(result.data[1].at_risk, false); // null variance never satisfies a threshold
  assert.equal(result.summary.variance_threshold_filter_applied, true);
  restore();
});

test('getEmployeeCapacityForecast() reads benchthresholdhours (the ACTUAL lowercase param name the frontend sends), not just the documented benchThresholdHours casing', async () => {
  let received;
  managementReportRepo.getEmployeeCapacityForecast = async (filters) => {
    received = filters.benchThresholdHours;
    return { rows: [], count: 0 };
  };

  await managementReportService.getEmployeeCapacityForecast(
    { month: 7, year: 2026, benchthresholdhours: '4' }, // exact casing from the bug report
    54
  );

  assert.equal(received, '4');
  restore();
});

test('getEmployeeCapacityForecast() also still accepts the documented camelCase benchThresholdHours', async () => {
  let received;
  managementReportRepo.getEmployeeCapacityForecast = async (filters) => {
    received = filters.benchThresholdHours;
    return { rows: [], count: 0 };
  };

  await managementReportService.getEmployeeCapacityForecast({ month: 7, year: 2026, benchThresholdHours: '4' }, 54);

  assert.equal(received, '4');
  restore();
});

test('getEmployeeCapacityForecast() forwards undefined (no filtering) when the param is omitted entirely', async () => {
  let received = 'not set';
  managementReportRepo.getEmployeeCapacityForecast = async (filters) => {
    received = filters.benchThresholdHours;
    return { rows: [], count: 0 };
  };

  await managementReportService.getEmployeeCapacityForecast({ month: 7, year: 2026 }, 54);

  assert.equal(received, undefined);
  restore();
});
