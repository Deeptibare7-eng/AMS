// Isolation Forest (Liu, Ting & Zhou 2008), our own code.
//
// Unusual points are easy to isolate: a random tree that splits on a random feature at a random value
// between the node's min and max separates them in few steps. Over many trees, each built on a small
// random sample, the average path length h(x) of a point gives the score
//     s(x) = 2^(-E[h(x)] / c(psi)),   c(n) = 2 H(n-1) - 2 (n-1) / n,  H(i) ~ ln i + 0.5772
// where psi is the sample size: s near 1 = clearly unusual, around 0.5 or below = ordinary.
// Why a point is unusual: for each feature, how much its score drops when that one value is replaced
// by the ordinary one (the training median, or a value the caller gives): "if its RAM were usual, it
// would look ordinary". Features that never vary in the training sample are never split on, so an
// unusual value there can't be seen.
const BaseModel = require('./baseModel');

const EULER = 0.5772156649;
function c(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - 2 * (n - 1) / n;
}

// Seeded random numbers (mulberry32), so a run is repeatable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One tree as flat arrays. feature = -1 marks a leaf (size = points that reached it).
function buildTree(X, idx, maxDepth, rand) {
  const feature = [], split = [], left = [], right = [], size = [];
  const d = X[0].length;
  const node = (ids, depth) => {
    const me = feature.length;
    feature.push(-1); split.push(0); left.push(-1); right.push(-1); size.push(ids.length);
    if (depth >= maxDepth || ids.length <= 1) return me;
    // Features that still vary in this node.
    const ranges = [];
    for (let f = 0; f < d; f++) {
      let lo = Infinity, hi = -Infinity;
      for (const i of ids) { const v = X[i][f]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi > lo) ranges.push([f, lo, hi]);
    }
    if (!ranges.length) return me;
    const [f, lo, hi] = ranges[Math.floor(rand() * ranges.length)];
    const s = lo + rand() * (hi - lo);
    const l = [], r = [];
    for (const i of ids) (X[i][f] < s ? l : r).push(i);
    feature[me] = f; split[me] = s;
    left[me] = node(l, depth + 1);
    right[me] = node(r, depth + 1);
    return me;
  };
  node(idx, 0);
  return { feature, split, left, right, size };
}

class IsolationForest extends BaseModel {
  static modelName = 'anomaly_iforest';

  // X: array of numeric rows (same length). Options: trees, sample (psi), seed.
  train(X, { trees = 100, sample = 256, seed = 7, features = null } = {}) {
    const rand = rng(seed);
    const psi = Math.min(sample, X.length);
    const maxDepth = Math.ceil(Math.log2(Math.max(2, psi)));
    const forest = [];
    for (let t = 0; t < trees; t++) {
      const idx = [];
      // Sample without replacement (partial Fisher-Yates).
      const pool = Array.from({ length: X.length }, (_, i) => i);
      for (let i = 0; i < psi; i++) { const j = i + Math.floor(rand() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; idx.push(pool[i]); }
      forest.push(buildTree(X, idx, maxDepth, rand));
    }
    this.params = { trees, sample: psi, seed, maxDepth, features };
    this.forest = forest;
    // The ordinary value of each feature (median), for explanations.
    this.typical = X[0].map((_, j) => { const v = X.map(x => x[j]).sort((a, b) => a - b); return v[v.length >> 1]; });
    return this;
  }

  // Path length of x in one tree (+ the expected rest of the path in a leaf holding several points).
  pathLength(tree, x) {
    let n = 0, depth = 0;
    while (tree.feature[n] !== -1) {
      n = x[tree.feature[n]] < tree.split[n] ? tree.left[n] : tree.right[n];
      depth++;
    }
    return depth + c(tree.size[n]);
  }

  score(x) {
    let sum = 0;
    for (const t of this.forest) sum += this.pathLength(t, x);
    return Math.pow(2, -(sum / this.forest.length) / c(this.params.sample));
  }

  // BaseModel contract: value = anomaly score 0..1; confidence = how far above ordinary (0.5) it is.
  predict(x) {
    const s = this.score(x);
    return { value: s, confidence: Math.max(0, Math.min(1, (s - 0.5) / 0.25)) };
  }

  // [{ factor, index, weight }]: weight = score drop when that feature takes its ordinary value
  // (typical: one value per feature, default the training medians), largest first.
  explain(x, { typical = this.typical } = {}) {
    const s = this.score(x);
    const names = this.params.features || [];
    return x.map((v, j) => {
      const y = x.slice();
      y[j] = typical[j];
      return { factor: names[j] || j, index: j, weight: s - this.score(y) };
    }).sort((a, b) => b.weight - a.weight);
  }

  // Labelled rows [{ x, y }] (y = 1 anomalous) -> ROC AUC of the score and precision in the top k.
  evaluate(rows, k = 50) {
    const scored = rows.map(r => ({ s: this.score(r.x), y: r.y ? 1 : 0 })).sort((a, b) => b.s - a.s);
    const pos = scored.filter(r => r.y).length, neg = scored.length - pos;
    // AUC: for each anomalous row, the share of ordinary rows scored lower.
    let auc = 0, seenNeg = 0;
    for (const r of scored.slice().reverse()) { if (r.y) auc += seenNeg; else seenNeg++; }
    return { auc: pos && neg ? auc / (pos * neg) : null, precision_at_k: scored.slice(0, k).filter(r => r.y).length / Math.min(k, scored.length), k, n: scored.length };
  }

  // Trees are rebuilt from the register each run (seeded); only the settings are saved.
  toJSON() { return { ...this.params }; }
}

module.exports = { IsolationForest, c, rng };
