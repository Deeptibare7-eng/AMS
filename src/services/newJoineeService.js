// New Joinee onboarding: allocation agent + engineer approval workflow.
// The agent DRAFTS a laptop + headphone per designation rules against live
// available inventory; it never assigns anything itself. An engineer reviews
// (and may edit) the draft, then "Allocate" finalizes through the existing
// writers — assetService.checkoutAsset for the laptop (assignments table,
// movement ledger, audit, dashboard cache) and inventoryWorkflowService.assign
// for the headphone (accessory_assignments + available_qty) — so approved
// allocations show up in the Assets / Accessories tabs like any other checkout.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const db = require('../core/db');
const { readWorkbook, mapRows } = require('../core/spreadsheet');
const mailService = require('./mailService');
const settings = require('./settingsService');
const audit = require('./auditService');
const assetService = require('./assetService');
const inventoryWorkflow = require('./inventoryWorkflowService');
const stock = require('./stockSiteService');
const { HttpError, intOr } = require('../core/helpers');

const LAPTOP_CATEGORY = 'Laptop';
const HEADPHONE_CATEGORY = 'Headphone';

// A laptop counts as premium/high-end when its model reads as an Apple or
// X1-class machine. Used both by the agent and the edit dropdown's
// designation-based filtering (with an Exception toggle to show all).
const PREMIUM_PATTERN = /(macbook|x1 carbon)/i;

// Business rules: designation -> preferred laptop models (in priority order,
// matched against assets.model_number) and preferred headphone models.
// premiumOnly drives the edit dropdown's initial premium-only filtering.
const ALLOCATION_RULES = {
  'Senior Director': {
    label: 'Premium MacBook',
    premiumOnly: true,
    laptops: ['MacBook Pro 16', 'MacBook Pro 14', 'MacBook Pro 13'],
    headphones: ['Sennheiser', 'WH1022', 'WH125']
  },
  'AVP': {
    label: 'MacBook',
    premiumOnly: true,
    laptops: ['MacBook Pro 14', 'MacBook Pro 13', 'MacBook'],
    headphones: ['Sennheiser', 'WH1022', 'WH125']
  },
  'Consultant': {
    label: 'High-performance business laptop',
    premiumOnly: false,
    laptops: ['ThinkPad X1', 'T14 Gen', 'ThinkPad-T14'],
    headphones: ['WH1022', 'WH125']
  },
  'Engineer': {
    label: 'Standard developer laptop',
    premiumOnly: false,
    laptops: ['Thinkpad-L14', 'ThinkPad-L15', 'ThinkPad-L13'],
    headphones: ['WH125', 'WH1022']
  },
  'Fresher': {
    label: 'Standard laptop',
    premiumOnly: false,
    laptops: ['ThinkBook', 'V130', 'V 130'],
    headphones: ['WH125']
  }
};
const DEFAULT_RULE = ALLOCATION_RULES['Engineer'];

function ruleFor(designation) {
  return ALLOCATION_RULES[designation] || DEFAULT_RULE;
}

// Laptops the agent may draft: available and unassigned, in a site's stock per Machine Name, and
// usable (not returned to client, reserved, faulty or old — see stockSiteService). The joinee's
// office location maps to the same site, so Asset Location (where it was bought) is not used.
async function laptopPool(q) {
  const rows = await q.query(
    `SELECT a.id, a.asset_tag, a.model_number, ${stock.LAPTOP_COLUMNS}
       FROM assets a JOIN asset_categories c ON a.category_id = c.id
      WHERE c.name = $1 AND a.deleted_at IS NULL AND a.assigned_to IS NULL AND LOWER(a.status) = 'available'`,
    [LAPTOP_CATEGORY]);
  return rows
    .map(r => ({ id: r.id, tag: r.asset_tag, model: r.model_number || 'Unknown model',
      premium: PREMIUM_PATTERN.test(r.model_number || ''), info: stock.describeLaptop(r) }))
    .filter(l => l.info.usable);
}

async function usableLaptopsBySite() {
  const counts = new Map();
  for (const l of await laptopPool(db)) counts.set(l.info.site, (counts.get(l.info.site) || 0) + 1);
  return counts;
}

// Best usable laptop at the joinee's site that no other draft holds: Good before Acceptable,
// then the designation's preferred models, newest processor, longest warranty. Keeps the
// current draft while it is still usable there, so a re-draft (e.g. for headphones) doesn't
// swap the laptop.
function pickLaptop(pool, patterns, site, taken, currentId) {
  if (!site) return null;
  const here = pool.filter(l => l.info.site === site && !taken.has(l.id));
  return (currentId && here.find(l => l.id === currentId)) || stock.rankLaptops(here, patterns)[0] || null;
}

// Headphone rows still free to draft at the joinee's location: available_qty
// must exceed the units reserved by other joinees' un-approved drafts. Same
// preferred-model-then-anything fallback as laptops.
async function pickHeadphone(t, patterns, excludeJoineeId, locationId) {
  if (!locationId) return null;
  for (const p of [...patterns, '']) {
    const row = await t.get(
      `SELECT a.id FROM accessories a
        JOIN asset_categories c ON a.category_id = c.id
       WHERE c.name = $1 AND a.deleted_at IS NULL AND a.location_id = $4
         AND (a.name ILIKE $2 OR a.model_number ILIKE $2)
         AND a.available_qty > (
           SELECT COUNT(*) FROM new_joinees nj
            WHERE nj.draft_headphone_accessory_id = a.id
              AND nj.allocation_status = 'draft' AND nj.id <> $3)
       ORDER BY a.id LIMIT 1`,
      [HEADPHONE_CATEGORY, `%${p}%`, excludeJoineeId, locationId]);
    if (row) return row.id;
  }
  return null;
}

