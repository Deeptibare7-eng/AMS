// Catalog model matching: which Asset Model (Inventory Setup catalog) does the typed text mean?
// A classifier can't do this: most new purchases are models that didn't exist last year. The
// catalog does list them, so we match against it instead.
//
// Each catalog model becomes a TF-IDF vector of words and character 3-4-grams of its name and
// model number (idf over the catalog). The query is vectorised the same way and scored by cosine
// similarity through an inverted index (only models sharing a feature are touched). The score and
// the margin over the runner-up are turned into a probability of being right with Platt scaling,
// a two-input logistic model fitted on past assets whose model is known.
const { normalize, words, charNgrams } = require('../models/text/tokenize');

function features(text) {
  const f = new Map();
  for (const w of words(text)) f.set('w:' + w, (f.get('w:' + w) || 0) + 1);
  for (const g of charNgrams(text, 3, 4)) f.set('c:' + g, (f.get('c:' + g) || 0) + 1);
  const joined = normalize(text).replace(/ /g, '');
  if (joined) f.set('j:' + joined, 1);
  return f;
}

class CatalogMatcher {
  // models: [{ id, name, model_number, manufacturer_id }]
  constructor(models) {
    this.models = models.map(m => ({ ...m, id: String(m.id), manufacturer_id: m.manufacturer_id === null || m.manufacturer_id === undefined ? null : String(m.manufacturer_id) }));
    const docs = this.models.map(m => features(`${m.name || ''} ${m.model_number && m.model_number !== m.name ? m.model_number : ''}`));
    const df = new Map();
    for (const d of docs) for (const k of d.keys()) df.set(k, (df.get(k) || 0) + 1);
    const N = docs.length;
    this.idf = new Map([...df].map(([k, n]) => [k, Math.log((N + 1) / (n + 1)) + 1]));
    this.index = new Map(); // feature -> [[modelIdx, weight]]
    docs.forEach((d, i) => {
      const v = this.weigh(d);
      for (const [k, w] of v) {
        if (!this.index.has(k)) this.index.set(k, []);
        this.index.get(k).push([i, w]);
      }
    });
  }

  weigh(doc) {
    const v = new Map();
    let norm = 0;
    for (const [k, n] of doc) {
      const idf = this.idf.get(k);
      if (!idf) continue;
      const w = (1 + Math.log(n)) * idf;
      v.set(k, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, w] of v) v.set(k, w / norm);
    return v;
  }

  // -> [{ id, name, score }] best first. manufacturerId (optional) keeps that maker's models only.
  match(text, { manufacturerId = null, k = 3 } = {}) {
    const q = this.weigh(features(text));
    const acc = new Map();
    for (const [f, w] of q) {
      for (const [i, mw] of this.index.get(f) || []) acc.set(i, (acc.get(i) || 0) + w * mw);
    }
    const maker = manufacturerId === null || manufacturerId === undefined || manufacturerId === '' ? null : String(manufacturerId);
    return [...acc].filter(([i]) => !maker || this.models[i].manufacturer_id === maker)
      .sort((a, b) => b[1] - a[1]).slice(0, k)
      .map(([i, s]) => ({ id: this.models[i].id, name: this.models[i].name, score: Math.min(1, s) }));
  }
}

const sigmoid = z => 1 / (1 + Math.exp(-z));
const plattInputs = ranked => [ranked[0] ? ranked[0].score : 0, ranked[0] ? ranked[0].score - (ranked[1] ? ranked[1].score : 0) : 0];

// Platt scaling: P(top match is right) = sigmoid(a·score + b·margin + c), fitted by gradient descent
// on the log loss. samples: [{ ranked, truth }].
function fitPlatt(samples, { epochs = 300, lr = 0.5 } = {}) {
  let a = 1, b = 1, c = 0;
  const X = samples.map(s => plattInputs(s.ranked));
  const y = samples.map(s => (s.ranked[0] && s.ranked[0].id === String(s.truth) ? 1 : 0));
  for (let e = 0; e < epochs; e++) {
    let ga = 0, gb = 0, gc = 0;
    for (let i = 0; i < X.length; i++) {
      const g = sigmoid(a * X[i][0] + b * X[i][1] + c) - y[i];
      ga += g * X[i][0]; gb += g * X[i][1]; gc += g;
    }
    const n = X.length || 1;
    a -= lr * ga / n * 10; b -= lr * gb / n * 10; c -= lr * gc / n * 10;
  }
  return [a, b, c];
}

function confidence(platt, ranked) {
  if (!ranked.length) return 0;
  const [s, m] = plattInputs(ranked);
  return sigmoid(platt[0] * s + platt[1] * m + platt[2]);
}

module.exports = { CatalogMatcher, fitPlatt, confidence, features };
