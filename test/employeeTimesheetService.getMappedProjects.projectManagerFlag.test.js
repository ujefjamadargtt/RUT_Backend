'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Section 10 of the PM redesign spec — Employee Service PO Loading: when a
// Project Manager logs in as an Employee, getMappedProjects() (the Service
// PO dropdown source for the Employee Self Timesheet form) must keep
// returning EVERY actively-mapped Service PO regardless of is_project_manager
// (never filtered down to only the PO(s) they're explicitly PM for), while
// also exposing is_project_manager on each entry so the frontend can badge
// which one(s) they are the PM for.
const employeeServicePOMappingRepository = require('../src/repositories/employeeServicePOMappingRepository');
const servicePOHierarchyRepository = require('../src/repositories/servicePOHierarchyRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');

const ORIGINAL = {
  findAllByEmployee: employeeServicePOMappingRepository.findAllByEmployee,
  findByServicePOIds: servicePOHierarchyRepository.findByServicePOIds,
};

function restore() {
  employeeServicePOMappingRepository.findAllByEmployee = ORIGINAL.findAllByEmployee;
  servicePOHierarchyRepository.findByServicePOIds = ORIGINAL.findByServicePOIds;
}

test('getMappedProjects: returns ALL active mappings regardless of is_project_manager, each carrying its own flag', async () => {
  try {
    // Employee A: PO 101 (PM) / PO 102 (plain) / PO 103 (plain) / PO 104 (PM)
    // — exactly the Section 19 "Expected Final Behavior" example.
    employeeServicePOMappingRepository.findAllByEmployee = async (employeeId, status) => {
      assert.equal(employeeId, 501);
      assert.equal(status, 'active');
      return [
        { service_po_id: 101, is_project_manager: true, servicePO: { id: 101, service_po_code: 'PO-101', service_po_name: 'Alpha' } },
        { service_po_id: 102, is_project_manager: false, servicePO: { id: 102, service_po_code: 'PO-102', service_po_name: 'Beta' } },
        { service_po_id: 103, is_project_manager: false, servicePO: { id: 103, service_po_code: 'PO-103', service_po_name: 'Gamma' } },
        { service_po_id: 104, is_project_manager: true, servicePO: { id: 104, service_po_code: 'PO-104', service_po_name: 'Delta' } },
      ];
    };
    servicePOHierarchyRepository.findByServicePOIds = async () => [];

    const projects = await employeeTimesheetService.getMappedProjects(501, 10);

    assert.deepEqual(projects.map((p) => p.id).sort((a, b) => a - b), [101, 102, 103, 104]);
    const pmFlagById = new Map(projects.map((p) => [p.id, p.is_project_manager]));
    assert.equal(pmFlagById.get(101), true);
    assert.equal(pmFlagById.get(102), false);
    assert.equal(pmFlagById.get(103), false);
    assert.equal(pmFlagById.get(104), true);
  } finally {
    restore();
  }
});

test('getMappedProjects: a plain Employee with zero PM-flagged mappings still sees every one of their mapped Service POs, each reporting is_project_manager: false', async () => {
  try {
    employeeServicePOMappingRepository.findAllByEmployee = async () => [
      { service_po_id: 201, is_project_manager: false, servicePO: { id: 201, service_po_code: 'PO-201', service_po_name: 'Solo' } },
    ];
    servicePOHierarchyRepository.findByServicePOIds = async () => [];

    const projects = await employeeTimesheetService.getMappedProjects(101, 10);

    assert.equal(projects.length, 1);
    assert.equal(projects[0].is_project_manager, false);
  } finally {
    restore();
  }
});
