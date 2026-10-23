// Refresh risk and unusual assets, measured on the register (read-only).
//
// Refresh risk. Retirement dates are not recorded, so the model can only be checked on what is known:
// for 20% of assets held out (by id), whether each was already retired at its age. Reported against
// simpler curves (overall rate, isotonic age curve, single-shape Weibull): Brier score (lower is
// better), AUC, calibration error and the reliability table. Then the forward-looking check that is
// possible today: the model's 12-month risk at each age next to what the register's own cross-section
// implies ((F(a+1) - F(a)) / (1 - F(a)) from the isotonic curve). That comparison assumes a laptop bought
// this year will be treated at each age like older ones were; the M1 snapshots will test it for real.
//
// Unusual assets. Detection of corrupted copies of real assets (objective), and the top findings, for
// review by people (the Alerts page records those reviews).
const db = require('../../core/db');
const assetRows = require('../features/assetRows');
const risk = require('../lifecycle/risk');
const detect = require('../anomaly/detect');
const { WeibullRisk, isotonicCurve } = require('../models/weibullRisk');

async function load() {
  return db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return assetRows.load(t); });
}

async function lifecycle(rows = null) {
  rows = rows || await load();
  const now = Date.now();
  const t0 = Date.now();
  const { params, metrics } = risk.trainParams({ rows, now });
  const ms = Date.now() - t0;
  const model = WeibullRisk.fromJSON(params);
  const train = risk.trainingRows(rows, now);
  const ages = [3, 4, 4.5, 5, 5.5, 6, 7, 8];
  const forward = {};
  for (const s of Object.keys(params.strata)) {
    const rs = train.filter(r => r.stratum === s);
    const iso = isotonicCurve(rs);
    forward[s] = ages.map(a => {
      const near = rs.filter(r => !r.event && Math.abs(r.age - a) < 0.25);
      return {
        age: a, active_near: near.length,
        model: near.length ? near.reduce((x, r) => x + model.risk(r, 1), 0) / near.length : null,
        cross_section: iso(a) < 1 ? (iso(a + 1) - iso(a)) / (1 - iso(a)) : null
      };
    });
  }
  let expected = 0, scored = 0, high = 0;
  const byCat = {};
  for (const r of rows) {
    if (r.deleted || r.is_retired) continue;
    const d = risk.describe(model, r, now);
    if (d.skip) continue;
    scored++; expected += d.risk12; if (d.label === 'high') high++;
    const c = byCat[d.category] || (byCat[d.category] = { n: 0, expected: 0 });
    c.n++; c.expected += d.risk12;
  }
  return { metrics, forward, scored, expected, high, byCat, ms, strata: Object.fromEntries(Object.entries(params.strata).map(([s, m]) => [s, { k: m.k, c: m.c, knots: m.knots, beta: m.beta, median: model.medianAge({ stratum: s, feats: [] }) }])) };
}

function formatLifecycle(r) {
  const p = x => (x === null || x === undefined ? '  -  ' : (x * 100).toFixed(1).padStart(5) + '%');
  const lines = [`Refresh risk: trained in ${(r.ms / 1000).toFixed(1)} s; held-out assets ${r.metrics.test_assets}. Overall Brier ${r.metrics.brier.toFixed(4)} (single-shape Weibull ${r.metrics.weibull_one_shape_brier.toFixed(4)}), AUC ${r.metrics.auc.toFixed(3)}, calibration error ${r.metrics.ece.toFixed(4)}.`];
  for (const [s, m] of Object.entries(r.metrics.strata)) {
    const st = r.strata[s];
    lines.push('', `${s}: ${m.assets} assets, ${m.retired} retired; held out ${m.test}. Half retired by ${st.median ? st.median.toFixed(1) + ' years' : '-'}.`);
    lines.push(`  Brier: model ${m.brier.toFixed(4)} | isotonic age curve ${m.baseline.age_curve_isotonic.toFixed(4)} | single-shape Weibull ${m.baseline.weibull_one_shape.toFixed(4)} | overall rate ${m.baseline.overall_rate.toFixed(4)}.  AUC ${m.auc === null ? '-' : m.auc.toFixed(3)}, calibration error ${m.ece.toFixed(4)}`);
    lines.push('  Covariates (risk multiplier at the same age): ' + (Object.entries(st.beta).map(([f, b]) => `${risk.FACTORS[f] || f} ×${Math.exp(b).toFixed(2)}`).join('; ') || 'none'));
    lines.push('  Reliability (held out): ' + m.reliability.filter(b => b.n).map(b => `${b.bin} n=${b.n} predicted ${p(b.predicted)} observed ${p(b.observed)}`).join(' | '));
    lines.push('  12-month risk of active assets by age, model vs the register\'s cross-section: ' + r.forward[s].filter(f => f.active_near).map(f => `${f.age}y ${p(f.model)} vs ${p(f.cross_section)} (n ${f.active_near})`).join(' | '));
  }
  lines.push('', `Scored ${r.scored} active assets: about ${Math.round(r.expected)} expected to be retired in the next 12 months, ${r.high} at high risk (50%+). `
    + Object.entries(r.byCat).map(([c, v]) => `${c} ~${Math.round(v.expected)} of ${v.n}`).join(', ') + '.');
  return lines.join('\n');
}

async function anomaly(rows = null) {
  rows = rows || await load();
  const t0 = Date.now();
  const out = detect.scoreAll({ rows, now: Date.now() });
  const byId = new Map(rows.map(r => [r.id, r]));
  const flagged = out.results.filter(r => r.flagged).sort((a, b) => b.score - a.score);
  return { ...out.metrics, ms: Date.now() - t0, top: flagged.slice(0, 40).map(f => ({ ...f, row: byId.get(f.id) })) };
}

function formatAnomaly(r) {
  const lines = [`Unusual assets: ${r.flagged} of ${r.assets} active assets flagged (score ${r.threshold.toFixed(3)}+), ${(r.ms / 1000).toFixed(1)} s.`,
    `Detection of corrupted copies of real assets (300 copies vs a 20% sample of real assets): AUC ${r.injected_auc.toFixed(3)}.`,
    '  ' + Object.entries(r.injected_by_kind).map(([k, v]) => `${k}: ${v.toFixed(3)}`).join(' | '), '', 'Top findings:'];
  for (const f of r.top) {
    const a = f.row;
    lines.push(`  ${f.score.toFixed(3)} ${a.asset_tag} | ${a.category} | ${a.model || '-'} | ${a.holder || '-'} | ${f.factors.map(x => x.text).join('; ')}`);
  }
  return lines.join('\n');
}

module.exports = { lifecycle, formatLifecycle, anomaly, formatAnomaly, load };
