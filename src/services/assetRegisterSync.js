// "Import Data": sync the Asset Data register into Hardware, employees,
// catalog and procurement — preview first, then apply.
//
// Rules (agreed):
//  - Match existing records by Service Tag (duplicates by occurrence, as in the first import).
//    Changed fields/status/allocation are updated; new rows are added; nothing is deleted.
//  - Records in the tool but not in the file are left unchanged (counted in the summary).
//  - Allocations changed in the tool after the last import (New Joinee allocations, check-outs,
//    check-ins) are protected: the file can't undo them; they're reported as conflicts.
//  - Asset tags are never changed (printed labels stay valid). Only Computing rows are imported
//    (see assetRegister.IMPORTED_TYPES); rows with other Asset Types, without an Asset Type or
//    with an unknown status are left out and counted in the preview. Intune columns are ignored.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const cache = require('../core/cache');
const config = require('../config');
const audit = require('./auditService');
const automation = require('./automationService');
const { readRegister, looksLikeTag } = require('./assetRegister');
const { HttpError } = require('../core/helpers');

const JOB_TYPE = 'asset_register_sync';
// Status labels the import adds when missing (the register's "Retired - ..." statuses).
const LABEL_TYPE = { stock: 'deployable', allocated: 'deployed', retired: 'archived' };
const LABEL_COLOR = { deployable: '#22c55e', deployed: '#3b82f6', archived: '#71717a' };
// Tool-only detail stamped when a sync finds the file agreeing with an in-tool allocation change.
const RECONCILED_KEY = 'Register reconciled at';
// Keys the import owns. The Intune/BIOS keys are no longer read from the file but stay
// listed so an import removes any left on a record by an older version.
const IMPORT_KEYS = new Set(['Sr. (source row)', 'Asset Type', 'Parent Asset Type', 'Asset Status (source)', 'Type of Allocation', 'CTID',
  'CTID Employer Name', 'PO #', 'FAMS No. / Barcode', 'Machine Name', 'OEM OS', 'Processor', 'No of Cores', 'RAM Size (GB)', 'Harddisk Type',
  'Harddisk Size', 'No of Harddisks', 'Warranty Start Date', 'Vendor Name', 'Invoice No.', 'Order No.', 'GRN No.', 'Fixed Asset ID', 'Client',
  'Group', 'Project', 'Client Provided Asset', 'Duty Exempted', 'Insured', 'Baseline Date', 'Keyboard', 'Monitor', 'Intune Device Name',
  'Intune Primary User', 'Intune Primary User Email', 'Intune Enrollment Date', 'Intune Last Check-in', 'Intune OS', 'Intune OS Version',
  'Intune Compliance', 'Intune Managed By', 'Intune Ownership', 'Intune Device State', 'Intune Join Type', 'Intune Model', 'BIOS Version',
  'Intune Encrypted', 'Allocated To', 'import_source']);

// ---------------- background jobs (in this process) ----------------
const jobs = new Map();
const tempDir = () => { const d = path.join(config.storageDir, 'temp'); fs.mkdirSync(d, { recursive: true }); return d; };
function publicJob(j) {
  if (!j) return null;
  const { file, ...rest } = j;
  return rest;
}
function getJob(id, userId) {
  const j = jobs.get(id);
  return j && j.userId === userId ? publicJob(j) : null;
}
function runningJob() { return [...jobs.values()].find(j => j.state === 'analyzing' || j.state === 'applying'); }

function startAnalysis(buffer, fileName, user) {
  if (runningJob()) throw new HttpError('Another import is already running. Wait for it to finish.', 409);
  const id = crypto.randomBytes(8).toString('hex');
  const file = path.join(tempDir(), `register-${id}.xlsx`);
  fs.writeFileSync(file, buffer);
  const job = { id, userId: user.id, fileName, file, state: 'analyzing', step: 'Reading the workbook…', createdAt: new Date().toISOString() };
  jobs.set(id, job);
  setImmediate(async () => {
    try {
      const parsed = await readRegister(fs.readFileSync(file));
      job.step = 'Comparing with the database…';
      const plan = await computePlan(parsed, db);
      job.summary = plan.summary;
      job.samples = plan.samples;
      job.state = 'ready';
      job.step = null;
    } catch (err) {
      job.state = 'failed'; job.error = err.message; job.step = null;
      fs.rmSync(file, { force: true });
    }
  });
  return id;
}

