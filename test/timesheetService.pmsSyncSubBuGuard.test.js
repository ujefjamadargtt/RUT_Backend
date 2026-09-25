'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Same monkey-patch style as this codebase's other service tests —
// timesheetService.js holds live references to these SAME module-cached
// objects.
const companyRepository = require('../src/repositories/companyRepository');
const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const timesheetImportRepository = require('../src/repositories/timesheetImportRepository');
const timesheetService = require('../src/services/timesheetService');

/**
 * BU Hierarchy / Sub-BU support — "Sync Employee Work Logs" now runs
 * strictly per-Business-Unit: a Business Unit that currently has Sub-BUs
 * cannot be synced directly ("only Sub-BU wise sync" per the confirmed
 * requirement); the caller must sync each Sub-BU individually. A Business
 * Unit with no Sub-BUs keeps the existing single-company sync behavior
 * completely unchanged.
 */

const ORIGINAL = {
  hasChildren: companyRepository.hasChildren,
  findForSync: employeeWorkLogRepository.findForSync,
  findImportById: timesheetImportRepository.findImportById,
};

function restore() {
  companyRepository.hasChildren = ORIGINAL.hasChildren;
  employeeWorkLogRepository.findForSync = ORIGINAL.findForSync;
  timesheetImportRepository.findImportById = ORIGINAL.findImportById;
}

test('previewPmsImport(): rejects syncing a Business Unit that currently has Sub-BUs, without reading any work logs', async () => {
  try {
    companyRepository.hasChildren = async (id) => id === 40; // "DATA + AI" has Sub-BU "DAS"
    employeeWorkLogRepository.findForSync = async () => {
      throw new Error('must not be called — the Sub-BU guard must reject before any work logs are read');
    };

    await assert.rejects(
      () => timesheetService.previewPmsImport(7, 2031, 1, 40),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Sub-BUs/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('previewPmsImport(): a Business Unit with no Sub-BUs proceeds exactly as before (unchanged, reaches findForSync)', async () => {
  try {
    companyRepository.hasChildren = async () => false; // e.g. "DAS" itself, or any BU with no children
    employeeWorkLogRepository.findForSync = async () => { throw new Error('__reached_findForSync__'); };

    await assert.rejects(
      () => timesheetService.previewPmsImport(7, 2031, 1, 42),
      (err) => err.message === '__reached_findForSync__'
    );
  } finally {
    restore();
  }
});

test('confirmImport(): rejects confirming a pending "pms" import whose Business Unit now has Sub-BUs (defense-in-depth)', async () => {
  try {
    timesheetImportRepository.findImportById = async () => ({
      id: 99, status: 'pending', source: 'pms', valid_rows: 1, import_month: 7, import_year: 2031,
    });
    companyRepository.hasChildren = async () => true;
    employeeWorkLogRepository.findForSync = async () => {
      throw new Error('must not be called — the Sub-BU guard must reject before any work logs are read');
    };

    await assert.rejects(
      () => timesheetService.confirmImport(99, 1, '127.0.0.1', 40),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Sub-BUs/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('confirmImport(): an Excel-source ("import") pending record is never subject to the Sub-BU sync guard, even if the Business Unit has Sub-BUs', async () => {
  try {
    timesheetImportRepository.findImportById = async () => ({
      id: 98, status: 'pending', source: 'import', valid_rows: 1, file_path: 'does-not-exist.xlsx', file_name: 'x.xlsx',
    });
    let hasChildrenCalled = false;
    companyRepository.hasChildren = async () => {
      hasChildrenCalled = true;
      return true;
    };

    // The Excel path fails downstream (file genuinely doesn't exist on
    // disk) — that failure is expected and irrelevant here; only whether
    // the Sub-BU guard ran is under test.
    await assert.rejects(() => timesheetService.confirmImport(98, 1, '127.0.0.1', 40));
    assert.equal(hasChildrenCalled, false, 'the Sub-BU sync guard must only apply to source: "pms"');
  } finally {
    restore();
  }
});
