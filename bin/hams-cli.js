#!/usr/bin/env node
// Port of hams-cli: migrate, seed, routes, archive:purge, logs:cleanup,
// reports:run-schedules, backup:run-schedules, tokens:prune.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../src/core/db');
const config = require('../src/config');

const command = process.argv[2] || 'help';

async function ensureMigrationsTable() {
  await db.run(`CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY, migration VARCHAR(255) NOT NULL, batch INT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}

async function migrate() {
  await ensureMigrationsTable();
  const dir = path.join(config.rootDir, 'database');
  const files = ['schema.sql', 'heartbeat.sql', 'agents.sql', 'software.sql', 'new_joinees.sql', 'software_allocation.sql', 'software_prices.sql', 'performance_indexes.sql', 'security_hardening.sql', 'joinee_notifications.sql', 'optional_user_email.sql', 'location_spocs.sql', 'site_spoc_contacts.sql', 'ai.sql', 'ai_m2.sql', 'ai_m7.sql', 'ai_m8.sql'];
  const applied = (await db.query('SELECT migration FROM migrations')).map(r => r.migration);
  const batchRow = await db.get('SELECT COALESCE(MAX(batch), 0) + 1 AS b FROM migrations');
  const batch = batchRow.b;
  for (const file of files) {
    if (applied.includes(file)) {
      console.log(`~ ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`> Applying ${file}...`);
    await db.run(sql);
    await db.run('INSERT INTO migrations (migration, batch) VALUES ($1, $2)', [file, batch]);
    console.log(`  OK`);
  }
  console.log('Migrations complete.');
}

// Undo one applied migration with its database/<name>.down.sql script (in one transaction).
async function rollback(file) {
  const name = path.basename(String(file || ''));
  if (!/^[\w.-]+\.sql$/.test(name) || name.endsWith('.down.sql')) {
    throw new Error('Usage: node bin/hams-cli.js migrate:rollback <migration.sql>');
  }
  const down = path.join(config.rootDir, 'database', name.replace(/\.sql$/, '.down.sql'));
  if (!fs.existsSync(down)) throw new Error(`No rollback script for ${name} (expected database/${path.basename(down)}).`);
  await ensureMigrationsTable();
  if (!(await db.get('SELECT id FROM migrations WHERE migration = $1', [name]))) {
    console.log(`${name} is not applied; nothing to roll back.`);
    return;
  }
  const sql = fs.readFileSync(down, 'utf8');
  await db.tx(async t => {
    await t.run(sql);
    await t.run('DELETE FROM migrations WHERE migration = $1', [name]);
  });
  console.log(`Rolled back ${name}.`);
}

