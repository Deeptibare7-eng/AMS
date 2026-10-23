// Where a laptop really is, and whether it is fit to hand out — from the Asset Data register.
//
// Site: the register's Asset Location is where a device was bought, not where it is. Stock rows
// carry the site in Machine Name as "<code> IT STOCK ON <date>" (e.g. "BL IT Stock 12/01/26",
// "Pune QBX ITSTOCK ON 03/02/2026"). Codes as confirmed by the IT team: BL = Bangalore,
// MS = Mindspace, L&T and TX = Powai, QBX = Pune Qubix, EON = Pune EON, HYBD = Hyderabad,
// "<city> wilco" = Wilco Source stock. A joinee's office location ("CT Powai", "CT Mindspace-2")
// maps to the same sites by name. Unknown codes give no site, so nothing is guessed.
//
// Usable for allocation: in a site's stock (not "Returned to client" or a host name), not tagged
// for a client/project or rental, no fault noted, and graded Good or Acceptable.
const STOCK_RE = /^(.*?)[-\s_]*it[-\s_]*stock/i;
const RESERVED_RE = /kyruus|hhp|gravie|deephealth|rental|do not format/i;
const FAULT_RE = /not\s*working|faulty|\bdead\b|broken|scrap|defect|crack|damaged|\bissue\b/i;

// Site of a Machine Name stock code or an office location name: the first rule whose patterns
// all match wins (site null = stop, unknown). The text is lower-cased and padded with spaces.
// Patterns work both as JS RegExps and PostgreSQL ~* regexes, so the agent (JS) and the
// Hardware filters (SQL, siteSql below) always agree.
const SITE_RULES = [
  ['Wilco Hyderabad', 'wilco', 'hyderabad|[\\s_-]hyd'],
  ['Wilco Chennai', 'wilco', 'chennai'],
  ['Wilco USA', 'wilco', '[\\s_-]usa?[\\s_-]'],
  [null, 'wilco'],
  ['Pune EON', 'pune', 'eon'],
  ['Pune Qubix', 'pune', 'qbx|qubix|qbix|\\(q\\)'],
  [null, 'pune'],
  ['Chennai', 'chennai'],
  ['Hyderabad', 'hybd|[\\s_-]hyd[\\s_-]|hyderabad'],
  ['Powai', 'powai|l\\s*&\\s*t|[\\s_-]tx[\\s_-]'],
  ['Bangalore', '[\\s_-]bl|bangalore|bengaluru'],
  ['Mindspace', '[\\s_-]ms\\d?[\\s_-]|mindspace'],
  ['USA', '[\\s_-]usa?[\\s_-]|princeton|sdlc'],
  ['Gurugram', 'gurugram|gurgaon'],
  ['Noida', 'noida']
].map(([site, ...patterns]) => ({ site, patterns, res: patterns.map(p => new RegExp(p, 'i')) }));

function siteOf(text) {
  const c = ` ${String(text || '').toLowerCase()} `;
  const rule = SITE_RULES.find(r => r.res.every(re => re.test(c)));
  return rule ? rule.site : null;
}

// ── The same rules in SQL ──
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
// SQL CASE giving the site of a text expression (or NULL).
function siteSql(textExpr) {
  const padded = `(' ' || lower(${textExpr}) || ' ')`;
  return `CASE ${SITE_RULES.map(r => `WHEN ${r.patterns.map(p => `${padded} ~* ${lit(p)}`).join(' AND ')} THEN ${r.site ? lit(r.site) : 'NULL'}`).join(' ')} END`;
}
// Stock-site key of an asset row (alias a): the site name; '_unknown' for stock with a code no
// rule knows; '_returned' for "Returned to client"; '_none' otherwise (e.g. deployed, host name).
const SITE_KEY_LABELS = { _returned: 'Returned to client', _unknown: 'Stock with an unknown site code', _none: 'No location in Machine Name (e.g. allocated)' };
function siteKeySql(alias = 'a') {
  const m = `(${alias ? alias + '.' : ''}custom_fields_data->>'Machine Name')`;
  const code = `btrim(substring(${m} from '(?i)^(.*?)[-\\s_]*it[-\\s_]*stock'), ' -_')`;
  return `(CASE WHEN ${m} ~* 'it[-\\s_]*stock' THEN COALESCE(${siteSql(code)}, '_unknown')
    WHEN ${m} ~* 'return' THEN '_returned' ELSE '_none' END)`;
}
const siteKeyLabel = k => SITE_KEY_LABELS[k] || k;
// Dropdown options for site keys: sites A–Z, then the special keys in SITE_KEY_LABELS order.
function siteOptions(keys) {
  const set = new Set(keys.filter(Boolean));
  const sites = [...set].filter(k => !SITE_KEY_LABELS[k]).sort();
  return [...sites, ...Object.keys(SITE_KEY_LABELS).filter(k => set.has(k))].map(v => ({ v, l: siteKeyLabel(v) }));
}