// Joinees that need a (new) recommendation: never drafted; a draft without a laptop while free
// usable stock exists at their site; a drafted laptop no longer usable there (taken, moved,
// marked faulty...); or a headphone to redo (headphones still follow Asset Location). A missing
// item only counts when stock for it exists — otherwise every page view would redo the draft.
// pool = laptopPool(q); lock = take row locks (inside the agent's transaction).
async function joineesNeedingDraft(q, pool, lock = false) {
  const rows = await q.query(
    `SELECT nj.id, nj.designation, nj.location_id, nj.allocation_status, nj.draft_laptop_asset_id, l.name AS location_name,
            (nj.allocation_status = 'draft' AND (
              (nj.draft_headphone_accessory_id IS NULL AND EXISTS (
                 SELECT 1 FROM accessories ac JOIN asset_categories c ON c.id = ac.category_id
                  WHERE c.name = $1 AND ac.location_id = nj.location_id AND ac.deleted_at IS NULL AND ac.available_qty > 0))
              OR EXISTS (SELECT 1 FROM accessories ac WHERE ac.id = nj.draft_headphone_accessory_id
                           AND ac.location_id IS DISTINCT FROM nj.location_id))) AS headphone_redo
       FROM new_joinees nj LEFT JOIN locations l ON l.id = nj.location_id
      WHERE nj.allocation_status IN ('pending', 'draft')
      ORDER BY nj.id${lock ? ' FOR UPDATE OF nj SKIP LOCKED' : ''}`, [HEADPHONE_CATEGORY]);
  if (!rows.length) return [];
  const drafted = new Set((await q.query(
    `SELECT draft_laptop_asset_id AS id FROM new_joinees WHERE allocation_status = 'draft' AND draft_laptop_asset_id IS NOT NULL`)).map(r => r.id));
  const siteOfLaptop = new Map(pool.map(l => [l.id, l.info.site]));
  const free = new Map();
  for (const l of pool) if (!drafted.has(l.id)) free.set(l.info.site, (free.get(l.info.site) || 0) + 1);
  return rows.map(r => ({ ...r, site: stock.siteOf(r.location_name) })).filter(r => {
    if (r.allocation_status === 'pending' || r.headphone_redo) return true;
    if (!r.draft_laptop_asset_id) return !!r.site && (free.get(r.site) || 0) > 0;
    return siteOfLaptop.get(r.draft_laptop_asset_id) !== r.site;
  });
}

// Read-only check so a page view only writes when there is work to do.
async function needsRecommendations() {
  const open = await db.get(`SELECT EXISTS (SELECT 1 FROM new_joinees WHERE allocation_status IN ('pending', 'draft')) AS any`);
  if (!open || !open.any) return false;
  return (await joineesNeedingDraft(db, await laptopPool(db))).length > 0;
}

// The agent: draft (recommend) allocations for joinees that need one. Never assigns —
// SPOC review + approval is still required. SKIP LOCKED lets concurrent callers
// skip rows another request is already drafting instead of queueing behind it,
// and `running` keeps it to one pass at a time per process.
let running = null;
function ensureDrafts() {
  if (running) return running;
  running = (async () => {
    let drafted = 0;
    await db.tx(async t => {
      const pool = await laptopPool(t);
      const todo = await joineesNeedingDraft(t, pool, true);
      if (!todo.length) return;
      // Laptops held by drafts this pass leaves alone.
      const redo = new Set(todo.map(j => j.id));
      const taken = new Set((await t.query(
        `SELECT id, draft_laptop_asset_id FROM new_joinees WHERE allocation_status = 'draft' AND draft_laptop_asset_id IS NOT NULL`))
        .filter(r => !redo.has(r.id)).map(r => r.draft_laptop_asset_id));
      for (const j of todo) {
        const rule = ruleFor(j.designation);
        const laptop = pickLaptop(pool, rule.laptops, j.site, taken, j.draft_laptop_asset_id);
        if (laptop) taken.add(laptop.id);
        const headphoneId = await pickHeadphone(t, rule.headphones, j.id, j.location_id);
        const note = laptop ? `Agent draft — ${rule.label} · ${laptop.info.summary} (${j.site} stock)`
          : `Agent draft — ${rule.label} · ${j.site ? `no usable laptop left in ${j.site} stock` : `"${j.location_name || 'no location'}" has no stock site`}`;
        await t.run(
          `UPDATE new_joinees
              SET draft_laptop_asset_id = $1, draft_headphone_accessory_id = $2,
                  draft_note = $3, draft_generated_at = CURRENT_TIMESTAMP,
                  allocation_status = 'draft', updated_at = CURRENT_TIMESTAMP
            WHERE id = $4`,
          [laptop ? laptop.id : null, headphoneId, note.slice(0, 255), j.id]);
        drafted += 1;
      }
    });
    return drafted;
  })().finally(() => { running = null; });
  return running;
}

