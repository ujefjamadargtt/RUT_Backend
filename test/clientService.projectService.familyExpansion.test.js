'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const clientRepository = require('../src/repositories/clientRepository');
const projectRepository = require('../src/repositories/projectRepository');
const { Company } = require('../src/models');
const clientService = require('../src/services/clientService');
const projectService = require('../src/services/projectService');

/**
 * BU Hierarchy / Sub-BU support — clientService.getAll()/projectService.getAll()
 * now expand a BU-scoped actor's single active BU to its whole Parent +
 * Sub-BU family before filtering. This is what powers the Client dropdown
 * on the Project/Service PO creation forms (and the Client/Project Master
 * lists themselves): a BU Admin active on Sub-BU "DAS" (42, parent "DATA +
 * AI" 23) must still see a Client/Project that lives at the Parent level
 * (e.g. "Alpharithm", created before Sub-BUs existed) — matching what
 * resolveCreateCompanyIdForActor() already allows them to create records
 * under.
 */

const ORIGINAL = {
  clientFindAll: clientRepository.findAll,
  projectFindAll: projectRepository.findAll,
  companyFindAll: Company.findAll,
};

function restore() {
  clientRepository.findAll = ORIGINAL.clientFindAll;
  projectRepository.findAll = ORIGINAL.projectFindAll;
  Company.findAll = ORIGINAL.companyFindAll;
}

test('clientService.getAll(): active on Sub-BU "DAS" (42) — the filter reach expands to include its Parent "DATA + AI" (23) and siblings', async () => {
  try {
    Company.findAll = async ({ where }) => {
      // 1st call (expandBusinessUnitIdsToFamily): resolve 42's own row to
      // find its parent. 2nd call (companyRepository.findFamilyMembers):
      // every member of the family rooted at 23.
      return where.id
        ? [{ id: 42, parent_business_unit_id: 23 }]
        : [
          { id: 23, parent_business_unit_id: null },
          { id: 42, parent_business_unit_id: 23 },
          { id: 43, parent_business_unit_id: 23 },
          { id: 44, parent_business_unit_id: 23 },
        ];
    };
    let capturedFilters;
    clientRepository.findAll = async (filters) => {
      capturedFilters = filters;
      return { rows: [], count: 0 };
    };

    const authContext = { companyId: 42, hierarchyRank: 4, employeeId: 900 };
    await clientService.getAll({}, authContext);

    assert.deepEqual(capturedFilters.companyId.sort((a, b) => a - b), [23, 42, 43, 44]);
  } finally {
    restore();
  }
});

test('projectService.getAll(): active on Sub-BU "DAS" (42) — the filter reach expands to include its Parent "DATA + AI" (23) and siblings', async () => {
  try {
    Company.findAll = async ({ where }) => {
      return where.id
        ? [{ id: 42, parent_business_unit_id: 23 }]
        : [
          { id: 23, parent_business_unit_id: null },
          { id: 42, parent_business_unit_id: 23 },
          { id: 43, parent_business_unit_id: 23 },
          { id: 44, parent_business_unit_id: 23 },
        ];
    };
    let capturedFilters;
    projectRepository.findAll = async (filters) => {
      capturedFilters = filters;
      return { rows: [], count: 0 };
    };

    const authContext = { companyId: 42, hierarchyRank: 4, employeeId: 900 };
    await projectService.getAll({}, authContext);

    assert.deepEqual(capturedFilters.companyId.sort((a, b) => a - b), [23, 42, 43, 44]);
  } finally {
    restore();
  }
});
