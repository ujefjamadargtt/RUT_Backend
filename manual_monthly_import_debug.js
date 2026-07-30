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

  try {
    const result = await monthlyCostService.importFromExcel(filePath, 1, '127.0.0.1');
    console.log('RESULT', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('ERROR', err);
    if (err.errors) console.error('ERR_ERRORS', JSON.stringify(err.errors, null, 2));
    process.exit(1);
  }
})();