// Joinee list for the New Joinee section, with draft/final asset details.
async function listJoinees() {
  const rows = await db.query(
    `SELECT nj.*, nj.date_of_joining::text AS date_of_joining, l.name AS location_name,
            la.asset_tag AS laptop_tag, la.model_number AS laptop_model, la.status AS laptop_status,
            la.custom_fields_data->>'Machine Name' AS laptop_machine, la.custom_fields_data->>'Processor' AS laptop_cpu,
            la.custom_fields_data->>'RAM Size (GB)' AS laptop_ram, TO_CHAR(la.warranty_expiry, 'YYYY-MM-DD') AS laptop_warranty, la.notes AS laptop_notes,
            hp.name AS headphone_name, hp.model_number AS headphone_model,
            ab.name AS allocated_by_name,
            (SELECT STRING_AGG(ls.name, ', ' ORDER BY ls.name) FROM location_spocs ls WHERE ls.location_id = nj.location_id) AS spoc_names,
            em.status AS email_status, em.error AS email_error, em.created_at AS email_at, em.to_email AS email_to
       FROM new_joinees nj
       LEFT JOIN LATERAL (SELECT status, error, created_at, to_email FROM email_log
                           WHERE related_type = 'new_joinee' AND related_id = nj.id
                           ORDER BY created_at DESC, id DESC LIMIT 1) em ON TRUE
       LEFT JOIN locations l ON nj.location_id = l.id
       LEFT JOIN assets la ON nj.draft_laptop_asset_id = la.id
       LEFT JOIN accessories hp ON nj.draft_headphone_accessory_id = hp.id
       LEFT JOIN users ab ON nj.allocated_by = ab.id
      ORDER BY nj.allocation_status = 'allocated', nj.date_of_joining DESC, nj.id`);
  // SPOC names: the office's (SPOC sheet) plus the site's (Location SPOCs page).
  const siteSpocs = {};
  for (const s of await db.query(`SELECT s.site, COALESCE(s.name, u.name) AS name FROM site_spocs s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.user_id IS NULL OR u.deleted_at IS NULL ORDER BY s.id`)) (siteSpocs[s.site] = siteSpocs[s.site] || []).push(s.name);
  const spocNames = (own, site) => [...new Set([...(own ? own.split(', ') : []), ...(siteSpocs[site] || [])])].join(', ') || null;
  return rows.map(r => ({
    ...r, rule: ruleFor(r.designation), site: stock.siteOf(r.location_name),
    spoc_names: spocNames(r.spoc_names, stock.siteOf(r.location_name)),
    laptop: r.draft_laptop_asset_id ? stock.describeLaptop({ machine: r.laptop_machine, cpu: r.laptop_cpu, ram: r.laptop_ram,
      warranty: r.laptop_warranty, notes: r.laptop_notes }) : null
  }));
}

// Dropdown options for the engineer's edit modal. Laptops carry their stock site (the modal
// shows only the joinee's site, best first); headphones carry location_id as before.
// locationIds: limit options to these locations' sites (null = all).
async function allocationOptions(locationIds = null) {
  const locs = locationIds === null ? null : [...new Set(locationIds.filter(Boolean).map(Number))];
  if (locs && !locs.length) return { laptops: [], headphones: [] };
  const locSql = locs ? ' AND a.location_id = ANY($2::int[])' : '';
  const sites = locs ? new Set((await db.query('SELECT name FROM locations WHERE id = ANY($1::int[])', [locs]))
    .map(r => stock.siteOf(r.name)).filter(Boolean)) : null;
  const pool = await laptopPool(db);
  const laptops = stock.rankLaptops(sites ? pool.filter(l => sites.has(l.info.site)) : pool);
  const headphones = await db.query(
    `SELECT a.id, a.name, a.model_number, a.available_qty, a.location_id
       FROM accessories a JOIN asset_categories c ON a.category_id = c.id
      WHERE c.name = $1 AND a.deleted_at IS NULL AND a.available_qty > 0${locSql}
      ORDER BY a.name, a.id`, locs ? [HEADPHONE_CATEGORY, locs] : [HEADPHONE_CATEGORY]);
  return {
    laptops: laptops.map(l => ({
      id: l.id, tag: l.tag, model: l.model, site: l.info.site, detail: l.info.summary, premium: l.premium
    })),
    headphones: headphones.map(a => ({
      id: a.id, name: a.name, model: a.model_number || '',
      locationId: a.location_id, available: a.available_qty
    }))
  };
}

// Engineer edits the agent's draft. Both picks are re-validated against live
// availability so a stale form can't draft an already-taken item.
async function updateDraft(id, data, actor) {
  id = intOr(id);
  const laptopId = intOr(data.laptop_asset_id, 0);
  const headphoneId = intOr(data.headphone_accessory_id, 0);
  const joinee = await db.get('SELECT * FROM new_joinees WHERE id = $1', [id]);
  if (!joinee) throw new HttpError('New joinee not found.', 404);
  if (joinee.allocation_status === 'allocated') {
    throw new HttpError('Allocation is already finalized for this joinee.', 422);
  }
  if (laptopId > 0 && laptopId !== joinee.draft_laptop_asset_id) {
    const row = await db.get(
      `SELECT a.id, ${stock.LAPTOP_COLUMNS} FROM assets a JOIN asset_categories c ON a.category_id = c.id
        WHERE a.id = $1 AND c.name = $2 AND a.deleted_at IS NULL
          AND a.assigned_to IS NULL AND LOWER(a.status) = 'available'
          AND a.id NOT IN (
            SELECT draft_laptop_asset_id FROM new_joinees
             WHERE draft_laptop_asset_id IS NOT NULL AND allocation_status = 'draft' AND id <> $3)`,
      [laptopId, LAPTOP_CATEGORY, id]);
    const loc = await db.get('SELECT name FROM locations WHERE id = $1', [joinee.location_id]);
    const site = stock.siteOf(loc && loc.name);
    const info = row ? stock.describeLaptop(row) : null;
    if (!info) throw new HttpError('Selected laptop is no longer available (taken or drafted for someone else).', 422);
    if (!info.usable || info.site !== site) {
      throw new HttpError(`Selected laptop can't go to this joinee: ${info.why || `it is in ${info.site} stock, not ${site || 'the joinee\'s site'}`}.`, 422);
    }
  }
  if (headphoneId > 0 && headphoneId !== joinee.draft_headphone_accessory_id) {
    const ok = await db.get(
      `SELECT 1 FROM accessories a JOIN asset_categories c ON a.category_id = c.id
        WHERE a.id = $1 AND c.name = $2 AND a.deleted_at IS NULL AND a.available_qty > 0
          AND a.location_id = $3`,
      [headphoneId, HEADPHONE_CATEGORY, joinee.location_id]);
    if (!ok) throw new HttpError('Selected headphones are not available at the joinee\'s location.', 422);
  }
  await db.run(
    `UPDATE new_joinees
        SET draft_laptop_asset_id = $1, draft_headphone_accessory_id = $2,
            draft_note = $3, allocation_status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE id = $4`,
    [laptopId > 0 ? laptopId : null, headphoneId > 0 ? headphoneId : null,
      'Engineer-adjusted allocation', id]);
  await audit.log(actor ? actor.id : null, 'JOINEE_DRAFT_UPDATED',
    `Allocation draft updated for new joinee ${joinee.name} (${joinee.employee_id}).`);
  return true;
}

