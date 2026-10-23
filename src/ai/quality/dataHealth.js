// Data-health scan: scores every active asset 0-100 with plain-language reasons (rules.js),
// scores each module (Hardware, Catalog, People, Procurement) and each location, lists catalog
// findings, and proposes grouped fixes for the AI Approvals inbox (fixes.js).
// Reads the existing tables; writes only ai_dq_runs, ai_dq_issues, ai_predictions and
// ai_recommendations. The category check runs in a worker thread.
const db = require('../../core/db');
const worker = require('../worker');
const rules = require('./rules');
const catalog = require('./catalog');
const { famsNumber, hostname, sharedValues } = require('./duplicates');
const { serialKey } = require('../models/text/tokenize');

const LOCK_KEY = 70415;
const dateStr = 'YYYY-MM-DD';

async function loadAssets(q) {
  return q.query(`
    SELECT a.id, a.asset_tag, a.name, a.model_number, a.serial_number, a.status, a.assigned_to, a.stock_site,
           a.category_id::text, a.manufacturer_id::text, a.supplier_id::text, a.location_id, a.asset_model_id::text,
           a.procurement_id, a.purchase_cost::float8 AS purchase_cost,
           to_char(a.purchase_date, '${dateStr}') AS purchase_date, to_char(a.warranty_expiry, '${dateStr}') AS warranty_expiry,
           am.name AS model_name, l.name AS location_name, sl.name AS label_name, sl.type AS label_type,
           a.custom_fields_data->>'Machine Name' AS machine_name,
           a.custom_fields_data->>'FAMS No. / Barcode' AS fams,
           a.custom_fields_data->>'Client Provided Asset' AS client_provided,
           a.custom_fields_data->>'PO #' AS po_number,
           substring(a.custom_fields_data->>'Warranty Start Date' from '^\\d{4}-\\d{2}-\\d{2}') AS warranty_start
      FROM assets a
      LEFT JOIN asset_models am ON am.id = a.asset_model_id
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN status_labels sl ON sl.id = a.status_label_id
     WHERE a.deleted_at IS NULL`);
}

const isActive = r => r.status !== 'archived' && r.label_type !== 'archived';

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Fleet-wide facts the rules compare against.
function buildContext(rows, { oof = [], models = [], categories = [] }) {
  const catNames = new Map(categories.map(c => [String(c.id), c.name]));
  const byModel = new Map();
  for (const r of rows) {
    if (!r.asset_model_id) continue;
    if (!byModel.has(r.asset_model_id)) byModel.set(r.asset_model_id, { cats: new Map(), costs: [] });
    const m = byModel.get(r.asset_model_id);
    if (r.category_id) m.cats.set(r.category_id, (m.cats.get(r.category_id) || 0) + 1);
    if (r.purchase_cost > 0) m.costs.push(r.purchase_cost);
  }
  const modelMajority = new Map(), modelCost = new Map();
  for (const [id, m] of byModel) {
    const total = [...m.cats.values()].reduce((a, b) => a + b, 0);
    const [category_id, count] = [...m.cats].sort((a, b) => b[1] - a[1])[0] || [];
    // Only a clear majority (80%+ of 5+ assets) says what the model "is".
    if (total >= 5 && count / total >= 0.8) modelMajority.set(id, { category_id, count, total, share: count / total });
    if (m.costs.length >= 3) {
      const s = m.costs.sort((a, b) => a - b);
      modelCost.set(id, { n: s.length, median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75) });
    }
  }
  const variantOf = new Map();
  const variants = catalog.modelVariants(models);
  for (const g of variants) for (const id of g.ids) variantOf.set(id, g.names.filter((_, i) => g.ids[i] !== id).join('", "'));
  return {
    tagOf: new Map(rows.map(r => [r.id, r.asset_tag])),
    serialShared: sharedValues(rows.filter(r => serialKey(r.serial_number).length >= 4), r => serialKey(r.serial_number)),
    famsShared: sharedValues(rows, r => famsNumber(r.fams)),
    hostShared: sharedValues(rows.filter(isActive), r => hostname(r.machine_name)),
    modelMajority, modelCost, variantOf, variants,
    oof: new Map(oof.map(o => [o.id, o])),
    catName: id => catNames.get(String(id)) || 'an unknown category'
  };
}

const ratio = (ok, total) => ({ ok: Number(ok), total: Number(total) });
const moduleScore = checks => {
  const used = checks.filter(c => c.total > 0);
  return used.length ? Math.round(used.reduce((s, c) => s + c.ok / c.total, 0) / used.length * 100) : null;
};

