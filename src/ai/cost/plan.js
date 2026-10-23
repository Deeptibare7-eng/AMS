// Refresh plan under a budget (capability 'cost'): which active assets to replace first.
//
// Each candidate is an active asset scored by Refresh risk. Its priority is its chance of being retired
// within the chosen horizon (6, 12 or 24 months), counted in full when it is in use (assigned or
// deployed) and half when it is spare stock (stock is optional). Its cost is its category's replacement
// cost (median recent purchase; editable on the page). A 0/1 knapsack (models/knapsack.js) picks the set
// with the most priority within the budget.
//
// The plan only recommends. "Send for approval" puts it in AI Approvals; accepting it records the sign-off
// and nothing else: no purchase, request or change is made (export it for Procurement).
const crypto = require('crypto');
const db = require('../../core/db');
const audit = require('../../services/auditService');
const approvals = require('../governance/approvals');
const forecast = require('./forecast');
const { solve } = require('../models/knapsack');

const HORIZONS = { 6: 'risk6', 12: 'risk12', 24: 'risk24' };
const STOCK_WEIGHT = 0.5;

// Options from a query string / form: budget, horizon, stock, categories, locations, per-category costs.
function options(q = {}) {
  const list = v => [].concat(v || []).map(String).filter(Boolean).slice(0, 100);
  const costs = {};
  for (const [k, v] of Object.entries(q)) {
    const m = k.match(/^cost_(.+)$/);
    if (m && Number(v) > 0) costs[m[1]] = Math.round(Number(v));
  }
  return {
    budget: Math.max(0, Math.round(Number(String(q.budget || '').replace(/[,\s]/g, '')) || 0)),
    horizon: [6, 12, 24].includes(Number(q.horizon)) ? Number(q.horizon) : 12,
    stock: q.stock === '1',
    categories: list(q.category),
    locations: list(q.location).map(Number).filter(Number.isFinite),
    costs
  };
}

async function candidates(user, opts) {
  const scope = await forecast.scopeOf(user);
  const params = [];
  let where = `p.capability = 'lifecycle' AND a.deleted_at IS NULL`;
  if (!scope.global) { params.push(scope.location_ids); where += ` AND a.location_id = ANY($${params.length}::int[])`; }
  if (opts.locations.length) { params.push(opts.locations); where += ` AND a.location_id = ANY($${params.length}::int[])`; }
  const rows = await db.query(
    `SELECT p.asset_id, p.factors, p.confidence::float8 AS confidence, a.asset_tag, a.name, a.location_id, l.name AS location,
            am.name AS model, u.name AS holder, a.assigned_to, sl.type AS label_type, sl.name AS status
       FROM ai_predictions p JOIN assets a ON a.id = p.asset_id
       LEFT JOIN locations l ON l.id = a.location_id LEFT JOIN asset_models am ON am.id = a.asset_model_id
       LEFT JOIN users u ON u.id = a.assigned_to LEFT JOIN status_labels sl ON sl.id = a.status_label_id
      WHERE ${where}`, params);
  return rows.filter(r => !opts.categories.length || opts.categories.includes(r.factors.category));
}

