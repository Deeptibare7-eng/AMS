// Refresh risk job (ai_lifecycle) and what the pages read.
//   - Retrains weekly (or on "Run now") in a worker, saves the version in the model registry and
//     activates it unless it scores clearly worse on held-out assets than the active one.
//   - Scores every active asset daily with the active version into ai_predictions (capability
//     'lifecycle'): 12-month risk 0-100, confidence, level and reasons.
// Reads existing tables only; writes ai_models and ai_predictions.
const db = require('../../core/db');
const authz = require('../../services/authorizationService');
const worker = require('../worker');
const registry = require('../governance/registry');
const assetRows = require('../features/assetRows');
const { WeibullRisk } = require('../models/weibullRisk');
const risk = require('./risk');

const RETRAIN_DAYS = 7;
const AGE_BANDS = [[0, 3, 'under 3 y'], [3, 4, '3–4 y'], [4, 5, '4–5 y'], [5, 6, '5–6 y'], [6, 8, '6–8 y'], [8, Infinity, '8 y +']];

let cached = { version: null, model: null, at: 0 };
async function activeModel() {
  if (Date.now() - cached.at < 60000) return cached.model;
  const m = await WeibullRisk.load();
  cached = { version: m ? m.version : null, model: m, at: Date.now() };
  return m;
}
function invalidate() { cached = { version: null, model: null, at: 0 }; }

async function train({ trigger = 'schedule', user = null, rows = null } = {}) {
  const t0 = Date.now();
  rows = rows || await db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return assetRows.load(t); });
  const { params, metrics } = await worker.run('trainLifecycle', { rows, now: Date.now() });
  if (!Object.keys(params.strata).length) return { skipped: true, summary: 'Not trained: no category has 50+ retirements and 200+ assets yet.' };
  const model = WeibullRisk.fromJSON(params);
  const version = await registry.save(model, {
    metrics: { brier: metrics.brier, auc: metrics.auc, ece: metrics.ece, weibull_one_shape_brier: metrics.weibull_one_shape_brier },
    userId: user ? user.id : null,
    training: { trigger, validation: '20% of assets held out (by id), current status', strata: metrics.strata, test_assets: metrics.test_assets, ms: Date.now() - t0 }
  });
  const active = (await registry.list(WeibullRisk.modelName)).find(r => r.status === 'active');
  const ok = !active || !active.metrics || metrics.brier <= active.metrics.brier + 0.005;
  if (ok) await registry.activate(WeibullRisk.modelName, version, user);
  invalidate();
  return { version, activated: ok, metrics };
}

async function run({ trigger = 'schedule', user = null } = {}) {
  const t0 = Date.now();
  const rows = await db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return assetRows.load(t); });
  const last = (await registry.list(WeibullRisk.modelName)).find(r => r.status === 'active');
  let trained = null;
  if (!last || trigger === 'manual' || Date.now() - new Date(last.trained_at).getTime() > RETRAIN_DAYS * 864e5) {
    trained = await train({ trigger, user, rows });
    if (trained.skipped) return trained;
  }
  const model = await activeModel();
  const now = Date.now();
  const scored = [];
  for (const r of rows) {
    if (r.deleted || r.is_retired) continue;
    const d = risk.describe(model, r, now);
    if (d.skip) continue;
    // Cumulative risk at the end of each of the next 8 quarters (for the cost forecast).
    const row = risk.scoringRow(r, model, now);
    const riskQ = [1, 2, 3, 4, 5, 6, 7, 8].map(q => Math.round(model.risk(row, q / 4) * 10000) / 10000);
    scored.push({ asset_id: r.id, score: Math.round(d.risk12 * 100000) / 1000, confidence: Math.round(d.confidence * 1000) / 1000, label: d.label,
      factors: { risk6: d.risk6, risk12: d.risk12, risk24: d.risk24, risk_q: riskQ, age: d.age, median_age: d.median_age, category: d.category, why: d.why } });
  }
  await db.tx(async t => {
    await t.run(`DELETE FROM ai_predictions WHERE capability = 'lifecycle'`);
    for (let i = 0; i < scored.length; i += 4000) {
      await t.run(`INSERT INTO ai_predictions (asset_id, capability, score, confidence, label, factors, model_name, model_version)
        SELECT asset_id, 'lifecycle', score, confidence, label, factors, $2, $3 FROM jsonb_to_recordset($1::jsonb)
          AS x(asset_id int, score numeric, confidence numeric, label text, factors jsonb)`,
        [JSON.stringify(scored.slice(i, i + 4000)), WeibullRisk.modelName, model.version]);
    }
  });
  require('../cost/forecast').invalidate(); // the cost forecast is built from these scores
  const expected = scored.reduce((s, x) => s + x.factors.risk12, 0);
  const high = scored.filter(x => x.label === 'high').length;
  const m = trained ? trained.metrics : (last && last.metrics) || {};
  return {
    scored: scored.length, expected12: expected, high, trained,
    summary: `Refresh risk v${model.version}${trained ? (trained.activated ? ' (retrained)' : ' (retrained, kept the active version)') : ''}: ${scored.length} active assets scored; `
      + `about ${Math.round(expected)} expected to be retired in the next 12 months, ${high} at high risk (50%+). `
      + (m.brier !== undefined ? `Held-out Brier ${m.brier.toFixed(3)}, AUC ${m.auc.toFixed(2)}. ` : '') + `${((Date.now() - t0) / 1000).toFixed(1)} s.`
  };
}

