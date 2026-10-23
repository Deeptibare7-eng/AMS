// Replace inventory data with the "Asset Data.xlsx" asset register (Intune columns are ignored).
//
// Usage:  node tools/import-asset-register.js "<path to Asset Data.xlsx>"
//
// Take a database backup first. Removes existing assets, accessories, assignments,
// repair history, stock ledger, procurement, catalog, software/import data and
// employee accounts, then loads the register. KEPT: admin and other non-employee
// accounts, roles, permissions, modules, settings, status labels, audit log, and
// New Joinees (their old suggestions are cleared and re-recommended from the new stock).
//
// Mapping (decided from the file's own columns):
//   Asset Type = Computing / Servers   -> Hardware assets
//   Asset Type = Accessories           -> Accessories (one record per unit)
//   (no Asset Type)                    -> skipped
//   Allocated + CTID                   -> employee account (by CTID) + open assignment
//   Allocated + Type "Hardware"        -> Deployed, no employee
//   In Repository                      -> In Stock
//   Retired - Lost / Absconding        -> Lost;  Retired - Not Working -> Broken;  other Retired -> Retired
//   Employee name/email                -> current directory (looked up by CTID before the wipe),
//                                         else CTID + placeholder email
//   Other register columns -> custom fields; Intune columns, phone numbers and Wi-Fi IPs are not imported.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const db = require('../src/core/db');

const FILE = process.argv[2];
if (!FILE) { console.error('Usage: node tools/import-asset-register.js "<path to Asset Data.xlsx>"'); process.exit(1); }

