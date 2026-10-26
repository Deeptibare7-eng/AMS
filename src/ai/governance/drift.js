// Drift: how far today's data has moved from the data a model was trained on. Pure statistics;
// the drift job (driftCheck.js) loads the data and stores the results.
//   PSI (population stability index) per feature, over the reference's bins:
//     PSI = Σ (actual − expected) × ln(actual / expected)
//     < 0.1 stable, 0.1–0.25 moderate, > 0.25 significant (the usual credit-scoring bands)
//   KS (two-sample Kolmogorov–Smirnov) for numbers: D = the largest gap between the two cumulative
//   distributions, and its p-value (asymptotic Kolmogorov distribution).
// A profile keeps, per feature, what the comparison needs: decile edges and shares plus a sample of
// values for numbers, the shares of the 30 most common values for categories, and the missing share.

const EPS = 1e-4;
const SAMPLE = 400;
const TOP = 30;
const BANDS = { moderate: 0.1, significant: 0.25 };
const level = p => (p > BANDS.significant ? 'significant' : p >= BANDS.moderate ? 'moderate' : 'stable');

function psi(expected, actual) {
  if (expected.length !== actual.length) throw new Error('PSI needs the same bins');
  let s = 0;
  for (let i = 0; i < expected.length; i++) {
    const e = Math.max(expected[i], EPS), a = Math.max(actual[i], EPS);
    s += (a - e) * Math.log(a / e);
  }
  return s;
}

// Probability that the KS statistic exceeds lambda (Numerical Recipes, probks).
function probKS(lambda) {
  const a2 = -2 * lambda * lambda;
  let fac = 2, sum = 0, prev = 0;
  for (let j = 1; j <= 100; j++) {
    const term = fac * Math.exp(a2 * j * j);
    sum += term;
    if (Math.abs(term) <= 0.001 * prev || Math.abs(term) <= 1e-8 * sum) return Math.min(1, Math.max(0, sum));
    fac = -fac;
    prev = Math.abs(term);
  }
  return 1;
}

function ks(a, b) {
  const x = a.filter(Number.isFinite).slice().sort((p, q) => p - q);
  const y = b.filter(Number.isFinite).slice().sort((p, q) => p - q);
  if (!x.length || !y.length) return { d: 0, p: 1 };
  let i = 0, j = 0, d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const ne = (x.length * y.length) / (x.length + y.length);
  const en = Math.sqrt(ne);
  return { d, p: probKS((en + 0.12 + 0.11 / en) * d) };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

// baseEdges: when profiling today's data against a reference, also its shares in the reference's
// bins from every value (exact, instead of estimating them from the sample).
function numericProfile(values, baseEdges = null) {
  const present = values.filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number).sort((p, q) => p - q);
  const missing = 1 - present.length / Math.max(1, values.length);
  const edges = [...new Set(Array.from({ length: 9 }, (_, k) => quantile(present, (k + 1) / 10)))].filter(v => v !== undefined);
  const shares = binShares(present, edges);
  const step = Math.max(1, Math.floor(present.length / SAMPLE));
  const sample = present.filter((_, k) => k % step === 0).slice(0, SAMPLE);
  const out = { kind: 'num', n: values.length, missing, edges, shares, sample, mean: present.length ? present.reduce((s, v) => s + v, 0) / present.length : null };
  if (baseEdges) out.on_base = binShares(present, baseEdges);
  return out;
}

// Shares of values in (−∞, e1], (e1, e2], …, (ek, ∞).
function binShares(sorted, edges) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of sorted) {
    let k = 0;
    while (k < edges.length && v > edges[k]) k++;
    counts[k]++;
  }
  return counts.map(c => c / Math.max(1, sorted.length));
}

function categoricalProfile(values) {
  const counts = new Map();
  let missing = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') { missing++; continue; }
    counts.set(String(v), (counts.get(String(v)) || 0) + 1);
  }
  const n = Math.max(1, values.length);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  const shares = Object.fromEntries(top.map(([k, c]) => [k, c / n]));
  const other = (values.length - missing - top.reduce((s, [, c]) => s + c, 0)) / n;
  return { kind: 'cat', n: values.length, missing: missing / n, shares, other };
}

