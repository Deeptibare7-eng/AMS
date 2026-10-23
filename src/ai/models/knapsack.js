// Choosing what to replace within a budget: a 0/1 knapsack, our own code.
//   items: [{ id, value, cost }]  (value = what replacing it is worth, cost = what it costs)
//   maximise the sum of values, keeping the sum of costs within the budget.
// greedy(): best value per rupee first (fast, usually near the best).
// optimal(): dynamic programming over the budget split into `buckets` steps. Each cost is rounded UP
// to whole steps, so the plan never goes over the budget; any money that rounding leaves is then
// filled greedily. Only the best `maxItems` by value per rupee are considered (the rest can't beat them
// at the margin when costs are similar, as replacement costs are).
function greedy(items, budget) {
  const sorted = items.filter(i => i.cost > 0 && i.value > 0).sort((a, b) => b.value / b.cost - a.value / a.cost);
  const chosen = [];
  let cost = 0, value = 0;
  for (const i of sorted) {
    if (cost + i.cost <= budget) { chosen.push(i.id); cost += i.cost; value += i.value; }
  }
  return { chosen, cost, value };
}

function optimal(items, budget, { buckets = 2000, maxItems = 4000 } = {}) {
  const pool = items.filter(i => i.cost > 0 && i.value > 0 && i.cost <= budget)
    .sort((a, b) => b.value / b.cost - a.value / a.cost).slice(0, maxItems);
  if (!pool.length || budget <= 0) return { chosen: [], cost: 0, value: 0 };
  const W = buckets;
  const unit = budget / W;
  const w = pool.map(i => Math.max(1, Math.ceil(i.cost / unit - 1e-9)));
  const best = new Float64Array(W + 1);
  const keep = new Uint8Array(pool.length * (W + 1));
  for (let k = 0; k < pool.length; k++) {
    const wk = w[k], vk = pool[k].value;
    for (let c = W; c >= wk; c--) {
      const cand = best[c - wk] + vk;
      if (cand > best[c]) { best[c] = cand; keep[k * (W + 1) + c] = 1; }
    }
  }
  let c = 0;
  for (let x = 1; x <= W; x++) if (best[x] > best[c]) c = x;
  const picked = new Set();
  for (let k = pool.length - 1; k >= 0 && c > 0; k--) {
    if (keep[k * (W + 1) + c]) { picked.add(k); c -= w[k]; }
  }
  let cost = 0, value = 0;
  const chosen = [];
  for (const k of picked) { chosen.push(pool[k].id); cost += pool[k].cost; value += pool[k].value; }
  // Fill what rounding left, best value per rupee first.
  const ids = new Set(chosen);
  for (const i of items.filter(x => !ids.has(x.id) && x.cost > 0 && x.value > 0).sort((a, b) => b.value / b.cost - a.value / a.cost)) {
    if (cost + i.cost <= budget) { chosen.push(i.id); cost += i.cost; value += i.value; }
  }
  return { chosen, cost, value };
}

// Both, and the better one (the dynamic programme can only match or beat greedy, up to rounding).
function solve(items, budget, opts = {}) {
  const g = greedy(items, budget);
  const o = optimal(items, budget, opts);
  const use = o.value >= g.value ? { ...o, method: 'optimal' } : { ...g, method: 'greedy' };
  return { ...use, greedy_value: g.value, optimal_value: o.value };
}

module.exports = { greedy, optimal, solve };
