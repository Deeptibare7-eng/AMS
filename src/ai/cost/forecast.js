// Cost forecast (capability 'cost'): what replacing the assets expected to be retired will cost,
// quarter by quarter, next to the pace of past spending.
//
// Need (the forecast). For every active asset scored by Refresh risk: the chance of being retired in
// each of the next 8 quarters (from its cumulative risk), times the replacement cost of its category.
// Summed: expected replacements and their cost per quarter.
//
// Pace (the baseline). Quarterly hardware spend from purchase orders, with Holt-Winters fitted to it and
// a rolling backtest against simple rules. On this register spend comes in waves (one quarter crores,
// the next a few lakh), so no method predicts a quarter well: the pace is shown as a yearly figure with
// its measured error, and the need is the figure to plan with.
//
// Reads existing tables and ai_predictions; writes nothing except the model registry (job only).
const db = require('../../core/db');
const authz = require('../../services/authorizationService');
const registry = require('../governance/registry');
const { HoltWinters, backtest } = require('../models/holtWinters');

const SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
const CACHE_MS = 10 * 60 * 1000;
let cache = new Map(); // scope key -> { at, value }
function invalidate() { cache = new Map(); }

// The currency the purchase orders are in (most of them), for display.
async function currency() {
  const r = await db.get(`SELECT currency, COUNT(*) AS n FROM procurement_records WHERE deleted_at IS NULL AND currency IS NOT NULL GROUP BY currency ORDER BY n DESC LIMIT 1`);
  const code = r && r.currency ? String(r.currency).toUpperCase() : 'INR';
  return { code, symbol: SYMBOLS[code] || code + ' ' };
}

// "₹20.3 Cr", "₹45.6 L", "₹73,680" (Indian grouping for INR), "$1.2M" otherwise.
function money(v, cur = { code: 'INR', symbol: '₹' }) {
  const x = Number(v) || 0;
  if (cur.code === 'INR') {
    if (Math.abs(x) >= 1e7) return `${cur.symbol}${(x / 1e7).toFixed(1)} Cr`;
    if (Math.abs(x) >= 1e5) return `${cur.symbol}${(x / 1e5).toFixed(1)} L`;
    return cur.symbol + Math.round(x).toLocaleString('en-IN');
  }
  if (Math.abs(x) >= 1e6) return `${cur.symbol}${(x / 1e6).toFixed(1)}M`;
  if (Math.abs(x) >= 1e3) return `${cur.symbol}${(x / 1e3).toFixed(0)}k`;
  return cur.symbol + Math.round(x).toLocaleString('en-IN');
}

// Replacement cost per category: the median priced purchase of the last 24 months when there are 30+
// of them, else of the latest 100 priced purchases; with the basis, so people can judge it.
async function unitCosts() {
  const rows = await db.query(
    `SELECT ac.name AS category, a.purchase_cost::float8 AS cost, to_char(a.purchase_date, 'YYYY-MM') AS month,
            a.purchase_date >= CURRENT_DATE - INTERVAL '24 months' AS recent
       FROM assets a JOIN asset_categories ac ON ac.id = a.category_id
      WHERE a.deleted_at IS NULL AND a.purchase_cost > 0 AND a.purchase_date IS NOT NULL
      ORDER BY ac.name, a.purchase_date DESC`);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.category)) by.set(r.category, []); by.get(r.category).push(r); }
  const med = xs => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const out = {};
  for (const [cat, rs] of by) {
    const recent = rs.filter(r => r.recent);
    if (recent.length >= 30) out[cat] = { cost: med(recent.map(r => r.cost)), n: recent.length, basis: `median of ${recent.length.toLocaleString('en-IN')} purchases in the last 24 months` };
    else {
      const latest = rs.slice(0, 100);
      out[cat] = { cost: med(latest.map(r => r.cost)), n: latest.length, basis: `median of the latest ${latest.length} purchases (${latest[latest.length - 1].month} to ${latest[0].month})` };
    }
  }
  return out;
}

const quarterOf = d => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;

