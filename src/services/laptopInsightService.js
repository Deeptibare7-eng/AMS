// Laptop insights for location SPOCs: base vs current location, quality grade, model-wise
// stock and laptop history. Everything is derived from the Asset Data register (Excel)
// fields already stored on each asset; nothing is guessed beyond the rules below.
//
// Location
//   Base location    = the register's "Asset Location" (assets.location_id).
//   Current location = for an in-stock asset, the stock site written in "Machine Name"
//                      (e.g. "Chennai IT Stock ON 09/03/2026" -> Chennai); otherwise, or when
//                      Machine Name names no site, the site of the base location.
//   Sites group locations by campus/city (CT Mindspace-1/2/3 -> Mumbai - Mindspace, ...).
//
// Quality (laptops only)
//   Not deployable : Machine Name says returned to client, remarks say not working/faulty,
//                    client-provided asset, or reserved for a client/project.
//   Good           : bought within the last 4 years and RAM >= 16 GB.
//   Acceptable     : up to 6 years old and RAM >= 8 GB.
//   Poor           : older than 6 years or RAM < 8 GB.
const db = require('../core/db');
const logger = require('../core/logger');

const GRADES = ['Good', 'Acceptable', 'Poor', 'Not deployable'];
const RETURNED = 'Returned to client';

// Site of a location name (the register's Asset Location values).
const LOCATION_SITES = [
  [/mindspace/i, 'Mumbai - Mindspace'],
  [/powai/i, 'Mumbai - Powai'],
  [/^wilco.*chennai/i, 'Wilco Chennai'],
  [/^wilco.*hyderabad/i, 'Wilco Hyderabad'],
  [/^wilco.*usa/i, 'Wilco USA'],
  [/bangalore|bengaluru/i, 'Bangalore'],
  [/pune/i, 'Pune'],
  [/chennai/i, 'Chennai'],
  [/hyderabad/i, 'Hyderabad'],
  [/gurugram|gurgaon/i, 'Gurugram'],
  [/noida/i, 'Noida'],
  [/\busa\b|\bus\b/i, 'USA'],
  [/canada/i, 'Canada'],
  [/poland/i, 'Poland'],
  [/singapore/i, 'Singapore'],
  [/\buk\b/i, 'UK']
];
function siteOfLocation(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const [re, site] of LOCATION_SITES) if (re.test(n)) return site;
  return n.replace(/^CT\s+/i, ''); // e.g. "CT India" -> "India"
}

// Stock site written in Machine Name ("BL IT Stock 12/01/26", "MS-ITSTOCK ON ...").
// Only names that are clearly a stock entry count; host names return null.
const MACHINE_SITES = [
  [/wilco/i, null], // resolved below with the city
  [/^(BL)\b|bangalore|bengaluru/i, 'Bangalore'],
  [/\bMS\b|mindspace/i, 'Mumbai - Mindspace'],
  [/^L\s*&\s*T?\b|^L\s*&|^TX\b|powai/i, 'Mumbai - Powai'],
  [/pune|qbx|qubix/i, 'Pune'],
  [/chennai/i, 'Chennai'],
  [/^(HYBD)\b|hyderabad/i, 'Hyderabad'],
  [/gurugram|gurgaon/i, 'Gurugram'],
  [/noida/i, 'Noida'],
  [/^(US|USA|USIT)\b|princeton/i, 'USA']
];
function siteFromMachineName(raw) {
  const s = String(raw || '').replace(/[-_]/g, ' ').trim();
  if (!s) return null;
  // "Returned to client" / "Returned to GE on ..." (anything returned to someone other than IT stock).
  if (/^return(ed)?\s+to\s+/i.test(s) && !/stock|store/i.test(s)) return RETURNED;
  if (!/stock|store/i.test(s)) return null;
  if (/wilco/i.test(s)) {
    if (/chennai/i.test(s)) return 'Wilco Chennai';
    if (/hyderabad|hybd/i.test(s)) return 'Wilco Hyderabad';
    if (/^us\b|usa/i.test(s)) return 'Wilco USA';
  }
  for (const [re, site] of MACHINE_SITES) if (site && re.test(s)) return site;
  return null;
}

const FAULT = /not\s*working|faulty|defective|\bdead\b|scrap|burnt|beyond\s+repair|motherboard\s+(issue|faulty|dead)|no\s+display|not\s+booting|not\s+power/i;
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

