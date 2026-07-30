try {
  require('../src/services/monthlyCostService');
  console.log('MODULE_OK');
} catch (err) {
  console.error('MODULE_ERROR');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 2;
}
