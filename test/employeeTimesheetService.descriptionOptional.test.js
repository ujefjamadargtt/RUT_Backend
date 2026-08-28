'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeWorkLogTimeEntryRepository = require('../src/repositories/employeeWorkLogTimeEntryRepository');
const employeeRepository = require('../src/repositories/employeeRepository');
const timesheetService = require('../src/services/timesheetService');
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');
const { replaceDailyEntriesSchema } = require('../src/validations/employeeTimesheetValidation');

const ORIGINAL = {
  findByEmployeeAndPO: employeeServicePOMappingRepository.findByEmployeeAndPO,
  resolveManualEntryReferences: timesheetService.resolveManualEntryReferences,
  findByIdAndServicePOWithParent: servicePOHierarchyRepository.findByIdAndServicePOWithParent,
  employeeFindById: employeeRepository.findById,
  hasMonthlyEntry: employeeWorkLogRepository.hasMonthlyEntry,
  getMonthEntryModeSummary: employeeWorkLogRepository.getMonthEntryModeSummary,
  findAll: employeeWorkLogRepository.findAll,
  deleteByEmployeeAndDate: employeeWorkLogRepository.deleteByEmployeeAndDate,
  bulkCreate: employeeWorkLogRepository.bulkCreate,
  markApprovedByIds: employeeWorkLogRepository.markApprovedByIds,
  getDailyHours: employeeWorkLogRepository.getDailyHours,
  teBulkCreate: employeeWorkLogTimeEntryRepository.bulkCreate,
  findByIdForEmployee: employeeWorkLogRepository.findByIdForEmployee,
  checkDuplicate: employeeWorkLogRepository.checkDuplicate,
  update: employeeWorkLogRepository.update,
  teDeleteByWorkLogId: employeeWorkLogTimeEntryRepository.deleteByWorkLogId,
};

function restore() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = ORIGINAL.findByEmployeeAndPO;
  timesheetService.resolveManualEntryReferences = ORIGINAL.resolveManualEntryReferences;
  employeeRepository.findById = ORIGINAL.employeeFindById;
  employeeWorkLogRepository.hasMonthlyEntry = ORIGINAL.hasMonthlyEntry;
  employeeWorkLogRepository.getMonthEntryModeSummary = ORIGINAL.getMonthEntryModeSummary;
  employeeWorkLogRepository.findAll = ORIGINAL.findAll;
  employeeWorkLogRepository.deleteByEmployeeAndDate = ORIGINAL.deleteByEmployeeAndDate;
  employeeWorkLogRepository.bulkCreate = ORIGINAL.bulkCreate;
  employeeWorkLogRepository.markApprovedByIds = ORIGINAL.markApprovedByIds;
  employeeWorkLogRepository.getDailyHours = ORIGINAL.getDailyHours;
  employeeWorkLogTimeEntryRepository.bulkCreate = ORIGINAL.teBulkCreate;
  employeeWorkLogRepository.findByIdForEmployee = ORIGINAL.findByIdForEmployee;
  employeeWorkLogRepository.checkDuplicate = ORIGINAL.checkDuplicate;
  employeeWorkLogRepository.update = ORIGINAL.update;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = ORIGINAL.teDeleteByWorkLogId;
  servicePOHierarchyRepository.findByIdAndServicePOWithParent = ORIGINAL.findByIdAndServicePOWithParent;
}

function stubCommonDeps() {
  employeeServicePOMappingRepository.findByEmployeeAndPO = async () => ({ status: 'active' });
  timesheetService.resolveManualEntryReferences = async () => ({ po: { service_po_name: 'PO One' } });
  employeeRepository.findById = async () => ({ is_timesheet_approval_required: false });
  employeeWorkLogRepository.hasMonthlyEntry = async () => false;
  employeeWorkLogRepository.getMonthEntryModeSummary = async () => ({ hasMonthly: false, hasTimeBased: false, hasHourly: false });
  employeeWorkLogRepository.findAll = async () => ({ rows: [] });
  employeeWorkLogRepository.markApprovedByIds = async () => 1;
  employeeWorkLogRepository.getDailyHours = async () => 0;
  servicePOHierarchyRepository.findByIdAndServicePOWithParent = async (id) => (id ? { id, node_name: `Node ${id}`, node_type: 'PARENT' } : null);
}

