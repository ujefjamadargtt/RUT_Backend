'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const monthlyCostService = require('./src/services/monthlyCostService');

(async () => {
  const filePath = path.resolve(__dirname, 'tmpmonthly.xlsx');
  const data = [{
    Name: 'Aditya Uday patil',
    'Month Year': 'Jan 2025',
    'Salary Cost': 1000,
    'Ops Cost': 200,
    'Total Cost': 1200,
    'Billable Cost': 1200,
  }];

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filePath);

  // importFromExcel now reads the target Business Unit from req.body.business_unit_id
  // (required) rather than inferring one from the caller's session — edit the
  // values below to match a real BU-scoped user/BU id in your local DB before running.
  const req = {
    body: { business_unit_id: '34' },
    companyId: 34,
    hierarchyRank: 6,
    employeeId: 1,
  };

  try {
    const result = await monthlyCostService.importFromExcel(filePath, 1, '127.0.0.1', req);
    console.log('RESULT', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('ERROR', err);
    if (err.errors) console.error('ERR_ERRORS', JSON.stringify(err.errors, null, 2));
    process.exit(1);
  }
})();
