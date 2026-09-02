'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Required BEFORE the service so we can monkey-patch its exported functions —
// reportService.js holds a live reference to this SAME module-cached object.
// Same pattern as test/managementReportService.thresholdFilters.test.js.
const reportRepo = require('../src/repositories/reportRepository');
const reportService = require('../src/services/reportService');

const ORIGINAL = {
  getServicePOHoursTrend: reportRepo.getServicePOHoursTrend,
  getServicePOCostBudgetByMonth: reportRepo.getServicePOCostBudgetByMonth,
};

function restore() {
  reportRepo.getServicePOHoursTrend = ORIGINAL.getServicePOHoursTrend;
  reportRepo.getServicePOCostBudgetByMonth = ORIGINAL.getServicePOCostBudgetByMonth;
}

test('getServicePOHoursBudgetReport() merges Total PO Hours and Cost Budget for each Month + Service PO present in either source', async () => {
  reportRepo.getServicePOHoursTrend = async () => ([
    { year: 2026, month: 8, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', total_hours: '320.00' },
    { year: 2026, month: 8, service_po_id: 2, service_po_code: 'PO-002', service_po_name: 'Project Beta', client_id: 11, client_name: 'Globex', total_hours: '180.00' },
  ]);
  reportRepo.getServicePOCostBudgetByMonth = async () => ([
    { year: 2026, month: 8, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', cost_budget: '500000.00' },
    { year: 2026, month: 8, service_po_id: 2, service_po_code: 'PO-002', service_po_name: 'Project Beta', client_id: 11, client_name: 'Globex', cost_budget: '300000.00' },
  ]);

  const { data } = await reportService.getServicePOHoursBudgetReport({ month: 8, year: 2026 }, [1]);

  assert.equal(data.length, 2);
  const po1 = data.find((r) => r.service_po_id === 1);
  const po2 = data.find((r) => r.service_po_id === 2);

  assert.equal(po1.total_hours, 320);
  assert.equal(po1.cost_budget, 500000);
  assert.equal(po2.total_hours, 180);
  assert.equal(po2.cost_budget, 300000);
});

test('getServicePOHoursBudgetReport() defaults Cost Budget to 0 when no budget is configured for that PO/month, without dropping the hours row', async () => {
  reportRepo.getServicePOHoursTrend = async () => ([
    { year: 2026, month: 8, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', total_hours: '320.00' },
  ]);
  reportRepo.getServicePOCostBudgetByMonth = async () => ([]);

  const { data } = await reportService.getServicePOHoursBudgetReport({ month: 8, year: 2026 }, [1]);

  assert.equal(data.length, 1);
  assert.equal(data[0].total_hours, 320);
  assert.equal(data[0].cost_budget, 0);
  restore();
});

test('getServicePOHoursBudgetReport() defaults Total PO Hours to 0 when a PO has a budget configured but no hours logged that month', async () => {
  reportRepo.getServicePOHoursTrend = async () => ([]);
  reportRepo.getServicePOCostBudgetByMonth = async () => ([
    { year: 2026, month: 8, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', cost_budget: '500000.00' },
  ]);

  const { data } = await reportService.getServicePOHoursBudgetReport({ month: 8, year: 2026 }, [1]);

  assert.equal(data.length, 1);
  assert.equal(data[0].total_hours, 0);
  assert.equal(data[0].cost_budget, 500000);
  restore();
});

test('getServicePOHoursBudgetReport() does not collapse multiple months for the same Service PO into one total', async () => {
  reportRepo.getServicePOHoursTrend = async () => ([
    { year: 2026, month: 8, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', total_hours: '320.00' },
    { year: 2026, month: 9, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', total_hours: '340.00' },
  ]);
  reportRepo.getServicePOCostBudgetByMonth = async () => ([
    { year: 2026, month: 8, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', cost_budget: '500000.00' },
    { year: 2026, month: 9, service_po_id: 1, service_po_code: 'PO-001', service_po_name: 'Project Alpha', client_id: 10, client_name: 'Acme', cost_budget: '520000.00' },
  ]);

  const { data } = await reportService.getServicePOHoursBudgetReport({ month: 8, year: 2026 }, [1]);

  assert.equal(data.length, 2);
  const aug = data.find((r) => r.month_number === 8);
  const sep = data.find((r) => r.month_number === 9);
  assert.equal(aug.total_hours, 320);
  assert.equal(aug.cost_budget, 500000);
  assert.equal(sep.total_hours, 340);
  assert.equal(sep.cost_budget, 520000);
  restore();
});

test('getServicePOHoursBudgetReport() forwards hoursSource and roleId to the hours-trend query, same existing timesheet-hours logic', async () => {
  let receivedFilters;
  reportRepo.getServicePOHoursTrend = async (filters) => {
    receivedFilters = filters;
    return [];
  };
  reportRepo.getServicePOCostBudgetByMonth = async () => [];

  await reportService.getServicePOHoursBudgetReport(
    { month: 8, year: 2026, hoursSource: 'O', roleId: '5', poId: '4' },
    [1]
  );

  assert.equal(receivedFilters.hoursSource, 'O');
  assert.equal(receivedFilters.roleId, '5');
  assert.equal(receivedFilters.poId, 4);
  restore();
});

test('getServicePOHoursBudgetReport() throws a 422 when neither month+year nor startDate+endDate is provided', async () => {
  await assert.rejects(
    () => reportService.getServicePOHoursBudgetReport({}, [1]),
    (err) => err.statusCode === 422
  );
});