// spec: [{ name, kind: 'num' | 'cat', get: row => value }]. base: the reference profile, when this
// one will be compared with it (numbers are then also binned on the reference's edges).
// A number with few distinct values (RAM sizes, counts) is compared as categories: quantile bins
// would pile it into one or two bins and exaggerate any shift. Today's data follows the reference's choice.
const DISCRETE_MAX = 12;
const isDiscrete = values => new Set(values.filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number)).size <= DISCRETE_MAX;

function profile(rows, spec, at = new Date(), base = null) {
  const features = {};
  for (const f of spec) {
    const values = rows.map(f.get);
    const ref = base && base.features && base.features[f.name];
    const asCategories = f.kind === 'num' && (ref ? ref.kind === 'cat' : isDiscrete(values));
    if (asCategories) features[f.name] = { ...categoricalProfile(values.map(v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : String(Number(v))))), discrete: true };
    else features[f.name] = f.kind === 'num' ? numericProfile(values, ref && ref.kind === 'num' ? ref.edges : null) : categoricalProfile(values);
  }
  return { at: new Date(at).toISOString(), rows: rows.length, features };
}

function compareFeature(name, base, cur) {
  if (base.kind === 'num') {
    // Current values in the reference's bins (exact when profiled against it, else from the
    // sample), plus the missing share as its own bin.
    const onBase = cur.on_base && cur.on_base.length === base.edges.length + 1 ? cur.on_base : binShares(cur.sample.slice().sort((p, q) => p - q), base.edges);
    const curShares = onBase.map(s => s * (1 - cur.missing));
    const baseShares = base.shares.map(s => s * (1 - base.missing));
    const value = psi([...baseShares, base.missing], [...curShares, cur.missing]);
    const t = ks(base.sample, cur.sample);
    return {
      feature: name, kind: 'num', psi: value, ks_d: t.d, ks_p: t.p, status: level(value),
      shifts: [`mean ${fmt(base.mean)} → ${fmt(cur.mean)}`, ...(Math.abs(cur.missing - base.missing) >= 0.02 ? [`missing ${pct(base.missing)} → ${pct(cur.missing)}`] : [])]
    };
  }
  const keys = Object.keys(base.shares);
  const curOther = 1 - cur.missing - keys.reduce((s, k) => s + (cur.shares[k] || 0), 0);
  const value = psi([...keys.map(k => base.shares[k]), base.other, base.missing], [...keys.map(k => cur.shares[k] || 0), Math.max(0, curOther), cur.missing]);
  const moves = [...new Set([...keys, ...Object.keys(cur.shares)])]
    .map(k => ({ k, from: base.shares[k] || 0, to: cur.shares[k] || 0 }))
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, 3)
    .filter(m => Math.abs(m.to - m.from) >= 0.01)
    .map(m => `${m.k} ${pct(m.from)} → ${pct(m.to)}${keys.includes(m.k) ? '' : ' (new)'}`);
  return { feature: name, kind: base.discrete ? 'num' : 'cat', discrete: !!base.discrete, psi: value, ks_d: null, ks_p: null, status: level(value), shifts: moves };
}

function compare(base, cur) {
  const features = Object.keys(base.features).filter(k => cur.features[k]).map(k => compareFeature(k, base.features[k], cur.features[k]))
    .sort((a, b) => b.psi - a.psi);
  const maxPsi = features.reduce((m, f) => Math.max(m, f.psi), 0);
  return { status: level(maxPsi), max_psi: maxPsi, features };
}

const pct = x => `${Math.round(x * 100)}%`;
const fmt = x => (x === null || x === undefined ? '—' : Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-IN') : (Math.round(x * 100) / 100).toString());

module.exports = { psi, ks, probKS, profile, compare, numericProfile, categoricalProfile, level, BANDS };