// The asset page card: computed now from the active model, so new and edited assets are covered.
async function forAsset(assetId) {
  const model = await activeModel();
  if (!model) return { ready: false };
  const [r] = await assetRows.load(db, 'a.id = $1', [assetId]);
  if (!r) return null;
  const d = risk.describe(model, r);
  return { ready: true, model_version: model.version, ...d };
}

// Dashboard: expected retirements in 12 months by Asset Location x age band, within the user's scope.
async function summary(user) {
  const scope = await authz.locationScopeFor(user);
  const params = [];
  let where = `p.capability = 'lifecycle' AND a.deleted_at IS NULL`;
  if (!scope.global) { params.push(scope.location_ids); where += ` AND a.location_id = ANY($1::int[])`; }
  const rows = await db.query(
    `SELECT COALESCE(l.name, 'No location') AS location, (p.factors->>'age')::float8 AS age, (p.factors->>'risk12')::float8 AS r12,
            p.factors->>'category' AS category, p.label, p.computed_at
       FROM ai_predictions p JOIN assets a ON a.id = p.asset_id LEFT JOIN locations l ON l.id = a.location_id WHERE ${where}`, params);
  if (!rows.length) return { ready: false };
  const band = age => AGE_BANDS.findIndex(([lo, hi]) => age >= lo && age < hi);
  const byLoc = new Map();
  for (const r of rows) {
    if (!byLoc.has(r.location)) byLoc.set(r.location, { location: r.location, n: 0, expected: 0, cells: AGE_BANDS.map(() => ({ n: 0, expected: 0 })) });
    const L = byLoc.get(r.location);
    const c = L.cells[Math.max(0, band(r.age))];
    L.n++; L.expected += r.r12; c.n++; c.expected += r.r12;
  }
  const locations = [...byLoc.values()].sort((a, b) => b.expected - a.expected);
  const top = locations.slice(0, 10);
  if (locations.length > 10) {
    const other = { location: `Other ${locations.length - 10} locations`, n: 0, expected: 0, cells: AGE_BANDS.map(() => ({ n: 0, expected: 0 })) };
    for (const L of locations.slice(10)) { other.n += L.n; other.expected += L.expected; L.cells.forEach((c, i) => { other.cells[i].n += c.n; other.cells[i].expected += c.expected; }); }
    top.push(other);
  }
  const byCat = new Map();
  for (const r of rows) { const c = byCat.get(r.category) || { category: r.category, n: 0, expected: 0, high: 0 }; c.n++; c.expected += r.r12; if (r.label === 'high') c.high++; byCat.set(r.category, c); }
  return {
    ready: true, assets: rows.length, expected: rows.reduce((s, r) => s + r.r12, 0), high: rows.filter(r => r.label === 'high').length,
    bands: AGE_BANDS.map(b => b[2]), locations: top, categories: [...byCat.values()].sort((a, b) => b.expected - a.expected),
    computed_at: rows[0].computed_at, model_version: (await activeModel() || {}).version || null
  };
}

module.exports = { run, train, forAsset, summary, activeModel, invalidate, AGE_BANDS };
