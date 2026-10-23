// Location SPOCs and the Location Workspace.
//
// A SPOC looks after one or more sites — the Location read from Machine Name (stockSiteService:
// Mindspace, Powai, Bangalore...). For a site the workspace covers:
//   - stock:   assets whose Machine Name puts them in the site's stock (assets.stock_site = site)
//   - devices out at the site: assets with no stock site in Machine Name (allocated devices carry
//     the user's computer name) whose Asset Location is one of the site's offices
// SPOCs only ever see and act on their own sites; users who can view Hardware may open any site.
//
// Smart insights are rule-based on the tool's own data (no AI service):
//   - forecast:  free usable laptops vs. demand (joiners due in 30 days + recent allocation rate)
//   - transfers: move spare laptops from sites above their target to sites below it, only within
//                the same company and country (CitiusTech India, USA, Wilco India, Wilco USA)
//   - refresh:   devices out at the site that are old / out of warranty
//   - data quality: register entries that contradict each other or need a check
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const audit = require('./auditService');
const authz = require('./authorizationService');
const stock = require('./stockSiteService');
const { HttpError } = require('../core/helpers');

const SPOC_ROLE = 'location_spoc';
const LAPTOP = 'Laptop';
const DAY = 86400000;

// ───────────────────────────── sites & access ─────────────────────────────

// Every site that has assets or an office, A–Z.
async function allSites() {
  const [keys, locs] = await Promise.all([
    db.query(`SELECT DISTINCT stock_site AS v FROM assets WHERE deleted_at IS NULL AND stock_site NOT LIKE '\\_%'`),
    db.query('SELECT name FROM locations WHERE deleted_at IS NULL')
  ]);
  return [...new Set([...keys.map(r => r.v), ...locs.map(l => stock.siteOf(l.name)).filter(Boolean)])].sort();
}

// Offices (Asset Location rows) that belong to a site, e.g. Mindspace -> CT Mindspace-1/2/3.
async function officesOf(site) {
  const locs = await db.query('SELECT id, name FROM locations WHERE deleted_at IS NULL ORDER BY name');
  return locs.filter(l => stock.siteOf(l.name) === site);
}
async function officeIds(site) {
  return (await officesOf(site)).map(l => l.id);
}

// The sites a user may open: { all: true } for users who can view Hardware, else their SPOC sites.
async function sitesFor(user) {
  if (!user) return { all: false, sites: [] };
  if (await authz.can('assets.view', user)) return { all: true, sites: await allSites() };
  const rows = await db.query('SELECT site FROM site_spocs WHERE user_id = $1 ORDER BY site', [user.id]);
  return { all: false, sites: rows.map(r => r.site) };
}

async function assertSite(user, site) {
  const access = await sitesFor(user);
  if (!site || !access.sites.includes(site)) throw new HttpError('You do not have access to this location.', 403);
  return access;
}

// SQL condition: the asset belongs to the site (its stock, or out at one of its offices).
const inSiteSql = (siteParam, officesParam) =>
  `(a.stock_site = ${siteParam} OR (a.stock_site LIKE '\\_%' AND a.location_id = ANY(${officesParam}::int[])))`;

// ───────────────────────────── SPOC directory (admin) ─────────────────────────────
//
// A SPOC row is either a contact (name + phone, no account yet: user_id is empty) or an account
// that signs in to the Location Workspace. Contacts are shown everywhere a SPOC is (workspace,
// joiner emails) but can't sign in or be CC'd until an admin enables sign-in with their email.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// SPOCs in the order they were added (keeps the order of the reference list per site).
async function listSpocs() {
  return db.query(
    `SELECT s.id, s.site, s.phone, s.created_at, s.user_id, COALESCE(s.name, u.name) AS name, u.email, u.employee_id,
            u.status, u.role, u.last_login_at, u.must_change_password
       FROM site_spocs s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.user_id IS NULL OR u.deleted_at IS NULL
      ORDER BY s.site, s.id`);
}

// Office name and address per site.
async function siteOffices() {
  const rows = await db.query('SELECT site, office_name, address FROM site_offices');
  return Object.fromEntries(rows.map(r => [r.site, r]));
}

