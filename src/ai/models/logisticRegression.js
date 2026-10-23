// Multinomial (softmax) logistic regression on sparse text features, from scratch.
//
// Features are hashed into `dims` slots (the "hashing trick", so no vocabulary is stored for the
// weights) and weighted TF-IDF style: (1 + log n) · idf, then L2-normalised per document.
// Trained by stochastic gradient descent with AdaGrad step sizes and L2 regularisation, a fixed
// number of passes over the shuffled data (seeded, so training is reproducible).
const BaseModel = require('./baseModel');
const metrics = require('../eval/metrics');
const { fnv1a } = require('./text/minhash');
const { describeFeature } = require('./text/tokenize');
const { softmax } = require('./naiveBayes');

class LogisticRegression extends BaseModel {
  static modelName = 'logistic_regression';

  train(docs, labels, { dims = 1 << 17, epochs = 6, lr = 0.5, l2 = 1e-6, seed = 7 } = {}) {
    const classes = [...new Set(labels.map(String))];
    const K = classes.length;
    const ci = new Map(classes.map((c, i) => [c, i]));
    const df = new Map();
    for (const d of docs) for (const f of d.keys()) df.set(f, (df.get(f) || 0) + 1);
    const N = docs.length;
    const idf = {};
    for (const [f, n] of df) idf[f] = Math.round((Math.log((N + 1) / (n + 1)) + 1) * 1e4) / 1e4;
    this.params = { classes, dims, idf, unseenIdf: Math.log(N + 1) + 1, temperature: 1 };
    const X = docs.map(d => this.vectorize(d));
    const y = labels.map(l => ci.get(String(l)));

    const W = new Float32Array(K * dims);
    const G = new Float32Array(K * dims);
    const b = new Float64Array(K);
    const Gb = new Float64Array(K);
    let state = seed >>> 0;
    const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const order = X.map((_, i) => i);
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (const i of order) {
        const { idx, val } = X[i];
        const z = new Float64Array(K);
        for (let k = 0; k < K; k++) {
          let s = b[k];
          const off = k * dims;
          for (let t = 0; t < idx.length; t++) s += W[off + idx[t]] * val[t];
          z[k] = s;
        }
        const p = softmax(Array.from(z));
        for (let k = 0; k < K; k++) {
          const g = p[k] - (y[i] === k ? 1 : 0);
          Gb[k] += g * g;
          b[k] -= (lr / Math.sqrt(Gb[k] + 1e-8)) * g;
          const off = k * dims;
          for (let t = 0; t < idx.length; t++) {
            const j = off + idx[t];
            const gw = g * val[t] + l2 * W[j];
            G[j] += gw * gw;
            W[j] -= (lr / Math.sqrt(G[j] + 1e-8)) * gw;
          }
        }
      }
    }
    // Keep only slots that were used (sparse), rounded to keep the saved model small.
    const w = {};
    for (let j = 0; j < dims; j++) {
      let used = false;
      for (let k = 0; k < K; k++) if (W[k * dims + j] !== 0) { used = true; break; }
      if (used) w[j] = Array.from({ length: K }, (_, k) => Math.round(W[k * dims + j] * 1e5) / 1e5);
    }
    this.params.bias = Array.from(b, x => Math.round(x * 1e5) / 1e5);
    this.params.w = w;
    return this;
  }

  vectorize(doc) {
    const { dims, idf, unseenIdf } = this.params;
    const acc = new Map();
    for (const [f, n] of doc) {
      const v = (1 + Math.log(n)) * (idf[f] ?? unseenIdf);
      const j = fnv1a(f) % dims;
      acc.set(j, (acc.get(j) || 0) + v);
    }
    let norm = 0;
    for (const v of acc.values()) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return { idx: Int32Array.from(acc.keys()), val: Float64Array.from([...acc.values()].map(v => v / norm)) };
  }

  scores(doc) {
    const { classes, bias, w } = this.params;
    const { idx, val } = this.vectorize(doc);
    const s = bias.slice();
    for (let t = 0; t < idx.length; t++) {
      const ws = w[idx[t]];
      if (ws) for (let k = 0; k < classes.length; k++) s[k] += ws[k] * val[t];
    }
    return s;
  }

  proba(doc, T = this.params.temperature) { return softmax(this.scores(doc), T); }

  rank(doc, k = 3) {
    const p = this.proba(doc);
    return p.map((x, i) => ({ value: this.params.classes[i], p: x })).sort((a, b) => b.p - a.p).slice(0, k);
  }

  predict(doc) {
    const [best] = this.rank(doc, 1);
    return { value: best.value, confidence: best.p };
  }

  explain(doc, k = 3) {
    const top = this.rank(doc, 2);
    if (top.length < 2) return [];
    const { classes, dims, w, idf, unseenIdf } = this.params;
    const a = classes.indexOf(top[0].value), b = classes.indexOf(top[1].value);
    const out = [];
    for (const [f, n] of doc) {
      const ws = w[fnv1a(f) % dims];
      if (!ws) continue;
      const v = (1 + Math.log(n)) * (idf[f] ?? unseenIdf);
      const weight = v * (ws[a] - ws[b]);
      if (weight > 0) out.push({ factor: f, text: describeFeature(f), weight });
    }
    return out.sort((x, y) => y.weight - x.weight).slice(0, k);
  }

  evaluate(docs, labels) {
    return metrics.classification(labels.map(String), docs.map(d => this.predict(d).value));
  }

  fitTemperature(docs, labels) {
    return require('./naiveBayes').prototype.fitTemperature.call(this, docs, labels);
  }
}

module.exports = LogisticRegression;