function captureWrites() {
  let capturedRows;
  employeeWorkLogRepository.deleteByEmployeeAndDate = async () => 0;
  employeeWorkLogRepository.bulkCreate = async (rows) => {
    capturedRows = rows;
    return rows.map((r, i) => ({ id: 900 + i, get: () => ({ id: 900 + i, ...r }) }));
  };
  employeeWorkLogTimeEntryRepository.bulkCreate = async () => [];
  return { getRows: () => capturedRows };
}

// ── Joi layer: HOURLY still requires description; TIME_BASED does not.

test('Joi: a plain HOURLY line (no time_entries) still requires description', () => {
  const { error } = replaceDailyEntriesSchema.validate({
    timesheet_date: '2026-08-27',
    entries: [{ service_po_id: 378, hours: 4 }],
  });
  assert.ok(error);
  assert.match(error.message, /Description is required/);
});

test('Joi: a TIME_BASED line with NO description anywhere (line or segments) is valid', () => {
  const { error } = replaceDailyEntriesSchema.validate({
    timesheet_date: '2026-08-27',
    entries: [{
      service_po_id: 378,
      hierarchy_node_id: 101,
      time_entries: [{ start_time: '09:00', end_time: '10:00' }],
    }],
  });
  assert.equal(error, undefined);
});

test('Joi: full replaceDailyEntries payload with no description anywhere is accepted', () => {
  const { error } = replaceDailyEntriesSchema.validate({
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
    ],
  });
  assert.equal(error, undefined);
});

// ── Service layer: replaceDailyEntries — a TIME_BASED line with no
// description anywhere defaults to blank, never rejected.

test('replaceDailyEntries: a TIME_BASED line with no description at all (line or segment) is saved with a blank description', async () => {
  stubCommonDeps();
  const { getRows } = captureWrites();

  const result = await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
    ],
  });

  assert.equal(getRows()[0].description, '');
  assert.equal(result[0].time_entries[0].description, '');

  restore();
});

test('replaceDailyEntries: a TIME_BASED line WITH a line-level description but a segment with none falls back correctly, still never blank-rejected', async () => {
  stubCommonDeps();
  const { getRows } = captureWrites();

  await employeeTimesheetService.replaceDailyEntries(101, 10, {
    timesheet_date: '2026-08-27',
    entries: [
      { service_po_id: 378, hierarchy_node_id: 101, description: 'Line description', time_entries: [{ start_time: '09:00', end_time: '10:00' }] },
    ],
  });

  assert.equal(getRows()[0].description, 'Line description');

  restore();
});

// ── Service layer: updateEntry — description may be blank.

test('updateEntry: an explicit blank description is accepted, not rejected', async () => {
  stubCommonDeps();
  employeeWorkLogRepository.findByIdForEmployee = async () => ({
    id: 80,
    service_po_id: 378,
    sub_project_id: null,
    hierarchy_node_id: 101,
    work_date: '2026-08-27',
    hours: 1,
    status: 'pending',
    description: 'Old',
    timeEntries: [{ start_time: '09:00', end_time: '10:00' }],
  });
  employeeWorkLogRepository.checkDuplicate = async () => null;
  employeeWorkLogTimeEntryRepository.deleteByWorkLogId = async () => 1;
  employeeWorkLogTimeEntryRepository.bulkCreate = async () => [];

  let capturedUpdatePayload;
  employeeWorkLogRepository.update = async (id, data) => {
    capturedUpdatePayload = data;
    return { get: () => ({ id, ...data }) };
  };

  await employeeTimesheetService.updateEntry(101, 10, 80, { description: '' });

  assert.equal(capturedUpdatePayload.description, '');

  restore();
});