async function saveSiteOffice(site, data, actor) {
  if (!(await allSites()).includes(site)) throw new HttpError(`Unknown site: ${site}`, 422);
  const officeName = String(data.office_name || '').trim().slice(0, 120) || null;
  const address = String(data.address || '').trim().slice(0, 1000) || null;
  await db.run(
    `INSERT INTO site_offices (site, office_name, address, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (site) DO UPDATE SET office_name = EXCLUDED.office_name, address = EXCLUDED.address,
       updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [site, officeName, address, actor ? actor.id : null]);
  await audit.log(actor ? actor.id : null, 'SITE_OFFICE_UPDATED', `Office details for ${site} updated.`);
}

// Everything the Location SPOCs page shows, one entry per site.
async function directory() {
  const [sites, spocs, offices, locs] = await Promise.all([
    allSites(), listSpocs(), siteOffices(), db.query('SELECT name FROM locations WHERE deleted_at IS NULL ORDER BY name')
  ]);
  return sites.map(site => ({
    site, office: offices[site] || null, spocs: spocs.filter(s => s.site === site),
    assetLocations: locs.map(l => l.name).filter(n => stock.siteOf(n) === site)
  }));
}

async function syncRole(t, userId, roleName) {
  const role = await t.get('SELECT id FROM roles WHERE name = $1', [roleName]);
  await t.run('UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [roleName, userId]);
  await t.run('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  if (role) await t.run('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, role.id]);
}

// Adds a SPOC for one or more sites.
//  - Without an email: a contact (name + phone) — no sign-in until an admin enables it.
//  - With an email: an existing account is linked; otherwise one is created with the Location SPOC
//    role and a temporary password that must be changed at sign-in. Employees linked here become
//    Location SPOCs; accounts with a wider role keep it. A contact of the same name at the site is
//    turned into this account rather than listed twice.
async function addSpoc(data, actor) {
  const name = String(data.name || '').trim().slice(0, 255);
  const email = String(data.email || '').trim().toLowerCase();
  const phone = String(data.phone || '').trim().slice(0, 50) || null;
  const sites = [...new Set([].concat(data.sites || []).map(String).filter(Boolean))];
  const known = await allSites();
  if (email && !EMAIL_RE.test(email)) throw new HttpError('That email doesn\'t look right.', 422);
  if (!email && !name) throw new HttpError('Enter the SPOC\'s name.', 422);
  if (!sites.length) throw new HttpError('Choose at least one site.', 422);
  const unknown = sites.filter(s => !known.includes(s));
  if (unknown.length) throw new HttpError(`Unknown site: ${unknown.join(', ')}`, 422);

  if (!email) {
    await db.tx(async t => {
      for (const site of sites) {
        const same = await t.get('SELECT id FROM site_spocs WHERE site = $1 AND user_id IS NULL AND LOWER(name) = LOWER($2)', [site, name]);
        if (same) await t.run('UPDATE site_spocs SET phone = COALESCE($1, phone) WHERE id = $2', [phone, same.id]);
        else await t.run('INSERT INTO site_spocs (user_id, name, site, phone, created_by) VALUES (NULL, $1, $2, $3, $4)', [name, site, phone, actor ? actor.id : null]);
      }
    });
    await audit.log(actor ? actor.id : null, 'SPOC_ADDED', `${name} added as Location SPOC contact for ${sites.join(', ')} (no sign-in yet).`);
    return { name, email: null, sites, contact: true, created: false, password: null };
  }

  const result = await db.tx(async t => {
    let user = await t.get('SELECT * FROM users WHERE LOWER(email) = $1 AND deleted_at IS NULL', [email]);
    let password = null;
    if (!user) {
      if (!name) throw new HttpError('Enter the SPOC\'s name.', 422);
      password = String(data.password || '').trim() || crypto.randomBytes(6).toString('base64url');
      if (password.length < 8) throw new HttpError('The temporary password needs at least 8 characters.', 422);
      const id = await t.insert(
        `INSERT INTO users (uuid, name, email, password, role, status, must_change_password)
         VALUES ($1, $2, $3, $4, $5, 'active', TRUE)`,
        [crypto.randomUUID(), name.slice(0, 255), email, await bcrypt.hash(password, 10), SPOC_ROLE]);
      await syncRole(t, id, SPOC_ROLE);
      user = { id, name, email, created: true };
    } else if (user.role === 'employee') {
      await syncRole(t, user.id, SPOC_ROLE);
    }
    const shown = name || user.name;
    for (const site of sites) {
      const mine = await t.get('SELECT id FROM site_spocs WHERE site = $1 AND user_id = $2', [site, user.id]);
      const contact = await t.get(`SELECT id, phone FROM site_spocs WHERE site = $1 AND user_id IS NULL
        AND LOWER(name) IN (LOWER($2), LOWER($3))`, [site, shown, user.name || shown]);
      if (mine) {
        await t.run('UPDATE site_spocs SET phone = COALESCE($1, phone, $2) WHERE id = $3', [phone, contact ? contact.phone : null, mine.id]);
        if (contact) await t.run('DELETE FROM site_spocs WHERE id = $1', [contact.id]);
      } else if (contact) {
        await t.run('UPDATE site_spocs SET user_id = $1, phone = COALESCE($2, phone) WHERE id = $3', [user.id, phone, contact.id]);
      } else {
        await t.run('INSERT INTO site_spocs (user_id, name, site, phone, created_by) VALUES ($1, $2, $3, $4, $5)',
          [user.id, shown, site, phone, actor ? actor.id : null]);
      }
    }
    return { user, password };
  });
  await audit.log(actor ? actor.id : null, 'SPOC_ADDED', `${name || result.user.name || email} made Location SPOC for ${sites.join(', ')}.`);
  return { name: name || result.user.name, email, sites, created: !!result.user.created, password: result.password };
}

// Gives a contact sign-in: links (or creates) the account for their email, for every site where
// they are listed as a contact under the same name.
async function enableSignIn(spocId, data, actor) {
  const row = await db.get('SELECT id, name FROM site_spocs WHERE id = $1 AND user_id IS NULL', [parseInt(spocId, 10)]);
  if (!row) throw new HttpError('That SPOC already has sign-in, or was removed.', 404);
  if (!String(data.email || '').trim()) throw new HttpError(`Enter ${row.name}'s work email — they sign in with it.`, 422);
  const sites = (await db.query('SELECT site FROM site_spocs WHERE user_id IS NULL AND LOWER(name) = LOWER($1) ORDER BY site', [row.name])).map(r => r.site);
  return addSpoc({ name: row.name, email: data.email, password: data.password, sites }, actor);
}

// Corrects a SPOC's name or phone (the name shown for them; an account's own name is not changed).
async function editSpoc(spocId, data, actor) {
  const row = await db.get('SELECT id, site, user_id, name FROM site_spocs WHERE id = $1', [parseInt(spocId, 10)]);
  if (!row) throw new HttpError('SPOC not found.', 404);
  const name = String(data.name || '').trim().slice(0, 255) || row.name;
  if (!name) throw new HttpError('Enter the SPOC\'s name.', 422);
  const phone = String(data.phone || '').trim().slice(0, 50) || null;
  if (!row.user_id && name.toLowerCase() !== String(row.name).toLowerCase()
    && await db.get('SELECT 1 AS x FROM site_spocs WHERE site = $1 AND user_id IS NULL AND LOWER(name) = LOWER($2)', [row.site, name])) {
    throw new HttpError(`${name} is already listed for ${row.site}.`, 422);
  }
  await db.run('UPDATE site_spocs SET name = $1, phone = $2 WHERE id = $3', [name, phone, row.id]);
  await audit.log(actor ? actor.id : null, 'SPOC_UPDATED', `SPOC details for ${name} (${row.site}) updated.`);
  return { name, site: row.site };
}

// Removes a SPOC from a site. A Location SPOC with no sites left goes back to Employee.
async function removeSpoc(spocId, actor) {
  const row = await db.get(`SELECT s.id, s.site, s.user_id, COALESCE(s.name, u.name) AS name, u.role
    FROM site_spocs s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [parseInt(spocId, 10)]);
  if (!row) throw new HttpError('SPOC not found.', 404);
  await db.tx(async t => {
    await t.run('DELETE FROM site_spocs WHERE id = $1', [row.id]);
    if (!row.user_id) return;
    const left = await t.get('SELECT COUNT(*)::int AS n FROM site_spocs WHERE user_id = $1', [row.user_id]);
    if (!left.n && row.role === SPOC_ROLE) await syncRole(t, row.user_id, 'employee');
  });
  await audit.log(actor ? actor.id : null, 'SPOC_REMOVED', `${row.name} is no longer Location SPOC for ${row.site}.`);
  return row;
}

// New temporary password for a SPOC account (must be changed at the next sign-in).
async function resetPassword(userId, actor) {
  const user = await db.get(`SELECT u.id, u.name, u.email FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM site_spocs s WHERE s.user_id = u.id)`, [parseInt(userId, 10)]);
  if (!user) throw new HttpError('SPOC not found.', 404);
  const password = crypto.randomBytes(6).toString('base64url');
  await db.run('UPDATE users SET password = $1, must_change_password = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [await bcrypt.hash(password, 10), user.id]);
  await audit.log(actor ? actor.id : null, 'SPOC_PASSWORD_RESET', `Temporary password set for ${user.name}.`);
  return { ...user, password };
}

// ───────────────────────────── site data ─────────────────────────────

// In-stock laptops at the site, each described (grade, usable, reserved, faulty).
async function stockLaptops(site) {
  const rows = await db.query(
    `SELECT a.id, a.asset_tag, a.serial_number, a.model_number, m.name AS maker, ${stock.LAPTOP_COLUMNS}
       FROM assets a JOIN asset_categories c ON c.id = a.category_id
       LEFT JOIN manufacturers m ON m.id = a.manufacturer_id
       LEFT JOIN status_labels sl ON sl.id = a.status_label_id
      WHERE a.deleted_at IS NULL AND c.name = $1 AND a.stock_site = $2 AND a.assigned_to IS NULL AND sl.type = 'deployable'`,
    [LAPTOP, site]);
  return rows.map(r => ({ ...r, model: r.model_number || 'Unknown model', info: stock.describeLaptop(r) }));
}

// Laptops held for joiners' not-yet-approved drafts (not free to allocate).
async function draftedIds() {
  return new Set((await db.query(
    `SELECT draft_laptop_asset_id AS id FROM new_joinees WHERE allocation_status = 'draft' AND draft_laptop_asset_id IS NOT NULL`)).map(r => r.id));
}

// Stock by model: counts per grade, CPU / RAM / warranty range, best units first.
function byModel(laptops) {
  const models = new Map();
  for (const l of laptops) {
    const key = l.model;
    const m = models.get(key) || { model: key, maker: l.maker, total: 0, good: 0, acceptable: 0, old: 0, faulty: 0, reserved: 0,
      cpus: new Set(), rams: new Set(), wMin: null, wMax: null, units: [] };
    m.total++;
    if (l.info.reserved) m.reserved++; else if (l.info.faulty) m.faulty++; else m[l.info.grade]++;
    m.cpus.add(l.info.cpu.label); m.rams.add(l.info.ram || '?');
    if (l.info.warranty) { if (!m.wMin || l.info.warranty < m.wMin) m.wMin = l.info.warranty; if (!m.wMax || l.info.warranty > m.wMax) m.wMax = l.info.warranty; }
    m.units.push(l);
    models.set(key, m);
  }
  return [...models.values()].map(m => ({
    ...m, cpus: [...m.cpus].join(', '), rams: [...m.rams].sort((a, b) => a - b).join('/') + ' GB',
    units: stock.rankLaptops(m.units.filter(u => u.info.usable)).concat(m.units.filter(u => !u.info.usable)),
    best: m.good ? 'good' : m.acceptable ? 'acceptable' : 'old'
  })).sort((a, b) => b.good - a.good || b.acceptable - a.acceptable || b.total - a.total);
}

// Devices out at the site (assigned), with holder and grade; newest allocation first.
async function outAtSite(site, offices) {
  const rows = await db.query(
    `SELECT a.id, a.asset_tag, a.serial_number, a.model_number, c.name AS category, u.name AS holder, u.employee_id,
            g.assigned_at, ${stock.LAPTOP_COLUMNS}
       FROM assets a LEFT JOIN asset_categories c ON c.id = a.category_id
       LEFT JOIN users u ON u.id = a.assigned_to
       LEFT JOIN LATERAL (SELECT assigned_at FROM assignments WHERE asset_id = a.id AND returned_at IS NULL ORDER BY assigned_at DESC LIMIT 1) g ON TRUE
      WHERE a.deleted_at IS NULL AND a.assigned_to IS NOT NULL AND ${inSiteSql('$1', '$2')}
      ORDER BY g.assigned_at DESC NULLS LAST, a.id DESC`, [site, offices]);
  return rows.map(r => ({ ...r, info: stock.describeLaptop(r) }));
}

// When the first register import ran: assignments made by it are the starting state, not demand.
async function firstImportAt() {
  const r = await db.get(`SELECT MIN(created_at) AS at FROM import_jobs WHERE type = 'asset_register_sync'`);
  return r && r.at ? r.at : new Date(0);
}

// Laptops allocated at the site in the last 8 weeks (after the first import) -> per week.
async function weeklyRate(site, offices, since) {
  const r = await db.get(
    `SELECT COUNT(*)::int AS n FROM assignments g JOIN assets a ON a.id = g.asset_id
       JOIN asset_categories c ON c.id = a.category_id
      WHERE c.name = $3 AND g.assigned_at > GREATEST($4::timestamp, NOW() - INTERVAL '56 days') AND ${inSiteSql('$1', '$2')}`,
    [site, offices, LAPTOP, since]);
  const weeks = Math.max(1, Math.min(8, (Date.now() - new Date(since).getTime()) / (7 * DAY)));
  return { allocations: r.n, weeks: Math.round(weeks * 10) / 10, perWeek: r.n / weeks };
}

// Joiners at the site not yet allocated; due = joining within the next 30 days (or overdue).
async function joinersAt(site) {
  const rows = await db.query(
    `SELECT nj.id, nj.name, nj.employee_id, nj.designation, nj.allocation_status, nj.date_of_joining::text AS doj,
            nj.draft_laptop_asset_id, l.name AS location_name
       FROM new_joinees nj LEFT JOIN locations l ON l.id = nj.location_id
      WHERE nj.allocation_status <> 'allocated'`);
  const soon = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
  const here = rows.filter(r => stock.siteOf(r.location_name) === site);
  return { all: here, due: here.filter(r => !r.doj || r.doj <= soon) };
}

// Minimum spare laptops a site should keep (Settings → Automations, "Minimum spares per site").
async function minSpares() {
  const v = await db.get(`SELECT setting_value AS v FROM settings WHERE group_key = 'automation' AND setting_key = 'low_stock_threshold'`);
  const n = parseInt(v && v.v, 10);
  return Number.isFinite(n) ? n : 5;
}

// Forecast for one site: free usable laptops vs. the next 4 weeks of demand. The minimum spares
// only apply to sites that use laptops (some out there, or joiners due); target = demand + 20%.
function forecast(free, rate, dueJoiners, min, inUse) {
  const demand4w = dueJoiners + rate.perWeek * 4;
  const target = Math.max(inUse ? min : 0, Math.ceil(demand4w * 1.2));
  const perWeek = Math.max(rate.perWeek, dueJoiners / 4.3);
  const weeks = perWeek > 0 ? free / perWeek : null;
  const status = free < dueJoiners ? 'short' : free < target ? 'low' : 'ok';
  return { free, dueJoiners, perWeek: Math.round(perWeek * 10) / 10, demand4w: Math.ceil(demand4w), target, weeks: weeks === null ? null : Math.floor(weeks), status, spare: free - target };
}

// Same model written two ways in the register (same maker and model number), e.g. "5400" and
// "Latitude 5400". Only a hint: an admin decides whether they really are the same.
async function spellingVariants(modelsHere) {
  const rows = await db.query(`SELECT DISTINCT m.name AS maker, a.model_number FROM assets a
    JOIN manufacturers m ON m.id = a.manufacturer_id WHERE a.deleted_at IS NULL AND a.model_number IS NOT NULL`);
  const groups = new Map();
  for (const r of rows) {
    const num = (r.model_number.match(/\b(\d{3,5})\b/) || [])[1];
    if (!num) continue;
    const key = `${r.maker}|${num}`;
    (groups.get(key) || groups.set(key, new Set()).get(key)).add(r.model_number);
  }
  const here = new Set(modelsHere);
  return [...groups.values()].map(s => [...s].sort()).filter(list => list.length > 1 && list.some(m => here.has(m)));
}

// Everything the workspace shows for one site.
async function siteWorkspace(site) {
  const officeRows = await officesOf(site);
  const offices = officeRows.map(o => o.id);
  const [laptops, drafted, others, out, since, joiners, min, spocs, returned, hostInStock] = await Promise.all([
    stockLaptops(site), draftedIds(),
    db.query(`SELECT c.name AS category, COUNT(*)::int AS n FROM assets a JOIN asset_categories c ON c.id = a.category_id
      LEFT JOIN status_labels sl ON sl.id = a.status_label_id
      WHERE a.deleted_at IS NULL AND a.stock_site = $1 AND a.assigned_to IS NULL AND sl.type = 'deployable' AND c.name <> $2
      GROUP BY 1 ORDER BY 2 DESC`, [site, LAPTOP]),
    outAtSite(site, offices), firstImportAt(), joinersAt(site), minSpares(),
    db.query(`SELECT COALESCE(s.name, u.name) AS name, u.email, s.phone FROM site_spocs s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.site = $1 AND (s.user_id IS NULL OR u.deleted_at IS NULL) ORDER BY s.id`, [site]),
    db.query(`SELECT a.id, a.asset_tag, a.model_number, a.custom_fields_data->>'Machine Name' AS machine FROM assets a
      LEFT JOIN status_labels sl ON sl.id = a.status_label_id
      WHERE a.deleted_at IS NULL AND a.stock_site = '_returned' AND a.assigned_to IS NULL AND sl.type = 'deployable'
        AND a.location_id = ANY($1::int[]) ORDER BY a.asset_tag`, [offices]),
    db.query(`SELECT a.id, a.asset_tag, a.model_number, a.custom_fields_data->>'Machine Name' AS machine FROM assets a
      JOIN asset_categories c ON c.id = a.category_id LEFT JOIN status_labels sl ON sl.id = a.status_label_id
      WHERE a.deleted_at IS NULL AND a.stock_site = '_none' AND a.assigned_to IS NULL AND sl.type = 'deployable'
        AND c.name = $2 AND a.location_id = ANY($1::int[]) ORDER BY a.asset_tag`, [offices, LAPTOP])
  ]);
  const usable = laptops.filter(l => l.info.usable);
  const free = usable.filter(l => !drafted.has(l.id));
  const rate = await weeklyRate(site, offices, since);
  const outLaptops = out.filter(o => o.category === LAPTOP);
  const fc = forecast(free.length, rate, joiners.due.length, min, outLaptops.length > 0 || joiners.due.length > 0);
  const refresh = outLaptops.filter(o => o.info.grade === 'old' || (o.info.warranty && o.info.warranty < new Date().toISOString().slice(0, 10)))
    .sort((a, b) => a.info.cpu.gen - b.info.cpu.gen || String(a.info.warranty || '').localeCompare(String(b.info.warranty || '')));
  const models = byModel(laptops);
  return {
    site, offices, officeNames: officeRows.map(o => o.name), office: (await siteOffices())[site] || null,
    spocs, models, others, joiners, forecast: fc, rate,
    free: stock.rankLaptops(free),
    counts: {
      inStock: laptops.length, usable: usable.length, free: free.length, drafted: usable.length - free.length,
      good: usable.filter(l => l.info.grade === 'good').length, acceptable: usable.filter(l => l.info.grade === 'acceptable').length,
      old: laptops.filter(l => !l.info.reserved && !l.info.faulty && l.info.grade === 'old').length,
      faulty: laptops.filter(l => l.info.faulty).length, reserved: laptops.filter(l => l.info.reserved).length,
      out: out.length, outLaptops: outLaptops.length
    },
    out: out.slice(0, 200), refresh: { total: refresh.length, items: refresh.slice(0, 50) },
    quality: {
      returned, hostInStock,
      faulty: laptops.filter(l => l.info.faulty), reserved: laptops.filter(l => l.info.reserved),
      oldInStock: laptops.filter(l => !l.info.reserved && !l.info.faulty && l.info.grade === 'old'),
      variants: await spellingVariants([...new Set([...laptops.map(l => l.model), ...outLaptops.map(o => o.model_number)])])
    }
  };
}

// ───────────────────────────── all sites ─────────────────────────────

// Transfers only make sense inside one company and country.
const transferGroup = site => (site === 'Wilco USA' ? 'Wilco USA' : site.startsWith('Wilco') ? 'Wilco India'
  : site === 'USA' ? 'USA' : 'CitiusTech India');

// Every site's forecast, and suggested transfers from sites above target to sites below it.
async function network(onlySites = null) {
  const sites = (await allSites()).filter(s => !onlySites || onlySites.includes(s));
  const [drafted, since, min, spocs, officeInfo] = await Promise.all([draftedIds(), firstImportAt(), minSpares(), listSpocs(), siteOffices()]);
  const rows = [];
  for (const site of sites) {
    const offices = await officeIds(site);
    const [laptops, rate, joiners, out] = await Promise.all([stockLaptops(site), weeklyRate(site, offices, since), joinersAt(site),
      db.get(`SELECT COUNT(*)::int AS n FROM assets a JOIN asset_categories c ON c.id = a.category_id
        WHERE a.deleted_at IS NULL AND c.name = $3 AND a.assigned_to IS NOT NULL AND ${inSiteSql('$1', '$2')}`, [site, offices, LAPTOP])]);
    const usable = laptops.filter(l => l.info.usable);
    const free = stock.rankLaptops(usable.filter(l => !drafted.has(l.id)));
    rows.push({
      site, group: transferGroup(site), office: officeInfo[site] || null, spocs: spocs.filter(s => s.site === site),
      usable: usable.length, good: usable.filter(l => l.info.grade === 'good').length,
      out: out.n, free, forecast: forecast(free.length, rate, joiners.due.length, min, out.n > 0 || joiners.due.length > 0)
    });
  }
  // Greedy: each short site takes from the site in its group with the most to spare.
  const transfers = [];
  const spare = new Map(rows.map(r => [r.site, r.forecast.spare]));
  for (const need of rows.filter(r => r.forecast.spare < 0).sort((a, b) => a.forecast.spare - b.forecast.spare)) {
    let missing = -need.forecast.spare;
    const donors = rows.filter(r => r.group === need.group && r.site !== need.site && spare.get(r.site) > 0)
      .sort((a, b) => spare.get(b.site) - spare.get(a.site));
    for (const d of donors) {
      if (missing <= 0) break;
      const n = Math.min(missing, spare.get(d.site));
      const taken = transfers.filter(t => t.from === d.site).reduce((s, t) => s + t.count, 0);
      const units = d.free.slice(taken, taken + n);
      const models = {};
      for (const u of units) models[u.model] = (models[u.model] || 0) + 1;
      transfers.push({ from: d.site, to: need.site, count: n, group: need.group,
        models: Object.entries(models).map(([m, c]) => `${m} ×${c}`).join(', '),
        why: `${need.site} has ${need.forecast.free} free vs. a target of ${need.forecast.target}; ${d.site} has ${spare.get(d.site)} above its target` });
      spare.set(d.site, spare.get(d.site) - n);
      missing -= n;
    }
  }
  return { min, rows: rows.map(({ free, ...r }) => r), transfers };
}

// ───────────────────────────── actions ─────────────────────────────

// The asset must be a free, usable laptop in the site's stock.
async function assertAllocatable(site, assetId) {
  const laptops = await stockLaptops(site);
  const l = laptops.find(x => x.id === assetId);
  if (!l) throw new HttpError('That laptop is not in this location\'s stock.', 422);
  if (!l.info.usable) throw new HttpError(`That laptop shouldn't be allocated: ${l.info.why}.`, 422);
  if ((await draftedIds()).has(assetId)) throw new HttpError('That laptop is held for a new joiner\'s draft; pick another one.', 422);
  return l;
}

// The asset must be out at the site (assigned).
async function assertOutAtSite(site, assetId) {
  const offices = await officeIds(site);
  const row = await db.get(`SELECT a.id FROM assets a WHERE a.id = $3 AND a.deleted_at IS NULL AND a.assigned_to IS NOT NULL AND ${inSiteSql('$1', '$2')}`,
    [site, offices, assetId]);
  if (!row) throw new HttpError('That device is not allocated at this location.', 422);
}

// Users a SPOC can allocate to: active (or pending) accounts, by name or CTID.
async function searchPeople(term) {
  const q = `%${String(term || '').trim().slice(0, 60)}%`;
  return db.query(
    `SELECT id, name, employee_id FROM users WHERE deleted_at IS NULL AND status IN ('active', 'pending')
       AND (name ILIKE $1 OR employee_id ILIKE $1 OR email ILIKE $1) ORDER BY name LIMIT 20`, [q]);
}

module.exports = {
  SPOC_ROLE, allSites, officeIds, sitesFor, assertSite, listSpocs, siteOffices, saveSiteOffice, directory,
  addSpoc, enableSignIn, editSpoc, removeSpoc, resetPassword,
  siteWorkspace, network, assertAllocatable, assertOutAtSite, searchPeople, transferGroup
};
