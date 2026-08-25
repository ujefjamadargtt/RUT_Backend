'use strict';
// Temporary script — applies the held-out employee-identity-redesign
// migrations against rut_db_test_employee_identity ONLY (never touches
// database/migrations/ or the live DB). Safe to delete once done.
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const TEST_DB = 'rut_db_test_employee_identity';
const PENDING_DIR = path.resolve(__dirname, '../database/_pending_employee_identity_redesign_migrations');

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: TEST_DB,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await client.connect();

  const files = fs
    .readdirSync(PENDING_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_rollback.sql'))
    .sort();

  const { rows: applied } = await client.query('SELECT name FROM schema_migrations');
  const appliedSet = new Set(applied.map((r) => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip ${file} (already applied)`);
      continue;
    }
    console.log(`Applying ${file}...`);
    const sql = fs.readFileSync(path.join(PENDING_DIR, file), 'utf8');
    try {
      await client.query(sql);
    } catch (err) {
      console.error(`FAILED at ${file}: ${err.message}`);
      throw err;
    }
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    console.log(`  OK`);
  }

  await client.end();
  console.log('\nAll pending migrations applied to test DB.');
}

main().catch((err) => {
  console.error('Apply failed:', err.message);
  process.exit(1);
});
