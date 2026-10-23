// Cost forecast, refresh plan and licence compliance, measured on the register (read-only).
//   - Replacement need per quarter: refresh risk scored in memory (as the nightly job would), times the
//     replacement cost per category.
//   - Spend pace: quarterly purchase-order spend, Holt-Winters and simple rules in a rolling backtest from
//     2023 (one quarter ahead, and the next four quarters' total).
//   - Plans at several budgets: assets chosen, cost (must stay within budget), expected retirements
//     covered, the dynamic programme vs greedy, time taken.
//   - Licence compliance: whether there is data to check.
const db = require('../../core/db');
const assetRows = require('../features/assetRows');
const risk = require('../lifecycle/risk');
const forecast = require('../cost/forecast');
const rules = require('../compliance/rules');
const { WeibullRisk } = require('../models/weibullRisk');
const { HoltWinters, RULES } = require('../models/holtWinters');
const { solve } = require('../models/knapsack');

async function run({ budgets = [5e7, 1e8, 2e8] } = {}) {
  const rows = await db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return assetRows.load(t); });
  const now = Date.now();
  const model = WeibullRisk.fromJSON(risk.trainParams({ rows, now }).params);
  const unit = await forecast.unitCosts();
  const scored = [];
  for (const r of rows) {
    if (r.deleted || r.is_retired) continue;
    const d = risk.describe(model, r, now);
    if (d.skip) continue;
    const row = risk.scoringRow(r, model, now);
    scored.push({ r, d, factors: { category: d.category, risk6: d.risk6, risk12: d.risk12, risk24: d.risk24, risk_q: [1, 2, 3, 4, 5, 6, 7, 8].map(q => model.risk(row, q / 4)) } });
  }
  const need = forecast.aggregateNeed(scored.map(s => s.factors), unit);
  // Spend pace and backtests.
  const series = await forecast.spendSeries();
  const p = forecast.pace(series);
  const from = series.quarters.findIndex(q => q >= '2023-Q1');
  const yearly = {};
  for (const [name, rule] of Object.entries(RULES)) {
    const errs = [];
    for (let t = from; t + 4 <= series.values.length; t++) {
      const hist = series.values.slice(0, t);
      const pred = name === 'holt_winters' ? new HoltWinters().train(hist).forecast(4).reduce((a, f) => a + f.value, 0)
        : name === 'same_quarter_last_year' ? hist.slice(-4).reduce((a, v) => a + v, 0) : 4 * rule(hist, 4);
      errs.push(Math.abs(series.values.slice(t, t + 4).reduce((a, v) => a + v, 0) - pred));
    }
    yearly[name] = errs.reduce((a, e) => a + e, 0) / (errs.length || 1);
  }
  // Plans (in-use assets, 12 months), as Refresh Planning makes them.
  const items = scored.filter(s => s.r.holder_user_id || s.r.label_type === 'deployed')
    .map(s => ({ id: s.r.id, value: s.d.risk12, cost: unit[s.d.category] ? unit[s.d.category].cost : 0, risk: s.d.risk12 })).filter(i => i.cost > 0);
  const plans = budgets.map(b => {
    const t0 = Date.now();
    const res = solve(items, b);
    const chosen = new Set(res.chosen);
    return {
      budget: b, assets: res.chosen.length, cost: res.cost, within: res.cost <= b, ms: Date.now() - t0,
      covered: items.filter(i => chosen.has(i.id)).reduce((s, i) => s + i.risk, 0), expected: items.reduce((s, i) => s + i.risk, 0),
      method: res.method, optimal_value: res.optimal_value, greedy_value: res.greedy_value
    };
  });
  const compliance = await rules.check(null);
  return { scored: scored.length, unit, need, series, pace: p, yearly, plans, compliance: { dormant: compliance.dormant, data: compliance.data, findings: compliance.findings.length }, currency: await forecast.currency() };
}

function format(r) {
  const m = v => forecast.money(v, r.currency);
  const pct = x => (x * 100).toFixed(0) + '%';
  const lines = [`Cost forecast: ${r.scored} active assets scored for refresh risk (in memory).`,
    'Replacement costs: ' + Object.entries(r.unit).map(([c, u]) => `${c} ${m(u.cost)} (${u.basis})`).join('; ') + '.', '',
    'Replacement need by quarter:'];
  for (const q of r.need.quarters) lines.push(`  ${q.label.padEnd(22)} ~${Math.round(q.units).toString().padStart(5)} assets  ${m(q.cost).padStart(10)}   ` + Object.entries(q.by).map(([c, v]) => `${c} ${Math.round(v.units)}`).join(', '));
  lines.push(`  Next 12 months: ~${Math.round(r.need.next12.units)} assets, ${m(r.need.next12.cost)}; next 24 months: ~${Math.round(r.need.next24.units)}, ${m(r.need.next24.cost)}.`, '');
  lines.push(`Purchase-order spend: ${r.series.quarters.length} quarters (${r.series.quarters[0]} to ${r.series.quarters[r.series.quarters.length - 1]}), average ${m(r.pace.quarter_mean)} a quarter; Holt-Winters picks seasonality "${r.pace.model.params.seasonal}", alpha ${r.pace.model.params.alpha}, pace ${m(r.pace.yearly)} a year.`);
  lines.push('Backtest from 2023 (error as a share of the average quarter / of the average four quarters):');
  for (const [k, v] of Object.entries(r.pace.backtest)) lines.push(`  ${k.padEnd(24)} one quarter ahead: MAE ${m(v.mae)} (${pct(v.mae_share)})   next four quarters: MAE ${m(r.yearly[k])} (${pct(r.yearly[k] / (4 * r.pace.quarter_mean))})`);
  lines.push(`  -> ${r.pace.forecastable ? 'forecastable' : 'not forecastable: spending comes in waves, so plan from the replacement need'}.`, '');
  lines.push('Refresh plans (in-use assets, 12 months):');
  for (const pl of r.plans) lines.push(`  budget ${m(pl.budget).padEnd(9)} ${String(pl.assets).padStart(5)} assets for ${m(pl.cost).padEnd(9)} within budget: ${pl.within ? 'yes' : 'NO'}; covers ~${Math.round(pl.covered)} of ~${Math.round(pl.expected)} expected retirements (${pct(pl.covered / pl.expected)}); ${pl.method}, priority ${pl.optimal_value.toFixed(1)} vs greedy ${pl.greedy_value.toFixed(1)}; ${pl.ms} ms`);
  lines.push('', `Licence compliance: ${r.compliance.dormant ? `dormant (${r.compliance.data.licenses} licences, ${r.compliance.data.software} software records)` : `${r.compliance.findings} findings`}.`);
  return lines.join('\n');
}

module.exports = { run, format };