// Quarterly spend from purchase orders, from the start of continuous records (no gap of a year or
// more after it) to the last complete quarter.
async function spendSeries() {
  const rows = await db.query(
    `SELECT date_trunc('quarter', purchase_date)::date AS q, SUM(total_amount)::float8 AS amount
       FROM procurement_records WHERE deleted_at IS NULL AND total_amount > 0 AND purchase_date IS NOT NULL
      GROUP BY 1 ORDER BY 1`);
  if (!rows.length) return { quarters: [], values: [] };
  const amounts = new Map(rows.map(r => [quarterOf(new Date(r.q)), r.amount]));
  const now = new Date();
  const lastComplete = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 - 3, 1));
  const quarters = [];
  for (let d = new Date(rows[0].q); d <= lastComplete; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1))) quarters.push(quarterOf(d));
  let start = 0, empty = 0;
  quarters.forEach((q, i) => { if (amounts.has(q)) { if (empty >= 4) start = i; empty = 0; } else empty++; });
  const qs = quarters.slice(start);
  return { quarters: qs, values: qs.map(q => amounts.get(q) || 0) };
}

// Holt-Winters on the spend series, and how it and simple rules did in a rolling backtest from 2023.
function pace(series) {
  if (series.values.length < 8) return null;
  const model = new HoltWinters().train(series.values);
  const from = Math.max(4, series.quarters.findIndex(q => q >= '2023-Q1'));
  const bt = backtest(series.values, from >= 0 ? from : Math.floor(series.values.length / 2));
  const next4 = model.forecast(4);
  const best = Object.entries(bt).sort((a, b) => a[1].mae - b[1].mae)[0];
  const mean = series.values.reduce((a, v) => a + v, 0) / series.values.length;
  return {
    model, params: model.toJSON(), yearly: next4.reduce((a, f) => a + f.value, 0),
    backtest: bt, best_rule: best[0], quarter_mean: mean,
    forecastable: bt.holt_winters.mae_share !== null && bt.holt_winters.mae_share < 0.5
  };
}

// A user's location scope; no user (a scheduled job) sees every location.
const scopeOf = async user => (user ? authz.locationScopeFor(user) : { global: true, location_ids: [] });

// Expected replacements per quarter from Refresh risk, within the user's locations.
async function need(user, unit) {
  const scope = await scopeOf(user);
  const params = [];
  let where = `p.capability = 'lifecycle' AND a.deleted_at IS NULL`;
  if (!scope.global) { params.push(scope.location_ids); where += ` AND a.location_id = ANY($1::int[])`; }
  const rows = await db.query(`SELECT p.factors, p.computed_at FROM ai_predictions p JOIN assets a ON a.id = p.asset_id WHERE ${where}`, params);
  return { ...aggregateNeed(rows.map(r => r.factors || {}), unit), computed_at: rows[0] ? rows[0].computed_at : null };
}

// factorsList: refresh-risk factors per asset ({ category, risk_q | risk6/12/24 }). Pure (also used by ai:eval).
function aggregateNeed(factorsList, unit, now = new Date()) {
  const Q = 8;
  const quarters = Array.from({ length: Q }, () => ({ units: 0, cost: 0, by: {} }));
  for (const f of factorsList) {
    // Cumulative risk at the end of each quarter; older scores have only 6/12/24 months (interpolated).
    const cum = Array.isArray(f.risk_q) && f.risk_q.length === Q ? f.risk_q
      : Array.from({ length: Q }, (_, i) => { const m = (i + 1) * 3; return m <= 6 ? f.risk6 * m / 6 : m <= 12 ? f.risk6 + (f.risk12 - f.risk6) * (m - 6) / 6 : f.risk12 + (f.risk24 - f.risk12) * (m - 12) / 12; });
    const price = unit[f.category] ? unit[f.category].cost : 0;
    let prev = 0;
    for (let i = 0; i < Q; i++) {
      const p = Math.max(0, (cum[i] || 0) - prev);
      prev = Math.max(prev, cum[i] || 0);
      const q = quarters[i];
      q.units += p; q.cost += p * price;
      const c = q.by[f.category] || (q.by[f.category] = { units: 0, cost: 0 });
      c.units += p; c.cost += p * price;
    }
  }
  const label = i => {
    const a = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3 * i, 1));
    const b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3 * i + 2, 1));
    const fmt = d => d.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    return `${fmt(a)} – ${fmt(b)}`;
  };
  const sum = (from, to) => quarters.slice(from, to).reduce((s, q) => ({ units: s.units + q.units, cost: s.cost + q.cost }), { units: 0, cost: 0 });
  return { assets: factorsList.length, quarters: quarters.map((q, i) => ({ label: label(i), ...q })), next12: sum(0, 4), next24: sum(0, 8) };
}