// assets.stock_site: a stored column PostgreSQL keeps equal to siteKeySql() on every write, so
// Hardware filters and counts don't re-run the regexes per row (~0.35 s over the register).
// Called at start-up; rebuilt only when the rules change (a hash of the expression is kept in
// the column comment).
async function ensureStockSiteColumn(db) {
  const expr = siteKeySql(null);
  const tag = 'stock-site-rules:' + require('crypto').createHash('sha1').update(expr).digest('hex').slice(0, 16);
  const row = await db.get(`SELECT col_description('assets'::regclass, attnum) AS note FROM pg_attribute
    WHERE attrelid = 'assets'::regclass AND attname = 'stock_site' AND NOT attisdropped`);
  if (row && row.note === tag) return false;
  await db.tx(async t => {
    await t.run('ALTER TABLE assets DROP COLUMN IF EXISTS stock_site');
    await t.run(`ALTER TABLE assets ADD COLUMN stock_site VARCHAR(40) GENERATED ALWAYS AS (${expr}) STORED`);
    await t.run('CREATE INDEX idx_assets_stock_site ON assets (stock_site) WHERE deleted_at IS NULL');
    await t.run(`COMMENT ON COLUMN assets.stock_site IS ${lit(tag)}`);
  });
  return true;
}

// Processor generation from the free-text Processor column (Core Ultra / Apple M / Core iN-NNNN).
function cpuOf(text) {
  const s = String(text || '');
  let m = s.match(/ultra\s*([579])\s*(\d)(\d{2})/i);
  if (m) return { gen: 13 + Number(m[2]), label: `Core Ultra ${m[1]} ${m[2]}${m[3]}` }; // series 1 = 14 ... newer than 13th gen
  m = s.match(/\b(M[1-5])(?:\s*(?:pro|max))?\b/) || s.match(/apple\s*(m[1-5])/i);
  if (m) { const n = parseInt(m[1].slice(1), 10); return { gen: n >= 2 ? 13 : 11, label: `Apple ${m[1].toUpperCase()}` }; }
  m = s.match(/i([3579])[\s-]*(\d{4,5})/i);
  if (m) {
    const n = m[2];
    const gen = n.length === 5 ? +n.slice(0, 2) : n[0] === '1' ? +n.slice(0, 2) : +n[0];
    return { gen, label: `Core i${m[1]} ${gen}th gen` };
  }
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)\s*gen/i);
  if (m) return { gen: +m[1], label: `${m[1]}th gen` };
  return { gen: 0, label: 'processor not recorded' };
}

const GRADES = { good: 'Good', acceptable: 'Acceptable', old: 'Old / low spec' };
// Good: in warranty, 16 GB+, 11th-gen Intel or newer / Core Ultra / Apple M.
// Acceptable: 10th-gen or newer with 8 GB+ (warranty may have ended). Anything else: Old.
function gradeOf(cpu, ramGb, warrantyEnd, today = new Date().toISOString().slice(0, 10)) {
  if (cpu.gen >= 11 && ramGb >= 16 && warrantyEnd && warrantyEnd >= today) return 'good';
  if (cpu.gen >= 10 && ramGb >= 8) return 'acceptable';
  return 'old';
}