// { grade, reason } for one laptop. `cf` is custom_fields_data (the register's detail columns).
function gradeLaptop({ purchase_date, notes, cf = {}, stock_site }, now = new Date()) {
  const blockers = [];
  if (stock_site === RETURNED) blockers.push('returned to client (Machine Name)');
  if (FAULT.test(notes || '')) blockers.push(`remarks: "${String(notes).slice(0, 60)}"`);
  if (/^yes$/i.test(cf['Client Provided Asset'] || '')) blockers.push('client-provided asset');
  const client = String(cf['Client'] || '').trim(), project = String(cf['Project'] || '').trim();
  if (client || project) blockers.push(`reserved for ${[client, project].filter(Boolean).join(' / ').slice(0, 60)}`);
  if (blockers.length) return { grade: 'Not deployable', reason: blockers.join('; ').slice(0, 255) };

  const bought = purchase_date ? new Date(purchase_date) : null;
  const years = bought && !Number.isNaN(bought.getTime()) ? (now - bought) / MS_PER_YEAR : null;
  const ram = /^\d+$/.test(String(cf['RAM Size (GB)'] || '')) ? Number(cf['RAM Size (GB)']) : null;
  const ageTxt = years === null ? 'purchase date not recorded' : `bought ${bought.toISOString().slice(0, 7)} (${years.toFixed(1)} yrs)`;
  const ramTxt = ram === null ? 'RAM not recorded' : `${ram} GB RAM`;
  const reason = `${ageTxt}, ${ramTxt}`;

  let grade;
  if (years !== null && ram !== null) {
    if (years <= 4 && ram >= 16) grade = 'Good';
    else if (years <= 6 && ram >= 8) grade = 'Acceptable';
    else grade = 'Poor';
  } else if (years === null && ram !== null) {
    grade = ram >= 8 ? 'Acceptable' : 'Poor';      // age unknown: never better than Acceptable
  } else if (years !== null) {
    grade = years <= 6 ? 'Acceptable' : 'Poor';    // RAM unknown: never better than Acceptable
  } else {
    grade = 'Poor';
  }
  return { grade, reason };
}

const isLaptop = category => /^laptop$/i.test(String(category || '').trim());

// Recompute stock site + quality for all assets (or the given ids) and the site of every location.
async function refresh(ids = null) {
  const started = Date.now();
  const locs = await db.query('SELECT id, name, site FROM locations');
  for (const l of locs) {
    const site = siteOfLocation(l.name);
    if (site !== l.site) await db.run('UPDATE locations SET site = $1 WHERE id = $2', [site, l.id]);
  }
  const where = ids && ids.length ? 'WHERE a.id = ANY($1::int[])' : '';
  const rows = await db.query(
    `SELECT a.id, a.category, ac.name AS category_name, a.purchase_date, a.notes, a.custom_fields_data, a.stock_site, a.quality_grade, a.quality_reason
       FROM assets a LEFT JOIN asset_categories ac ON ac.id = a.category_id ${where}`, ids && ids.length ? [ids] : []);
  const now = new Date();
  const upd = { id: [], site: [], grade: [], reason: [] };
  for (const r of rows) {
    const cf = r.custom_fields_data || {};
    const site = siteFromMachineName(cf['Machine Name']);
    let grade = null, reason = null;
    if (isLaptop(r.category_name || r.category)) ({ grade, reason } = gradeLaptop({ purchase_date: r.purchase_date, notes: r.notes, cf, stock_site: site }, now));
    if (site !== r.stock_site || grade !== r.quality_grade || reason !== r.quality_reason) {
      upd.id.push(r.id); upd.site.push(site); upd.grade.push(grade); upd.reason.push(reason);
    }
  }
  for (let i = 0; i < upd.id.length; i += 5000) {
    await db.run(
      `UPDATE assets a SET stock_site = u.site, quality_grade = u.grade, quality_reason = u.reason
         FROM unnest($1::int[], $2::varchar[], $3::varchar[], $4::varchar[]) AS u(id, site, grade, reason)
        WHERE a.id = u.id`,
      [upd.id.slice(i, i + 5000), upd.site.slice(i, i + 5000), upd.grade.slice(i, i + 5000), upd.reason.slice(i, i + 5000)]);
  }
  return { checked: rows.length, changed: upd.id.length, ms: Date.now() - started };
}

// Refresh without failing the caller (used after saves/imports).
async function refreshQuietly(ids = null) {
  try { return await refresh(ids); } catch (err) { logger.error('Laptop insight refresh failed', { error: err.message }); return null; }
}

// SQL fragments shared by the pages. Assets alias a, base location alias l, category alias ac.
const CURRENT_SITE_SQL = `(CASE WHEN a.status = 'available' AND a.stock_site IS NOT NULL THEN a.stock_site ELSE l.site END)`;
const STATE_SQL = `(CASE WHEN a.status = 'available' THEN 'In stock' WHEN a.status = 'assigned' THEN 'Allocated' ELSE 'Retired' END)`;

module.exports = {
  GRADES, RETURNED, CURRENT_SITE_SQL, STATE_SQL,
  siteOfLocation, siteFromMachineName, gradeLaptop, refresh, refreshQuietly
};
