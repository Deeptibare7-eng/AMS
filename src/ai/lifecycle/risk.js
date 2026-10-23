// Refresh risk: which assets are modelled, their covariates, training (in a worker) and the
// plain-language reasons. The model itself is models/weibullRisk.js.
//
// What counts as a refresh: retirement with any reason except Lost, Absconding and Returned to Client
// (those assets leave for other reasons and are left out of training). Client-provided assets go back
// to the client, so they are not scored. One curve per category; a category needs 50+ retirements
// (so VMs, never retired in this register, get no score).
//
// Covariates describe the machine, not its purchase year: with one snapshot, asset model and purchase
// year can't be told apart from age, and a model's "kept longer so far" would really mean "its refresh
// hasn't come yet" (measured: docs/ai/MODELS.md).
const { WeibullRisk, evaluateProbabilities, isotonicCurve } = require('../models/weibullRisk');
const { cpuOf } = require('../../services/stockSiteService');
const { ageYears } = require('../features/assetRows');

const NOT_REFRESH = /lost|abscond|returned to client/i;
// Machine traits that can only make a refresh likelier (see WeibullRisk.train `positive`).
const POSITIVE = ['cpu_pre_win11', 'ram_le_8'];
const HORIZONS = { risk6: 0.5, risk12: 1, risk24: 2 };

const FACTORS = {
  cpu_pre_win11: 'Processor too old for Windows 11 (Intel 7th gen or earlier)',
  ram_le_8: '8 GB RAM or less',
  warranty_4y_plus: 'Warranty of 4 years or more',
  warranty_under_3y: 'Warranty under 3 years'
};

function features(r) {
  const out = [];
  const g = cpuOf(r.cpu).gen; // 0 = not recorded: a gap in the data, not a reason to refresh
  if (g && g <= 7) out.push('cpu_pre_win11');
  if (r.ram_gb && r.ram_gb <= 8) out.push('ram_le_8');
  if (r.purchase_date && r.warranty_expiry) {
    const term = (Date.parse(r.warranty_expiry) - Date.parse(r.purchase_date)) / (365.25 * 864e5);
    if (term >= 3.75) out.push('warranty_4y_plus');
    if (term < 2.75) out.push('warranty_under_3y');
  }
  return out;
}

// Training rows: every asset with a purchase date, retired or not (current status).
function trainingRows(rows, now = Date.now()) {
  const out = [];
  for (const r of rows) {
    if (r.deleted || r.client_provided || !r.purchase_date || !r.category) continue;
    if (r.is_retired && NOT_REFRESH.test(r.retired_reason || '')) continue;
    const age = ageYears(r.purchase_date, now);
    if (age < 0) continue;
    out.push({ id: r.id, stratum: r.category, age, event: !!r.is_retired, feats: features(r) });
  }
  return out;
}

// The row to score for an active asset, or { skip: reason }.
function scoringRow(r, model, now = Date.now()) {
  if (r.is_retired) return { skip: 'Retired assets are not scored.' };
  if (r.client_provided) return { skip: 'Client-provided: when it is replaced is up to the client.' };
  if (!r.purchase_date) return { skip: 'No purchase date, so its age is unknown.' };
  if (!model.stratum(r.category)) return { skip: `Not enough retirement history for ${r.category || 'this category'} to estimate a refresh risk.` };
  return { stratum: r.category, age: Math.max(0, ageYears(r.purchase_date, now)), feats: features(r) };
}

