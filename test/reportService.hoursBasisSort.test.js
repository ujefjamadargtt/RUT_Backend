'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Repository stubbed before use — reportService holds a live reference to this module-cached object.
const reportRepo = require('../src/repositories/reportRepository');
const reportService = require('../src/services/reportService');

const KEYS = [
  'getEmployeeBenchDetailReport', 'getEmployeeBenchRoster', 'getResourceUtilizationTrend', 'getServicePOHoursTrend',
  'getServicePOCostBudgetByMonth', 'getClientWiseAnalyticsHours', 'getClientWiseAnalyticsCost',
  'getClientCostAnalyticsHours', 'getClientCostAnalyticsCost', 'getClientCategoryCostMatrixReport',
];
const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, reportRepo[k]]));
test.afterEach(() => { KEYS.forEach((k) => { reportRepo[k] = ORIGINAL[k]; }); });

const PERIOD = { month: 9, year: 2026 };

// A has more ADJUSTED hours, B has more ORIGINAL hours — the two bases rank them in opposite order.
test('employee-bench-percentage sorts by the original twin when hoursSource=O (and explicit original_* keys)', async () => {
  reportRepo.getEmployeeBenchRoster = async () => [];
  reportRepo.getEmployeeBenchDetailReport = async () => ([
    { employee_id: 1, employee_code: 'A', full_name: 'A', service_po_name: 'Bench', hours: '50', original_hours: '10' },
    { employee_id: 1, employee_code: 'A', full_name: 'A', service_po_name: 'Work', hours: '50', original_hours: '10' },
    { employee_id: 2, employee_code: 'B', full_name: 'B', service_po_name: 'Bench', hours: '10', original_hours: '40' },
    { employee_id: 2, employee_code: 'B', full_name: 'B', service_po_name: 'Work', hours: '10', original_hours: '40' },
  ]);
  const ids = async (query) => (await reportService.getEmployeeBenchPercentage({ ...PERIOD, ...query }, [1])).data.map((r) => r.employee_id);

  assert.deepEqual(await ids({ sortBy: 'total_hours', sortOrder: 'DESC' }), [1, 2]);
  assert.deepEqual(await ids({ sortBy: 'total_hours', sortOrder: 'DESC', hoursSource: 'O' }), [2, 1]);
  assert.deepEqual(await ids({ sortBy: 'bench_hours', sortOrder: 'DESC', hoursSource: 'O' }), [2, 1]);
  assert.deepEqual(await ids({ sortBy: 'original_total_hours', sortOrder: 'DESC' }), [2, 1]);
  // Unknown key falls back to the default sort, never reaches anything dynamic.
  assert.equal((await ids({ sortBy: 'x; DROP TABLE', hoursSource: 'zzz' })).length, 2);
});

test('resource-utilization-trend sorts by original_total_hours / original_billable_hours under hoursSource=O', async () => {
  reportRepo.getResourceUtilizationTrend = async () => ([
    { year: 2026, month: 9, employee_id: 1, employee_code: 'A', full_name: 'A', total_hours: '100', billable_hours: '90', original_total_hours: '10', original_billable_hours: '5', cap_hours: '160' },
    { year: 2026, month: 9, employee_id: 2, employee_code: 'B', full_name: 'B', total_hours: '20', billable_hours: '10', original_total_hours: '150', original_billable_hours: '140', cap_hours: '160' },
  ]);
  const ids = async (query) => (await reportService.getResourceUtilizationTrendReport({ ...PERIOD, sortOrder: 'DESC', ...query }, [1])).data.map((r) => r.employee_id);

  assert.deepEqual(await ids({ sortBy: 'total_hours' }), [1, 2]);
  assert.deepEqual(await ids({ sortBy: 'total_hours', hoursSource: 'O' }), [2, 1]);
  assert.deepEqual(await ids({ sortBy: 'billable_hours', hoursSource: 'O' }), [2, 1]);
  assert.deepEqual(await ids({ sortBy: 'utilization_percentage', hoursSource: 'O' }), [2, 1]);
});

test('service-po-hours-budget sorts by original_total_hours under hoursSource=O', async () => {
  reportRepo.getServicePOCostBudgetByMonth = async () => [];
  reportRepo.getServicePOHoursTrend = async () => ([
    { year: 2026, month: 9, service_po_id: 1, service_po_code: 'P1', service_po_name: 'P1', client_id: 1, client_name: 'C', total_hours: '100', original_total_hours: '10' },
    { year: 2026, month: 9, service_po_id: 2, service_po_code: 'P2', service_po_name: 'P2', client_id: 1, client_name: 'C', total_hours: '20', original_total_hours: '150' },
  ]);
  const ids = async (query) => (await reportService.getServicePOHoursBudgetReport({ ...PERIOD, sortOrder: 'DESC', sortBy: 'total_hours', ...query }, [1])).data.map((r) => r.service_po_id);

  assert.deepEqual(await ids({}), [1, 2]);
  assert.deepEqual(await ids({ hoursSource: 'O' }), [2, 1]);
});

test('client-wise-analytics accepts sortBy=original_total_hours', async () => {
  reportRepo.getClientWiseAnalyticsCost = async () => [];
  reportRepo.getClientWiseAnalyticsHours = async () => ([
    { client_id: 1, client_name: 'A', total_hours: '100', original_total_hours: '10', total_projects: 1 },
    { client_id: 2, client_name: 'B', total_hours: '20', original_total_hours: '150', total_projects: 1 },
  ]);
  const ids = async (query) => (await reportService.getClientWiseAnalyticsReport({ ...PERIOD, sortOrder: 'DESC', ...query }, [1])).data.map((r) => r.client_id);

  assert.deepEqual(await ids({ sortBy: 'total_hours' }), [1, 2]);
  assert.deepEqual(await ids({ sortBy: 'original_total_hours' }), [2, 1]);
  assert.deepEqual(await ids({ sortBy: 'total_hours', hoursSource: 'O' }), [2, 1]);
});

test('client-cost-analytics ranks Top Clients by original_total_hours under hoursSource=O, by cost otherwise', async () => {
  reportRepo.getClientCategoryCostMatrixReport = async () => [];
  reportRepo.getClientCostAnalyticsHours = async () => ([
    { client_id: 1, client_name: 'A', total_hours: '100', original_total_hours: '10' },
    { client_id: 2, client_name: 'B', total_hours: '20', original_total_hours: '150' },
  ]);
  reportRepo.getClientCostAnalyticsCost = async () => ([
    { client_id: 1, client_name: 'A', total_cost: '900' },
    { client_id: 2, client_name: 'B', total_cost: '100' },
  ]);
  const ranked = async (query) => (await reportService.getClientCostAnalytics(query, [1])).top_clients.data.map((c) => [c.rank, c.client_id]);

  assert.deepEqual(await ranked({}), [[1, 1], [2, 2]]);
  assert.deepEqual(await ranked({ hoursSource: 'O' }), [[1, 2], [2, 1]]);
});