// Engineer approval: finalize via the existing checkout/assignment writers so
// every downstream tab (Assets, Accessories, ledger, audit) stays in sync.
// The laptop checkout re-validates availability inside its own transaction.
async function approveAllocation(id, actor) {
  id = intOr(id);
  const joinee = await db.get('SELECT * FROM new_joinees WHERE id = $1', [id]);
  if (!joinee) throw new HttpError('New joinee not found.', 404);
  if (joinee.allocation_status === 'allocated') {
    throw new HttpError('Allocation is already finalized for this joinee.', 422);
  }
  // A laptop is required. Headphones are allocated when drafted; when none is
  // available at the location the laptop can still go out (headphones follow later).
  if (!joinee.draft_laptop_asset_id) {
    throw new HttpError('Pick a laptop before allocating.', 422);
  }
  const note = `New joinee onboarding — ${joinee.designation} (${joinee.employee_id})`;

  await assetService.checkoutAsset(joinee.draft_laptop_asset_id,
    { user_id: joinee.user_id, checkout_notes: note }, actor);
  if (joinee.draft_headphone_accessory_id) {
    try {
      await inventoryWorkflow.assign('accessories', joinee.draft_headphone_accessory_id,
        { user_id: joinee.user_id, quantity: 1, notes: note }, actor ? actor.id : null);
    } catch (err) {
      // Roll the laptop back so a headphone stock failure doesn't half-allocate.
      await assetService.checkinAsset(joinee.draft_laptop_asset_id,
        { checkin_notes: 'Rollback: headphone allocation failed' }, actor).catch(() => {});
      throw err;
    }
  }

  await db.run(
    `UPDATE new_joinees
        SET allocation_status = 'allocated', allocated_at = CURRENT_TIMESTAMP,
            allocated_by = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`, [actor ? actor.id : null, id]);
  // Onboarding complete: activate the directory account.
  await db.run(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending'`,
    [joinee.user_id]);
  await audit.log(actor ? actor.id : null, 'JOINEE_ALLOCATED',
    `Onboarding assets allocated to ${joinee.name} (${joinee.employee_id})${joinee.draft_headphone_accessory_id ? '' : ' — laptop only, headphones pending'}.`);
  // Allocation is committed; the email can't undo it (failures are logged for resend).
  const email = await sendAllocationEmail(id, actor);
  return { allocated: true, headphones: !!joinee.draft_headphone_accessory_id, email };
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Builds the allocation email exactly as it will be sent: joinee in To, the location
// SPOC(s) in CC — or the allocating engineer when the location has no SPOC.
// Used for both Preview (any joinee with a drafted laptop) and sending.
async function buildAllocationEmail(joineeId, actor) {
  const j = await db.get(
    `SELECT nj.*, nj.date_of_joining::text AS doj, u.email AS user_email, l.name AS location_name,
            a.name AS laptop_name, a.model_number AS laptop_model, a.asset_tag AS laptop_tag, a.serial_number AS laptop_serial,
            m.name AS laptop_maker, hp.name AS headphone_name, hp.model_number AS headphone_model,
            ab.name AS engineer_name, ab.email AS engineer_email
       FROM new_joinees nj JOIN users u ON u.id = nj.user_id
       LEFT JOIN locations l ON l.id = nj.location_id
       LEFT JOIN assets a ON a.id = nj.draft_laptop_asset_id
       LEFT JOIN manufacturers m ON m.id = a.manufacturer_id
       LEFT JOIN accessories hp ON hp.id = nj.draft_headphone_accessory_id
       LEFT JOIN users ab ON ab.id = nj.allocated_by
      WHERE nj.id = $1`, [joineeId]);
  if (!j) throw new HttpError('New joinee not found.', 404);
  if (!j.draft_laptop_asset_id) throw new HttpError('No laptop is drafted for this joinee yet, so there is no email to show.', 422);
  // Contacts: the office's SPOCs (SPOC sheet) and the site's Location SPOCs (Location SPOCs page).
  const officeSpocs = j.location_id ? await db.query('SELECT name, email, phone FROM location_spocs WHERE location_id = $1 ORDER BY name', [j.location_id]) : [];
  const site = stock.siteOf(j.location_name);
  // Site SPOCs without sign-in are contacts (name + phone, no email): listed, not CC'd.
  const siteSpocs = site ? await db.query(
    `SELECT COALESCE(s.name, u.name) AS name, u.email, s.phone FROM site_spocs s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.site = $1 AND (s.user_id IS NULL OR (u.deleted_at IS NULL AND u.status = 'active')) ORDER BY s.id`, [site]) : [];
  const office = site ? await db.get('SELECT office_name, address FROM site_offices WHERE site = $1', [site]) : null;
  const sameContact = (a, b) => (a.email && b.email ? String(a.email).toLowerCase() === String(b.email).toLowerCase()
    : String(a.name).toLowerCase() === String(b.name).toLowerCase());
  const spocs = [...officeSpocs, ...siteSpocs].filter((c, i, all) => all.findIndex(x => sameContact(x, c)) === i);
  const spocEmails = spocs.filter(c => c.email);
  // CC when no SPOC has an email: the engineer who allocated
  // (for allocated joinees), otherwise the person about to click Allocate.
  const allocatedBy = j.engineer_email ? { name: j.engineer_name, email: j.engineer_email } : null;
  const current = actor && actor.email ? { name: actor.name, email: actor.email } : null;
  const engineer = j.allocation_status === 'allocated' ? (allocatedBy || current) : (current || allocatedBy);
  const contacts = spocs.length ? spocs : (engineer ? [{ ...engineer, phone: null }] : []);
  const cc = spocEmails.length ? spocEmails.map(c => c.email) : (engineer ? [engineer.email] : []);
  const address = office && office.address ? office.address.replace(/\s*\n\s*/g, ', ') : null;
  const brand = await settings.get('branding', 'app_name', 'IT Asset Management');

  const laptop = [j.laptop_maker && !String(j.laptop_model || '').toLowerCase().startsWith(String(j.laptop_maker).toLowerCase()) ? j.laptop_maker : '', j.laptop_model || j.laptop_name].filter(Boolean).join(' ');
  const headphones = j.headphone_name ? [j.headphone_name, j.headphone_model && j.headphone_model !== j.headphone_name ? j.headphone_model : ''].filter(Boolean).join(' ') : null;
  const contactLine = c => [c.name, c.email, c.phone].filter(Boolean).join(' · ');
  const subject = `Your laptop is ready for collection — ${j.name} (${j.employee_id})`;
  const text = [
    `Hi ${j.name},`, '',
    `Welcome! The following IT assets have been allocated to you${j.doj ? ` for your joining on ${j.doj}` : ''}:`, '',
    `Laptop: ${laptop}`, `  Asset tag: ${j.laptop_tag}`, `  Serial number: ${j.laptop_serial || '—'}`,
    `Headphones: ${headphones || 'not available yet at your location — they will be issued separately'}`, '',
    `Please collect them at ${j.location_name || 'your location'} from:`,
    ...(contacts.length ? contacts.map(c => `  ${contactLine(c)}`) : ['  your local IT team']), '',
    ...(address ? [`Office address${office.office_name ? ` (${office.office_name})` : ''}:`, `  ${address}`, ''] : []),
    'Please carry your employee ID when collecting.', '',
    `Regards,`, `${brand}`
  ].join('\n');
  const td = 'padding:6px 12px;border-bottom:1px solid #e5e7eb';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827;line-height:1.5">
<p>Hi ${esc(j.name)},</p>
<p>Welcome! The following IT assets have been allocated to you${j.doj ? ` for your joining on <b>${esc(j.doj)}</b>` : ''}:</p>
<table style="border-collapse:collapse;margin:8px 0 16px">
<tr><td style="${td};color:#6b7280">Laptop</td><td style="${td}"><b>${esc(laptop)}</b></td></tr>
<tr><td style="${td};color:#6b7280">Asset tag</td><td style="${td}">${esc(j.laptop_tag)}</td></tr>
<tr><td style="${td};color:#6b7280">Serial number</td><td style="${td}">${esc(j.laptop_serial || '—')}</td></tr>
<tr><td style="${td};color:#6b7280">Headphones</td><td style="${td}">${headphones ? esc(headphones) : '<i>Not available yet at your location — they will be issued separately</i>'}</td></tr>
</table>
<p>Please collect them at <b>${esc(j.location_name || 'your location')}</b> from:</p>
<ul>${contacts.length ? contacts.map(c => `<li><b>${esc(c.name)}</b>${c.email ? ` — <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}</li>`).join('') : '<li>your local IT team</li>'}</ul>
${address ? `<p style="color:#374151">Office address${office.office_name ? ` (${esc(office.office_name)})` : ''}:<br>${esc(address)}</p>` : ''}
<p>Please carry your employee ID when collecting.</p>
<p>Regards,<br>${esc(brand)}</p></div>`;

  return {
    joinee: j, to: j.user_email, cc,
    ccSource: spocEmails.length ? 'spoc' : (engineer ? (spocs.length ? 'engineer_spoc_no_email' : 'engineer') : 'none'),
    subject, text, html
  };
}

// Sends the allocation email (allocated joinees only). Logged in email_log.
async function sendAllocationEmail(joineeId, actor) {
  const m = await buildAllocationEmail(joineeId, actor);
  if (m.joinee.allocation_status !== 'allocated') throw new HttpError('Only allocated joinees can be emailed.', 422);
  return mailService.send({
    type: 'joinee_allocation', to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: m.html,
    relatedType: 'new_joinee', relatedId: m.joinee.id, createdBy: actor ? actor.id : null
  });
}

// Preview data for the UI: the composed email plus why it would or wouldn't send.
async function previewAllocationEmail(joineeId, actor) {
  const m = await buildAllocationEmail(joineeId, actor);
  const cfg = await mailService.smtpConfig();
  const last = await db.get(
    `SELECT status, error, created_at FROM email_log WHERE related_type = 'new_joinee' AND related_id = $1 ORDER BY id DESC LIMIT 1`, [joineeId]);
  const toOk = mailService.isDeliverable(m.to);
  return {
    to: m.to, cc: m.cc, ccSource: m.ccSource, subject: m.subject, html: m.html, text: m.text,
    allocated: m.joinee.allocation_status === 'allocated',
    smtpReady: cfg.enabled, smtpReason: cfg.reason,
    recipientOk: toOk,
    willSend: cfg.enabled && toOk,
    lastStatus: last ? last.status : null, lastError: last ? last.error : null
  };
}

// ---------------------------------------------------------------------------
// Excel/CSV import: each row creates (or updates) a pending directory account +
// new_joinees row; recommendations are then drafted for the engineer to review.
// Workflow stays: import -> system recommendation -> engineer review -> Allocate.
// ---------------------------------------------------------------------------
const IMPORT_COLUMNS = {
  employee_id: ['Employee ID', 'Emp ID', 'Employee Code', 'Emp Code', 'Employee No', 'Employee Number', 'CTID'],
  name: ['Name', 'Employee Name', 'Full Name', 'Joinee Name'],
  email: ['Email', 'Email ID', 'Email Address', 'Official Email', 'Mail'],
  designation: ['Designation', 'Role', 'Title', 'Job Title'],
  location: ['Location', 'Work Location', 'Office', 'Office Location', 'Base Location', 'Asset Location'],
  employment_status: ['Employment Status', 'Employment Type', 'Employee Type'],
  date_of_joining: ['Date of Joining', 'DOJ', 'Joining Date', 'Start Date']
};
const DESIGNATION_ALIASES = {
  'senior director': 'Senior Director', 'sr director': 'Senior Director', 'sr. director': 'Senior Director',
  'avp': 'AVP', 'assistant vice president': 'AVP', 'associate vice president': 'AVP',
  'consultant': 'Consultant', 'senior consultant': 'Consultant', 'sr consultant': 'Consultant',
  'engineer': 'Engineer', 'software engineer': 'Engineer', 'senior engineer': 'Engineer', 'sr engineer': 'Engineer',
  'fresher': 'Fresher', 'trainee': 'Fresher', 'graduate trainee': 'Fresher', 'intern': 'Fresher'
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseJoinDate(v) {
  const s = String(v || '').trim();
  if (!s) return { value: null };
  let y, m, d, x;
  if ((x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [+x[1], +x[2], +x[3]];
  } else if ((x = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})$/)) && MONTHS[x[2].toLowerCase()]) {
    [d, m, y] = [+x[1], MONTHS[x[2].toLowerCase()], +x[3]];
    if (y < 100) y += 2000;
  } else if ((x = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/))) { // dd/mm/yyyy (India format)
    [d, m, y] = [+x[1], +x[2], +x[3]];
    if (y < 100) y += 2000;
  } else {
    return { error: `Unrecognized date "${s}" (use YYYY-MM-DD or DD-Mon-YYYY)` };
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { error: `Invalid date "${s}"` };
  return { value: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

function canonicalDesignation(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  const key = s.toLowerCase();
  const exact = Object.keys(ALLOCATION_RULES).find(k => k.toLowerCase() === key);
  return { value: exact || DESIGNATION_ALIASES[key] || s, known: !!(exact || DESIGNATION_ALIASES[key]) };
}

function employmentStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || ['employee', 'permanent', 'full time', 'full-time', 'fte', 'regular'].includes(s)) return 'Employee';
  if (['contractor', 'contract', 'c2h', 'temporary', 'temp'].includes(s)) return 'Contractor';
  return null;
}

const dateStr = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

// Saves one validated row in its own transaction. Returns { kind } or { skip }.
async function saveImportedJoinee(row, placeholderHash) {
  return db.tx(async t => {
    const existing = await t.get('SELECT * FROM new_joinees WHERE LOWER(employee_id) = LOWER($1)', [row.empId]);
    if (existing) {
      if (existing.allocation_status === 'allocated') return { skip: 'Already allocated; not changed' };
      const user = await t.get('SELECT LOWER(email) AS email FROM users WHERE id = $1', [existing.user_id]);
      const ruleChanged = existing.designation !== row.designation || existing.location_id !== row.locationId;
      const changed = ruleChanged || existing.name !== row.name || existing.employment_status !== row.status ||
        (row.doj && dateStr(existing.date_of_joining) !== row.doj) || (row.email && row.email !== user.email);
      if (!changed) return { kind: 'unchanged' };
      if (row.email && row.email !== user.email) {
        const clash = await t.get('SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2', [row.email, existing.user_id]);
        if (clash) return { skip: `Email ${row.email} already belongs to another user` };
        await t.run('UPDATE users SET email = $1 WHERE id = $2', [row.email, existing.user_id]);
      }
      // A new designation or location needs a fresh recommendation.
      await t.run(
        `UPDATE new_joinees SET name = $1, designation = $2, location_id = $3, employment_status = $4,
                date_of_joining = COALESCE($5::date, date_of_joining), updated_at = CURRENT_TIMESTAMP
                ${ruleChanged ? `, allocation_status = 'pending', draft_laptop_asset_id = NULL,
                draft_headphone_accessory_id = NULL, draft_note = NULL` : ''}
          WHERE id = $6`, [row.name, row.designation, row.locationId, row.status, row.doj, existing.id]);
      await t.run('UPDATE users SET name = $1, location_id = $2 WHERE id = $3', [row.name, row.locationId, existing.user_id]);
      return { kind: 'updated' };
    }
    const dir = row.email
      ? await t.get('SELECT id FROM users WHERE LOWER(employee_id) = LOWER($1) OR LOWER(email) = $2', [row.empId, row.email])
      : await t.get('SELECT id FROM users WHERE LOWER(employee_id) = LOWER($1)', [row.empId]);
    if (dir) return { skip: 'Already in the Enterprise Directory (existing employee, not a new joinee)' };
    // No email yet (common before day one): reserved ".invalid" placeholder until HR supplies one.
    const userEmail = row.email || `${row.empId.toLowerCase().replace(/[^a-z0-9._-]/g, '')}@pending-email.invalid`;
    const userId = await t.insert(
      `INSERT INTO users (uuid, employee_id, name, email, password, role, status, location_id)
       VALUES ($1, $2, $3, $4, $5, 'employee', 'pending', $6)`,
      [crypto.randomUUID(), row.empId, row.name, userEmail, placeholderHash, row.locationId]);
    const empRole = await t.get(`SELECT id FROM roles WHERE name = 'employee'`);
    if (empRole) await t.run('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, empRole.id]);
    await t.run(
      `INSERT INTO new_joinees (user_id, employee_id, name, location_id, employment_status, date_of_joining, designation)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7)`,
      [userId, row.empId, row.name, row.locationId, row.status, row.doj, row.designation]);
    return { kind: 'created' };
  });
}

// "Location SPOC details" sheet: engineers who hand over assets at each location.
const SPOC_COLUMNS = {
  location: ['Location', 'Work Location', 'Office', 'Site', 'Asset Location'],
  name: ['SPOC Name', 'Engineer Name', 'SPOC', 'Name', 'Contact Name'],
  email: ['SPOC Email', 'SPOC Email ID', 'Engineer Email', 'Email', 'Email ID', 'Email Address'],
  phone: ['SPOC Contact', 'Contact Number', 'Phone', 'Phone Number', 'Mobile', 'Mobile Number', 'Contact']
};

// Picks the joinee sheet and the SPOC sheet out of a workbook, by sheet name first,
// then by their columns. A single-sheet file (or CSV) is treated as joinees only.
function pickSheets(sheets) {
  const hasCols = (sheet, aliases, keys) => {
    const mapped = mapRows([Object.fromEntries(sheet.headers.map(h => [h, 'x']))], aliases)[0];
    return keys.every(k => k in mapped);
  };
  const usable = sheets.filter(s => !/valid values/i.test(s.name));
  const spoc = usable.find(s => /spoc/i.test(s.name)) ||
    usable.find(s => hasCols(s, SPOC_COLUMNS, ['location', 'email']) && !hasCols(s, IMPORT_COLUMNS, ['employee_id']));
  const joinee = usable.find(s => s !== spoc && /joinee/i.test(s.name)) ||
    usable.find(s => s !== spoc && hasCols(s, IMPORT_COLUMNS, ['employee_id', 'designation'])) ||
    (usable.length === 1 && usable[0] !== spoc ? usable[0] : null);
  return { joinee, spoc };
}

// Replaces the SPOC list of every location present in the sheet.
async function importSpocs(rows, locByName) {
  const res = { saved: 0, locations: 0, skipped: [] };
  const byLoc = new Map();
  for (const r of mapRows(rows, SPOC_COLUMNS)) {
    const skip = reason => res.skipped.push({ row: r.__row, reason });
    const loc = locByName.get(String(r.location || '').trim().toLowerCase());
    const name = String(r.name || '').replace(/\s+/g, ' ').trim();
    const email = String(r.email || '').trim().toLowerCase();
    if (!loc) { skip(`SPOC sheet: unknown location "${r.location || ''}"`); continue; }
    if (!name) { skip('SPOC sheet: SPOC name is empty'); continue; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skip(`SPOC sheet: invalid email "${r.email || ''}"`); continue; }
    const list = byLoc.get(loc.id) || new Map();
    list.set(email, { name, email, phone: String(r.phone || '').trim().slice(0, 50) || null });
    byLoc.set(loc.id, list);
  }
  await db.tx(async t => {
    for (const [locationId, list] of byLoc) {
      await t.run('DELETE FROM location_spocs WHERE location_id = $1', [locationId]);
      for (const s of list.values()) {
        await t.run('INSERT INTO location_spocs (location_id, name, email, phone) VALUES ($1, $2, $3, $4)', [locationId, s.name, s.email, s.phone]);
        res.saved += 1;
      }
    }
  });
  res.locations = byLoc.size;
  return res;
}

async function importJoinees(buffer, filename, actor) {
  const sheets = await readWorkbook(buffer, filename);
  const { joinee: joineeSheet, spoc: spocSheet } = pickSheets(sheets);
  if (!joineeSheet && !spocSheet) {
    throw new HttpError('No "New Joinee details" or "Location SPOC details" sheet found. Download the template for the expected layout.', 422);
  }
  const locations = await db.query('SELECT id, name FROM locations WHERE deleted_at IS NULL');
  const locByName = new Map(locations.map(l => [l.name.trim().toLowerCase(), l]));
  // SPOCs first, so this import's joinees already have their contacts.
  const spocs = spocSheet ? await importSpocs(spocSheet.rows, locByName) : null;

  const rows = joineeSheet ? mapRows(joineeSheet.rows, IMPORT_COLUMNS) : [];
  if (joineeSheet) {
    const present = new Set(rows.flatMap(r => Object.keys(r)));
    const missing = ['employee_id', 'name', 'designation', 'location'].filter(k => !present.has(k));
    if (missing.length) {
      throw new HttpError(`"${joineeSheet.name}" sheet is missing column(s): ${missing.map(k => IMPORT_COLUMNS[k][0]).join(', ')}. Download the template for the expected headers.`, 422);
    }
  }
  // Imported joinees can't sign in until onboarding (random, unknown password).
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);

  const result = { created: 0, updated: 0, unchanged: 0, skipped: [...(spocs ? spocs.skipped : [])], defaultedDesignation: 0, noStock: new Set(), spocs };
  const usableBySite = await usableLaptopsBySite();
  const seen = new Set();
  for (const r of rows) {
    const skip = reason => result.skipped.push({ row: r.__row, employee_id: r.employee_id || '', reason });
    const empId = String(r.employee_id || '').trim();
    const name = String(r.name || '').replace(/\s+/g, ' ').trim();
    if (!empId) { skip('Employee ID is empty'); continue; }
    if (!name) { skip('Name is empty'); continue; }
    if (seen.has(empId.toLowerCase())) { skip('Duplicate Employee ID in the file'); continue; }
    seen.add(empId.toLowerCase());
    const desig = canonicalDesignation(r.designation);
    if (!desig.value) { skip('Designation is empty'); continue; }
    const loc = locByName.get(String(r.location || '').trim().toLowerCase());
    if (!loc) { skip(`Unknown location "${r.location || ''}" (must match a location in Inventory Setup)`); continue; }
    const status = employmentStatus(r.employment_status);
    if (!status) { skip(`Employment Status must be Employee or Contractor (got "${r.employment_status}")`); continue; }
    const doj = parseJoinDate(r.date_of_joining);
    if (doj.error) { skip(doj.error); continue; }
    const email = String(r.email || '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skip(`Invalid email "${r.email}"`); continue; }

    try {
      const out = await saveImportedJoinee({
        empId, name, email, designation: desig.value, locationId: loc.id, status, doj: doj.value
      }, placeholderHash);
      if (out.skip) { skip(out.skip); continue; }
      result[out.kind] += 1;
      if (out.kind !== 'unchanged') {
        if (!desig.known) result.defaultedDesignation += 1;
        if (!usableBySite.get(stock.siteOf(loc.name))) result.noStock.add(loc.name);
      }
    } catch (err) {
      skip(err.message);
    }
  }

  // System recommendation step (same agent the page uses); engineer approval still required.
  result.recommended = (result.created || result.updated) ? await ensureDrafts() : 0;
  result.noStock = [...result.noStock];
  await audit.log(actor ? actor.id : null, 'JOINEES_IMPORTED',
    `New joinee import (${filename}): ${result.created} created, ${result.updated} updated, ${result.skipped.length} skipped.`);
  return result;
}

// Template workbook: the import headers + a "Valid values" sheet listing designations
// (with the laptop each gets) and locations with current laptop/headset stock.
async function importTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('New Joinee details');
  ws.columns = [
    { header: 'Employee ID', width: 14 }, { header: 'Name', width: 26 }, { header: 'Email', width: 32 },
    { header: 'Designation', width: 18 }, { header: 'Location', width: 26 },
    { header: 'Employment Status', width: 18 }, { header: 'Date of Joining', width: 16 }
  ];
  ws.getRow(1).font = { bold: true };
  ws.getColumn(7).numFmt = 'yyyy-mm-dd';

  // SPOC sheet, prefilled with the SPOCs already on file (edit and re-import to change them).
  const sp = wb.addWorksheet('Location SPOC details');
  sp.columns = [{ header: 'Location', width: 28 }, { header: 'SPOC Name', width: 26 },
    { header: 'SPOC Email', width: 34 }, { header: 'Contact Number', width: 18 }];
  sp.getRow(1).font = { bold: true };
  for (const s of await db.query(
    `SELECT l.name AS location, ls.name, ls.email, ls.phone FROM location_spocs ls JOIN locations l ON l.id = ls.location_id ORDER BY l.name, ls.name`)) {
    sp.addRow([s.location, s.name, s.email, s.phone || '']);
  }

  const ref = wb.addWorksheet('Valid values');
  ref.columns = [{ width: 20 }, { width: 34 }, { width: 4 }, { width: 28 }, { width: 18 }, { width: 22 }, { width: 18 }];
  ref.addRow(['Designation', 'Recommended laptop', '', 'Location', 'Stock site', 'Usable laptops at site', 'Headsets available']).font = { bold: true };
  const usableBySite = await usableLaptopsBySite();
  const siteStock = (await db.query(
    `SELECT l.name,
            (SELECT COALESCE(SUM(ac.available_qty), 0) FROM accessories ac JOIN asset_categories c ON c.id = ac.category_id
              WHERE c.name = $1 AND ac.location_id = l.id AND ac.deleted_at IS NULL)::int AS headsets
       FROM locations l WHERE l.deleted_at IS NULL`, [HEADPHONE_CATEGORY]))
    .map(l => ({ ...l, site: stock.siteOf(l.name), laptops: usableBySite.get(stock.siteOf(l.name)) || 0 }))
    .sort((a, b) => b.laptops - a.laptops || a.name.localeCompare(b.name));
  const left = Object.entries(ALLOCATION_RULES).map(([k, r]) => [k, r.label]).concat([
    ['', ''], ['Employment Status', 'Employee or Contractor'], ['Date of Joining', 'YYYY-MM-DD or DD-Mon-YYYY'],
    ['Email', 'Optional before day one'], ['Location', 'Must match exactly (see list)']
  ]);
  for (let i = 0; i < Math.max(left.length, siteStock.length); i++) {
    const a = left[i] || ['', ''];
    const s = siteStock[i];
    ref.addRow([a[0], a[1], '', s ? s.name : '', s ? s.site || 'none' : '', s ? s.laptops : '', s ? s.headsets : '']);
  }
  return wb.xlsx.writeBuffer();
}

// Remove a joinee who hasn't been allocated yet (e.g. offer withdrawn, wrong row).
// Deletes the new_joinees row and — when it is still the pending account the import
// created and holds no assets — the directory account too, so nothing is left behind.
// Allocated joinees can't be removed here: their laptop must be checked in first.
async function removeJoinee(id, actor) {
  id = intOr(id);
  const removed = await db.tx(async t => {
    const j = await t.get('SELECT * FROM new_joinees WHERE id = $1 FOR UPDATE', [id]);
    if (!j) throw new HttpError('New joinee not found.', 404);
    if (j.allocation_status === 'allocated') {
      throw new HttpError(`${j.name} is already allocated. Check the laptop in from Hardware first; allocated joinees can't be removed.`, 422);
    }
    await t.run('DELETE FROM new_joinees WHERE id = $1', [id]);
    const holds = await t.get(
      `SELECT EXISTS (SELECT 1 FROM assignments WHERE user_id = $1)
           OR EXISTS (SELECT 1 FROM accessory_assignments WHERE user_id = $1)
           OR EXISTS (SELECT 1 FROM assets WHERE assigned_to = $1) AS any`, [j.user_id]);
    const user = await t.get('SELECT id, status, role FROM users WHERE id = $1', [j.user_id]);
    let accountRemoved = false;
    if (user && user.status === 'pending' && user.role === 'employee' && !holds.any) {
      await t.run('DELETE FROM users WHERE id = $1', [j.user_id]);
      accountRemoved = true;
    }
    return { name: j.name, employee_id: j.employee_id, accountRemoved };
  });
  await audit.log(actor ? actor.id : null, 'JOINEE_REMOVED',
    `New joinee ${removed.name} (${removed.employee_id}) removed${removed.accountRemoved ? ' with their pending account' : ''}.`);
  return removed;
}

module.exports = {
  removeJoinee,
  importJoinees, importTemplate, IMPORT_COLUMNS, SPOC_COLUMNS, sendAllocationEmail, previewAllocationEmail,
  needsRecommendations,
  ensureDrafts, listJoinees, allocationOptions, updateDraft, approveAllocation,
  ALLOCATION_RULES
};