// Everything the dashboard card needs (cached 10 minutes per location scope).
async function forecast(user) {
  const scope = await scopeOf(user);
  const key = scope.global ? 'all' : scope.location_ids.slice().sort().join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const [cur, unit, series] = [await currency(), await unitCosts(), await spendSeries()];
  const n = await need(user, unit);
  const p = pace(series);
  const value = {
    ready: n.assets > 0, currency: cur, unit_costs: unit, need: n,
    history: { quarters: series.quarters.slice(-12), values: series.values.slice(-12) },
    pace: p && {
      yearly: p.yearly, quarter_mean: p.quarter_mean, forecastable: p.forecastable, best_rule: p.best_rule,
      backtest: Object.fromEntries(Object.entries(p.backtest).map(([k, v]) => [k, { mae: v.mae, mae_share: v.mae_share, quarters: v.quarters }])),
      model: { seasonal: p.params.seasonal, alpha: p.params.alpha, beta: p.params.beta, gamma: p.params.gamma, phi: p.params.phi }
    },
    // Restricted users see their own locations' need; spend history is the whole company's (purchase
    // orders have no location).
    scoped: !scope.global,
    computed_at: new Date().toISOString()
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

const canon = v => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}` : JSON.stringify(v));

// Job ai_cost_forecast: refreshes the forecast and records the spend model's choice and backtest in the
// registry when the choice changes.
async function run({ trigger = 'schedule', user = null } = {}) {
  invalidate();
  const f = await forecast(null);
  if (!f.ready) return { skipped: true, summary: 'No refresh-risk scores yet: the forecast needs Refresh risk to have run once.' };
  let version = null;
  const series = await spendSeries();
  const p = pace(series);
  if (p) {
    const choice = { m: p.params.m, alpha: p.params.alpha, beta: p.params.beta, gamma: p.params.gamma, phi: p.params.phi, seasonal: p.params.seasonal };
    const active = await db.get(`SELECT version, params FROM ai_models WHERE name = $1 AND status = 'active'`, [HoltWinters.modelName]);
    const pick = o => (o ? { m: o.m, alpha: o.alpha, beta: o.beta, gamma: o.gamma, phi: o.phi, seasonal: o.seasonal } : null);
    version = active ? active.version : null;
    if (!active || canon(pick(active.params)) !== canon(choice)) {
      version = await registry.save(p.model, {
        metrics: { backtest_mae_share: p.backtest.holt_winters.mae_share, best_rule_mae_share: p.backtest[p.best_rule].mae_share },
        userId: user ? user.id : null,
        training: { trigger, quarters: series.quarters.length, from: series.quarters[0], to: series.quarters[series.quarters.length - 1], backtest: p.backtest, best_rule: p.best_rule }
      });
      await registry.activate(HoltWinters.modelName, version, user);
    }
  }
  const cur = f.currency;
  return {
    ...f, version,
    summary: `Replacement need, next 12 months: ~${Math.round(f.need.next12.units).toLocaleString('en-IN')} assets ≈ ${money(f.need.next12.cost, cur)}`
      + (f.pace ? `; past spend pace ≈ ${money(f.pace.yearly, cur)} a year (quarterly timing not forecastable: best rule off by ${Math.round(f.pace.backtest[f.pace.best_rule].mae_share * 100)}% of an average quarter).` : '.')
  };
}

module.exports = { forecast, run, need, aggregateNeed, unitCosts, spendSeries, pace, money, currency, invalidate, scopeOf };
