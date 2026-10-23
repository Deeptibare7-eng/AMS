// Daily folder import: picks up the Asset Data register from watched folders (e.g. a
// synced OneDrive or network folder) and imports it with the same code as the Import
// Data page. Run by schedulerService every 30 minutes.
//
// - Files are recognised by their columns, not their names. Only .xlsx files unchanged
//   for 2 minutes are read, so files still syncing are left for the next check.
// - Each file is handled once (remembered by path, size and modified time). The register
//   is a full snapshot, so only the newest file is imported; a file whose content
//   matches the last import is skipped.
// - The register import never deletes anything (see assetRegisterSync). It is applied
//   automatically only within the safety limits; otherwise it is held for review and
//   admins are alerted.
// - Files are never moved, renamed or changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../core/db');
const config = require('../config');
const settings = require('./settingsService');
const sync = require('./assetRegisterSync');
const { readRegister } = require('./assetRegister');
const digest = require('./alertDigestService');
const { e } = require('../core/helpers');

const SETTLE_MS = 2 * 60 * 1000;
const STATE_KEY = 'folder_import';
const MAX_SEEN = 200;
const DEFAULTS = { import_folders: '', import_register_mode: 'auto', import_max_alloc_changes: '300', import_max_update_pct: '10', import_actor_id: '' };
const TYPE_LABEL = { register: 'Asset Data register' };

const parseFolders = v => [...new Set(String(v || '').split(/[\r\n;]+/).map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean))];

async function getConfig() {
  const g = k => settings.get('automation', k, DEFAULTS[k]);
  return {
    folders: parseFolders(await g('import_folders')),
    mode: (await g('import_register_mode')) === 'review' ? 'review' : 'auto',
    maxAlloc: Math.max(0, parseInt(await g('import_max_alloc_changes'), 10) || 0),
    maxUpdatePct: Math.max(0, parseFloat(await g('import_max_update_pct')) || 0),
    actorId: parseInt(await g('import_actor_id'), 10) || null
  };
}

// Problems with a folder list, for validating the settings form.
function folderProblems(folders) {
  const out = [];
  for (const dir of folders) {
    if (!path.isAbsolute(dir)) { out.push(`"${dir}" is not a full path`); continue; }
    try {
      if (!fs.statSync(dir).isDirectory()) out.push(`"${dir}" is not a folder`);
      else fs.readdirSync(dir);
    } catch (err) {
      out.push(`"${dir}": ${err.code === 'ENOENT' ? 'folder not found on this server' : err.code === 'EACCES' || err.code === 'EPERM' ? 'no permission to read it' : err.message}`);
    }
  }
  return out;
}

// ───────────────────────────── state ─────────────────────────────