function startApply(id, user) {
  const job = jobs.get(id);
  if (!job || job.userId !== user.id) throw new HttpError('Import not found. Upload the file again.', 404);
  if (job.state !== 'ready') throw new HttpError('This import is not ready to apply.', 409);
  if (runningJob()) throw new HttpError('Another import is already running.', 409);
  job.state = 'applying'; job.step = 'Starting…'; job.progress = 0;
  setImmediate(async () => {
    try {
      job.result = await applySync(job, user);
      job.summary = job.result; // show applied totals
      job.state = 'done'; job.step = null;
    } catch (err) {
      job.state = 'failed'; job.error = 'Import failed and was rolled back — nothing was changed: ' + err.message; job.step = null;
    } finally {
      fs.rmSync(job.file, { force: true });
    }
  });
}

// ---------------- plan ----------------
async function lastImportAt(client) {
  const r = await client.query(`SELECT MAX(created_at) AS at FROM import_jobs WHERE type IN ('assets', $1) AND status = 'completed'`, [JOB_TYPE]);
  return (r.rows || r)[0].at;
}
const q = async (client, sql, params) => { const r = await client.query(sql, params); return r.rows || r; };
const dstr = v => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

async function loadState(client) {
  // Sequential: a single transaction client can't run queries in parallel.
  const run = async list => { const out = []; for (const [sql, p] of list) out.push(await q(client, sql, p)); return out; };
  // "Tool activity" = allocations/returns NOT made by an import (New Joinee, check-out, check-in).
  const IMPORT_NOTE = `(COALESCE(%s, '') LIKE 'Imported from%%' OR COALESCE(%s, '') LIKE 'Asset Data sync%%')`;
  const notImport = col => `NOT ${IMPORT_NOTE.replace(/%s/g, col).replace(/%%/g, '%')}`;
  const [assets, accessories, openAsg, openAccAsg, lastAct, lastAccAct, users, cats, locs, mfrs, sups, models, labels, pos] = await run([
    [`SELECT id, serial_number, custom_fields_data->>'Original Service Tag' AS orig, asset_tag, name, status, status_label_id, assigned_to,
                 location_id, category_id, manufacturer_id, asset_model_id, supplier_id, procurement_id, model_number, category,
                 purchase_date, purchase_cost, warranty_expiry, notes, custom_fields_data FROM assets WHERE deleted_at IS NULL`],
    [`SELECT id, serial_number, custom_fields_data->>'Original Service Tag' AS orig, name, category_id, manufacturer_id, supplier_id,
                 location_id, model_number, total_qty, available_qty, notes, custom_fields_data FROM accessories WHERE deleted_at IS NULL`],
    ['SELECT id, asset_id, user_id FROM assignments WHERE returned_at IS NULL'],
    ['SELECT id, accessory_id, user_id FROM accessory_assignments WHERE returned_at IS NULL'],
    [`SELECT asset_id, GREATEST(MAX(assigned_at) FILTER (WHERE ${notImport('checkout_notes')}),
                                MAX(returned_at) FILTER (WHERE ${notImport('checkin_notes')})) AS at
        FROM assignments GROUP BY asset_id`],
    [`SELECT accessory_id, MAX(COALESCE(returned_at, assigned_at)) FILTER (WHERE ${notImport('notes')}) AS at
        FROM accessory_assignments GROUP BY accessory_id`],
    ['SELECT id, LOWER(employee_id) AS emp, LOWER(email) AS email FROM users'],
    ['SELECT id, name FROM asset_categories'], ['SELECT id, name FROM locations'],
    ['SELECT id, name FROM manufacturers'], ['SELECT id, name FROM suppliers'],
    ['SELECT id, name, manufacturer_id FROM asset_models'], ['SELECT id, name FROM status_labels'],
    ['SELECT id, po_number FROM procurement_records WHERE deleted_at IS NULL']
  ]);
  const byName = rows => new Map(rows.map(r => [r.name, r.id]));
  const index = list => {
    const bySerial = new Map(), byOrig = new Map();
    for (const r of list) {
      if (r.serial_number) bySerial.set(r.serial_number.toUpperCase(), r);
      if (r.orig) { const k = r.orig.toUpperCase(); (byOrig.get(k) || byOrig.set(k, []).get(k)).push(r); }
    }
    return { bySerial, byOrig, all: list };
  };
  return {
    assets: index(assets), accessories: index(accessories),
    openAsg: new Map(openAsg.map(r => [r.asset_id, r])), openAccAsg: new Map(openAccAsg.map(r => [r.accessory_id, r])),
    lastAct: new Map(lastAct.map(r => [r.asset_id, r.at])), lastAccAct: new Map(lastAccAct.map(r => [r.accessory_id, r.at])),
    userByEmp: new Map(users.filter(u => u.emp).map(u => [u.emp, u.id])), emails: new Set(users.map(u => u.email)),
    cats: byName(cats), locs: byName(locs), mfrs: byName(mfrs), sups: byName(sups), labels: byName(labels),
    models: new Map(models.map(m => [`${m.manufacturer_id}||${m.name}`, m.id])),
    modelNames: new Set(models.map(m => m.name)),
    pos: new Map(pos.map(p => [p.po_number, p.id])),
    lastImport: await lastImportAt(client)
  };
}

