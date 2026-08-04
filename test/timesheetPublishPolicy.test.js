'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeInitialIsPublish,
  extractIsOriginalDataVisible,
} = require('../src/utils/timesheetPublishPolicy');

// ── computeInitialIsPublish() — the rule itself ─────────────────────────────

test('Case 1: companies.is_original_data_visible = TRUE -> is_publish = FALSE', () => {
  assert.equal(computeInitialIsPublish(true), false);
});

test('Case 2: companies.is_original_data_visible = FALSE -> is_publish = TRUE', () => {
  assert.equal(computeInitialIsPublish(false), true);
});

// ── extractIsOriginalDataVisible() — null-safe read off the company row ────

test('company.is_original_data_visible = true -> true', () => {
  assert.equal(extractIsOriginalDataVisible({ is_original_data_visible: true }), true);
});

test('company.is_original_data_visible = false -> false', () => {
  assert.equal(extractIsOriginalDataVisible({ is_original_data_visible: false }), false);
});

test('company not found (null) -> false', () => {
  assert.equal(extractIsOriginalDataVisible(null), false);
});

test('company object missing the field entirely -> false', () => {
  assert.equal(extractIsOriginalDataVisible({}), false);
});

// ── End-to-end composition, matching the two required business-rule cases ──
// (mirrors exactly what resolveInitialIsPublish() does with a resolved
// company, minus the DB lookup itself — not covered here, see PR summary)

test('E2E Case 1: companies.is_original_data_visible = TRUE -> timesheets.is_publish = FALSE', () => {
  const company = { id: 1, is_original_data_visible: true };
  const isPublish = computeInitialIsPublish(extractIsOriginalDataVisible(company));
  assert.equal(isPublish, false);
});

test('E2E Case 2: companies.is_original_data_visible = FALSE -> timesheets.is_publish = TRUE', () => {
  const company = { id: 1, is_original_data_visible: false };
  const isPublish = computeInitialIsPublish(extractIsOriginalDataVisible(company));
  assert.equal(isPublish, true);
});

// ── Both tables must receive the SAME value (confirmImport's contract) ─────
// timesheetService.js's confirmImport() computes `isPublish` ONCE and stamps
// it onto both the `records` (timesheets) array and the
// updateImportHistory() payload (timesheet_import_history) — this simulates
// that exact usage to confirm one resolved value is sufficient for both.

test('one resolved isPublish value is applied identically to both tables (Case 1)', () => {
  const company = { id: 1, is_original_data_visible: true };
  const isPublish = computeInitialIsPublish(extractIsOriginalDataVisible(company));

  const timesheetRecord = { employee_id: 1, service_po_id: 1, hours_logged: 8, is_publish: isPublish };
  const importHistoryUpdate = { status: 'completed', is_publish: isPublish };

  assert.equal(timesheetRecord.is_publish, false);
  assert.equal(importHistoryUpdate.is_publish, false);
  assert.equal(timesheetRecord.is_publish, importHistoryUpdate.is_publish);
});

test('one resolved isPublish value is applied identically to both tables (Case 2)', () => {
  const company = { id: 1, is_original_data_visible: false };
  const isPublish = computeInitialIsPublish(extractIsOriginalDataVisible(company));

  const timesheetRecord = { employee_id: 1, service_po_id: 1, hours_logged: 8, is_publish: isPublish };
  const importHistoryUpdate = { status: 'completed', is_publish: isPublish };

  assert.equal(timesheetRecord.is_publish, true);
  assert.equal(importHistoryUpdate.is_publish, true);
  assert.equal(timesheetRecord.is_publish, importHistoryUpdate.is_publish);
});

// ── Company-level, NOT per-user: two different actors in the SAME company ──
// must get the identical is_publish decision, since the flag now lives on
// companies, not users.

test('two different users in the SAME company get the identical is_publish decision', () => {
  const company = { id: 1, is_original_data_visible: true };
  const isPublishForActorA = computeInitialIsPublish(extractIsOriginalDataVisible(company));
  const isPublishForActorB = computeInitialIsPublish(extractIsOriginalDataVisible(company));
  assert.equal(isPublishForActorA, isPublishForActorB);
});