const t = v => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const JUNK = new Set(['', 'na', 'n/a', '#n/a', 'nil', 'none', 'pending', '-', '0', 'tbd', 'null']);
const clean = v => (JUNK.has(t(v).toLowerCase()) ? '' : t(v));
const cellText = v => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    return '';
  }
  return String(v);
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(v) {
  const s = t(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return +m[1] >= 1990 && +m[1] <= 2045 ? s : null;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = +m[3]; if (y < 100) y += y >= 70 ? 1900 : 2000;
    return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  return null;
}
function parseAmount(v) {
  const s = t(v).replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return n > 0 && n < 1e9 ? n : null;
}
const isRealPo = v => /^(CTIN|CTINPO|CTUS|PO)[-_ ]?\w*\d{3,}/i.test(t(v)) || /^\d{6,}$/.test(t(v));
const looksLikeTag = v => /^\d{6,12}$/.test(t(v));
const looksLikeHostname = v => /^[A-Za-z][A-Za-z0-9\-_.]{2,30}$/.test(t(v)) && !/stock|return|client|store|scrap|repair|handover/i.test(t(v));
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function statusFor(raw) {
  const s = t(raw).toLowerCase();
  if (s.startsWith('allocated')) return { kind: 'allocated' };
  if (s.startsWith('in repository')) return { kind: 'stock', status: 'available', label: 'In Stock' };
  if (/lost|abscond/.test(s)) return { kind: 'retired', status: 'archived', label: 'Lost' };
  if (/not working/.test(s)) return { kind: 'retired', status: 'archived', label: 'Broken' };
  if (s.startsWith('retired')) return { kind: 'retired', status: 'archived', label: 'Retired' };
  return { kind: 'stock', status: 'available', label: 'In Stock' };
}
function countryOf(name) {
  const n = name.toLowerCase();
  if (/\b(us|usa)\b|princeton/.test(n)) return 'USA';
  if (/canada/.test(n)) return 'Canada';
  if (/\buk\b|united kingdom/.test(n)) return 'United Kingdom';
  if (/singapore/.test(n)) return 'Singapore';
  if (/poland/.test(n)) return 'Poland';
  return 'India';
}
function cityOf(name) {
  const n = name.toLowerCase();
  for (const [k, c] of [['pune', 'Pune'], ['bangalore', 'Bengaluru'], ['chennai', 'Chennai'], ['hyderabad', 'Hyderabad'],
    ['gurugram', 'Gurugram'], ['noida', 'Noida'], ['powai', 'Mumbai'], ['mindspace', 'Navi Mumbai'], ['singapore', 'Singapore']]) {
    if (n.includes(k)) return c;
  }
  return null;
}
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

(async () => {
  // ---------- read workbook ----------
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.worksheets[0];
  const H = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { H[i - 1] = t(cellText(c.value)); });
  const col = name => { const i = H.indexOf(name); if (i < 0) throw new Error(`Column "${name}" not found`); return i; };
  const opt = name => H.indexOf(name);
  const all = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const a = [];
    for (let i = 1; i <= H.length; i++) a.push(t(cellText(row.getCell(i).value)));
    if (a.some(Boolean)) all.push(a);
  });
  const C = {
    sr: col('Sr.'), type: col('Asset Type'), friendly: col('Friendly Name'), tag: col('Service Tag #'), po: col('PO #'),
    fams: col('FAMS No. / Barcode'), purchase: col('Purchase Date'), amount: col('Amount'), status: col('Asset Status'),
    allocType: col('Type of Allocation'), ctid: col('CTID'), clientProv: col('Client Provided Asset'), duty: col('Duty Exempted'),
    loc: col('Asset Location'), employer: col('CTID Employer Name'), parent: col('Parent Asset Type'), mfr: col('Manufacturer Name'),
    machine: col('Machine Name'), model: col('Model Number'), os: col('OEM OS'), hddType: col('Harddisk Type'), hddSize: col('Harddisk Size'),
    hddCount: col('No of Harddisks'), cpu: col('Processor'), cores: col('No of Cores Processors'), ram: col('RAM Size'),
    wStart: col('Warranty Start Date'), wEnd: col('Warranty End Date'), vendor: col('Vendor Name'), invoice: col('Invoice No.'),
    order: col('Order No.'), baseline: col('Baseline Date'), keyboard: col('Keyboard'), monitor: col('Monitor'), client: col('Client'),
    group: col('Group'), project: col('Project'), remarks: col('Remarks'), fixedId: col('Fixed Asset ID'), grn: col('GRN No.'),
    insured: col('Insured')
  };
  const g = (r, k) => (C[k] >= 0 ? r[C[k]] || '' : '');
  const data = all.filter(r => g(r, 'type'));
  const skipped = all.length - data.length;
  console.log(`Read ${all.length} rows: ${data.length} asset-register rows, ${skipped} rows without an Asset Type skipped.`);

  // ---------- reference data from the file ----------
  const locations = new Set(), categories = new Map(), manufacturers = new Set(), suppliers = new Set(), models = new Map(), pos = new Map();
  const userLoc = new Map();      // ctid -> Map(location -> count)
  for (const r of data) {
    const isAcc = /^accessories$/i.test(g(r, 'type'));
    const cat = clean(g(r, 'friendly'));
    if (cat) { const c = categories.get(cat) || { asset: 0, accessory: 0 }; c[isAcc ? 'accessory' : 'asset']++; categories.set(cat, c); }
    const loc = clean(g(r, 'loc')); if (loc) locations.add(loc);
    const mf = clean(g(r, 'mfr')); if (mf) manufacturers.add(mf);
    const vd = clean(g(r, 'vendor')); if (vd && !/client provided/i.test(vd)) suppliers.add(vd);
    const md = clean(g(r, 'model')); if (!isAcc && md) models.set(`${mf}||${md}`, { mf, md, cat });
    const po = g(r, 'po');
    if (isRealPo(po)) {
      const p = pos.get(po) || { po, invoices: {}, vendor: vd, date: null, total: 0 };
      const inv = clean(g(r, 'invoice')); if (inv) p.invoices[inv] = (p.invoices[inv] || 0) + 1;
      const d = parseDate(g(r, 'purchase')); if (d && (!p.date || d < p.date)) p.date = d;
      p.total += parseAmount(g(r, 'amount')) || 0;
      pos.set(po, p);
    }
    const ctid = clean(g(r, 'ctid'));
    if (ctid && statusFor(g(r, 'status')).kind === 'allocated') {
      const k = ctid.toLowerCase();
      if (loc) { const m = userLoc.get(k) || new Map(); m.set(loc, (m.get(loc) || 0) + 1); userLoc.set(k, m); }
    }
  }
  const ctids = new Map(); // lower -> original CTID (allocated rows only)
  for (const r of data) { const c = clean(g(r, 'ctid')); if (c && statusFor(g(r, 'status')).kind === 'allocated' && !ctids.has(c.toLowerCase())) ctids.set(c.toLowerCase(), c); }
  console.log(`Found ${ctids.size} employees (CTIDs), ${locations.size} locations, ${categories.size} categories, ${manufacturers.size} manufacturers, ${models.size} models, ${suppliers.size} vendors, ${pos.size} purchase orders`);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const admin = (await client.query(`SELECT id FROM users WHERE email = 'admin@hams.inc'`)).rows[0];
    if (!admin) throw new Error('Admin user admin@hams.inc not found.');

    // ---------- lookup from the current directory (before it is cleared) ----------
    const dirByCtid = new Map();
    for (const u of (await client.query(
      `SELECT employee_id, name, LOWER(email) AS email FROM users WHERE employee_id IS NOT NULL AND role = 'employee'`)).rows) {
      dirByCtid.set(u.employee_id.toLowerCase(), { name: u.name, email: u.email && !u.email.endsWith('.invalid') ? u.email : '' });
    }
    // New Joinees are kept: remember their location names to re-link after locations are rebuilt.
    const joinees = (await client.query(
      `SELECT nj.id, nj.user_id, LOWER(nj.employee_id) AS emp, l.name AS loc FROM new_joinees nj LEFT JOIN locations l ON l.id = nj.location_id`)).rows;
    const joineeUserIds = joinees.map(j => j.user_id);

    // ---------- remove existing data (dependency order; no TRUNCATE CASCADE so New Joinees survive) ----------
    await client.query(`UPDATE new_joinees SET draft_laptop_asset_id = NULL, draft_headphone_accessory_id = NULL, draft_note = NULL,
                          draft_generated_at = NULL, allocation_status = 'pending' WHERE allocation_status <> 'allocated'`);
    const delOrder = ['assignments', 'accessory_assignments', 'component_assignments', 'license_assignments', 'consumable_issues',
      'stock_movements', 'asset_maintenance', 'asset_requests', 'asset_reservations', 'attachments', 'inventory_workflow_notes',
      'grn_items', 'grn_records', 'purchase_orders', 'heartbeat_alerts', 'asset_heartbeats', 'asset_health_status', 'asset_monitors',
      'agent_metrics', 'agents', 'notification_reads', 'notifications', 'import_jobs', 'software_assets', 'software_prices',
      'ldap_directory_users', 'cache', 'assets', 'accessories', 'consumables', 'components', 'licenses', 'procurement_records',
      'asset_models', 'license_manufacturers', 'license_suppliers', 'manufacturers', 'suppliers'];
    const removed = {};
    for (const tbl of delOrder) removed[tbl] = (await client.query(`DELETE FROM ${tbl}`)).rowCount;
    removed.employees = (await client.query(
      `DELETE FROM users WHERE role = 'employee' AND id <> ALL($1::int[])`, [joineeUserIds])).rowCount;
    await client.query('UPDATE users SET department_id = NULL, manager_id = NULL');
    removed.sub_locations = (await client.query('DELETE FROM sub_locations')).rowCount;
    removed.locations = (await client.query('DELETE FROM locations')).rowCount;
    await client.query('DELETE FROM departments');
    removed.categories = (await client.query(`DELETE FROM asset_categories WHERE type IN ('asset', 'accessory')`)).rowCount;
    console.log('Removed:', Object.entries(removed).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(', '));

    // ---------- catalog ----------
    const colors = ['#3b82f6', '#6366f1', '#06b6d4', '#8b5cf6', '#14b8a6', '#f59e0b', '#64748b', '#22c55e', '#f97316', '#ec4899'];
    let ci = 0;
    for (const [name, c] of categories) {
      await client.query(`INSERT INTO asset_categories (name, type, color) VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE SET type = EXCLUDED.type, deleted_at = NULL`, [name, c.accessory > c.asset ? 'accessory' : 'asset', colors[ci++ % colors.length]]);
    }
    for (const l of locations) await client.query('INSERT INTO locations (name, city, country) VALUES ($1, $2, $3)', [l, cityOf(l), countryOf(l)]);
    // Joinee locations that aren't in the new register are recreated so joinees keep them.
    const joineeOnlyLocs = [...new Set(joinees.map(j => j.loc).filter(n => n && !locations.has(n)))];
    for (const l of joineeOnlyLocs) await client.query('INSERT INTO locations (name, city, country) VALUES ($1, $2, $3)', [l, cityOf(l), countryOf(l)]);
    for (const m of manufacturers) await client.query('INSERT INTO manufacturers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [m]);
    for (const s of suppliers) await client.query('INSERT INTO suppliers (name) VALUES ($1)', [s]);
    const mapOf = async sql => new Map((await client.query(sql)).rows.map(r => [r.name, r.id]));
    const catMap = await mapOf('SELECT id, name FROM asset_categories');
    const locMap = await mapOf('SELECT id, name FROM locations');
    const mfMap = await mapOf('SELECT id, name FROM manufacturers');
    const supMap = await mapOf('SELECT id, name FROM suppliers');
    const labelMap = await mapOf('SELECT id, name FROM status_labels');
    for (const j of joinees) {
      await client.query('UPDATE new_joinees SET location_id = $1 WHERE id = $2', [j.loc ? locMap.get(j.loc) || null : null, j.id]);
      await client.query('UPDATE users SET location_id = $1 WHERE id = $2', [j.loc ? locMap.get(j.loc) || null : null, j.user_id]);
    }
    for (const { mf, md, cat } of models.values()) {
      await client.query(`INSERT INTO asset_models (name, model_number, manufacturer_id, category_id) VALUES ($1, $1, $2, $3)
        ON CONFLICT (name, model_number) DO NOTHING`, [md, mf ? mfMap.get(mf) : null, cat ? catMap.get(cat) : null]);
    }
    const modelMap = new Map((await client.query('SELECT id, name, manufacturer_id FROM asset_models')).rows.map(r => [`${r.manufacturer_id}||${r.name}`, r.id]));
    const poRows = [...pos.values()].map(p => {
      const inv = Object.entries(p.invoices).sort((a, b) => b[1] - a[1])[0];
      return [p.po, inv ? inv[0] : null, p.vendor ? supMap.get(p.vendor) || null : null, p.date, p.total || null, 'INR', 'Imported from Asset Data.xlsx', admin.id];
    });
    const poIds = await bulkInsert(client, 'procurement_records',
      ['po_number', 'invoice_number', 'vendor_id', 'purchase_date', 'total_amount', 'currency', 'notes', 'created_by'], poRows, true);
    const poMap = new Map(poRows.map((r, i) => [r[0], poIds[i]]));

    // ---------- employees (one per CTID with an allocation) ----------
    const pwd = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // unusable: no one knows it
    const existing = (await client.query('SELECT id, LOWER(employee_id) AS emp, LOWER(email) AS email FROM users')).rows;
    const userByCtid = new Map(existing.filter(u => u.emp).map(u => [u.emp, u.id])); // joinees already present
    const usedEmails = new Set(existing.map(u => u.email));
    const userRows = [], userKeys = [];
    const source = { directory: 0, ctidOnly: 0 };
    for (const [k, ctid] of ctids) {
      if (userByCtid.has(k)) continue;
      let name = '', email = '';
      const d = dirByCtid.get(k);
      if (d && d.email && !usedEmails.has(d.email)) { name = d.name; email = d.email; source.directory++; }
      else { name = (d && d.name) || ctid; email = `${k.replace(/[^a-z0-9._-]/g, '')}@pending-email.invalid`; source.ctidOnly++; }
      usedEmails.add(email);
      const lm = userLoc.get(k);
      const homeLoc = lm ? [...lm.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
      userRows.push([crypto.randomUUID(), ctid, name.slice(0, 255), email, pwd, 'employee', 'active', homeLoc ? locMap.get(homeLoc) || null : null]);
      userKeys.push(k);
    }
    const userIds = await bulkInsert(client, 'users', ['uuid', 'employee_id', 'name', 'email', 'password', 'role', 'status', 'location_id'], userRows, true);
    userKeys.forEach((k, i) => userByCtid.set(k, userIds[i]));
    const empRole = (await client.query(`SELECT id FROM roles WHERE name = 'employee'`)).rows[0];
    if (empRole && userIds.length) await bulkInsert(client, 'user_roles', ['user_id', 'role_id'], userIds.map(id => [id, empRole.id]));
    console.log(`Created ${userIds.length} employee accounts (names/emails: ${source.directory} from current directory, ${source.ctidOnly} CTID only).`);

    // ---------- assets & accessories ----------
    const usedSerials = new Set(), usedTags = new Set(), accSerials = new Set();
    let tagSeq = 1, dupSerials = 0;
    const nextTag = () => { let s; do { s = 'HAMS-' + String(tagSeq++).padStart(6, '0'); } while (usedTags.has(s)); usedTags.add(s); return s; };
    const assetRows = [], assetMeta = [], accRows = [], accMeta = [];
    const counts = { allocatedEmp: 0, allocatedHw: 0, stock: 0, retired: 0 };
    for (const r of data) {
      const isAcc = /^accessories$/i.test(g(r, 'type'));
      const st = statusFor(g(r, 'status'));
      const ctid = clean(g(r, 'ctid'));
      const userId = st.kind === 'allocated' && ctid ? userByCtid.get(ctid.toLowerCase()) || null : null;
      const cat = clean(g(r, 'friendly')) || null;
      const mf = clean(g(r, 'mfr')) || null;
      const md = clean(g(r, 'model')) || null;
      const locName = clean(g(r, 'loc')) || null;
      const purchase = parseDate(g(r, 'purchase'));
      let status = st.status, label = st.label;
      if (st.kind === 'allocated') { status = 'assigned'; label = 'Deployed'; counts[userId ? 'allocatedEmp' : 'allocatedHw']++; } else counts[st.kind]++;

      const cf = {};
      const put = (k, v) => { const s = t(v); if (s && !JUNK.has(s.toLowerCase())) cf[k] = s.slice(0, 500); };
      put('Sr. (source row)', g(r, 'sr')); put('Asset Type', g(r, 'type')); put('Parent Asset Type', g(r, 'parent'));
      put('Asset Status (source)', g(r, 'status')); put('Type of Allocation', g(r, 'allocType')); put('CTID', g(r, 'ctid'));
      put('CTID Employer Name', g(r, 'employer')); put('PO #', g(r, 'po')); put('FAMS No. / Barcode', g(r, 'fams'));
      put('Machine Name', g(r, 'machine')); put('OEM OS', g(r, 'os')); put('Processor', g(r, 'cpu'));
      if (/^[1-9]\d*$/.test(g(r, 'cores'))) cf['No of Cores'] = g(r, 'cores');
      if (/^[1-9]\d*$/.test(g(r, 'ram'))) cf['RAM Size (GB)'] = g(r, 'ram');
      put('Harddisk Type', g(r, 'hddType'));
      if (/^[1-9]\d*$/.test(g(r, 'hddSize'))) cf['Harddisk Size'] = g(r, 'hddSize');
      if (/^[1-9]\d*$/.test(g(r, 'hddCount'))) cf['No of Harddisks'] = g(r, 'hddCount');
      const ws_ = parseDate(g(r, 'wStart')); if (ws_) cf['Warranty Start Date'] = ws_;
      put('Vendor Name', g(r, 'vendor')); put('Invoice No.', g(r, 'invoice')); put('Order No.', g(r, 'order'));
      put('GRN No.', g(r, 'grn')); put('Fixed Asset ID', g(r, 'fixedId')); put('Client', g(r, 'client')); put('Group', g(r, 'group'));
      put('Project', g(r, 'project')); put('Client Provided Asset', g(r, 'clientProv')); put('Duty Exempted', g(r, 'duty'));
      put('Insured', g(r, 'insured')); put('Baseline Date', g(r, 'baseline')); put('Keyboard', g(r, 'keyboard')); put('Monitor', g(r, 'monitor'));
      if (st.kind === 'allocated' && !userId) cf['Allocated To'] = 'Hardware (no employee)';
      cf.import_source = 'Asset Data.xlsx';

      let serial = g(r, 'tag') || null;
      const notes = g(r, 'remarks') || null;
      const supId = clean(g(r, 'vendor')) ? supMap.get(clean(g(r, 'vendor'))) || null : null;
      const locId = locName ? locMap.get(locName) || null : null;
      if (isAcc) {
        if (serial && accSerials.has(serial.toUpperCase())) { cf['Original Service Tag'] = serial; serial = `${serial}-DUP${++dupSerials}`; }
        if (serial) accSerials.add(serial.toUpperCase());
        const name = (md || [mf, cat].filter(Boolean).join(' ') || 'Accessory').slice(0, 255);
        const inStock = st.kind === 'stock' ? 1 : 0; // allocated or retired units are not available
        accRows.push([name, cat ? catMap.get(cat) || null : null, mf ? mfMap.get(mf) || null : null, supId, locId,
          md, serial, 1, inStock, 0, st.kind === 'retired' ? `[${g(r, 'status')}] ${notes || ''}`.trim() : notes, JSON.stringify(cf), purchase || new Date()]);
        accMeta.push({ userId, locId, kind: st.kind });
      } else {
        if (!serial) serial = `NOSERIAL-${g(r, 'sr') || assetRows.length + 1}`;
        if (usedSerials.has(serial.toUpperCase())) {
          cf['Original Service Tag'] = serial;
          let n = 2, cand; do { cand = `${serial}-DUP${n++}`; } while (usedSerials.has(cand.toUpperCase()));
          serial = cand; dupSerials++;
        }
        usedSerials.add(serial.toUpperCase());
        const fams = g(r, 'fams');
        const tag = looksLikeTag(fams) && !usedTags.has(fams) ? (usedTags.add(fams), fams) : nextTag();
        const machine = g(r, 'machine');
        const name = (looksLikeHostname(machine) ? machine : [mf, md].filter(Boolean).join(' ') || cat || `Asset ${serial}`).slice(0, 255);
        const mfId = mf ? mfMap.get(mf) || null : null;
        assetRows.push([tag, crypto.randomBytes(16).toString('hex'), name,
          mfId && md ? modelMap.get(`${mfId}||${md}`) || null : null, cat ? catMap.get(cat) || null : null, mfId, supId,
          isRealPo(g(r, 'po')) ? poMap.get(g(r, 'po')) || null : null, locId, serial, md, cat, status,
          labelMap.get(label) || null, purchase, parseAmount(g(r, 'amount')), parseDate(g(r, 'wEnd')), userId, notes,
          JSON.stringify(cf), purchase || new Date()]);
        assetMeta.push({ userId, locId, kind: st.kind });
      }
    }
    const assetIds = await bulkInsert(client, 'assets',
      ['asset_tag', 'label_token', 'name', 'asset_model_id', 'category_id', 'manufacturer_id', 'supplier_id', 'procurement_id',
        'location_id', 'serial_number', 'model_number', 'category', 'status', 'status_label_id', 'purchase_date',
        'purchase_cost', 'warranty_expiry', 'assigned_to', 'notes', 'custom_fields_data', 'created_at'], assetRows, true);
    const accIds = await bulkInsert(client, 'accessories',
      ['name', 'category_id', 'manufacturer_id', 'supplier_id', 'location_id', 'model_number', 'serial_number',
        'total_qty', 'available_qty', 'min_qty', 'notes', 'custom_fields_data', 'created_at'], accRows, true);
    console.log(`Imported ${assetIds.length} hardware assets and ${accIds.length} accessories.`);

    // ---------- assignments ----------
    const note = 'Imported from Asset Data.xlsx (allocation date not in source)';
    const asgRows = [];
    assetMeta.forEach((m, i) => { if (m.userId) asgRows.push([assetIds[i], m.userId, admin.id, note]); });
    const asgIds = await bulkInsert(client, 'assignments', ['asset_id', 'user_id', 'checked_out_by', 'checkout_notes'], asgRows, true);
    const accAsgRows = [];
    accMeta.forEach((m, i) => { if (m.userId) accAsgRows.push([accIds[i], m.userId, 1, note]); });
    const accAsgIds = await bulkInsert(client, 'accessory_assignments', ['accessory_id', 'user_id', 'qty', 'notes'], accAsgRows, true);
    console.log(`Created ${asgIds.length} hardware and ${accAsgIds.length} accessory assignments.`);

    // ---------- stock ledger ----------
    const mv = [];
    assetMeta.forEach((m, i) => mv.push(['assets', assetIds[i], 'stock_in', 'in', 1, m.locId || null, null, null, 'available', 'Asset Data import', admin.id]));
    accMeta.forEach((m, i) => mv.push(['accessories', accIds[i], 'stock_in', 'in', 1, m.locId || null, null, null, 'available', 'Asset Data import', admin.id]));
    asgRows.forEach((r, k) => mv.push(['assets', r[0], 'assigned', 'out', 1, null, r[1], asgIds[k], 'assigned', 'Asset Data import (allocated)', admin.id]));
    accAsgRows.forEach((r, k) => mv.push(['accessories', r[0], 'assigned', 'out', 1, null, r[1], accAsgIds[k], 'assigned', 'Asset Data import (allocated)', admin.id]));
    assetMeta.forEach((m, i) => { if (m.kind === 'retired') mv.push(['assets', assetIds[i], 'retired', 'out', 1, null, null, null, 'archived', 'Asset Data import (retired)', admin.id]); });
    await bulkInsert(client, 'stock_movements', ['module_key', 'item_id', 'movement_type', 'direction', 'quantity',
      'to_location_id', 'holder_user_id', 'related_assignment_id', 'effective_status', 'reason', 'created_by'], mv);

    await client.query(`INSERT INTO import_jobs (type, status, rows_total, rows_imported, errors, created_by) VALUES ('assets', 'completed', $1, $2, $3, $4)`,
      [all.length, assetIds.length + accIds.length,
        `${skipped} rows without an Asset Type skipped; ${dupSerials} duplicate service tags suffixed; ${counts.allocatedHw} allocated to hardware (no employee)`, admin.id]);
    await client.query(`INSERT INTO activity_logs (user_id, action, description) VALUES ($1, 'ASSET_BULK_IMPORTED', $2)`,
      [admin.id, `Asset Data.xlsx import: ${assetIds.length} hardware assets, ${accIds.length} accessories, ${userIds.length} employees (previous inventory replaced).`]);
    await client.query('COMMIT');
    console.log(`Status: ${counts.allocatedEmp} allocated to employees, ${counts.allocatedHw} allocated to hardware, ${counts.stock} in stock, ${counts.retired} retired. Duplicate service tags suffixed: ${dupSerials}.`);
    if (joineeOnlyLocs.length) console.log(`Kept joinee locations not in the register: ${joineeOnlyLocs.join(', ')}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed, nothing was changed:', err.message);
    process.exitCode = 1;
    client.release();
    await db.pool.end();
    return;
  }
  client.release();

  // Re-recommend kept New Joinees from the new inventory (engineer approval still required).
  try {
    const nj = require('../src/services/newJoineeService');
    const drafted = await nj.ensureDrafts();
    console.log(`New Joinees re-recommended from new stock: ${drafted}.`);
  } catch (err) { console.error('Re-recommendation failed (run: node bin/hams-cli.js joinees:recommend):', err.message); }
  await db.pool.end();
})();