async function readState() {
  const row = await db.get(`SELECT setting_value FROM settings WHERE group_key = 'scheduler_state' AND setting_key = $1`, [STATE_KEY]);
  let s = null;
  try { s = row ? JSON.parse(row.setting_value) : null; } catch (_) {}
  return { seen: [], last: {}, ...(s || {}) };
}
async function writeState(state) {
  state.seen = state.seen.slice(-MAX_SEEN);
  await db.run(
    `INSERT INTO settings (group_key, setting_key, setting_value) VALUES ('scheduler_state', $1, $2)
     ON CONFLICT (group_key, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
    [STATE_KEY, JSON.stringify(state)]);
}

// ───────────────────────────── files ─────────────────────────────

function listFiles(folders) {
  const files = [], errors = [];
  for (const dir of folders) {
    let names;
    try { names = fs.readdirSync(dir); } catch (err) { errors.push(`${dir}: ${err.code === 'ENOENT' ? 'folder not found' : err.message}`); continue; }
    for (const name of names) {
      if (!/\.xlsx$/i.test(name) || name.startsWith('~$')) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (!st.isFile() || !st.size) continue;
      files.push({ name, full, size: st.size, mtime: st.mtimeMs, fp: `${full}|${st.size}|${Math.round(st.mtimeMs)}`, settled: Date.now() - st.mtimeMs >= SETTLE_MS });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { files, errors };
}

// Identify a workbook by its columns. Returns { type, parsed } or null.
async function detect(buffer) {
  try {
    const parsed = await readRegister(buffer);
    if (parsed.rows.length) return { type: 'register', parsed };
  } catch (_) { /* not a register */ }
  return null;
}

async function actorFor(cfg) {
  if (cfg.actorId) {
    const u = await db.get('SELECT id, name FROM users WHERE id = $1 AND deleted_at IS NULL', [cfg.actorId]);
    if (u) return u;
  }
  return db.get(`SELECT id, name FROM users WHERE deleted_at IS NULL AND role IN ('super_admin', 'admin') ORDER BY id LIMIT 1`);
}

// ───────────────────────────── imports ─────────────────────────────

async function importRegister(file, buffer, parsed, actor, cfg) {
  const plan = await sync.computePlan(parsed, db); // read-only preview
  const s = plan.summary;
  const inTool = (await db.get('SELECT COUNT(*)::int AS n FROM assets WHERE deleted_at IS NULL')).n;
  const allocChanges = s.assigned + s.returned + s.reassigned;
  const updatePct = s.register ? (s.updated * 100) / s.register : 0;
  const preview = `${s.added} new, ${s.updated} updated, ${s.assigned} assigned, ${s.returned} returned, ${s.reassigned} reassigned, ${s.conflicts} protected, ${s.newEmployees} new employees`;

  const reasons = [];
  if (cfg.mode === 'review') reasons.push('automatic apply is switched off (review mode)');
  if (inTool > 100 && s.hardware < inTool * 0.5) reasons.push(`the file has ${s.hardware.toLocaleString('en-IN')} hardware rows but the tool holds ${inTool.toLocaleString('en-IN')}, so it may be incomplete`);
  if (cfg.maxAlloc && allocChanges > cfg.maxAlloc) reasons.push(`${allocChanges} allocation changes (limit ${cfg.maxAlloc})`);
  if (cfg.maxUpdatePct && updatePct > cfg.maxUpdatePct) reasons.push(`${updatePct.toFixed(1)}% of records would be updated (limit ${cfg.maxUpdatePct}%)`);

  if (reasons.length) {
    // Prepare the same preview the Import Data page shows, so an admin can review and apply it.
    let review = 'Upload the file on Import Data to review it.';
    try {
      const id = sync.startAnalysis(buffer, file.name, actor);
      review = `Review and apply it on Import Data: ${config.appUrl}/import-data?job=${id} (link works for ${actor.name} until the app restarts; otherwise upload the file again).`;
    } catch (_) { /* another import is running: fall back to manual upload */ }
    return { status: 'held', text: `Held for review: ${reasons.join('; ')}. Preview: ${preview}. ${review}` };
  }

  const tmp = path.join(config.storageDir, 'temp', `auto-register-${crypto.randomBytes(6).toString('hex')}.xlsx`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, buffer);
  try {
    const r = await sync.applySync({ id: 'auto', fileName: `${file.name} (automatic import)`, file: tmp, step: null, progress: 0 }, actor);
    const a = r.applied || {};
    return { status: 'imported', text: `${a.added ?? s.added} added, ${a.updated ?? s.updated} updated, ${a.assigned ?? s.assigned} assigned, ${a.returned ?? s.returned} returned, ${a.reassigned ?? s.reassigned} reassigned, ${s.conflicts} protected` };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ───────────────────────────── run ─────────────────────────────

// ctx.manual (Run now) also retries files whose previous attempt failed.
async function run(ctx = {}) {
  const cfg = await getConfig();
  if (!cfg.folders.length) return 'No import folder set (Settings → Automations → Daily folder import).';
  const state = await readState();
  const seen = new Map(state.seen.map(x => [x.fp, x]));
  const { files, errors } = listFiles(cfg.folders);
  const fresh = files.filter(f => {
    const prev = seen.get(f.fp);
    return !prev || (ctx.manual && prev.status === 'failed');
  });
  const waiting = fresh.filter(f => !f.settled).length;
  const results = [];
  const doneTypes = new Set();
  const actor = await actorFor(cfg);
  const remember = (f, extra) => {
    state.seen = state.seen.filter(x => x.fp !== f.fp);
    state.seen.push({ fp: f.fp, file: f.name, at: new Date().toISOString(), ...extra });
  };

  for (const f of fresh.filter(x => x.settled)) {
    let buffer, kind;
    try {
      buffer = fs.readFileSync(f.full);
      kind = await detect(buffer);
    } catch (err) {
      remember(f, { type: null, status: 'failed', text: `Could not read the file: ${err.message}` });
      results.push(state.seen[state.seen.length - 1]);
      continue;
    }
    if (!kind) { remember(f, { type: null, status: 'unrecognised', text: 'Not an Asset Data register (columns not recognised).' }); continue; }
    if (doneTypes.has(kind.type)) { remember(f, { type: kind.type, status: 'superseded', text: 'A newer register file was handled.' }); continue; }
    doneTypes.add(kind.type);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const last = state.last[kind.type];
    if (last && last.hash === hash && last.status === 'imported') {
      remember(f, { type: kind.type, status: 'unchanged', text: `Same content as ${last.file}, already imported.` });
      continue;
    }
    let r;
    try {
      if (!actor) throw new Error('No admin user to attribute the import to.');
      r = await importRegister(f, buffer, kind.parsed, actor, cfg);
    } catch (err) {
      r = { status: 'failed', text: `Import failed, nothing was changed: ${err.message}` };
    }
    remember(f, { type: kind.type, ...r });
    if (r.status === 'imported') state.last[kind.type] = { hash, file: f.name, at: new Date().toISOString(), status: 'imported' };
    results.push(state.seen[state.seen.length - 1]);
  }
  state.checked_at = new Date().toISOString();
  state.errors = errors;
  await writeState(state);

  if (results.length) {
    const needsAction = results.some(x => x.status !== 'imported');
    const facts = results.map(x => [`${TYPE_LABEL[x.type] || 'File'}: ${x.file}`, `${x.status}: ${x.text}`]);
    const c = await digest.getConfig();
    await digest.deliver({
      kind: 'folder_import', c, recipients: c.recipients, facts, email: needsAction,
      subject: needsAction ? 'IT-HAMS daily import needs attention' : 'IT-HAMS daily import completed',
      title: 'Daily folder import',
      intro: needsAction ? 'At least one file was not imported automatically. Details below.' : 'New files from the import folder were imported.',
      sections: [{ title: 'Files', count: results.length, columns: ['File', 'Type', 'Result'],
        rows: results.map(x => [x.file, TYPE_LABEL[x.type] || '—', `${x.status}: ${x.text}`].map(e)),
        textRows: results.map(x => `${x.file}: ${x.status}: ${x.text}`) }]
    });
  }

  const parts = results.map(x => `${TYPE_LABEL[x.type] || x.file}: ${x.status}${x.status === 'imported' ? ` (${x.text})` : ''}`);
  if (waiting) parts.push(`${waiting} file(s) still syncing, will check again`);
  if (errors.length) parts.push(`Folder problem: ${errors.join('; ')}`);
  if (!parts.length) parts.push(`No new files (${files.length} .xlsx file(s) in the folder already handled)`);
  if (errors.length && !results.length && !files.length) throw new Error(errors.join('; '));
  return parts.join(' · ');
}

async function status() {
  const [cfg, state] = await Promise.all([getConfig(), readState()]);
  return { cfg, state, recent: state.seen.slice(-12).reverse() };
}

module.exports = { DEFAULTS, getConfig, folderProblems, parseFolders, detect, run, status };