function matchRecord(idx, row, used) {
  const take = r => (r && !used.has(r.id) ? (used.add(r.id), r) : null);
  if (!row.key) return take(idx.bySerial.get(`NOSERIAL-${row.sr}`.toUpperCase()));
  if (row.occ === 1) return take(idx.bySerial.get(row.key));
  const exact = take(idx.bySerial.get(`${row.key}-DUP${row.occ}`));
  if (exact) return exact;
  for (const r of idx.byOrig.get(row.key) || []) { const m = take(r); if (m) return m; }
  return null;
}

function cfChanged(existing, fileCf) {
  existing = existing || {};
  for (const [k, v] of Object.entries(fileCf)) if (existing[k] !== v) return true;
  for (const k of Object.keys(existing)) if (IMPORT_KEYS.has(k) && !(k in fileCf)) return true;
  return false;
}
function mergeCf(existing, fileCf) {
  const out = {};
  for (const [k, v] of Object.entries(existing || {})) if (!IMPORT_KEYS.has(k)) out[k] = v; // keep tool-only keys
  return { ...out, ...fileCf };
}

// Computes what the file would change. Pure read (uses `client` for lookups only).
async function computePlan(parsed, client) {
  const S = await loadState(client);
  const usedA = new Set(), usedX = new Set();
  const newCtids = new Map();      // ctid(lower) -> original CTID
  // labels: status name -> label type, for "Retired - ..." statuses not yet in the tool.
  const newCatalog = { locations: new Set(), categories: new Set(), manufacturers: new Set(), suppliers: new Set(), models: new Set(), pos: new Set(), labels: new Map() };
  const items = [];
  const c = { rows: parsed.total, register: parsed.rows.length, skipped: parsed.skipped, excluded: parsed.excluded || {}, unknownStatus: parsed.unknownStatus || {},
    hardware: 0, accessories: 0,
    added: 0, updated: 0, unchanged: 0, statusChanged: 0, assigned: 0, returned: 0, reassigned: 0, conflicts: 0 };
  const samples = { added: [], updated: [], allocation: [], conflicts: [] };
  const sample = (k, v) => { if (samples[k].length < 12) samples[k].push(v); };

  for (const row of parsed.rows) {
    row.isAcc ? c.accessories++ : c.hardware++;
    // catalog references (new names are created on apply)
    if (row.location && !S.locs.has(row.location)) newCatalog.locations.add(row.location);
    if (row.category && !S.cats.has(row.category)) newCatalog.categories.add(row.category);
    if (row.manufacturer && !S.mfrs.has(row.manufacturer)) newCatalog.manufacturers.add(row.manufacturer);
    if (row.vendor && !S.sups.has(row.vendor)) newCatalog.suppliers.add(row.vendor);
    if (row.po && !S.pos.has(row.po)) newCatalog.pos.add(row.po);
    if (row.label && !S.labels.has(row.label)) newCatalog.labels.set(row.label, LABEL_TYPE[row.statusKind]);
    const mfId = row.manufacturer ? S.mfrs.get(row.manufacturer) : null;
    if (!row.isAcc && row.model && !S.modelNames.has(row.model) && !(mfId && S.models.has(`${mfId}||${row.model}`))) newCatalog.models.add(`${row.manufacturer || ''}||${row.model}`);
    // holder
    let holder = null;
    if (row.statusKind === 'allocated' && row.ctid) {
      holder = S.userByEmp.get(row.ctid.toLowerCase()) || `new:${row.ctid.toLowerCase()}`;
      if (typeof holder === 'string' && !newCtids.has(row.ctid.toLowerCase())) newCtids.set(row.ctid.toLowerCase(), row.ctid);
    }
    const want = {
      name: row.name, category_id: row.category ? S.cats.get(row.category) ?? `new:${row.category}` : null,
      manufacturer_id: row.manufacturer ? S.mfrs.get(row.manufacturer) ?? `new:${row.manufacturer}` : null,
      supplier_id: row.vendor ? S.sups.get(row.vendor) ?? `new:${row.vendor}` : null,
      location_id: row.location ? S.locs.get(row.location) ?? `new:${row.location}` : null,
      model_number: row.model,
      notes: row.isAcc && row.statusKind === 'retired' ? `[${row.statusRaw}] ${row.notes || ''}`.trim() : row.notes
    };
    const idx = row.isAcc ? S.accessories : S.assets;
    const existing = matchRecord(idx, row, row.isAcc ? usedX : usedA);
    const tag = existing ? (existing.asset_tag || existing.serial_number) : (row.serialRaw || '(no tag)');
    if (!existing) {
      c.added++; sample('added', { tag: row.serialRaw, name: row.name, type: row.isAcc ? 'Accessory' : 'Hardware', status: row.label });
      if (holder) c.assigned++;
      items.push({ row, existing: null, holder, want });
      continue;
    }
    // compare register fields
    const changed = [];
    const cmp = (f, a, b) => { if ((a ?? null) !== (b ?? null)) changed.push(f); };
    cmp('name', existing.name, want.name);
    for (const f of ['category_id', 'manufacturer_id', 'supplier_id', 'location_id']) cmp(f, existing[f], want[f]);
    cmp('model', existing.model_number, want.model_number);
    cmp('notes', existing.notes, want.notes);
    if (!row.isAcc) {
      cmp('category', existing.category, row.category);
      cmp('purchase date', dstr(existing.purchase_date), row.purchase);
      cmp('cost', num(existing.purchase_cost), row.amount === null ? null : Math.round(row.amount * 100) / 100);
      cmp('warranty', dstr(existing.warranty_expiry), row.warrantyEnd);
      const poId = row.po ? (S.pos.get(row.po) ?? `new:${row.po}`) : null;
      cmp('purchase order', existing.procurement_id, poId);
      if (row.model && mfId && S.models.has(`${mfId}||${row.model}`)) cmp('model link', existing.asset_model_id, S.models.get(`${mfId}||${row.model}`));
    }
    if (cfChanged(existing.custom_fields_data, row.cf)) changed.push('details');

    // allocation / status
    const open = (row.isAcc ? S.openAccAsg : S.openAsg).get(existing.id);
    const curHolder = row.isAcc ? (open ? open.user_id : null) : existing.assigned_to;
    const curLabel = row.isAcc ? null : existing.status_label_id;
    const wantLabel = S.labels.get(row.label) || null;
    // Accessories have no status column: compare "in stock / held by someone / neither (retired or
    // allocated to hardware)" so unchanged retired units don't show up as changed every time.
    const accKind = (h, avail) => (h ? 'allocated' : avail ? 'stock' : 'other');
    const allocDiff = curHolder !== holder;
    const statusDiff = row.isAcc
      ? accKind(curHolder, existing.available_qty > 0) !== accKind(holder, row.statusKind === 'stock')
      : (curLabel !== wantLabel || existing.status !== row.status);
    // Protected until the file agrees: the latest allocation/return made in the tool (not by an
    // import) is newer than the last time a sync found the file in agreement for this record.
    const toolAct = (row.isAcc ? S.lastAccAct : S.lastAct).get(existing.id);
    const reconciled = (existing.custom_fields_data || {})[RECONCILED_KEY];
    const toolNewer = !!toolAct && (!reconciled || new Date(toolAct) > new Date(reconciled));
    const isProtected = (allocDiff || statusDiff) && toolNewer;
    const reconcile = toolNewer && !allocDiff && !statusDiff; // file now matches the tool's change
    let alloc = 'none';
    if (isProtected) {
      c.conflicts++;
      sample('conflicts', { tag, name: existing.name, file: row.statusRaw + (row.ctid ? ` (${row.ctid})` : ''), tool: curHolder ? 'allocated in the tool' : 'returned in the tool' });
    } else {
      if (allocDiff) {
        alloc = curHolder && holder ? 'reassign' : holder ? 'assign' : 'return';
        c[alloc === 'reassign' ? 'reassigned' : alloc === 'assign' ? 'assigned' : 'returned']++;
        sample('allocation', { tag, name: existing.name, change: alloc, to: row.ctid || '', status: row.label });
      }
      if (statusDiff) c.statusChanged++;
    }
    const anyChange = changed.length || (!isProtected && (allocDiff || statusDiff));
    if (anyChange) {
      c.updated++;
      if (changed.length) sample('updated', { tag, name: existing.name, fields: changed.join(', ') });
    } else c.unchanged++;
    items.push({ row, existing, holder, want, changed, isProtected, allocDiff: !isProtected && allocDiff, statusDiff: !isProtected && statusDiff, alloc, anyChange, reconcile });
  }
  c.notInFileHardware = S.assets.all.length - usedA.size;
  c.notInFileAccessories = S.accessories.all.length - usedX.size;
  c.newEmployees = newCtids.size;
  c.newCatalog = Object.fromEntries(Object.entries(newCatalog).map(([k, v]) => [k, v.size]));
  return { summary: c, samples, items, newCtids, newCatalog, state: S };
}

