// Multinomial Naive Bayes over sparse feature counts (Map feature -> count), from scratch.
//
//   P(class | doc) ∝ P(class) · Π_f P(f | class)^n_f,   P(f | c) = (count(f, c) + α) / (total(c) + α·V)
//
// Only (feature, class) pairs seen in training are stored. Scores are computed in log space as
// "every feature unseen" plus a correction for the seen pairs, so prediction costs O(features in
// the document × classes that feature occurred in). Probabilities are softmax(scores / T), where
// the temperature T is fitted on held-out data (Naive Bayes is notoriously over-confident).
const BaseModel = require('./baseModel');
const metrics = require('../eval/metrics');
const { describeFeature } = require('./text/tokenize');

function softmax(scores, T = 1) {
  let max = -Infinity;
  for (const s of scores) if (s / T > max) max = s / T;
  const e = scores.map(s => Math.exp(s / T - max));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / z);
}

class NaiveBayes extends BaseModel {
  static modelName = 'naive_bayes';

  // docs: Map[] ; labels: string[] (same length). minDocFreq drops rare features.
  train(docs, labels, { alpha = 0.5, minDocFreq = 1 } = {}) {
    const classes = [...new Set(labels.map(String))];
    const ci = new Map(classes.map((c, i) => [c, i]));
    const classDocs = new Array(classes.length).fill(0);
    const counts = new Map(); // feature -> Map(classIdx -> count)
    const df = new Map();
    docs.forEach((doc, i) => {
      const c = ci.get(String(labels[i]));
      classDocs[c]++;
      for (const [f, n] of doc) {
        let m = counts.get(f);
        if (!m) { m = new Map(); counts.set(f, m); }
        m.set(c, (m.get(c) || 0) + n);
        df.set(f, (df.get(f) || 0) + 1);
      }
    });
    const feats = {};
    const totals = new Array(classes.length).fill(0);
    for (const [f, m] of counts) {
      if (df.get(f) < minDocFreq) continue;
      feats[f] = [...m].map(([c, n]) => { totals[c] += n; return [c, n]; });
    }
    const V = Object.keys(feats).length;
    this.params = {
      classes, alpha, vocab: V, temperature: 1,
      logPrior: classDocs.map(n => Math.log(n / docs.length)),
      logDenom: totals.map(t => Math.log(t + alpha * V)),
      feats
    };
    this._index = null;
    return this;
  }

  get index() {
    if (!this._index) this._index = new Map(Object.entries(this.params.feats));
    return this._index;
  }

  // Raw log scores per class.
  scores(doc) {
    const { logPrior, logDenom, alpha } = this.params;
    const la = Math.log(alpha);
    const s = logPrior.slice();
    let n = 0;
    for (const [f, cnt] of doc) {
      const pairs = this.index.get(f);
      if (!pairs) continue; // unseen feature: ignored for every class alike
      n += cnt;
      for (const [c, k] of pairs) s[c] += cnt * (Math.log(k + alpha) - la);
    }
    for (let c = 0; c < s.length; c++) s[c] += n * (la - logDenom[c]);
    return s;
  }

  proba(doc, T = this.params.temperature) { return softmax(this.scores(doc), T); }

  // Top-k [{ value, p }] best first.
  rank(doc, k = 3) {
    const p = this.proba(doc);
    return p.map((x, i) => ({ value: this.params.classes[i], p: x })).sort((a, b) => b.p - a.p).slice(0, k);
  }

  predict(doc) {
    const [best] = this.rank(doc, 1);
    return { value: best.value, confidence: best.p };
  }

  // Features that most favour the predicted class over the runner-up.
  explain(doc, k = 3) {
    const top = this.rank(doc, 2);
    if (top.length < 2) return [];
    const { classes, alpha, logDenom } = this.params;
    const a = classes.indexOf(top[0].value), b = classes.indexOf(top[1].value);
    const out = [];
    for (const [f, n] of doc) {
      const pairs = this.index.get(f);
      if (!pairs) continue;
      let ka = 0, kb = 0;
      for (const [c, cnt] of pairs) { if (c === a) ka = cnt; if (c === b) kb = cnt; }
      const w = n * ((Math.log(ka + alpha) - logDenom[a]) - (Math.log(kb + alpha) - logDenom[b]));
      if (w > 0) out.push({ factor: f, text: describeFeature(f), weight: w });
    }
    return out.sort((x, y) => y.weight - x.weight).slice(0, k);
  }

  evaluate(docs, labels) {
    return metrics.classification(labels.map(String), docs.map(d => this.predict(d).value));
  }

  // Temperature minimising held-out log loss (grid over 0.25 .. 400, log-spaced).
  fitTemperature(docs, labels) {
    const raw = docs.map(d => this.scores(d));
    const idx = labels.map(l => this.params.classes.indexOf(String(l)));
    let best = { T: 1, nll: Infinity };
    for (let e = -2; e <= 8.65; e += 0.05) {
      const T = 2 ** e;
      let nll = 0;
      for (let i = 0; i < raw.length; i++) {
        const p = idx[i] < 0 ? 1e-12 : softmax(raw[i], T)[idx[i]];
        nll -= Math.log(Math.max(1e-12, p));
      }
      if (nll < best.nll) best = { T, nll };
    }
    this.params.temperature = best.T;
    return best.T;
  }
}

module.exports = NaiveBayes;
module.exports.softmax = softmax;
