// Unusual assets (snapshot anomalies): Isolation Forest over features that compare each active asset
// with the other assets of its model, plus who holds it and its age. Runs in a worker thread.
//
// Features (robust z-scores: distance from the model's median in units of its spread, so a generic
// model name such as "MacBook Pro" or "Cloud" that spans many years doesn't make everything unusual):
//   holder_devices    ln(1 + active devices of the same holder)
//   cost_vs_model     ln cost vs the model's ln costs
//   ram_vs_model      log2 RAM vs the model's
//   cpu_vs_model      processor generation vs the model's
//   bought_vs_model   purchase date vs the model's purchase dates
//   warranty_vs_model warranty term vs the model's
//   age_years         age (very old assets still active)
// Why an asset is unusual: for each feature, how much the score drops when that value is replaced by
// the ordinary one ("if its RAM matched its model, it would look ordinary"), keeping only reasons
// worth a person's look on their own.
const { IsolationForest, rng } = require('../models/isolationForest');
const { cpuOf } = require('../../services/stockSiteService');
const { ageYears } = require('../features/assetRows');

const FEATURES = ['holder_devices', 'cost_vs_model', 'ram_vs_model', 'cpu_vs_model', 'bought_vs_model', 'warranty_vs_model', 'age_years'];
// minPeers: a comparison with the model needs 10+ assets of it with that value (with fewer, the
// "usual" value can itself be a data error).
const SETTINGS = { trees: 100, sample: 256, seed: 7, minPeers: 10, minScore: 0.6, flagQuantile: 0.99, version: 'iforest-1' };

const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const spread = (xs, floor) => {
  if (xs.length < 4) return floor;
  const s = xs.slice().sort((a, b) => a - b);
  return Math.max(floor, (s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)]) / 1.349);
};
const mode = xs => { const m = new Map(); let best = null, n = 0; for (const x of xs) { const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > n) { n = c; best = x; } } return best; };
const yearOf = d => { const t = new Date(d + 'T00:00:00Z'); return t.getUTCFullYear() + t.getUTCMonth() / 12; };
const termOf = r => (r.purchase_date && r.warranty_expiry ? (Date.parse(r.warranty_expiry) - Date.parse(r.purchase_date)) / (365.25 * 864e5) : null);