// ---------------- apply ----------------
async function bulkInsert(client, table, cols, rows, returning = false) {
  const ids = [];
  const CHUNK = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params = [];
    const values = part.map(r => `(${r.map(v => { params.push(v); return '$' + params.length; }).join(',')})`);
    const res = await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}${returning ? ' RETURNING id' : ''}`, params);
    if (returning) ids.push(...res.rows.map(r => r.id));
  }
  return ids;
}

// opts.rollback / opts.inspect: verification only (not reachable from routes) — runs the full
// apply, lets the caller inspect the result inside the transaction, then rolls back.
async function applySync(job, actor, opts = {}) {
  const parsed = await readRegister(fs.readFileSync(job.file));
  const client = await db.pool.connect();
  const progress = (step, p) => { job.step = step; if (p !== undefined) job.progress = p; };
  try {
    await client.query('BEGIN');
    // Serialize with any other sync/import.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('hams_asset_register_sync'))`);
    progress('Preparing catalog and employees…', 5);
    let plan = await computePlan(parsed, client);

    // 1) catalog
    const colors = ['#3b82f6', '#6366f1', '#06b6d4', '#8b5cf6', '#14b8a6', '#f59e0b', '#64748b', '#22c55e', '#f97316', '#ec4899'];
    let ci = 0;
    const accCats = new Set(parsed.rows.filter(r => r.isAcc && r.category).map(r => r.category));
    for (const n of plan.newCatalog.categories) {
      await client.query(`INSERT INTO asset_categories (name, type, color) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
        [n, accCats.has(n) ? 'accessory' : 'asset', colors[ci++ % colors.length]]);
    }
    // Locations by name only: the register has no city/country columns.
    for (const n of plan.newCatalog.locations) await client.query('INSERT INTO locations (name) VALUES ($1)', [n]);
    for (const [n, type] of plan.newCatalog.labels) {
      await client.query(`INSERT INTO status_labels (name, type, color) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`, [n, type, LABEL_COLOR[type]]);
    }
    for (const n of plan.newCatalog.manufacturers) await client.query('INSERT INTO manufacturers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [n]);
    for (const n of plan.newCatalog.suppliers) await client.query('INSERT INTO suppliers (name) VALUES ($1)', [n]);
    const mfrIds = new Map((await q(client, 'SELECT id, name FROM manufacturers')).map(r => [r.name, r.id]));
    const catIds = new Map((await q(client, 'SELECT id, name FROM asset_categories')).map(r => [r.name, r.id]));
    for (const key of plan.newCatalog.models) {
      const [mf, md] = key.split('||');
      const cat = (parsed.rows.find(r => !r.isAcc && r.model === md && (r.manufacturer || '') === mf) || {}).category;
      await client.query(`INSERT INTO asset_models (name, model_number, manufacturer_id, category_id) VALUES ($1, $1, $2, $3)
        ON CONFLICT (name, model_number) DO NOTHING`, [md, mf ? mfrIds.get(mf) || null : null, cat ? catIds.get(cat) || null : null]);
    }
    if (plan.newCatalog.pos.size) {
      const supIds = new Map((await q(client, 'SELECT id, name FROM suppliers')).map(r => [r.name, r.id]));
      const agg = new Map();
      for (const r of parsed.rows) {
        if (!r.po || !plan.newCatalog.pos.has(r.po)) continue;
        const p = agg.get(r.po) || { inv: {}, vendor: r.vendor, date: null, total: 0 };
        if (r.invoice) p.inv[r.invoice] = (p.inv[r.invoice] || 0) + 1;
        if (r.purchase && (!p.date || r.purchase < p.date)) p.date = r.purchase;
        p.total += r.amount || 0;
        agg.set(r.po, p);
      }
      await bulkInsert(client, 'procurement_records', ['po_number', 'invoice_number', 'vendor_id', 'purchase_date', 'total_amount', 'currency', 'notes', 'created_by'],
        [...agg.entries()].map(([po, p]) => [po, (Object.entries(p.inv).sort((a, b) => b[1] - a[1])[0] || [null])[0], p.vendor ? supIds.get(p.vendor) || null : null,
          p.date, p.total || null, 'INR', 'Imported from Asset Data (Import Data)', actor.id]));
    }

    // 2) new employees (by CTID). The register has only the CTID: it is used as the name, and
    //    location and email are left empty (no sign-in: the password is random and unknown).
    if (plan.newCtids.size) {
      const pwd = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      const rows = [...plan.newCtids.values()].map(ctid => [crypto.randomUUID(), ctid, ctid.slice(0, 255), pwd, 'employee', 'active']);
      const ids = await bulkInsert(client, 'users', ['uuid', 'employee_id', 'name', 'password', 'role', 'status'], rows, true);
      const role = (await q(client, `SELECT id FROM roles WHERE name = 'employee'`))[0];
      if (role) await bulkInsert(client, 'user_roles', ['user_id', 'role_id'], ids.map(id => [id, role.id]));
    }

    // 3) recompute with every reference now resolvable
    progress('Updating records…', 15);
    plan = await computePlan(parsed, client);
    const S = plan.state;
    const note = 'Asset Data sync (Import Data)';
    const mv = [];
    const ledger = (module, itemId, type, dir, extra = {}) => mv.push([module, itemId, type, dir, 1, extra.loc || null, extra.holder || null,
      extra.asg || null, extra.eff || 'available', extra.reason || note, actor.id]);
    const usedTags = new Set((await q(client, 'SELECT asset_tag FROM assets WHERE asset_tag IS NOT NULL')).map(r => r.asset_tag));
    const usedSerA = new Set(S.assets.all.map(a => (a.serial_number || '').toUpperCase()));
    const usedSerX = new Set(S.accessories.all.map(a => (a.serial_number || '').toUpperCase()));
    let tagSeq = 1;
    const nextTag = () => { let s; do { s = 'HAMS-' + String(tagSeq++).padStart(6, '0'); } while (usedTags.has(s)); usedTags.add(s); return s; };
    const uniqueSerial = (set, base, occ) => {
      let s = base || null;
      if (!s) return null;
      if (occ > 1 || set.has(s.toUpperCase())) { let n = Math.max(occ, 2); do { s = `${base}-DUP${n++}`; } while (set.has(s.toUpperCase())); }
      set.add(s.toUpperCase());
      return s;
    };
    const res = { added: 0, updated: 0, assigned: 0, returned: 0, reassigned: 0, conflicts: plan.summary.conflicts };
    const newAssets = [], newAssetMeta = [], newAcc = [], newAccMeta = [];
    let done = 0;
    for (const it of plan.items) {
      const { row, existing } = it;
      const holder = it.holder;
      const locId = it.want.location_id;
      if (!existing) {
        const cf = { ...row.cf };
        if (row.isAcc) {
          const serial = uniqueSerial(usedSerX, row.serialRaw, row.occ);
          if (serial !== row.serialRaw && row.serialRaw) cf['Original Service Tag'] = row.serialRaw;
          newAcc.push([row.name, it.want.category_id, it.want.manufacturer_id, it.want.supplier_id, locId, row.model, serial, 1,
            row.statusKind === 'stock' ? 1 : 0, 0, row.statusKind === 'retired' ? `[${row.statusRaw}] ${row.notes || ''}`.trim() : row.notes,
            JSON.stringify(cf), row.purchase || new Date()]);
          newAccMeta.push({ holder, locId, kind: row.statusKind });
        } else {
          const serial = uniqueSerial(usedSerA, row.serialRaw || `NOSERIAL-${row.sr}`, row.occ);
          if (serial !== row.serialRaw && row.serialRaw) cf['Original Service Tag'] = row.serialRaw;
          const tag = looksLikeTag(row.fams) && row.famsUnique && !usedTags.has(row.fams) ? (usedTags.add(row.fams), row.fams) : nextTag();
          const mfId = it.want.manufacturer_id;
          newAssets.push([tag, crypto.randomBytes(16).toString('hex'), row.name, mfId && row.model ? S.models.get(`${mfId}||${row.model}`) || null : null,
            it.want.category_id, mfId, it.want.supplier_id, row.po ? S.pos.get(row.po) || null : null, locId, serial, row.model, row.category,
            row.status, S.labels.get(row.label) || null, row.purchase, row.amount, row.warrantyEnd, holder, row.notes, JSON.stringify(cf), row.purchase || new Date()]);
          newAssetMeta.push({ holder, locId, kind: row.statusKind });
        }
        continue;
      }
      if (it.reconcile) {
        await client.query(`UPDATE ${row.isAcc ? 'accessories' : 'assets'} SET custom_fields_data = COALESCE(custom_fields_data, '{}'::jsonb) || jsonb_build_object($1::text, $2::text) WHERE id = $3`,
          [RECONCILED_KEY, new Date().toISOString(), existing.id]);
        existing.custom_fields_data = { ...(existing.custom_fields_data || {}), [RECONCILED_KEY]: new Date().toISOString() };
      }
      if (!it.anyChange) continue;
      res.updated++;
      const cf = JSON.stringify(mergeCf(existing.custom_fields_data, row.cf));
      if (row.isAcc) {
        const open = S.openAccAsg.get(existing.id);
        let avail = existing.available_qty;
        if (!it.isProtected) avail = row.statusKind === 'stock' && !holder ? 1 : 0;
        await client.query(`UPDATE accessories SET name = $1, category_id = $2, manufacturer_id = $3, supplier_id = $4, location_id = $5,
            model_number = $6, notes = $7, custom_fields_data = $8, total_qty = 1, available_qty = $9, updated_at = CURRENT_TIMESTAMP WHERE id = $10`,
          [row.name, it.want.category_id, it.want.manufacturer_id, it.want.supplier_id, locId, row.model,
            row.statusKind === 'retired' ? `[${row.statusRaw}] ${row.notes || ''}`.trim() : row.notes, cf, avail, existing.id]);
        if (it.allocDiff) {
          if (open) {
            await client.query('UPDATE accessory_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = $1', [open.id]);
            ledger('accessories', existing.id, 'returned', 'in', { holder: open.user_id, eff: 'available' });
          }
          if (holder) {
            const a = await client.query('INSERT INTO accessory_assignments (accessory_id, user_id, qty, notes) VALUES ($1, $2, 1, $3) RETURNING id', [existing.id, holder, note]);
            ledger('accessories', existing.id, 'assigned', 'out', { holder, asg: a.rows[0].id, eff: 'assigned' });
          }
          res[it.alloc === 'reassign' ? 'reassigned' : it.alloc === 'assign' ? 'assigned' : 'returned']++;
        }
      } else {
        const mfId = it.want.manufacturer_id;
        const keepAlloc = it.isProtected;
        await client.query(`UPDATE assets SET name = $1, category_id = $2, manufacturer_id = $3, supplier_id = $4, location_id = $5, model_number = $6,
            category = $7, notes = $8, custom_fields_data = $9, purchase_date = $10, purchase_cost = $11, warranty_expiry = $12,
            procurement_id = $13, asset_model_id = COALESCE($14, asset_model_id),
            status = CASE WHEN $15 THEN status ELSE $16 END, status_label_id = CASE WHEN $15 THEN status_label_id ELSE $17 END,
            assigned_to = CASE WHEN $15 THEN assigned_to ELSE $18 END, updated_at = CURRENT_TIMESTAMP WHERE id = $19`,
          [row.name, it.want.category_id, mfId, it.want.supplier_id, locId, row.model, row.category, row.notes, cf,
            row.purchase, row.amount, row.warrantyEnd, row.po ? S.pos.get(row.po) || null : null,
            mfId && row.model ? S.models.get(`${mfId}||${row.model}`) || null : null,
            keepAlloc, row.status, S.labels.get(row.label) || null, holder, existing.id]);
        if (it.allocDiff) {
          const open = S.openAsg.get(existing.id);
          if (open) {
            await client.query(`UPDATE assignments SET returned_at = CURRENT_TIMESTAMP, checked_in_by = $1, checkin_notes = $2 WHERE id = $3`, [actor.id, note, open.id]);
            ledger('assets', existing.id, 'returned', 'in', { holder: open.user_id, loc: locId, eff: 'available' });
          }
          if (holder) {
            const a = await client.query('INSERT INTO assignments (asset_id, user_id, checked_out_by, checkout_notes) VALUES ($1, $2, $3, $4) RETURNING id', [existing.id, holder, actor.id, note]);
            ledger('assets', existing.id, 'assigned', 'out', { holder, asg: a.rows[0].id, eff: 'assigned' });
          }
          res[it.alloc === 'reassign' ? 'reassigned' : it.alloc === 'assign' ? 'assigned' : 'returned']++;
        }
        if (it.statusDiff && row.statusKind === 'retired' && existing.status !== 'archived') ledger('assets', existing.id, 'retired', 'out', { eff: 'archived', reason: `${note}: ${row.statusRaw}` });
      }
      if (++done % 500 === 0) progress(`Updating records… ${done}`, 15 + Math.min(60, Math.round(done / Math.max(1, plan.summary.updated) * 60)));
    }

    // 4) inserts for new rows
    progress('Adding new records…', 80);
    const assetIds = await bulkInsert(client, 'assets', ['asset_tag', 'label_token', 'name', 'asset_model_id', 'category_id', 'manufacturer_id', 'supplier_id',
      'procurement_id', 'location_id', 'serial_number', 'model_number', 'category', 'status', 'status_label_id', 'purchase_date', 'purchase_cost',
      'warranty_expiry', 'assigned_to', 'notes', 'custom_fields_data', 'created_at'], newAssets, true);
    const accIds = await bulkInsert(client, 'accessories', ['name', 'category_id', 'manufacturer_id', 'supplier_id', 'location_id', 'model_number',
      'serial_number', 'total_qty', 'available_qty', 'min_qty', 'notes', 'custom_fields_data', 'created_at'], newAcc, true);
    for (let i = 0; i < assetIds.length; i++) {
      const m = newAssetMeta[i];
      ledger('assets', assetIds[i], 'stock_in', 'in', { loc: m.locId });
      if (m.holder) {
        const a = await client.query('INSERT INTO assignments (asset_id, user_id, checked_out_by, checkout_notes) VALUES ($1, $2, $3, $4) RETURNING id', [assetIds[i], m.holder, actor.id, note]);
        ledger('assets', assetIds[i], 'assigned', 'out', { holder: m.holder, asg: a.rows[0].id, eff: 'assigned' });
        res.assigned++;
      } else if (m.kind === 'retired') ledger('assets', assetIds[i], 'retired', 'out', { eff: 'archived' });
    }
    for (let i = 0; i < accIds.length; i++) {
      const m = newAccMeta[i];
      ledger('accessories', accIds[i], 'stock_in', 'in', { loc: m.locId });
      if (m.holder) {
        const a = await client.query('INSERT INTO accessory_assignments (accessory_id, user_id, qty, notes) VALUES ($1, $2, 1, $3) RETURNING id', [accIds[i], m.holder, note]);
        ledger('accessories', accIds[i], 'assigned', 'out', { holder: m.holder, asg: a.rows[0].id, eff: 'assigned' });
        res.assigned++;
      }
    }
    res.added = assetIds.length + accIds.length;
    await bulkInsert(client, 'stock_movements', ['module_key', 'item_id', 'movement_type', 'direction', 'quantity', 'to_location_id',
      'holder_user_id', 'related_assignment_id', 'effective_status', 'reason', 'created_by'], mv);

    progress('Finishing…', 95);
    const summary = { ...plan.summary, applied: res };
    await client.query(`INSERT INTO import_jobs (type, status, rows_total, rows_imported, errors, created_by) VALUES ($1, 'completed', $2, $3, $4, $5)`,
      [JOB_TYPE, parsed.total, res.added + res.updated, JSON.stringify({ file: job.fileName, ...summary }), actor.id]);
    if (opts.inspect) await opts.inspect(client);
    if (opts.rollback) { await client.query('ROLLBACK'); return summary; }
    await client.query('COMMIT');
    cache.del('hams_dashboard_metrics');
    await audit.log(actor.id, 'ASSET_REGISTER_SYNCED',
      `Import Data (${job.fileName}): ${res.added} added, ${res.updated} updated, ${res.assigned} assigned, ${res.returned} returned, ${res.reassigned} reassigned, ${res.conflicts} protected.`);
    // Bulk changes fire no per-asset events; listeners (the AI layer) refresh after the import.
    automation.publish('import.applied', { source: 'asset_register', file: job.fileName, added: res.added, updated: res.updated });
    job.progress = 100;
    return summary;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function history(limit = 10) {
  return db.query(`SELECT j.id, j.type, j.status, j.rows_total, j.rows_imported, j.errors, j.created_at, u.name AS by_name
                     FROM import_jobs j LEFT JOIN users u ON u.id = j.created_by
                    WHERE j.type IN ('assets', $1) ORDER BY j.created_at DESC LIMIT $2`, [JOB_TYPE, limit]);
}

module.exports = { startAnalysis, startApply, getJob, history, computePlan, applySync };