async function moduleScores(q, scored, ctx, models) {
  const people = await q.get(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE COALESCE(name, '') <> '' AND name IS DISTINCT FROM employee_id) AS named,
           COUNT(*) FILTER (WHERE email LIKE '%@%' AND email NOT LIKE '%.invalid') AS emailed,
           COUNT(*) FILTER (WHERE department_id IS NOT NULL) AS dept,
           COUNT(*) FILTER (WHERE location_id IS NOT NULL) AS located
      FROM users WHERE deleted_at IS NULL AND role <> 'super_admin'`);
  const po = await q.get(`
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE vendor_id IS NOT NULL) AS vendor,
           COUNT(*) FILTER (WHERE total_amount > 0) AS amount,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM assets a WHERE a.procurement_id = p.id AND a.deleted_at IS NULL)) AS linked
      FROM procurement_records p WHERE p.deleted_at IS NULL`);
  const withMajority = models.filter(m => ctx.modelMajority.has(String(m.id)));
  const hw = scored.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length) : null;
  const catalogChecks = [
    { label: 'Models filed under the category their assets use', ...ratio(withMajority.filter(m => String(m.category_id) === ctx.modelMajority.get(String(m.id)).category_id).length, withMajority.length) },
    { label: 'Models without a duplicate spelling', ...ratio(models.length - [...ctx.variantOf.keys()].length, models.length) },
    { label: 'Models with an end-of-life period', ...ratio(models.filter(m => m.eol_months).length, models.length) }
  ];
  const peopleChecks = [
    { label: 'Employees with a real name (not just the CTID)', ...ratio(people.named, people.total) },
    { label: 'Employees with an email address', ...ratio(people.emailed, people.total) },
    { label: 'Employees with a department', ...ratio(people.dept, people.total) },
    { label: 'Employees with a location', ...ratio(people.located, people.total) }
  ];
  const poChecks = [
    { label: 'Purchase orders with a vendor', ...ratio(po.vendor, po.total) },
    { label: 'Purchase orders with an amount', ...ratio(po.amount, po.total) },
    { label: 'Purchase orders linked to assets', ...ratio(po.linked, po.total) },
    { label: 'Active assets linked to a purchase order', ...ratio(scored.filter(s => !s.issues.some(i => i.code === 'missing_po')).length, scored.length) }
  ];
  return [
    { module: 'Hardware', score: hw, checks: [{ label: 'Active assets with no data issue', ...ratio(scored.filter(s => !s.issues.length).length, scored.length) }] },
    { module: 'Catalog', score: moduleScore(catalogChecks), checks: catalogChecks },
    { module: 'People', score: moduleScore(peopleChecks), checks: peopleChecks },
    { module: 'Procurement', score: moduleScore(poChecks), checks: poChecks }
  ];
}

async function insertJson(t, sql, rows, chunk = 4000) {
  for (let i = 0; i < rows.length; i += chunk) await t.run(sql, [JSON.stringify(rows.slice(i, i + chunk))]);
}

// The category model's temperature: from the active intake model when there is one.
async function categoryTemperature() {
  try {
    const IntakeClassifier = require('../intake/classifier');
    const m = await IntakeClassifier.load();
    const h = m && m.params.heads.category;
    if (h && h.kind === 'logreg') return h.params.temperature;
  } catch (_) { /* no model yet */ }
  return 0.35;
}

// Everything the scan finds, without writing anything (q: db or a read-only transaction).
async function analyse(q, { temperature = null } = {}) {
  const rows = await loadAssets(q);
  const models = await q.query('SELECT id, name, model_number, manufacturer_id, category_id, eol_months FROM asset_models WHERE deleted_at IS NULL');
  const categories = await q.query('SELECT id, name FROM asset_categories');
  const suppliers = await q.query('SELECT id, name FROM suppliers WHERE deleted_at IS NULL');
  const oof = await worker.run('categoryOutOfFold', {
    rows: rows.map(r => ({ id: r.id, name: r.name || '', model_number: r.model_number || '', serial_number: r.serial_number || '', category_id: r.category_id })),
    temperature: temperature ?? await categoryTemperature(), minP: 0.8
  });
  const ctx = buildContext(rows, { oof, models, categories });

  const active = rows.filter(isActive);
  const scored = active.map(r => ({ row: r, ...rules.evaluate(r, ctx) }));
  const issueCounts = {};
  for (const s of scored) for (const i of s.issues) issueCounts[i.code] = (issueCounts[i.code] || 0) + 1;
  const byLoc = new Map();
  for (const s of scored) {
    const k = s.row.location_name || '(no location)';
    if (!byLoc.has(k)) byLoc.set(k, { location: k, location_id: s.row.location_id, assets: 0, total: 0, issues: 0 });
    const b = byLoc.get(k);
    b.assets++; b.total += s.score; b.issues += s.issues.length;
  }
  const byLocation = [...byLoc.values()].map(b => ({ location: b.location, location_id: b.location_id, assets: b.assets, avg_score: Math.round(b.total / b.assets * 10) / 10, issues: b.issues }))
    .sort((a, b) => a.avg_score - b.avg_score);
  const modules = await moduleScores(q, scored, ctx, models);
  const catNames = Object.fromEntries(categories.map(c => [String(c.id), c.name]));
  const findings = {
    model_variants: ctx.variants,
    model_category_fixes: catalog.modelCategoryFixes(models, ctx.modelMajority).map(f => ({ ...f, from_name: catNames[f.from], to_name: catNames[f.to] })),
    supplier_groups: catalog.supplierGroups(suppliers)
  };
  const avg = scored.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length * 10) / 10 : null;
  return { rows, scored, ctx, issueCounts, byLocation, modules, findings, catNames, avg };
}

async function run({ trigger = 'schedule' } = {}) {
  const t0 = Date.now();
  // Session lock on one dedicated connection (a pooled query could unlock on another connection).
  const lockClient = await db.pool.connect();
  const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0];
  if (!got.ok) { lockClient.release(); return { skipped: true, summary: 'Skipped: a data-health scan is already running.' }; }
  try {
    const { scored, ctx, issueCounts, byLocation, modules, findings, catNames, avg } = await analyse(db);

    const runId = await db.tx(async t => {
      const id = await t.insert(
        `INSERT INTO ai_dq_runs (trigger, assets, avg_score, issues, by_location, modules, catalog, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [trigger, scored.length, avg, JSON.stringify(issueCounts), JSON.stringify(byLocation), JSON.stringify(modules), JSON.stringify(findings), Date.now() - t0]);
      await t.run('DELETE FROM ai_dq_issues');
      await insertJson(t, `INSERT INTO ai_dq_issues (asset_id, code, severity, confidence, detail, data, run_id)
        SELECT asset_id, code, severity, confidence, detail, data, run_id FROM jsonb_to_recordset($1::jsonb)
          AS x(asset_id int, code text, severity text, confidence numeric, detail text, data jsonb, run_id int)`,
        scored.flatMap(s => s.issues.map(i => ({ asset_id: s.row.id, code: i.code, severity: i.severity, confidence: Math.round(i.confidence * 1000) / 1000, detail: i.detail, data: i.data, run_id: id }))));
      await t.run(`DELETE FROM ai_predictions WHERE capability = 'data_quality'`);
      await insertJson(t, `INSERT INTO ai_predictions (asset_id, capability, score, confidence, label, factors, model_name)
        SELECT asset_id, 'data_quality', score, 1, label, factors, 'data_health_rules' FROM jsonb_to_recordset($1::jsonb)
          AS x(asset_id int, score numeric, label text, factors jsonb)`,
        scored.map(s => ({ asset_id: s.row.id, score: s.score, label: rules.grade(s.score),
          factors: s.issues.sort((a, b) => rules.WEIGHT[b.severity] - rules.WEIGHT[a.severity]).slice(0, 5).map(i => ({ code: i.code, severity: i.severity, text: i.detail })) })));
      await t.run('UPDATE ai_dq_runs SET duration_ms = $2 WHERE id = $1', [id, Date.now() - t0]);
      return id;
    });

    const proposed = await require('./fixes').proposeAll({ scored, ctx, findings, catNames, runId });
    const ms = Date.now() - t0;
    const top = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${rules.BY_CODE.get(k).label.toLowerCase()}`).join(', ');
    return {
      runId, trigger, assets: scored.length, avg, issues: issueCounts, proposed, ms,
      summary: `Data health (${trigger}): ${scored.length} active assets, average score ${avg}; ${top || 'no issues'}; ${proposed.new} new recommendation(s); ${(ms / 1000).toFixed(1)} s.`
    };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

// Latest run (for the dashboard card, Settings > AI and the Data Health page).
async function latest() {
  return db.get('SELECT * FROM ai_dq_runs ORDER BY run_at DESC, id DESC LIMIT 1');
}

async function previous(beforeId) {
  return db.get('SELECT id, run_at, avg_score, issues FROM ai_dq_runs WHERE id < $1 ORDER BY id DESC LIMIT 1', [beforeId]);
}

module.exports = { run, analyse, latest, previous, loadAssets, buildContext, isActive };
