// database/ai.sql is additive and reversible: migrate -> rollback -> migrate on a throwaway
// database (it_hams_migration_test), checking that rollback removes exactly what ai.sql added.
// Skipped when PostgreSQL is not reachable with the .env login.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const DB = 'it_hams_migration_test';
const root = path.join(__dirname, '..');
const AI_TABLES = ['ai_feature_snapshots', 'ai_asset_events', 'ai_models', 'ai_recommendations', 'ai_feedback'];
const M2_TABLES = ['ai_dq_runs', 'ai_dq_issues', 'ai_predictions'];

function cli(...args) {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'hams-cli.js'), ...args], {
    cwd: root, env: { ...process.env, DB_NAME: DB }, encoding: 'utf8'
  });
  assert.equal(r.status, 0, `hams-cli ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

test('ai.sql migrates, rolls back cleanly and migrates again', { timeout: 180000 }, async t => {
  require('dotenv').config({ path: path.join(root, '.env') });
  const conn = database => new Client({
    host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER, password: process.env.DB_PASS, database
  });
  const admin = conn('postgres');
  try { await admin.connect(); } catch (err) { return t.skip(`PostgreSQL not reachable: ${err.message}`); }
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  const c = conn(DB);
  t.after(async () => {
    await c.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await admin.end();
  });

  cli('migrate');
  cli('seed');
  await c.connect();
  const state = async () => {
    const tables = (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ai\\_%' ORDER BY 1`)).rows.map(r => r.table_name);
    const one = async sql => Number((await c.query(sql)).rows[0].n);
    return {
      tables,
      module: await one(`SELECT COUNT(*) AS n FROM modules WHERE name = 'ai'`),
      perms: await one(`SELECT COUNT(*) AS n FROM permissions WHERE module = 'ai'`),
      grants: await one(`SELECT COUNT(*) AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.module = 'ai'`),
      migration: await one(`SELECT COUNT(*) AS n FROM migrations WHERE migration = 'ai.sql'`),
      otherTables: await one(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE 'ai\\_%'`),
      otherPerms: await one(`SELECT COUNT(*) AS n FROM permissions WHERE module <> 'ai'`),
      assets: await one('SELECT COUNT(*) AS n FROM assets')
    };
  };

  const full = await state();
  assert.deepEqual(full.tables, [...AI_TABLES, ...M2_TABLES].sort());
  // Newest first: ai_m2.sql, then ai.sql.
  assert.match(cli('migrate:rollback', 'ai_m2.sql'), /Rolled back ai_m2\.sql/);
  const up = await state();
  assert.deepEqual(up.tables, [...AI_TABLES].sort(), 'ai_m2 rollback removes only its own tables');
  assert.equal(up.otherTables, full.otherTables);
  assert.equal(up.module, 1);
  assert.equal(up.perms, 3);
  assert.equal(up.grants, 10, 'super/it admin 3 each, asset manager and SPOC 2 each');
  assert.equal(up.migration, 1);
  assert.equal(Number((await c.query(`SELECT COUNT(*) AS n FROM modules WHERE name = 'ai' AND is_active`)).rows[0].n), 0, 'AI module starts off');
  await c.query(`INSERT INTO settings (group_key, setting_key, setting_value) VALUES ('ai', 'snapshots', '1')`);

  assert.match(cli('migrate:rollback', 'ai.sql'), /Rolled back ai\.sql/);
  const down = await state();
  assert.deepEqual(down.tables, []);
  assert.equal(down.module + down.perms + down.grants + down.migration, 0);
  assert.equal(Number((await c.query(`SELECT COUNT(*) AS n FROM settings WHERE group_key = 'ai'`)).rows[0].n), 0);
  assert.equal(down.otherTables, up.otherTables, 'no other table touched');
  assert.equal(down.otherPerms, up.otherPerms);
  assert.equal(down.assets, up.assets);
  assert.match(cli('migrate:rollback', 'ai.sql'), /not applied/);

  cli('migrate');
  const again = await state();
  assert.deepEqual(again.tables, full.tables, 'both migrations apply again');
  assert.equal(again.migration, 1);
});
