// Location Stock (for location SPOCs) + the Asset Models statistics + laptop history +
// the in-app stock assistant. Read-only; built on the laptop insight columns
// (stock_site, quality_grade, quality_reason, locations.site).
const db = require('../core/db');
const authz = require('./authorizationService');
const Paginator = require('../core/paginator');
const { GRADES, CURRENT_SITE_SQL, STATE_SQL } = require('./laptopInsightService');

const STATES = ['In stock', 'Allocated', 'Retired'];
const STATE_STATUS = { 'In stock': 'available', Allocated: 'assigned' };

// ---------------- filters ----------------
// Query-string values arrive as a string or an array (name[]=a&name[]=b).
const list = v => (v === undefined || v === null || v === '' ? [] : (Array.isArray(v) ? v : [v])).map(x => String(x).trim()).filter(Boolean);
const ids = v => list(v).map(Number).filter(n => Number.isInteger(n) && n > 0);

function parseFilters(q = {}, defaults = {}) {
  const f = {
    search: String(q.search || '').trim().slice(0, 100),
    site: list(q.site), base: ids(q.base), quality: list(q.quality).filter(g => GRADES.includes(g)),
    model: ids(q.model), manufacturer: ids(q.manufacturer), category: ids(q.category),
    state: list(q.state).filter(s => STATES.includes(s)), with_stock: q.with_stock === '1' || q.with_stock === 'on'
  };
  // Defaults only on a first visit; a submitted form / filter link carries f=1 so cleared filters stay cleared.
  if (!q.f) for (const [k, v] of Object.entries(defaults)) if (!f[k].length) f[k] = v;
  return f;
}