async function build(user, opts) {
  const unit = await forecast.unitCosts();
  const cur = await forecast.currency();
  const costOf = cat => opts.costs[cat] || (unit[cat] ? Math.round(unit[cat].cost) : 0);
  const key = HORIZONS[opts.horizon];
  const rows = await candidates(user, opts);
  const items = [];
  const noCost = new Set();
  for (const r of rows) {
    const inUse = !!r.assigned_to || r.label_type === 'deployed';
    if (!inUse && !opts.stock) continue;
    const cat = r.factors.category;
    const cost = costOf(cat);
    if (!cost) { noCost.add(cat); continue; }
    const risk = Number(r.factors[key]) || 0;
    items.push({ id: r.asset_id, value: risk * (inUse ? 1 : STOCK_WEIGHT), cost, risk, inUse, row: r });
  }
  const result = opts.budget > 0 ? solve(items, opts.budget) : { chosen: [], cost: 0, value: 0, method: 'none', greedy_value: 0, optimal_value: 0 };
  const chosenSet = new Set(result.chosen);
  const chosen = items.filter(i => chosenSet.has(i.id)).sort((a, b) => b.value - a.value);
  const expectedAll = items.reduce((s, i) => s + i.risk, 0);
  const expectedCovered = chosen.reduce((s, i) => s + i.risk, 0);
  const high = items.filter(i => i.risk >= 0.5 && i.inUse);
  const highLeft = high.filter(i => !chosenSet.has(i.id));
  const group = (list, keyOf) => {
    const m = new Map();
    for (const i of list) { const k = keyOf(i); const g = m.get(k) || { key: k, n: 0, cost: 0, expected: 0 }; g.n++; g.cost += i.cost; g.expected += i.risk; m.set(k, g); }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const horizonText = `${opts.horizon} months`;
  return {
    options: opts, currency: cur, unit_costs: Object.fromEntries(Object.entries(unit).map(([c, u]) => [c, { ...u, used: costOf(c) }])),
    candidates: items.length, no_cost: [...noCost],
    method: result.method, greedy_value: result.greedy_value, optimal_value: result.optimal_value,
    chosen: chosen.map(i => ({
      id: i.id, tag: i.row.asset_tag, name: i.row.name, category: i.row.factors.category, model: i.row.model, location: i.row.location,
      holder: i.row.holder, status: i.row.status, age: i.row.factors.age, risk: i.risk, in_use: i.inUse, cost: i.cost, confidence: i.row.confidence,
      why: `${Math.round(i.risk * 100)}% chance of being retired within ${horizonText}; ${i.inUse ? (i.row.holder ? 'in use by ' + i.row.holder : 'in use') : 'spare stock (counted half)'}; ${i.row.factors.age.toFixed(1)} years old`
    })),
    totals: {
      assets: chosen.length, cost: result.cost, budget: opts.budget, left: opts.budget - result.cost,
      expected_covered: expectedCovered, expected_all: expectedAll,
      // What replacing every expected retirement in the horizon would cost (a budget to start from).
      expected_cost: items.reduce((s, i) => s + i.risk * i.cost, 0),
      high_risk_in_use: high.length, high_risk_left: highLeft.length, budget_for_all_high: high.reduce((s, i) => s + i.cost, 0),
      confidence: chosen.length ? chosen.reduce((s, i) => s + (i.row.confidence || 0), 0) / chosen.length : 0
    },
    by_category: group(chosen, i => i.row.factors.category),
    by_location: group(chosen, i => i.row.location || 'No location')
  };
}

// For the Excel export.
const EXPORT_COLUMNS = [
  { header: 'Asset tag', key: 'tag', width: 16 }, { header: 'Name', key: 'name', width: 28 }, { header: 'Category', key: 'category', width: 14 },
  { header: 'Model', key: 'model', width: 24 }, { header: 'Asset Location', key: 'location', width: 20 }, { header: 'Assigned to', key: 'holder', width: 18 },
  { header: 'Status', key: 'status', width: 14 }, { header: 'Age (years)', key: 'age', width: 12 }, { header: 'Chance of retirement in the horizon', key: 'risk', width: 18 },
  { header: 'Replacement cost', key: 'cost', width: 16 }, { header: 'Why', key: 'why', width: 70 }
];
function exportRows(plan) {
  return plan.chosen.map(c => ({ ...c, age: Math.round(c.age * 10) / 10, risk: Math.round(c.risk * 1000) / 10 + '%' }));
}

// Puts the plan in AI Approvals for sign-off.
async function propose(user, opts) {
  const plan = await build(user, opts);
  if (!plan.chosen.length) return { id: null, plan, reason: 'The plan is empty: raise the budget or widen the filters.' };
  const t = plan.totals, cur = plan.currency;
  const ids = plan.chosen.map(c => c.id);
  const key = crypto.createHash('sha1').update(JSON.stringify({ o: opts, ids })).digest('hex').slice(0, 20);
  const id = await approvals.propose({
    type: 'plan.refresh', agent: 'PlanningAgent', target_type: 'plan',
    location_id: opts.locations.length === 1 ? opts.locations[0] : null,
    title: `Refresh plan: replace ${t.assets} assets for ${forecast.money(t.cost, cur)} within ${opts.horizon} months`,
    why: [
      `Budget ${forecast.money(t.budget, cur)}; ${forecast.money(t.left, cur)} left unspent`,
      `Covers ~${Math.round(t.expected_covered)} of the ~${Math.round(t.expected_all)} retirements expected within ${opts.horizon} months among the candidates`,
      `${t.high_risk_left} in-use assets at 50%+ risk are not covered; covering all ${t.high_risk_in_use} would cost ${forecast.money(t.budget_for_all_high, cur)}`,
      ...plan.by_category.slice(0, 3).map(g => `${g.key}: ${g.n} at ${forecast.money(g.cost, cur)}`),
      'Chosen by priority per rupee (0/1 knapsack); accepting records the sign-off only, nothing is purchased'
    ],
    proposed: {
      assets: t.assets, cost: forecast.money(t.cost, cur), budget: forecast.money(t.budget, cur), horizon: `${opts.horizon} months`,
      categories: plan.by_category.map(g => `${g.key} ${g.n}`).join(', '), spare_stock: opts.stock ? 'included (counted half)' : 'not included',
      _asset_ids: ids, _options: opts, _cost: t.cost, _budget: t.budget, _currency: cur.code
    },
    confidence: Math.max(0.05, Math.min(1, t.confidence)),
    dedupe_key: 'plan:' + key
  });
  if (id) await audit.log(user ? user.id : null, 'AI_PLAN_PROPOSED', `Refresh plan sent for approval: ${t.assets} assets, ${forecast.money(t.cost, cur)}.`);
  return { id, plan, reason: id ? null : 'The same plan is already waiting in AI Approvals.' };
}

approvals.registerHandler('plan.refresh', {
  label: 'Refresh plan', capability: 'cost', permission: 'ai.manage',
  // Sign-off only: the AI never buys or changes anything.
  apply: async rec => ({ summary: `Plan approved (${rec.proposed.assets} assets). Nothing was purchased or changed: export the plan from Refresh Planning for Procurement` })
});

module.exports = { options, build, propose, exportRows, EXPORT_COLUMNS, HORIZONS };
