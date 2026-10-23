#!/usr/bin/env node
// Creates (or with --reset, re-creates) the empty test database used by `npm test`:
// schema + seed only, no company data. Same server and login as .env, database name from
// TEST_DB_NAME (default it_hams_test). Refuses any name that doesn't end in "_test", so it can
// never touch the real database.
//
//   node tools/setup-test-db.js            create if missing, then migrate + seed
//   node tools/setup-test-db.js --reset    drop and create again
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });
const { Client } = require('pg');

const name = process.env.TEST_DB_NAME || 'it_hams_test';
if (!/^[a-z0-9_]+_test$/.test(name)) {
  console.error(`Refusing: test database name must end in "_test" (got "${name}").`);
  process.exit(1);
}
const reset = process.argv.includes('--reset');

function cli(command) {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'hams-cli.js'), command], {
    cwd: root, env: { ...process.env, DB_NAME: name }, encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`hams-cli ${command} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

(async () => {
  const admin = new Client({
    host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: 'postgres'
  });
  await admin.connect();
  const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
  if (exists && reset) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE "${name}"`);
    console.log(`Dropped ${name}.`);
  }
  if (!exists || reset) {
    await admin.query(`CREATE DATABASE "${name}"`);
    console.log(`Created ${name}.`);
  }
  await admin.end();

  process.stdout.write(cli('migrate'));
  const seeded = cli('seed');
  console.log(seeded.split('\n').filter(l => !/one-time password/i.test(l)).join('\n'));

  // Same boot step as src/server.js: the generated assets.stock_site column.
  process.env.DB_NAME = name;
  const db = require('../src/core/db');
  await require('../src/services/stockSiteService').ensureStockSiteColumn(db);
  await db.pool.end();
  console.log(`Test database ${name} is ready.`);
})().catch(err => { console.error(err.message); process.exit(1); });