// Query string for links (keeps every filter).
function toQuery(f, extra = {}) {
  const p = new URLSearchParams({ f: '1' });
  const all = { ...f, ...extra };
  for (const [k, v] of Object.entries(all)) {
    if (Array.isArray(v)) v.forEach(x => p.append(`${k}[]`, x));
    else if (v === true) p.append(k, '1');
    else if (v !== undefined && v !== null && v !== '' && v !== false) p.append(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// WHERE for assets (alias a, base location l). `skip` leaves out one filter (used for model-level stats).
async function assetWhere(f, user, { skip = [] } = {}) {
  const where = ['a.deleted_at IS NULL'], params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  const scope = await authz.locationScopeFor(user);
  if (!scope.global) add('a.location_id = ANY(?::int[])', scope.location_ids);
  if (f.site.length && !skip.includes('site')) add(`${CURRENT_SITE_SQL} = ANY(?::text[])`, f.site);
  if (f.base.length && !skip.includes('base')) add('a.location_id = ANY(?::int[])', f.base);
  if (f.quality.length && !skip.includes('quality')) add('a.quality_grade = ANY(?::text[])', f.quality);
  if (f.model.length && !skip.includes('model')) add('a.asset_model_id = ANY(?::int[])', f.model);
  if (f.manufacturer.length && !skip.includes('manufacturer')) add('a.manufacturer_id = ANY(?::int[])', f.manufacturer);
  if (f.category.length && !skip.includes('category')) add('a.category_id = ANY(?::int[])', f.category);
  if (f.state.length && !skip.includes('state')) add(`${STATE_SQL} = ANY(?::text[])`, f.state);
  if (f.search && !skip.includes('search')) {
    add(`(a.asset_tag ILIKE ? OR a.serial_number ILIKE ? OR a.name ILIKE ? OR a.model_number ILIKE ?)`, `%${f.search}%`);
  }
  return { sql: where.join(' AND '), params };
}

const FROM = `FROM assets a LEFT JOIN locations l ON l.id = a.location_id`;
const gradeCounts = (cond = "a.status = 'available'") => GRADES.map((g, i) =>
  `COUNT(*) FILTER (WHERE ${cond} AND a.quality_grade = '${g}')::int AS g${i}`).join(', ');
const gradeObj = r => Object.fromEntries(GRADES.map((g, i) => [g, r[`g${i}`] || 0]));

async function filterOptions(user) {
  const scope = await authz.locationScopeFor(user);
  const scoped = scope.global ? '' : 'WHERE l.id = ANY($1::int[])';
  const p = scope.global ? [] : [scope.location_ids];
  const [locations, sites, models, manufacturers, categories] = await Promise.all([
    db.query(`SELECT l.id, l.name, l.site FROM locations l ${scoped} ORDER BY l.name`, p),
    db.query(`SELECT DISTINCT ${CURRENT_SITE_SQL} AS site ${FROM} WHERE a.deleted_at IS NULL ${scope.global ? '' : 'AND a.location_id = ANY($1::int[])'} ORDER BY 1`, p),
    db.query(`SELECT am.id, am.name FROM asset_models am ORDER BY am.name`),
    db.query(`SELECT id, name FROM manufacturers ORDER BY name`),
    db.query(`SELECT id, name FROM asset_categories WHERE type = 'asset' ORDER BY name`)
  ]);
  return {
    sites: sites.map(r => r.site).filter(Boolean), locations, models, manufacturers, categories,
    grades: GRADES, states: STATES
  };
}

const laptopCategoryIds = async () => (await db.query(`SELECT id FROM asset_categories WHERE name ILIKE 'laptop'`)).map(r => r.id);

// ---------------- Location Stock page ----------------
async function siteCards(f, user) {
  const w = await assetWhere(f, user, { skip: ['site'] });
  const rows = await db.query(
    `SELECT ${CURRENT_SITE_SQL} AS site,
            COUNT(*) FILTER (WHERE a.status = 'available')::int AS in_stock,
            COUNT(*) FILTER (WHERE a.status = 'assigned')::int AS allocated, ${gradeCounts()}
       ${FROM} WHERE ${w.sql} GROUP BY 1 ORDER BY in_stock DESC, 1`, w.params);
  const spocs = await db.query(
    `SELECT l.site, s.name, s.email, s.phone FROM location_spocs s JOIN locations l ON l.id = s.location_id ORDER BY s.name`);
  const bySite = new Map();
  for (const s of spocs) { if (!bySite.has(s.site)) bySite.set(s.site, []); if (!bySite.get(s.site).some(x => x.email === s.email)) bySite.get(s.site).push(s); }
  return rows.filter(r => r.site).map(r => ({ ...r, grades: gradeObj(r), spocs: bySite.get(r.site) || [], selected: f.site.includes(r.site) }));
}

async function totals(f, user) {
  const w = await assetWhere(f, user);
  const r = await db.get(
    `SELECT COUNT(*) FILTER (WHERE a.status = 'available')::int AS in_stock,
            COUNT(*) FILTER (WHERE a.status = 'assigned')::int AS allocated,
            COUNT(*) FILTER (WHERE a.status NOT IN ('available', 'assigned'))::int AS retired,
            COUNT(DISTINCT a.asset_model_id)::int AS models, ${gradeCounts()}
       ${FROM} WHERE ${w.sql}`, w.params);
  return { ...r, grades: gradeObj(r) };
}

async function modelBreakdown(f, user, limit = 50) {
  const w = await assetWhere(f, user);
  const rows = await db.query(
    `SELECT am.id, COALESCE(am.name, a.model_number, '(no model)') AS model, m.name AS manufacturer,
            COUNT(*) FILTER (WHERE a.status = 'available')::int AS in_stock,
            COUNT(*) FILTER (WHERE a.status = 'assigned')::int AS allocated, ${gradeCounts()}
       ${FROM} LEFT JOIN asset_models am ON am.id = a.asset_model_id LEFT JOIN manufacturers m ON m.id = a.manufacturer_id
      WHERE ${w.sql} GROUP BY am.id, 2, m.name ORDER BY in_stock DESC, allocated DESC LIMIT ${limit}`, w.params);
  return rows.map(r => ({ ...r, grades: gradeObj(r) }));
}

async function laptopList(f, user, page = 1, perPage = 25) {
  const w = await assetWhere(f, user);
  const total = (await db.get(`SELECT COUNT(*)::int AS c ${FROM} WHERE ${w.sql}`, w.params)).c;
  const paginator = new Paginator(total, perPage, page);
  // Best first: Good > Acceptable > Poor > Not deployable, then newest purchase.
  const items = await db.query(
    `SELECT a.id, a.asset_tag, a.name, a.serial_number, a.model_number, am.name AS model_name, m.name AS manufacturer,
            a.purchase_date, a.warranty_expiry, a.quality_grade, a.quality_reason, l.name AS base_location,
            ${CURRENT_SITE_SQL} AS current_site, ${STATE_SQL} AS state,
            a.custom_fields_data->>'RAM Size (GB)' AS ram, a.custom_fields_data->>'Processor' AS cpu,
            a.custom_fields_data->>'Machine Name' AS machine_name, u.name AS holder
       ${FROM} LEFT JOIN asset_models am ON am.id = a.asset_model_id LEFT JOIN manufacturers m ON m.id = a.manufacturer_id
       LEFT JOIN users u ON u.id = a.assigned_to
      WHERE ${w.sql}
      ORDER BY array_position(ARRAY['Good','Acceptable','Poor','Not deployable']::text[], a.quality_grade::text) NULLS LAST,
               a.purchase_date DESC NULLS LAST, a.id
      LIMIT ${perPage} OFFSET ${paginator.offset}`, w.params);
  return { items, paginator };
}

// ---------------- Asset Models page ----------------
// Model-level filters (search/model/manufacturer/category) pick the models; unit filters
// (site/base/quality/state) decide which units are counted. with_stock keeps models with
// at least one matching in-stock unit.
async function modelStats(f, user, page = 1, perPage = 15) {
  const w = await assetWhere(f, user, { skip: ['model', 'manufacturer', 'category', 'search'] });
  const mp = [...w.params];
  const mw = [];
  const addM = (sql, val) => { mp.push(val); mw.push(sql.replace(/\?/g, `$${mp.length}`)); };
  if (f.search) addM('(am.name ILIKE ? OR am.model_number ILIKE ?)', `%${f.search}%`);
  if (f.model.length) addM('am.id = ANY(?::int[])', f.model);
  if (f.manufacturer.length) addM('am.manufacturer_id = ANY(?::int[])', f.manufacturer);
  if (f.category.length) addM('am.category_id = ANY(?::int[])', f.category);
  const unitFilter = f.site.length || f.base.length || f.quality.length || f.state.length;
  const having = f.with_stock ? 'HAVING COUNT(u.id) FILTER (WHERE u.status = \'available\') > 0'
    : unitFilter ? 'HAVING COUNT(u.id) > 0' : '';
  const rows = await db.query(
    `WITH u AS (SELECT a.id, a.asset_model_id, a.status, a.quality_grade ${FROM} WHERE ${w.sql})
     SELECT am.*, m.name AS manufacturer_name, ac.name AS category_name,
            COUNT(u.id) FILTER (WHERE u.status = 'available')::int AS in_stock,
            COUNT(u.id) FILTER (WHERE u.status = 'assigned')::int AS allocated,
            ${GRADES.map((g, i) => `COUNT(u.id) FILTER (WHERE u.status = 'available' AND u.quality_grade = '${g}')::int AS g${i}`).join(', ')}
       FROM asset_models am
       LEFT JOIN manufacturers m ON m.id = am.manufacturer_id
       LEFT JOIN asset_categories ac ON ac.id = am.category_id
       LEFT JOIN u ON u.asset_model_id = am.id
      ${mw.length ? 'WHERE ' + mw.join(' AND ') : ''}
      GROUP BY am.id, m.name, ac.name ${having}
      ORDER BY in_stock DESC, allocated DESC, am.name`, mp);
  const all = rows.map(r => {
    const grades = gradeObj(r);
    return { ...r, total_units: r.in_stock + r.allocated, grades,
      good: grades.Good, acceptable: grades.Acceptable, poor: grades.Poor, not_deployable: grades['Not deployable'] };
  });
  const sum = k => all.reduce((s, r) => s + r[k], 0);
  const summary = { models: all.length, in_stock: sum('in_stock'), allocated: sum('allocated'), total: sum('total_units'),
    grades: Object.fromEntries(GRADES.map(g => [g, all.reduce((s, r) => s + r.grades[g], 0)])) };
  const paginator = new Paginator(all.length, perPage, page);
  return { items: all.slice(paginator.offset, paginator.offset + perPage), summary, paginator };
}

// ---------------- laptop history ----------------
// Everything known about one asset, oldest first: register dates, procurement, allocations,
// returns, stock ledger and audit entries.
async function history(asset) {
  const cf = asset.custom_fields_data || {};
  const ev = [];
  const push = (at, kind, title, detail) => { if (at) ev.push({ at: new Date(at), kind, title, detail: detail || '' }); };
  push(asset.purchase_date, 'purchase', 'Purchased', [cf['Vendor Name'] && `Vendor: ${cf['Vendor Name']}`, cf['PO #'] && `PO: ${cf['PO #']}`,
    cf['Invoice No.'] && `Invoice: ${cf['Invoice No.']}`, asset.purchase_cost && `Amount: ${asset.purchase_cost}`].filter(Boolean).join(' · '));
  if (/^\d{4}-\d{2}-\d{2}$/.test(cf['Warranty Start Date'] || '')) push(cf['Warranty Start Date'], 'warranty', 'Warranty started');
  push(asset.warranty_expiry, 'warranty', new Date(asset.warranty_expiry) < new Date() ? 'Warranty ended' : 'Warranty ends');
  const [asg, mv, audit] = await Promise.all([
    db.query(`SELECT s.assigned_at, s.returned_at, s.checkout_notes, s.checkin_notes, u.name AS user_name, u.employee_id
                FROM assignments s LEFT JOIN users u ON u.id = s.user_id WHERE s.asset_id = $1 ORDER BY s.assigned_at`, [asset.id]),
    db.query(`SELECT sm.created_at, sm.movement_type, sm.direction, sm.reason, sm.effective_status, l.name AS to_location
                FROM stock_movements sm LEFT JOIN locations l ON l.id = sm.to_location_id
               WHERE sm.module_key = 'assets' AND sm.item_id = $1 ORDER BY sm.created_at`, [asset.id]),
    db.query(`SELECT al.created_at, al.action, al.description, u.name AS actor FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id
               WHERE al.description ~* $1 ORDER BY al.created_at LIMIT 100`,
      [`(^|[^A-Za-z0-9-])${String(asset.asset_tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`])
  ]);
  for (const a of asg) {
    const who = a.user_name && a.user_name !== a.employee_id ? `${a.user_name} (${a.employee_id})` : (a.employee_id || a.user_name || 'employee');
    push(a.assigned_at, 'allocated', `Allocated to ${who}`, a.checkout_notes);
    push(a.returned_at, 'returned', `Returned by ${who}`, a.checkin_notes);
  }
  for (const m of mv) {
    if (['assigned', 'returned'].includes(m.movement_type)) continue; // shown via assignments
    push(m.created_at, 'ledger', `Stock: ${m.movement_type.replace(/_/g, ' ')}`, [m.to_location && `at ${m.to_location}`, m.reason].filter(Boolean).join(' · '));
  }
  for (const a of audit) push(a.created_at, 'audit', a.action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()), [a.description, a.actor && `by ${a.actor}`].filter(Boolean).join(' · '));
  ev.sort((x, y) => x.at - y.at);
  return ev;
}

// Current/base location and register facts shown with the grade.
async function insight(assetId) {
  return db.get(
    `SELECT a.quality_grade, a.quality_reason, a.stock_site, l.name AS base_location, l.site AS base_site,
            ${CURRENT_SITE_SQL} AS current_site, ${STATE_SQL} AS state
       ${FROM} WHERE a.id = $1`, [assetId]);
}

// ---------------- stock assistant (rule-based, runs inside the tool) ----------------
const SITE_WORDS = [
  [/mindspace|\bms\b|airoli/, 'Mumbai - Mindspace'], [/powai|l&t|\btx\b/, 'Mumbai - Powai'],
  [/wilco\s*chennai|chennai\s*wilco/, 'Wilco Chennai'], [/wilco\s*(hyderabad|hybd)|hyderabad\s*wilco/, 'Wilco Hyderabad'],
  [/wilco\s*us|us\s*wilco/, 'Wilco USA'], [/bangalore|bengaluru|\bbl\b|\bblr\b/, 'Bangalore'], [/pune|qubix|qbx/, 'Pune'],
  [/chennai/, 'Chennai'], [/hyderabad|hybd|hyd\b/, 'Hyderabad'], [/gurugram|gurgaon/, 'Gurugram'], [/noida/, 'Noida'],
  [/\busa\b|\bus\b|princeton|america/, 'USA'], [/mumbai/, ['Mumbai - Mindspace', 'Mumbai - Powai']], [/returned to client/, 'Returned to client']
];
const EXAMPLES = ['How many good laptops are in Pune?', 'Which location has the most good laptops?',
  'Best laptops in Bangalore with 16 GB', 'Dell laptops in stock in Chennai', 'History of HAMS-000169'];

async function ask(question, user, baseUrl) {
  const raw = String(question || '').trim().slice(0, 300);
  const q = raw.toLowerCase();
  if (!q) return { answer: 'Ask about stock, quality or a laptop\'s history.', examples: EXAMPLES };

  // 1) history of one laptop (asset tag or serial number)
  const tagMatch = raw.match(/\bHAMS-\d+\b/i);
  const serialMatch = !tagMatch && /history|timeline|details|about|where is/.test(q) ? raw.match(/\b[A-Z0-9][A-Z0-9-]{5,}\b/gi) : null;
  if (tagMatch || serialMatch) {
    const keys = tagMatch ? [tagMatch[0].toUpperCase()] : serialMatch.map(s => s.toUpperCase());
    const scope = await authz.locationScopeFor(user);
    const a = await db.get(
      `SELECT a.* ${FROM} WHERE a.deleted_at IS NULL AND (UPPER(a.asset_tag) = ANY($1::text[]) OR UPPER(a.serial_number) = ANY($1::text[]))
         ${scope.global ? '' : 'AND a.location_id = ANY($2::int[])'} LIMIT 1`, scope.global ? [keys] : [keys, scope.location_ids]);
    if (!a) return { answer: `No asset found for ${keys.join(', ')} (or it is outside your locations).` };
    const ins = await insight(a.id);
    const ev = await history(a);
    const last = ev.slice(-6).reverse().map(e => `${e.at.toISOString().slice(0, 10)} — ${e.title}${e.detail ? ` (${e.detail})` : ''}`);
    return {
      answer: `${a.asset_tag} · ${a.name} (SN ${a.serial_number || '—'}): ${ins.state}, current location ${ins.current_site || '—'}, base ${ins.base_location || '—'}. ` +
        `Quality: ${a.quality_grade || 'not graded'}${a.quality_reason ? ` — ${a.quality_reason.replace(/\.+$/, '')}` : ''}. ${ev.length} history event(s).`,
      lines: last, link: { href: `${baseUrl}/assets/${a.id}#history`, label: 'Open full history' }
    };
  }

  // 2) stock questions -> filters
  const f = parseFilters({});
  for (const [re, site] of SITE_WORDS) if (re.test(q)) f.site.push(...[].concat(site));
  f.site = [...new Set(f.site)];
  if (/not\s*deployable|undeployable|faulty|blocked/.test(q)) f.quality.push('Not deployable');
  else {
    if (/\bgood\b|\bbest\b|\btop\b|\bnew(est)?\b|recommend/.test(q)) f.quality.push('Good');
    if (/acceptable|\bok\b|average|medium/.test(q)) f.quality.push('Acceptable');
    if (/\bpoor\b|\bbad\b|\bold\b|worst/.test(q)) f.quality.push('Poor');
    if (/deployable|usable|available to give|ready/.test(q) && !f.quality.length) f.quality.push('Good', 'Acceptable');
  }
  if (/allocated|assigned|with employees|in use/.test(q)) f.state.push('Allocated');
  else if (/retired|scrapped|disposed/.test(q)) f.state.push('Retired');
  else f.state.push('In stock');
  const ramM = q.match(/(\d{1,2})\s*gb/);
  const mfrs = await db.query('SELECT id, name FROM manufacturers');
  for (const m of mfrs) if (m.name && new RegExp(`\\b${m.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)) f.manufacturer.push(m.id);
  const cats = await db.query(`SELECT id, name FROM asset_categories WHERE type = 'asset'`);
  for (const c of cats) if (new RegExp(`\\b${c.name.toLowerCase()}s?\\b`).test(q)) f.category.push(c.id);
  if (!f.category.length) f.category = await laptopCategoryIds();
  // model words, e.g. "latitude 5410", "l14", "x1 carbon"
  const models = await db.query('SELECT id, name FROM asset_models');
  const words = q.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && /\d/.test(w));
  if (words.length) for (const m of models) { const n = m.name.toLowerCase(); if (words.some(w => n.includes(w))) f.model.push(m.id); }

  const w = await assetWhere(f, user, { skip: ['site'] });
  const sitePart = f.site.length ? ` AND ${CURRENT_SITE_SQL} = ANY($${w.params.length + 1}::text[])` : '';
  const ramPart = ramM ? ` AND (a.custom_fields_data->>'RAM Size (GB)') ~ '^\\d+$' AND (a.custom_fields_data->>'RAM Size (GB)')::int >= ${Number(ramM[1])}` : '';
  const params = f.site.length ? [...w.params, f.site] : w.params;
  const desc = [f.quality.length ? f.quality.join('/') : '',f.manufacturer.length ? mfrs.filter(m => f.manufacturer.includes(m.id)).map(m => m.name).join('/') : '',
    cats.filter(c => f.category.includes(c.id)).map(c => c.name.toLowerCase() + 's').join('/') || 'assets', ramM ? `with ≥${ramM[1]} GB RAM` : '',
    f.model.length ? `(${f.model.length} matching model${f.model.length > 1 ? 's' : ''})` : '', f.state.join('/').toLowerCase()].filter(Boolean).join(' ');

  const compare = /which|compare|most|least|each location|every location|location wise|by location|per location/.test(q) && !f.site.length;
  const bySite = await db.query(
    `SELECT ${CURRENT_SITE_SQL} AS site, COUNT(*)::int AS n, ${gradeCounts('TRUE')}
       ${FROM} WHERE ${w.sql}${sitePart}${ramPart} AND ${CURRENT_SITE_SQL} IS NOT NULL GROUP BY 1 ORDER BY n DESC`, params);
  const total = bySite.reduce((s, r) => s + r.n, 0);
  const link = { href: `${baseUrl}/location-stock${toQuery(f)}`, label: 'Show these in Location Stock' };
  if (!total) return { answer: `There are no ${desc}${f.site.length ? ` in ${f.site.join(', ')}` : ''}.`, link };

  const g = GRADES.map((x, i) => [x, bySite.reduce((s, r) => s + r[`g${i}`], 0)]).filter(([, n]) => n);
  const lines = [];
  if (compare || f.site.length !== 1) {
    for (const r of bySite.slice(0, 10)) lines.push(`${r.site}: ${r.n}${f.quality.length === 1 ? '' : ` (${GRADES.map((x, i) => r[`g${i}`] ? `${r[`g${i}`]} ${x.toLowerCase()}` : '').filter(Boolean).join(', ')})`}`);
  }
  if (/\bbest\b|\btop\b|recommend|which laptop|\blist\b|\bshow\b/.test(q) || f.site.length === 1) {
    const top = await db.query(
      `SELECT a.asset_tag, COALESCE(am.name, a.model_number) AS model, a.purchase_date, a.custom_fields_data->>'RAM Size (GB)' AS ram, ${CURRENT_SITE_SQL} AS site, a.quality_grade
         ${FROM} LEFT JOIN asset_models am ON am.id = a.asset_model_id
        WHERE ${w.sql}${sitePart}${ramPart}
        ORDER BY array_position(ARRAY['Good','Acceptable','Poor','Not deployable']::text[], a.quality_grade::text) NULLS LAST, a.purchase_date DESC NULLS LAST LIMIT 5`, params);
    if (top.length) lines.push('Top picks:', ...top.map(t => `${t.asset_tag} · ${t.model || '—'} · ${t.ram ? t.ram + ' GB' : 'RAM ?'} · bought ${t.purchase_date ? new Date(t.purchase_date).toISOString().slice(0, 7) : '?'} · ${t.site} · ${t.quality_grade || '—'}`));
  }
  const where = f.site.length ? ` in ${f.site.join(', ')}` : ' across all locations';
  const best = compare && bySite[0] ? ` Most: ${bySite[0].site} (${bySite[0].n}).` : '';
  return { answer: `${total} ${desc}${where}${g.length > 1 ? ` — ${g.map(([x, n]) => `${n} ${x.toLowerCase()}`).join(', ')}` : ''}.${best}`, lines, link };
}

module.exports = {
  GRADES, STATES, STATE_STATUS, EXAMPLES, parseFilters, toQuery, filterOptions, laptopCategoryIds,
  siteCards, totals, modelBreakdown, laptopList, modelStats, history, insight, ask
};
