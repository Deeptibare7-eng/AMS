// Daily IT alerts digest and weekly summary, run by schedulerService.
// build*() only read data; deliver() sends one email (to the configured recipients,
// else to admins), one Microsoft Teams message and an in-app notification to admins.
const db = require('../core/db');
const config = require('../config');
const settings = require('./settingsService');
const mailService = require('./mailService');
const teams = require('./teamsService');
const notifications = require('./notificationService');
const automation = require('./automationService');
const { e } = require('../core/helpers');

const DEFAULTS = {
  warranty_days: '90,60,30', low_stock_threshold: '5', low_stock_category: 'Laptop',
  alert_recipients: '', summary_recipients: '', teams_webhook_url: '', in_app_enabled: '1'
};
const UNUSABLE_LABELS = ['Lost', 'Broken', 'Damaged', 'In Repair'];
const MAX_ROWS = 25;

const parseList = v => [...new Set(String(v || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(mailService.isDeliverable))];
const fmtDate = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const n = v => Number(v || 0).toLocaleString('en-IN');

async function getConfig() {
  const g = k => settings.get('automation', k, DEFAULTS[k]);
  const warranty = String(await g('warranty_days')).split(/[,\s]+/).map(x => parseInt(x, 10)).filter(x => x > 0 && x <= 365);
  return {
    warrantyDays: [...new Set(warranty)].sort((a, b) => b - a).slice(0, 5),
    lowStockThreshold: Math.max(0, parseInt(await g('low_stock_threshold'), 10) || 0),
    lowStockCategory: String(await g('low_stock_category')).trim() || 'Laptop',
    recipients: parseList(await g('alert_recipients')),
    summaryRecipients: parseList(await g('summary_recipients')),
    teamsUrl: String(await g('teams_webhook_url') || '').trim(),
    inApp: (await g('in_app_enabled')) !== '0'
  };
}

// ───────────────────────────── shared checks ─────────────────────────────

const ASSET_JOINS = `
  LEFT JOIN asset_categories c ON c.id = a.category_id
  LEFT JOIN locations l ON l.id = a.location_id
  LEFT JOIN status_labels sl ON sl.id = a.status_label_id
  LEFT JOIN users u ON u.id = a.assigned_to`;

// Warranties crossing each threshold in the window (since, until]: a daily run sees
// each asset once per threshold, and a missed day is caught up on the next run.
async function warrantyCrossings(c, since, until) {
  const out = [];
  for (const days of c.warrantyDays) {
    const rows = await db.query(
      `SELECT a.id, a.asset_tag, a.name, a.model_number, COALESCE(c.name, a.category) AS category, l.name AS location,
              COALESCE(sl.name, a.status) AS status, u.name AS holder, a.warranty_expiry
         FROM assets a ${ASSET_JOINS}
        WHERE a.deleted_at IS NULL AND a.status <> 'archived'
          AND a.warranty_expiry > ($1::date + $3::int) AND a.warranty_expiry <= ($2::date + $3::int)
        ORDER BY a.warranty_expiry, a.asset_tag`, [since, until, days]);
    out.push({ days, rows });
  }
  return out;
}

// Deployed devices whose holder is no longer active (left / deactivated / deleted).
async function leaversHoldingDevices() {
  return db.query(
    `SELECT a.id, a.asset_tag, a.model_number, COALESCE(c.name, a.category) AS category, l.name AS location,
            u.name AS holder, u.employee_id, CASE WHEN u.deleted_at IS NOT NULL THEN 'deleted' ELSE u.status END AS holder_status
       FROM assets a ${ASSET_JOINS}
      WHERE a.deleted_at IS NULL AND a.status = 'assigned' AND u.id IS NOT NULL
        AND (u.deleted_at IS NOT NULL OR COALESCE(u.status, 'active') NOT IN ('active', 'pending'))
      ORDER BY u.name, a.asset_tag`);
}

// Sites (that use the category) whose usable spare stock is below the minimum.
async function lowStockSites(c) {
  if (!c.lowStockThreshold) return [];
  return db.query(
    `SELECT l.id, l.name AS location,
            COUNT(*) FILTER (WHERE a.status = 'available' AND COALESCE(sl.name, '') <> ALL($3::text[]))::int AS in_stock,
            COUNT(*) FILTER (WHERE a.status = 'assigned')::int AS deployed
       FROM assets a
       JOIN locations l ON l.id = a.location_id
       LEFT JOIN asset_categories c ON c.id = a.category_id
       LEFT JOIN status_labels sl ON sl.id = a.status_label_id
      WHERE a.deleted_at IS NULL AND lower(COALESCE(c.name, a.category, '')) = lower($1)
      GROUP BY l.id, l.name
     HAVING COUNT(*) FILTER (WHERE a.status = 'assigned') > 0
        AND COUNT(*) FILTER (WHERE a.status = 'available' AND COALESCE(sl.name, '') <> ALL($3::text[])) < $2
      ORDER BY in_stock, deployed DESC`, [c.lowStockCategory, c.lowStockThreshold, UNUSABLE_LABELS]);
}

// ───────────────────────────── message building ─────────────────────────────

const assetLink = r => `<a href="${e(config.appUrl)}/assets/${r.id}" style="color:#2563eb">${e(r.asset_tag)}</a>`;

// section: { title, count, note?, columns: [label], rows: [[htmlCell]], textRows: [string] }
function renderHtml(title, intro, sections) {
  const body = sections.map(s => {
    const table = s.rows.length ? `<table cellpadding="6" style="border-collapse:collapse;width:100%;font:13px Arial,sans-serif;margin-top:6px">
      <tr>${s.columns.map(h => `<th align="left" style="background:#f1f5f9;color:#475569;border-bottom:1px solid #e2e8f0">${e(h)}</th>`).join('')}</tr>
      ${s.rows.slice(0, MAX_ROWS).map(r => `<tr>${r.map(v => `<td style="border-bottom:1px solid #f1f5f9">${v}</td>`).join('')}</tr>`).join('')}
    </table>${s.count > MAX_ROWS ? `<p style="color:#64748b;font:12px Arial,sans-serif">…and ${n(s.count - MAX_ROWS)} more in IT-HAMS.</p>` : ''}` : '';
    return `<h3 style="font:bold 15px Arial,sans-serif;margin:22px 0 4px">${e(s.title)} <span style="color:${s.count ? '#dc2626' : '#16a34a'}">(${n(s.count)})</span></h3>
      ${s.note ? `<p style="color:#64748b;font:12px Arial,sans-serif;margin:0">${e(s.note)}</p>` : ''}${table}`;
  }).join('');
  return `<div style="max-width:760px;font:14px Arial,sans-serif;color:#0f172a">
    <h2 style="font:bold 20px Arial,sans-serif;margin:0 0 6px">${e(title)}</h2>
    <p style="color:#475569;margin:0">${e(intro)}</p>${body}
    <p style="margin-top:26px"><a href="${e(config.appUrl)}" style="color:#2563eb">Open IT-HAMS</a></p>
    <p style="color:#94a3b8;font:11px Arial,sans-serif">Sent automatically by IT-HAMS. Change recipients or switch this off under Settings → Automations.</p>
  </div>`;
}

function renderText(title, intro, sections) {
  return [title, intro, ...sections.map(s =>
    `\n${s.title} (${s.count})${s.note ? '\n' + s.note : ''}${s.textRows.slice(0, MAX_ROWS).map(t => '\n - ' + t).join('')}${s.count > MAX_ROWS ? `\n ...and ${s.count - MAX_ROWS} more` : ''}`),
  `\nOpen IT-HAMS: ${config.appUrl}`].join('\n');
}

// email: false sends only Teams + in-app (used for routine "all good" notices).
async function deliver({ kind, subject, title, intro, sections, facts, recipients, c, email = true }) {
  const parts = [];
  // Email: configured recipients, else admins with a real address.
  let to = recipients;
  if (email && !to.length) to = (await notifications.adminUsers()).map(a => String(a.email || '').toLowerCase()).filter(mailService.isDeliverable);
  if (!email) {
    parts.push('no email (routine notice)');
  } else if (to.length) {
    const r = await mailService.send({ type: kind, to: to[0], cc: to.slice(1), subject,
      text: renderText(title, intro, sections), html: renderHtml(title, intro, sections), relatedType: 'scheduler' });
    parts.push(r.status === 'sent' ? `email sent to ${to.length}` : `email ${r.status} (${r.error})`);
  } else {
    parts.push('email skipped (no recipients with a real address)');
  }
  if (c.teamsUrl) {
    const r = await teams.post(c.teamsUrl, { title: subject, text: intro, facts });
    parts.push(r.ok ? 'Teams posted' : `Teams failed (${r.error})`);
  } else {
    parts.push('Teams not set up');
  }
  if (c.inApp) {
    const count = await notifications.sendToAdmins(kind, subject.slice(0, 250), [intro, ...facts.map(([k, v]) => `${k}: ${v}`)].join('\n'));
    parts.push(`in-app to ${count} admin(s)`);
  }
  return parts.join(' · ');
}

// ───────────────────────────── daily alerts ─────────────────────────────

async function buildDaily(c, since, until) {
  const [warranty, leavers, lowStock] = await Promise.all([
    warrantyCrossings(c, since, until), leaversHoldingDevices(), lowStockSites(c)
  ]);
  return { warranty, leavers, lowStock };
}

// ctx: { since, until } as YYYY-MM-DD (since exclusive), manual: Run now.
async function runDaily(ctx) {
  const c = await getConfig();
  const d = await buildDaily(c, ctx.since, ctx.until);
  const sections = [];
  for (const w of d.warranty) {
    sections.push({
      title: `Warranty ends in ${w.days} days`, count: w.rows.length,
      columns: ['Asset', 'Model', 'Category', 'Location', 'Holder', 'Warranty ends'],
      rows: w.rows.map(r => [assetLink(r), e(r.model_number || '—'), e(r.category || '—'), e(r.location || '—'), e(r.holder || 'In stock'), e(fmtDate(r.warranty_expiry))]),
      textRows: w.rows.map(r => `${r.asset_tag} · ${r.model_number || ''} · ${r.holder || 'in stock'} · ends ${fmtDate(r.warranty_expiry)}`)
    });
  }
  sections.push({
    title: 'Leavers still holding devices', count: d.leavers.length, note: 'Employees who are no longer active but have hardware assigned: recover it.',
    columns: ['Asset', 'Category', 'Employee', 'Status', 'Location'],
    rows: d.leavers.map(r => [assetLink(r), e(r.category || '—'), e(`${r.holder}${r.employee_id ? ' (' + r.employee_id + ')' : ''}`), e(r.holder_status), e(r.location || '—')]),
    textRows: d.leavers.map(r => `${r.asset_tag} · ${r.holder} (${r.holder_status})`)
  });
  if (c.lowStockThreshold) {
    sections.push({
      title: `Low spare ${c.lowStockCategory.toLowerCase()} stock`, count: d.lowStock.length,
      note: `Sites with fewer than ${c.lowStockThreshold} usable spares in stock.`,
      columns: ['Location', 'In stock', 'Deployed'],
      rows: d.lowStock.map(r => [e(r.location), `<b>${n(r.in_stock)}</b>`, n(r.deployed)]),
      textRows: d.lowStock.map(r => `${r.location}: ${r.in_stock} in stock, ${r.deployed} deployed`)
    });
  }

  const warrantyTotal = d.warranty.reduce((t, w) => t + w.rows.length, 0);
  const facts = [
    ...d.warranty.map(w => [`Warranty ends in ${w.days} days`, n(w.rows.length)]),
    ['Leavers holding devices', n(d.leavers.length)],
    ...(c.lowStockThreshold ? [[`Sites low on spare ${c.lowStockCategory.toLowerCase()}s`, n(d.lowStock.length)]] : [])
  ];
  const actionable = warrantyTotal + d.leavers.length + d.lowStock.length;
  const counts = facts.map(([k, v]) => `${k}: ${v}`).join(', ');
  if (!actionable) return `Nothing to report (${counts}). No message sent.`;

  const subject = `IT-HAMS daily alerts: ${actionable.toLocaleString('en-IN')} item(s) need attention`;
  const delivery = await deliver({
    kind: 'daily_alerts', subject, title: 'Daily IT alerts', facts, sections, recipients: c.recipients, c,
    intro: `Checks for ${ctx.until}. Warranty alerts cover assets reaching ${c.warrantyDays.join(' / ')} days before expiry.`
  });

  // Let event rules act on individual items (scheduled runs only, so "Run now" can't double-fire them).
  if (!ctx.manual) {
    let fired = 0;
    for (const w of d.warranty) {
      for (const r of w.rows) {
        if (fired++ >= 500) break;
        automation.fire('warranty.expiring', () => automation.assetPayload(r.id, { days_left: w.days }));
      }
    }
    for (const s of d.lowStock) {
      automation.fire('low_stock', { location: s.location, category: c.lowStockCategory, in_stock: s.in_stock, threshold: c.lowStockThreshold });
    }
  }
  return `${counts}. Delivery: ${delivery}`;
}

// ───────────────────────────── weekly summary ─────────────────────────────

async function runWeekly() {
  const c = await getConfig();
  const [fleet, activity, warranty, cats, leavers, lowStock] = await Promise.all([
    db.get(`SELECT COUNT(*) FILTER (WHERE status <> 'archived')::int AS active, COUNT(*) FILTER (WHERE status = 'assigned')::int AS deployed,
                   COUNT(*) FILTER (WHERE status = 'available')::int AS in_stock, COUNT(*) FILTER (WHERE status = 'archived')::int AS retired
              FROM assets WHERE deleted_at IS NULL`),
    db.get(`SELECT (SELECT COUNT(*) FROM assets WHERE created_at >= now() - INTERVAL '7 days' AND deleted_at IS NULL)::int AS added,
                   (SELECT COUNT(*) FROM assets WHERE deleted_at >= now() - INTERVAL '7 days')::int AS deleted,
                   (SELECT COUNT(*) FROM assignments WHERE assigned_at >= now() - INTERVAL '7 days')::int AS checked_out,
                   (SELECT COUNT(*) FROM assignments WHERE returned_at >= now() - INTERVAL '7 days')::int AS checked_in,
                   (SELECT COUNT(*) FROM asset_requests WHERE created_at >= now() - INTERVAL '7 days' AND deleted_at IS NULL)::int AS requests`),
    db.get(`SELECT COUNT(*) FILTER (WHERE warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + 90)::int AS next_90,
                   COUNT(*) FILTER (WHERE warranty_expiry < CURRENT_DATE AND status = 'assigned')::int AS expired_in_use
              FROM assets WHERE deleted_at IS NULL AND status <> 'archived'`),
    db.query(`SELECT COALESCE(c.name, a.category, 'Uncategorised') AS category,
                     COUNT(*) FILTER (WHERE a.status = 'assigned')::int AS deployed, COUNT(*) FILTER (WHERE a.status = 'available')::int AS in_stock
                FROM assets a LEFT JOIN asset_categories c ON c.id = a.category_id
               WHERE a.deleted_at IS NULL AND a.status <> 'archived'
               GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 8`),
    leaversHoldingDevices(), lowStockSites(c)
  ]);
  const facts = [
    ['Active assets', n(fleet.active)], ['Deployed', n(fleet.deployed)], ['In stock', n(fleet.in_stock)],
    ['Added this week', n(activity.added)], ['Checked out / returned', `${n(activity.checked_out)} / ${n(activity.checked_in)}`],
    ['Warranties ending in 90 days', n(warranty.next_90)], ['Deployed & out of warranty', n(warranty.expired_in_use)],
    ['Leavers holding devices', n(leavers.length)],
    ...(c.lowStockThreshold ? [[`Sites low on spare ${c.lowStockCategory.toLowerCase()}s`, n(lowStock.length)]] : [])
  ];
  const sections = [
    { title: 'Fleet by category', count: cats.length, columns: ['Category', 'Deployed', 'In stock'],
      rows: cats.map(r => [e(r.category), n(r.deployed), n(r.in_stock)]), textRows: cats.map(r => `${r.category}: ${r.deployed} deployed, ${r.in_stock} in stock`) },
    { title: 'This week', count: activity.added + activity.checked_out + activity.checked_in + activity.deleted + activity.requests,
      columns: ['Activity', 'Count'],
      rows: [['Assets added', n(activity.added)], ['Check-outs', n(activity.checked_out)], ['Returns', n(activity.checked_in)], ['Assets deleted', n(activity.deleted)], ['Asset requests', n(activity.requests)]],
      textRows: [`Added ${activity.added}, check-outs ${activity.checked_out}, returns ${activity.checked_in}, deleted ${activity.deleted}, requests ${activity.requests}`] },
    { title: 'Leavers still holding devices', count: leavers.length, columns: ['Asset', 'Employee', 'Status'],
      rows: leavers.map(r => [assetLink(r), e(r.holder), e(r.holder_status)]), textRows: leavers.map(r => `${r.asset_tag} · ${r.holder}`) }
  ];
  if (c.lowStockThreshold) {
    sections.push({ title: `Low spare ${c.lowStockCategory.toLowerCase()} stock`, count: lowStock.length, columns: ['Location', 'In stock', 'Deployed'],
      rows: lowStock.map(r => [e(r.location), n(r.in_stock), n(r.deployed)]), textRows: lowStock.map(r => `${r.location}: ${r.in_stock} in stock`) });
  }
  const delivery = await deliver({
    kind: 'weekly_summary', subject: 'IT-HAMS weekly summary', title: 'Weekly IT asset summary', facts, sections,
    recipients: c.summaryRecipients.length ? c.summaryRecipients : c.recipients, c,
    intro: `Week ending ${new Date().toISOString().slice(0, 10)}: ${n(fleet.active)} active assets, ${n(fleet.deployed)} deployed, ${n(fleet.in_stock)} in stock.`
  });
  return `${facts.map(([k, v]) => `${k}: ${v}`).join(', ')}. Delivery: ${delivery}`;
}

module.exports = { DEFAULTS, getConfig, buildDaily, runDaily, runWeekly, deliver, renderHtml, renderText };
