// Replace all inventory data with the "Asset Data .csv" hardware export.
//
// Usage:  node tools/import-asset-data.js "<path to Asset Data .csv>" [--keep-existing]
//
// Column routing (decided from the file's own "Asset Type" column):
//   Computing / Network / Servers -> Hardware assets (assets table)
//   Accessories                   -> Accessories module (one record per serialized unit)
//   Allocated rows                -> users (by Email ID) + open assignment to that user
//   Asset Location / Work Location -> locations   Manufacturer Name -> manufacturers
//   Friendly Name -> categories   Model Number -> asset models   Vendor Name -> suppliers
//   PO #                          -> procurement records (real PO numbers only)
// Every other column is kept on the record as a custom field, so nothing is lost.
//
// By default the existing inventory, people and demo data are removed first
// (the admin account, roles, permissions, modules and settings are kept).
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/core/db');

const FILE = process.argv[2];
const KEEP = process.argv.includes('--keep-existing');
if (!FILE || !fs.existsSync(FILE)) {
  console.error('Usage: node tools/import-asset-data.js "<path to Asset Data .csv>" [--keep-existing]');
  process.exit(1);
}

// ---------- parsing ----------
// The export is Windows-1252, LF-terminated, RFC-quoted (quoted cells may hold newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const t = v => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const JUNK = new Set(['', 'na', 'n/a', '#n/a', 'nil', 'none', 'pending', '-', '0', 'tbd']);
const clean = v => (JUNK.has(t(v).toLowerCase()) ? '' : t(v));

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(v) { // dd-MMM-yy
  const m = t(v).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  let y = parseInt(m[3], 10);
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  const d = parseInt(m[1], 10);
  if (d < 1 || d > 31 || y < 1990 || y > 2045) return null;
  return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseAmount(v) {
  const s = t(v).replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return n > 0 && n < 1e9 ? n : null;
}
const isRealPo = v => /^(CTIN|CTINPO|CTUS|PO)[-_ ]?\w*\d{3,}/i.test(t(v)) || /^\d{6,}$/.test(t(v));
const looksLikeTag = v => /^\d{6,12}$/.test(t(v));
const looksLikeHostname = v => /^[A-Za-z][A-Za-z0-9\-_.]{2,30}$/.test(t(v)) && !/stock|return|client|store|scrap|repair/i.test(t(v));

function countryOf(name) {
  const n = name.toLowerCase();
  if (/\b(us|usa)\b|princeton/.test(n)) return 'USA';
  if (/canada/.test(n)) return 'Canada';
  if (/\buk\b|united kingdom/.test(n)) return 'United Kingdom';
  if (/switzerland/.test(n)) return 'Switzerland';
  if (/dubai/.test(n)) return 'United Arab Emirates';
  if (/poland/.test(n)) return 'Poland';
  return 'India';
}
function cityOf(name) {
  const n = name.toLowerCase();
  for (const [k, c] of [['pune', 'Pune'], ['bangalore', 'Bengaluru'], ['chennai', 'Chennai'], ['hyderabad', 'Hyderabad'],
    ['gurugram', 'Gurugram'], ['noida', 'Noida'], ['powai', 'Mumbai'], ['mindspace', 'Navi Mumbai'], ['princeton', 'Princeton']]) {
    if (n.includes(k)) return c;
  }
  return null;
}

// Multi-row INSERT in chunks; returns ids in input order when `returning` is set.
async function bulkInsert(client, table, cols, rows, returning = false) {
  const ids = [];
  const CHUNK = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params = [];
    const values = part.map(r => `(${r.map(v => { params.push(v); return '$' + params.length; }).join(',')})`);
    const res = await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}${returning ? ' RETURNING id' : ''}`, params);
    if (returning) ids.push(...res.rows.map(r => r.id));
  }
  return ids;
}

(async () => {
  const text = new TextDecoder('windows-1252').decode(fs.readFileSync(FILE)).replace(/^﻿/, '');
  const rows = parseCsv(text);
  const H = rows[0].map(t);
  const idx = name => { const i = H.indexOf(name); if (i < 0) throw new Error(`Column "${name}" not found in file`); return i; };
  const C = {
    sr: idx('Sr.'), type: idx('Asset Type'), friendly: idx('Friendly Name'), tag: idx('Service Tag #'), po: idx('PO #'),
    fams: idx('FAMS No. / Barcode'), purchase: idx('Purchase Date'), amount: idx('Amount'), status: idx('Asset Status'),
    allocType: idx('Type of Allocation'), ctid: idx('CTID'), emp: idx('Employee Name'), email: idx('Email ID'),
    workLoc: idx('Work Location'), age: idx('Asset Age'), clientProv: idx('Client Provided Asset'), duty: idx('Duty Exempted'),
    assetLoc: idx('Asset Location'), employer: idx('CTID Employer Name'), parent: idx('Parent Asset Type'),
    mfr: idx('Manufacturer Name'), machine: idx('Machine Name'), model: idx('Model Number'), os: idx('OEM OS'),
    hddType: idx('Harddisk Type'), hddSize: idx('Harddisk Size'), hddCount: idx('No of Harddisks'), cpu: idx('Processor'),
    cores: idx('No of Cores Processors'), ram: idx('RAM Size'), wStart: idx('Warranty Start Date'), wEnd: idx('Warranty End Date'),
    wDays: idx('Remaining Warranty In Days'), vendor: idx('Vendor Name'), invoice: idx('Invoice No.'), order: idx('Order No.'),
    baseline: idx('Baseline Date'), keyboard: idx('Keyboard'), monitor: idx('Monitor'), client: idx('Client'), group: idx('Group'),
    project: idx('Project'), remarks: idx('Remarks'), fixedId: idx('Fixed Asset ID'), grn: idx('GRN No.'), insured: idx('Insured'),
    ageText: H.lastIndexOf('Asset Age')
  };
  const data = rows.slice(1).filter(r => r.length >= H.length - 1 && t(r[C.type]));
  console.log(`Read ${data.length} records (${H.length} columns) from ${FILE}`);

  // ---------- pass 1: reference data ----------
  const people = new Map(); // email -> { names: Map, ctid, workLoc }
  const locations = new Set(), categories = new Map(), manufacturers = new Set(), suppliers = new Set(), models = new Map(), pos = new Map();
  for (const r of data) {
    const isAcc = /^accessories$/i.test(t(r[C.type]));
    const cat = clean(r[C.friendly]);
    if (cat && !categories.has(cat)) categories.set(cat, isAcc ? 'accessory' : 'asset');
    const al = clean(r[C.assetLoc]); if (al) locations.add(al);
    const wl = clean(r[C.workLoc]); if (wl) locations.add(wl);
    const mf = clean(r[C.mfr]); if (mf) manufacturers.add(mf);
    const vd = clean(r[C.vendor]); if (vd && !/client provided/i.test(vd)) suppliers.add(vd);
    const md = clean(r[C.model]);
    if (!isAcc && md) models.set(`${mf}||${md}`, { mf, md, cat });
    const po = t(r[C.po]);
    if (isRealPo(po)) {
      const p = pos.get(po) || { po, invoices: {}, vendor: vd, date: null, total: 0 };
      const inv = clean(r[C.invoice]); if (inv) p.invoices[inv] = (p.invoices[inv] || 0) + 1;
      const d = parseDate(r[C.purchase]); if (d && (!p.date || d < p.date)) p.date = d;
      p.total += parseAmount(r[C.amount]) || 0;
      pos.set(po, p);
    }
    const email = t(r[C.email]).toLowerCase();
    if (/^allocated/i.test(t(r[C.status])) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const p = people.get(email) || { names: new Map(), ctid: '', workLoc: '' };
      const nm = t(r[C.emp]); if (nm) p.names.set(nm, (p.names.get(nm) || 0) + 1);
      if (!p.ctid && clean(r[C.ctid])) p.ctid = t(r[C.ctid]);
      if (!p.workLoc && wl) p.workLoc = wl;
      people.set(email, p);
    }
  }
  console.log(`Found ${people.size} employees, ${locations.size} locations, ${categories.size} categories, ` +
    `${manufacturers.size} manufacturers, ${models.size} models, ${suppliers.size} vendors, ${pos.size} purchase orders`);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const admin = (await client.query(`SELECT id FROM users WHERE email = 'admin@hams.inc'`)).rows[0];
    if (!admin) throw new Error('Admin user admin@hams.inc not found — run the seed first.');

    // ---------- remove existing data ----------
    if (!KEEP) {
      await client.query(`TRUNCATE assets, accessories, consumables, components, licenses, software_assets, software_prices,
        stock_movements, new_joinees, procurement_records, purchase_orders, grn_records, import_jobs, activity_logs,
        notifications, asset_models, manufacturers, suppliers, license_manufacturers, license_suppliers, agents,
        ldap_directory_users, attachments, asset_maintenance, asset_requests, asset_reservations, cache
        RESTART IDENTITY CASCADE`);
      await client.query('DELETE FROM users WHERE id <> $1', [admin.id]);
      await client.query('UPDATE users SET location_id = NULL, department_id = NULL, manager_id = NULL');
      await client.query('DELETE FROM sub_locations');
      await client.query('DELETE FROM locations');
      await client.query('DELETE FROM departments');
      await client.query(`DELETE FROM asset_categories WHERE type IN ('asset', 'accessory')`);
      console.log('Removed existing inventory, people and demo data (admin, roles, settings kept).');
    }

    // ---------- catalog ----------
    const colors = ['#3b82f6', '#6366f1', '#06b6d4', '#8b5cf6', '#14b8a6', '#f59e0b', '#64748b', '#22c55e', '#f97316', '#ec4899'];
    let ci = 0;
    for (const [name, type] of categories) {
      await client.query(`INSERT INTO asset_categories (name, type, color) VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE SET type = EXCLUDED.type, deleted_at = NULL`, [name, type, colors[ci++ % colors.length]]);
    }
    for (const l of locations) {
      const ex = await client.query('SELECT id FROM locations WHERE name = $1 LIMIT 1', [l]);
      if (!ex.rows.length) await client.query('INSERT INTO locations (name, city, country) VALUES ($1, $2, $3)', [l, cityOf(l), countryOf(l)]);
    }
    for (const m of manufacturers) await client.query('INSERT INTO manufacturers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [m]);
    for (const s of suppliers) {
      const ex = await client.query('SELECT id FROM suppliers WHERE name = $1 LIMIT 1', [s]);
      if (!ex.rows.length) await client.query('INSERT INTO suppliers (name) VALUES ($1)', [s]);
    }
    const mapOf = async sql => new Map((await client.query(sql)).rows.map(r => [r.name, r.id]));
    const catMap = await mapOf('SELECT id, name FROM asset_categories');
    const locMap = await mapOf('SELECT id, name FROM locations');
    const mfMap = await mapOf('SELECT id, name FROM manufacturers');
    const supMap = await mapOf('SELECT id, name FROM suppliers');
    const labelMap = await mapOf('SELECT id, name FROM status_labels');
    for (const { mf, md, cat } of models.values()) {
      await client.query(`INSERT INTO asset_models (name, model_number, manufacturer_id, category_id) VALUES ($1, $1, $2, $3)
        ON CONFLICT (name, model_number) DO NOTHING`, [md, mf ? mfMap.get(mf) : null, cat ? catMap.get(cat) : null]);
    }
    const modelMap = new Map((await client.query('SELECT id, name, manufacturer_id FROM asset_models')).rows
      .map(r => [`${r.manufacturer_id}||${r.name}`, r.id]));

    const poRows = [...pos.values()].map(p => {
      const inv = Object.entries(p.invoices).sort((a, b) => b[1] - a[1])[0];
      return [p.po, inv ? inv[0] : null, p.vendor ? supMap.get(p.vendor) || null : null, p.date, p.total || null, 'INR',
        'Imported from Asset Data export', admin.id];
    });
    const poIds = await bulkInsert(client, 'procurement_records',
      ['po_number', 'invoice_number', 'vendor_id', 'purchase_date', 'total_amount', 'currency', 'notes', 'created_by'], poRows, true);
    const poMap = new Map(poRows.map((r, i) => [r[0], poIds[i]]));

    // ---------- people ----------
    // Imported employees can't sign in until an admin sets a password (random, unknown hash).
    const pwd = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    const usedEmp = new Set((await client.query('SELECT employee_id FROM users WHERE employee_id IS NOT NULL')).rows.map(r => r.employee_id));
    const existingEmails = new Map((await client.query('SELECT id, LOWER(email) AS e FROM users')).rows.map(r => [r.e, r.id]));
    const userRows = [], userEmails = [];
    for (const [email, p] of people) {
      if (existingEmails.has(email)) continue;
      const name = [...p.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || email.split('@')[0];
      let emp = p.ctid || null;
      if (emp && usedEmp.has(emp)) emp = null;
      if (emp) usedEmp.add(emp);
      userRows.push([crypto.randomUUID(), emp, name.slice(0, 255), email, pwd, 'employee', 'active',
        p.workLoc ? locMap.get(p.workLoc) || null : null]);
      userEmails.push(email);
    }
    const userIds = await bulkInsert(client, 'users',
      ['uuid', 'employee_id', 'name', 'email', 'password', 'role', 'status', 'location_id'], userRows, true);
    const userMap = new Map(existingEmails);
    userEmails.forEach((e, i) => userMap.set(e, userIds[i]));
    const empRole = (await client.query(`SELECT id FROM roles WHERE name = 'employee'`)).rows[0];
    if (empRole && userIds.length) await bulkInsert(client, 'user_roles', ['user_id', 'role_id'], userIds.map(id => [id, empRole.id]));
    console.log(`Created ${userIds.length} employee accounts.`);

    // ---------- assets & accessories ----------
    const usedSerials = new Set((await client.query('SELECT serial_number FROM assets WHERE serial_number IS NOT NULL')).rows.map(r => r.serial_number));
    const usedTags = new Set((await client.query('SELECT asset_tag FROM assets WHERE asset_tag IS NOT NULL')).rows.map(r => r.asset_tag));
    let tagSeq = (await client.query('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM assets')).rows[0].n;
    const nextTag = () => { let s; do { s = 'HAMS-' + String(tagSeq++).padStart(6, '0'); } while (usedTags.has(s)); usedTags.add(s); return s; };
    const accSerials = new Set();

    const assetRows = [], assetMeta = [], accRows = [], accMeta = [];
    let dupSerials = 0;
    for (const r of data) {
      const g = k => t(r[C[k]]);
      const isAcc = /^accessories$/i.test(g('type'));
      const allocated = /^allocated/i.test(g('status'));
      const email = g('email').toLowerCase();
      const userId = allocated ? userMap.get(email) || null : null;
      const cat = clean(r[C.friendly]) || null;
      const mf = clean(r[C.mfr]) || null;
      const md = clean(r[C.model]) || null;
      const locName = clean(r[C.assetLoc]) || null;
      const purchase = parseDate(r[C.purchase]);

      const cf = {};
      const put = (k, v) => { const s = t(v); if (s && !JUNK.has(s.toLowerCase())) cf[k] = s.slice(0, 500); };
      put('Sr. (source row)', r[C.sr]); put('Asset Type', r[C.type]); put('Parent Asset Type', r[C.parent]);
      put('PO #', r[C.po]); put('FAMS No. / Barcode', r[C.fams]); put('Asset Status (source)', r[C.status]);
      put('Type of Allocation', r[C.allocType]); put('CTID', r[C.ctid]); put('Employee Name', r[C.emp]);
      put('Email ID', r[C.email]); put('Work Location', r[C.workLoc]); put('CTID Employer Name', r[C.employer]);
      put('Machine Name', r[C.machine]); put('OEM OS', r[C.os]); put('Processor', r[C.cpu]);
      if (/^[1-9]\d*$/.test(g('cores'))) cf['No of Cores'] = g('cores');
      if (/^[1-9]\d*$/.test(g('ram'))) cf['RAM Size (GB)'] = g('ram');
      put('Harddisk Type', r[C.hddType]);
      if (/^[1-9]\d*$/.test(g('hddSize'))) cf['Harddisk Size'] = g('hddSize');
      if (/^[1-9]\d*$/.test(g('hddCount'))) cf['No of Harddisks'] = g('hddCount');
      const ws = parseDate(r[C.wStart]); if (ws) cf['Warranty Start Date'] = ws;
      put('Vendor Name', r[C.vendor]); put('Invoice No.', r[C.invoice]); put('Order No.', r[C.order]);
      put('GRN No.', r[C.grn]); put('Fixed Asset ID', r[C.fixedId]); put('Client', r[C.client]);
      put('Group', r[C.group]); put('Project', r[C.project]); put('Client Provided Asset', r[C.clientProv]);
      put('Duty Exempted', r[C.duty]); put('Insured', r[C.insured]); put('Asset Age', r[C.ageText]);
      put('Baseline Date', r[C.baseline]); put('Keyboard', r[C.keyboard]); put('Monitor', r[C.monitor]);
      cf.import_source = 'Asset Data .csv';

      let serial = g('tag') || null;
      const notes = g('remarks') || null;

      if (isAcc) {
        if (serial && accSerials.has(serial)) { cf['Original Service Tag'] = serial; serial = `${serial}-DUP${++dupSerials}`; }
        if (serial) accSerials.add(serial);
        const name = (md || [mf, cat].filter(Boolean).join(' ') || cat || 'Accessory').slice(0, 255);
        accRows.push([name, cat ? catMap.get(cat) || null : null, mf ? mfMap.get(mf) || null : null,
          clean(r[C.vendor]) ? supMap.get(clean(r[C.vendor])) || null : null, locName ? locMap.get(locName) || null : null,
          md, serial, 1, allocated && userId ? 0 : 1, 0, notes, JSON.stringify(cf), purchase || new Date()]);
        accMeta.push({ userId: allocated ? userId : null, locId: locName ? locMap.get(locName) : null });
      } else {
        if (!serial) serial = `NOSERIAL-${g('sr')}`;
        if (usedSerials.has(serial)) {
          cf['Original Service Tag'] = serial;
          let n = 2, cand; do { cand = `${serial}-DUP${n++}`; } while (usedSerials.has(cand));
          serial = cand; dupSerials++;
        }
        usedSerials.add(serial);
        const fams = g('fams');
        const tag = looksLikeTag(fams) && !usedTags.has(fams) ? (usedTags.add(fams), fams) : nextTag();
        const machine = g('machine');
        const name = (looksLikeHostname(machine) ? machine : [mf, md].filter(Boolean).join(' ') || cat || `Asset ${serial}`).slice(0, 255);
        const mfId = mf ? mfMap.get(mf) || null : null;
        assetRows.push([tag, crypto.randomBytes(16).toString('hex'), name,
          mfId && md ? modelMap.get(`${mfId}||${md}`) || null : null, cat ? catMap.get(cat) || null : null, mfId,
          clean(r[C.vendor]) ? supMap.get(clean(r[C.vendor])) || null : null,
          isRealPo(g('po')) ? poMap.get(g('po')) || null : null, locName ? locMap.get(locName) || null : null,
          serial, md, cat, allocated && userId ? 'assigned' : 'available',
          labelMap.get(allocated && userId ? 'Deployed' : 'In Stock') || null,
          purchase, parseAmount(r[C.amount]), parseDate(r[C.wEnd]), allocated ? userId : null, notes,
          JSON.stringify(cf), purchase || new Date()]);
        assetMeta.push({ userId: allocated ? userId : null, locId: locName ? locMap.get(locName) : null, purchase });
      }
    }

    const assetIds = await bulkInsert(client, 'assets',
      ['asset_tag', 'label_token', 'name', 'asset_model_id', 'category_id', 'manufacturer_id', 'supplier_id', 'procurement_id',
        'location_id', 'serial_number', 'model_number', 'category', 'status', 'status_label_id', 'purchase_date',
        'purchase_cost', 'warranty_expiry', 'assigned_to', 'notes', 'custom_fields_data', 'created_at'], assetRows, true);
    console.log(`Imported ${assetIds.length} hardware assets.`);
    const accIds = await bulkInsert(client, 'accessories',
      ['name', 'category_id', 'manufacturer_id', 'supplier_id', 'location_id', 'model_number', 'serial_number',
        'total_qty', 'available_qty', 'min_qty', 'notes', 'custom_fields_data', 'created_at'], accRows, true);
    console.log(`Imported ${accIds.length} accessories.`);

    // ---------- assignments ----------
    const note = 'Imported from Asset Data .csv (allocation date not in source)';
    const asgRows = [], asgAsset = [];
    assetMeta.forEach((m, i) => { if (m.userId) { asgRows.push([assetIds[i], m.userId, admin.id, note]); asgAsset.push(i); } });
    const asgIds = await bulkInsert(client, 'assignments', ['asset_id', 'user_id', 'checked_out_by', 'checkout_notes'], asgRows, true);
    const accAsgRows = [], accAsgIdx = [];
    accMeta.forEach((m, i) => { if (m.userId) { accAsgRows.push([accIds[i], m.userId, 1, note]); accAsgIdx.push(i); } });
    const accAsgIds = await bulkInsert(client, 'accessory_assignments', ['accessory_id', 'user_id', 'qty', 'notes'], accAsgRows, true);
    console.log(`Created ${asgIds.length} hardware and ${accAsgIds.length} accessory assignments.`);

    // ---------- stock ledger (Stock Movements screen) ----------
    const mv = [];
    assetMeta.forEach((m, i) => mv.push(['assets', assetIds[i], 'stock_in', 'in', 1, m.locId || null, null, null, 'available', 'Asset Data import', admin.id]));
    accMeta.forEach((m, i) => mv.push(['accessories', accIds[i], 'stock_in', 'in', 1, m.locId || null, null, null, 'available', 'Asset Data import', admin.id]));
    asgRows.forEach((r, k) => mv.push(['assets', r[0], 'assigned', 'out', 1, null, r[1], asgIds[k], 'assigned', 'Asset Data import (allocated)', admin.id]));
    accAsgRows.forEach((r, k) => mv.push(['accessories', r[0], 'assigned', 'out', 1, null, r[1], accAsgIds[k], 'assigned', 'Asset Data import (allocated)', admin.id]));
    await bulkInsert(client, 'stock_movements', ['module_key', 'item_id', 'movement_type', 'direction', 'quantity',
      'to_location_id', 'holder_user_id', 'related_assignment_id', 'effective_status', 'reason', 'created_by'], mv);

    const allocatedNoUser = data.filter(r => /^allocated/i.test(t(r[C.status])) && !userMap.get(t(r[C.email]).toLowerCase())).length;
    await client.query(`INSERT INTO import_jobs (type, status, rows_total, rows_imported, errors, created_by) VALUES ('assets', 'completed', $1, $2, $3, $4)`,
      [data.length, assetIds.length + accIds.length,
        `${dupSerials} duplicate service tags suffixed; ${allocatedNoUser} allocated rows had no valid email (left unassigned)`, admin.id]);
    await client.query(`INSERT INTO activity_logs (user_id, action, description) VALUES ($1, 'ASSET_BULK_IMPORTED', $2)`,
      [admin.id, `Asset Data import: ${assetIds.length} hardware assets, ${accIds.length} accessories, ${userIds.length} employees.`]);

    await client.query('COMMIT');
    console.log(`\nDONE. Duplicate service tags suffixed: ${dupSerials}. Allocated rows without a usable email: ${allocatedNoUser}.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed, nothing was changed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
})();