// Per model: medians and spreads of cost, RAM, processor generation, purchase date and warranty term.
function peerStats(rows) {
  const by = new Map();
  for (const r of rows) { const k = r.asset_model_id || 0; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  const out = new Map();
  for (const [k, rs] of by) {
    const costs = rs.map(r => r.cost).filter(v => v > 0).map(Math.log);
    const rams = rs.map(r => r.ram_gb).filter(v => v > 0).map(Math.log2);
    const cpus = rs.map(r => cpuOf(r.cpu)).filter(c => c.gen > 0);
    const years = rs.filter(r => r.purchase_date).map(r => yearOf(r.purchase_date));
    const terms = rs.map(termOf).filter(v => v !== null);
    out.set(k, {
      n: rs.length,
      cost: { n: costs.length, med: median(costs), s: spread(costs, 0.15) },
      ram: { n: rams.length, med: median(rams), s: spread(rams, 0.5) },
      cpu: { n: cpus.length, med: median(cpus.map(c => c.gen)), s: spread(cpus.map(c => c.gen), 1), label: mode(cpus.map(c => c.label)) },
      year: { n: years.length, med: median(years), s: spread(years, 0.75) },
      term: { n: terms.length, med: median(terms), s: spread(terms, 0.5) }
    });
  }
  return out;
}

// Feature vector of one active asset, plus the raw values its explanation quotes.
function vectorOf(r, peers, holderCount, now, minPeers) {
  const p = peers.get(r.asset_model_id || 0);
  const z = (v, st) => (v !== null && v !== undefined && st.n >= minPeers && st.med !== null ? (v - st.med) / st.s : 0);
  const cpu = cpuOf(r.cpu);
  const devices = r.holder_user_id ? holderCount.get(r.holder_user_id) || 1 : 0;
  const term = termOf(r);
  return {
    x: [
      Math.log1p(devices),
      z(r.cost > 0 ? Math.log(r.cost) : null, p.cost),
      z(r.ram_gb > 0 ? Math.log2(r.ram_gb) : null, p.ram),
      z(cpu.gen > 0 ? cpu.gen : null, p.cpu),
      z(r.purchase_date ? yearOf(r.purchase_date) : null, p.year),
      z(term, p.term),
      r.purchase_date ? Math.max(0, ageYears(r.purchase_date, now)) : 0
    ],
    raw: { devices, cost: r.cost, ram: r.ram_gb, cpu: cpu.label, year: r.purchase_date ? r.purchase_date.slice(0, 4) : null, term, age: r.purchase_date ? ageYears(r.purchase_date, now) : null },
    peer: p
  };
}

const num = v => Math.round(v).toLocaleString('en-IN');
const yrs = v => (Math.round(v * 10) / 10).toString();
// "Core i5 2th gen" (as the processor parser writes it) -> "Core i5 2nd gen".
const ordinal = s => String(s || '').replace(/\b(\d+)th gen\b/g, (m, n) => {
  const k = Number(n) % 100;
  return n + (k >= 11 && k <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th')) + ' gen';
});

// Plain-language reason for one feature.
function reason(feature, r, v) {
  const model = r.model || 'its model';
  const p = v.peer;
  switch (feature) {
    case 'holder_devices': return `${r.holder || 'Its holder'} holds ${v.raw.devices} active devices (most holders have 1)`;
    case 'cost_vs_model': return `Cost ${num(v.raw.cost)}; ${model} usually cost ${num(Math.exp(p.cost.med))} (${(v.raw.cost / Math.exp(p.cost.med)).toFixed(1)}×)`;
    case 'ram_vs_model': return `${v.raw.ram} GB RAM; ${model} usually has ${Math.round(Math.pow(2, p.ram.med))} GB`;
    case 'cpu_vs_model': return `Processor ${ordinal(v.raw.cpu)}; ${model} usually has ${ordinal(p.cpu.label)}`;
    case 'bought_vs_model': return `Bought in ${v.raw.year}; most ${model} were bought around ${Math.floor(p.year.med)}`;
    case 'warranty_vs_model': return `${yrs(v.raw.term)}-year warranty; ${model} usually has ${yrs(p.term.med)} years`;
    case 'age_years': return `${yrs(v.raw.age)} years old and still active`;
    default: return feature;
  }
}

// Corrupted copies of real assets, to measure detection objectively (no database change).
function injectionTest(forest, X, rand) {
  const kinds = [
    ['RAM 4× or ¼ of its model', x => { x[2] += (rand() < 0.5 ? 2 : -2) / 0.5; }],
    ['cost 5× or ⅕ of its model', x => { x[1] += (rand() < 0.5 ? 1 : -1) * Math.log(5) / 0.25; }],
    ['bought 6 years from its model', x => { x[4] += rand() < 0.5 ? 6 : -6; }],
    ['holder with 15 devices', x => { x[0] = Math.log1p(15); }],
    ['10-year warranty', x => { x[5] += 7 / 0.5; }],
    ['processor 5 generations off', x => { x[3] += rand() < 0.5 ? 5 : -5; }]
  ];
  const normal = X.filter(() => rand() < 0.2).map(x => ({ x, y: 0 }));
  const out = { overall: null, kinds: {} };
  const all = [];
  for (const [name, fn] of kinds) {
    const inj = [];
    for (let i = 0; i < 50; i++) { const x = X[Math.floor(rand() * X.length)].slice(); fn(x); inj.push({ x, y: 1 }); }
    out.kinds[name] = forest.evaluate([...normal, ...inj], 50).auc;
    all.push(...inj);
  }
  out.overall = forest.evaluate([...normal, ...all], 100).auc;
  return out;
}

// rows: assetRows.load() output. Returns { results: [{ id, score, flagged, factors? }], threshold, metrics }.
function scoreAll({ rows, now = Date.now(), settings = {} }) {
  const S = { ...SETTINGS, ...settings };
  const live = rows.filter(r => !r.deleted);
  const active = live.filter(r => !r.is_retired);
  const holderCount = new Map();
  for (const r of active) if (r.holder_user_id) holderCount.set(r.holder_user_id, (holderCount.get(r.holder_user_id) || 0) + 1);
  const peers = peerStats(live);
  const vecs = active.map(r => vectorOf(r, peers, holderCount, now, S.minPeers));
  const X = vecs.map(v => v.x);
  if (X.length < 50) return { results: [], threshold: null, metrics: { assets: X.length, skipped: true } };
  const forest = new IsolationForest().train(X, { trees: S.trees, sample: S.sample, seed: S.seed, features: FEATURES });
  const scores = X.map(x => forest.score(x));
  const sorted = scores.slice().sort((a, b) => b - a);
  const threshold = Math.max(S.minScore, sorted[Math.floor(sorted.length * (1 - S.flagQuantile))]);
  // The ordinary value of each feature (for the counterfactual): one device if held, the model's
  // median (z = 0), the median age.
  const medAge = median(X.map(x => x[6]));
  // A reason must be worth a person's look on its own: 2+ spreads from the model's usual value, a
  // holder with 3+ active devices, or 10+ years old. A high score with no such reason is not shown.
  const notable = (j, x, raw) => (j === 0 ? raw.devices >= 3 : j === 6 ? raw.age >= 10 : Math.abs(x[j]) >= 2);
  const results = active.map((r, i) => {
    const s = scores[i];
    const out = { id: r.id, score: s, flagged: false, hash: r.feature_hash };
    if (s < threshold) return out;
    const x = X[i];
    // Ordinary values: one device if it is held, the model's usual value (z = 0), the median age.
    const typical = [vecs[i].raw.devices ? Math.log1p(1) : 0, 0, 0, 0, 0, 0, medAge];
    const drops = forest.explain(x, { typical })
      .filter(e => notable(e.index, x, vecs[i].raw) && e.weight >= 0.005)
      .slice(0, 3).map(e => ({ feature: e.factor, drop: e.weight }));
    if (!drops.length) return out;
    out.flagged = true;
    out.factors = drops.map(d => ({ feature: d.feature, drop: Math.round(d.drop * 1000) / 1000, text: reason(d.feature, r, vecs[i]) }));
    return out;
  });
  const inj = injectionTest(forest, X, rng(99));
  return {
    results, threshold,
    metrics: { assets: X.length, flagged: results.filter(r => r.flagged).length, threshold, injected_auc: inj.overall, injected_by_kind: inj.kinds }
  };
}

module.exports = { scoreAll, peerStats, vectorOf, reason, FEATURES, SETTINGS };