async function seed() {
  console.log('Seeding Enterprise Data...');
  const sql = fs.readFileSync(path.join(config.rootDir, 'database', 'seed.sql'), 'utf8');
  await db.run(sql);
  // Admin user with a random one-time password (shown once here); the account must
  // set its own password at first sign-in. No credential is hard-coded.
  const existing = await db.get(`SELECT id FROM users WHERE email = 'admin@hams.inc'`);
  if (!existing) {
    const oneTime = require('crypto').randomBytes(12).toString('base64url');
    const hash = await bcrypt.hash(oneTime, 10);
    const adminId = await db.insert(
      `INSERT INTO users (name, email, password, role, status, must_change_password)
       VALUES ('Administrator', 'admin@hams.inc', $1, 'super_admin', 'active', TRUE)`,
      [hash]);
    const role = await db.get(`SELECT id FROM roles WHERE name = 'super_admin'`);
    if (role) {
      await db.run('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [adminId, role.id]);
    }
    console.log('  Admin user created: admin@hams.inc');
    console.log(`  One-time password: ${oneTime}   (shown only now; you must change it at first sign-in)`);
  } else {
    console.log('  Admin user already exists.');
  }
  // Demo assets (port of demo_data.sql)
  const demo = [
    ['MacBook Pro M3', 'QW98122', 'A2991', 'Laptop', '2026-01-15', '2027-01-15'],
    ['Dell XPS 15', 'DXP9021', '9530', 'Laptop', '2026-02-10', '2027-02-10'],
    ['Logitech MX Master 3S', 'LMX302', 'MXM3S', 'Accessory', '2026-03-05', '2027-03-05']
  ];
  const crypto = require('crypto');
  for (const [name, serial, model, category, pd, we] of demo) {
    const dup = await db.get('SELECT id FROM assets WHERE serial_number = $1', [serial]);
    if (dup) continue;
    const tag = await require('../src/services/assetService').nextAssetTag();
    await db.run(
      `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category, status,
         category_id, status_label_id, purchase_date, warranty_expiry)
       VALUES ($1, $2, $3, $4, $5, $6, 'available',
         (SELECT id FROM asset_categories WHERE name = $7),
         (SELECT id FROM status_labels WHERE name = 'Ready to Deploy'), $8, $9)`,
      [tag, crypto.randomBytes(16).toString('hex'), name, serial, model, category, category, pd, we]);
    console.log(`  Demo asset: ${name} (${tag})`);
  }
  console.log('Seed complete.');
}

async function main() {
  try {
    switch (command) {
      case 'migrate': await migrate(); break;
      case 'migrate:rollback': await rollback(process.argv[3]); break;
      case 'seed': await seed(); break;
      case 'routes':
        console.log('Routes are defined in src/routes/*.js');
        break;
      case 'archive:purge': {
        const archiveService = require('../src/services/archiveService');
        const count = await archiveService.purgeExpired();
        console.log(`Purged ${count} expired archived record(s).`);
        break;
      }
      case 'logs:cleanup': {
        const logService = require('../src/services/logService');
        const count = await logService.enforceRetention();
        console.log(`Log retention enforced: ${count} file(s) processed.`);
        break;
      }
      case 'reports:run-schedules': {
        const reportSchedules = require('../src/services/reportScheduleService');
        const count = await reportSchedules.runDue();
        console.log(`Executed ${count} due report schedule(s).`);
        break;
      }
      case 'backup:run-schedules': {
        const backupService = require('../src/services/backupService');
        const count = await backupService.runDueSchedules(null);
        console.log(`Executed ${count} due backup schedule(s).`);
        break;
      }
      case 'tokens:prune': {
        const apiTokenService = require('../src/services/apiTokenService');
        const count = await apiTokenService.pruneExpired();
        console.log(`Pruned ${count} expired API token(s).`);
        break;
      }
      case 'joinees:recommend': {
        // Generate New Joinee allocation recommendations ahead of time (e.g. after a
        // bulk joinee import or from cron) so the first page view doesn't do it.
        const newJoineeService = require('../src/services/newJoineeService');
        const count = await newJoineeService.ensureDrafts();
        console.log(`Drafted recommendations for ${count} new joinee(s); SPOC review still required.`);
        break;
      }
      case 'ai:eval': {
        // Read-only: measures the AI on the current database and prints the report.
        await require('../src/ai/eval/run').main(process.argv[3] || '2024-01-01');
        break;
      }
      case 'insights:refresh': {
        // Recompute laptop quality grades and stock sites (also runs after imports and asset saves).
        const r = await require('../src/services/laptopInsightService').refresh();
        console.log(`Laptop insights: ${r.checked} assets checked, ${r.changed} updated in ${r.ms} ms.`);
        break;
      }
      default:
        console.log(`IT-HAMS CLI
Usage: node bin/hams-cli.js <command>

Commands:
  migrate                 Apply database schema
  migrate:rollback <f>    Undo one migration with database/<f>.down.sql (e.g. ai.sql)
  seed                  Seed reference + demo data (prints a one-time admin password)
  routes                  Route info
  archive:purge           Purge expired soft-deleted records
  logs:cleanup            Enforce log retention policy
  reports:run-schedules   Execute due report schedules
  backup:run-schedules    Execute due backup schedules
  joinees:recommend       Generate New Joinee allocation recommendations
  insights:refresh        Recompute laptop quality grades and current locations
  ai:eval [cutoff|part]   Measure the AI on this database (read-only; time split at cutoff, default 2024-01-01;
                          part = search, lifecycle, anomaly, cost, nl, agents or drift for that part only)
  tokens:prune            Delete expired API tokens`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