// Everything the allocation agent needs to know about one laptop row. Expects
// machine, notes, cpu, ram and warranty (YYYY-MM-DD) columns.
function describeLaptop(row) {
  const machine = String(row.machine || '');
  const hit = machine.match(STOCK_RE);
  const code = hit ? hit[1].replace(/^[\s_-]+|[\s_-]+$/g, '') : '';
  const cpu = cpuOf(row.cpu);
  const ram = parseInt(row.ram, 10) || 0;
  const info = {
    site: hit ? siteOf(code) : null,
    inSiteStock: !!hit,
    returnedToClient: !hit && /return/i.test(machine),
    reserved: RESERVED_RE.test(machine),
    faulty: FAULT_RE.test(`${machine} ${row.notes || ''}`.replace(/accidental damage/ig, '')),
    cpu, ram, warranty: row.warranty || null,
    grade: gradeOf(cpu, ram, row.warranty)
  };
  info.usable = info.inSiteStock && !!info.site && !info.reserved && !info.faulty && info.grade !== 'old';
  info.why = !info.inSiteStock ? (info.returnedToClient ? 'returned to client' : 'no stock site in Machine Name')
    : !info.site ? `unknown stock code "${code}"` : info.reserved ? 'client/project or reserved stock'
      : info.faulty ? 'fault noted' : info.grade === 'old' ? 'old / low spec' : '';
  info.summary = `${GRADES[info.grade]}: ${cpu.label}, ${ram || '?'} GB${info.warranty ? `, warranty ${info.warranty >= new Date().toISOString().slice(0, 10) ? 'to' : 'ended'} ${info.warranty}` : ''}`;
  return info;
}

// Best first: Good before Acceptable, then preferred model (index into `patterns`; designation
// rules), newer processor, later warranty end, then oldest record.
function rankLaptops(list, patterns = []) {
  const pref = l => { const i = patterns.findIndex(p => p && (l.model || '').toLowerCase().includes(p.toLowerCase())); return i < 0 ? patterns.length : i; };
  return list.slice().sort((a, b) =>
    (a.info.grade === 'good' ? 0 : 1) - (b.info.grade === 'good' ? 0 : 1) ||
    pref(a) - pref(b) ||
    b.info.cpu.gen - a.info.cpu.gen ||
    String(b.info.warranty || '').localeCompare(String(a.info.warranty || '')) ||
    a.id - b.id);
}

// SQL columns describeLaptop() reads, for a query over `assets a`.
const LAPTOP_COLUMNS = `a.custom_fields_data->>'Machine Name' AS machine, a.custom_fields_data->>'Processor' AS cpu,
  a.custom_fields_data->>'RAM Size (GB)' AS ram, TO_CHAR(a.warranty_expiry, 'YYYY-MM-DD') AS warranty, a.notes`;

// "Quality & Location" panel of the asset page: grade (laptops only), where the asset is now
// (its stock site while in stock, else the site of its Asset Location) and its state.
function assetInsight(asset) {
  let cf = asset.custom_fields_data || {};
  if (typeof cf === 'string') { try { cf = JSON.parse(cf); } catch (e) { cf = {}; } }
  const stockSite = asset.stock_site && !asset.stock_site.startsWith('_') ? asset.stock_site : null;
  const state = asset.assigned_to ? 'Allocated' : asset.stock_site === '_returned' ? 'Returned to client'
    : asset.stock_site && asset.stock_site !== '_none' ? 'In stock' : 'Not allocated';
  const baseSite = siteOf(asset.location_name);
  const out = { stock_site: stockSite, base_location: asset.location_name || null, base_site: baseSite,
    current_site: state === 'In stock' && stockSite ? stockSite : baseSite, state, quality_grade: null, quality_reason: null };
  if (/^laptop$/i.test(asset.category_name || '')) {
    const w = asset.warranty_expiry ? new Date(asset.warranty_expiry) : null;
    const info = describeLaptop({ machine: cf['Machine Name'], cpu: cf['Processor'], ram: cf['RAM Size (GB)'], notes: asset.notes,
      warranty: w && !isNaN(w) ? `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}` : null });
    out.quality_grade = info.faulty ? 'Not deployable' : GRADES[info.grade];
    out.quality_reason = [info.summary.replace(/^[^:]+: /, ''), info.reserved && 'client/project or reserved stock', info.faulty && 'fault noted'].filter(Boolean).join(' · ');
  }
  return out;
}

module.exports = { siteOf, siteSql, siteKeySql, siteKeyLabel, siteOptions, SITE_KEY_LABELS, ensureStockSiteColumn, cpuOf, gradeOf, describeLaptop, rankLaptops, assetInsight, GRADES, LAPTOP_COLUMNS };