// Worker task: fit on 80% of assets (by id), measure on the other 20% against simpler baselines, then
// refit on everything. Returns { params, metrics }.
function trainParams({ rows, now }) {
  const all = trainingRows(rows, now);
  const hold = r => ((r.id * 2654435761) >>> 0) % 10 >= 8;
  const train = all.filter(r => !hold(r)), test = all.filter(hold);
  const noFeats = rs => rs.map(r => ({ ...r, feats: [] }));
  const opts = { positive: POSITIVE };
  const model = new WeibullRisk().train(train, opts);
  const weibull = new WeibullRisk().train(noFeats(train), { knots: [] });
  const strata = {};
  for (const s of Object.keys(model.params.strata)) {
    const te = test.filter(r => r.stratum === s), tr = train.filter(r => r.stratum === s);
    const iso = isotonicCurve(tr);
    const prior = tr.filter(r => r.event).length / tr.length;
    const m = model.evaluate(te);
    strata[s] = {
      assets: all.filter(r => r.stratum === s).length, retired: all.filter(r => r.stratum === s && r.event).length, test: te.length,
      brier: m.brier, logloss: m.logloss, auc: m.auc, ece: m.ece, reliability: m.reliability,
      baseline: {
        overall_rate: evaluateProbabilities(te.map(r => ({ p: prior, y: r.event ? 1 : 0 }))).brier,
        age_curve_isotonic: evaluateProbabilities(te.map(r => ({ p: iso(r.age), y: r.event ? 1 : 0 }))).brier,
        weibull_one_shape: weibull.evaluate(noFeats(te)).brier
      }
    };
  }
  const evalAll = model.evaluate(test.filter(r => model.stratum(r.stratum)));
  const final = new WeibullRisk().train(all, opts);
  // How well each category's curve separated retired from active on held-out assets feeds the confidence.
  for (const [s, m] of Object.entries(final.params.strata)) {
    const auc = strata[s] ? strata[s].auc : null;
    m.quality = auc === null || auc === undefined ? 0.5 : Math.max(0, Math.min(1, (auc - 0.5) / 0.4));
    m.auc = auc;
  }
  return {
    params: final.toJSON(),
    metrics: {
      brier: evalAll.brier, auc: evalAll.auc, ece: evalAll.ece, logloss: evalAll.logloss, test_assets: evalAll.n,
      weibull_one_shape_brier: weibull.evaluate(noFeats(test.filter(r => weibull.stratum(r.stratum)))).brier,
      strata
    }
  };
}

const pct = x => `${Math.round(x * 100)}%`;
const level = r12 => (r12 >= 0.5 ? 'high' : r12 >= 0.2 ? 'medium' : 'low');

// Risk, confidence and reasons for one asset row (from assetRows.load), or { skip }.
function describe(model, r, now = Date.now()) {
  const row = scoringRow(r, model, now);
  if (row.skip) return row;
  const out = { category: row.stratum, age: row.age };
  for (const [k, h] of Object.entries(HORIZONS)) out[k] = model.risk(row, h);
  out.confidence = model.confidence(row);
  out.label = level(out.risk12);
  out.median_age = model.medianAge({ stratum: row.stratum, feats: [] });
  const noun = row.stratum.toLowerCase().endsWith('s') ? row.stratum.toLowerCase() : row.stratum.toLowerCase() + 's';
  const why = [];
  if (out.median_age) {
    why.push(`${row.age.toFixed(1)} years old; half of ${noun} here are retired by ${out.median_age.toFixed(1)} years`);
  } else {
    why.push(`${row.age.toFixed(1)} years old`);
  }
  for (const f of model.explain(row)) {
    why.push(`${FACTORS[f.factor] || f.factor}: such ${noun} are retired ${f.ratio >= 1 ? f.ratio.toFixed(1) + '× as often' : 'less often (×' + f.ratio.toFixed(2) + ')'} at the same age`);
  }
  if (row.age > model.stratum(row.stratum).maxAge) why.push(`Older than any ${row.stratum.toLowerCase()} in the history, so the estimate is less sure`);
  out.why = why;
  out.summary = `${pct(out.risk12)} chance of being retired in the next 12 months`;
  return out;
}

module.exports = { trainingRows, scoringRow, trainParams, describe, features, FACTORS, HORIZONS, NOT_REFRESH, level };
