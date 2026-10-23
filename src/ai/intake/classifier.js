// Intake classifier: from what someone types on Register Asset (name, model number, serial),
// suggest the category, manufacturer and catalog model.
//
// - Category and manufacturer: one classifier "head" each. A head trains Naive Bayes and logistic
//   regression on the older 90% of assets (by purchase date), keeps whichever scores the higher
//   macro-F1 on the newest 10%, fits its confidence temperature there, then retrains the winner on
//   every asset.
// - Model: matched against the Asset Models catalog (modelMatcher.js), because most new purchases
//   are models no earlier asset had. Only the Platt calibration of the match score is learnt here;
//   the catalog itself is read fresh at prediction time.
// Rows are plain objects so training can run in a worker thread.
const BaseModel = require('../models/baseModel');
const NaiveBayes = require('../models/naiveBayes');
const LogisticRegression = require('../models/logisticRegression');
const metrics = require('../eval/metrics');
const { assetFeatures } = require('../models/text/tokenize');
const { CatalogMatcher, fitPlatt, confidence } = require('./modelMatcher');

const HEADS = [
  { key: 'category', field: 'category_id' },
  { key: 'manufacturer', field: 'manufacturer_id' }
];
const KINDS = { nb: NaiveBayes, logreg: LogisticRegression };
const LOGREG_OPTS = { dims: 1 << 17, epochs: 5 };
const PLATT_SAMPLE = 6000;

const docOf = r => assetFeatures(r);
// Reasons people can read: whole words, model numbers and serial patterns first; letter
// fragments ("la", "itu") only when nothing better explains the answer.
const readable = why => {
  const words = why.filter(w => !w.factor.startsWith('c:'));
  return (words.length >= 2 ? words : [...words, ...why.filter(w => w.factor.startsWith('c:'))]).slice(0, 3);
};
const queryOf = r => `${r.name || ''} ${r.model_number || ''}`;
const dateKey = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || ''));
const byTime = (a, b) => dateKey(a.purchase_date).localeCompare(dateKey(b.purchase_date)) || (a.id - b.id);

function fitHead(rows, head, { validationShare = 0.1 } = {}) {
  const labelled = rows.filter(r => r[head.field] !== null && r[head.field] !== undefined).sort(byTime);
  const cut = Math.floor(labelled.length * (1 - validationShare));
  const train = labelled.slice(0, cut), val = labelled.slice(cut);
  const docs = r => r.map(docOf), labels = r => r.map(x => String(x[head.field]));
  const trainDocs = docs(train), valDocs = docs(val);
  const candidates = {};
  for (const kind of ['nb', 'logreg']) {
    const m = new KINDS[kind]().train(trainDocs, labels(train), kind === 'logreg' ? LOGREG_OPTS : {});
    // Labels first seen in the validation slice can't be predicted; they still count as errors.
    candidates[kind] = { model: m, val: m.evaluate(valDocs, labels(val)) };
  }
  const chosen = Object.keys(candidates).sort((a, b) => candidates[b].val.macroF1 - candidates[a].val.macroF1 || (a === 'nb' ? -1 : 1))[0];
  const temperature = candidates[chosen].model.fitTemperature(valDocs, labels(val));
  const final = new KINDS[chosen]().train(docs(labelled), labels(labelled), chosen === 'logreg' ? LOGREG_OPTS : {});
  final.params.temperature = temperature;
  const v = candidates[chosen].val;
  return {
    head: { kind: chosen, params: final.toJSON() },
    metrics: {
      chosen, rows: labelled.length, classes: final.params.classes.length, temperature,
      validation: { n: v.n, accuracy: v.accuracy, macroF1: v.macroF1, weightedF1: v.weightedF1 },
      candidates: Object.fromEntries(Object.entries(candidates).map(([k, c]) => [k, { macroF1: c.val.macroF1, accuracy: c.val.accuracy }]))
    }
  };
}

// Evenly spaced sample (deterministic).
function sample(rows, n) {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * step)]);
}

class IntakeClassifier extends BaseModel {
  static modelName = 'intake_classifier';

  // rows: [{ id, name, model_number, serial_number, category_id, manufacturer_id, asset_model_id, purchase_date }]
  // catalog: [{ id, name, model_number, manufacturer_id }] (Asset Models)
  train(rows, { catalog = [], ...opts } = {}) {
    const heads = {}, m = {};
    for (const h of HEADS) {
      const r = fitHead(rows, h, opts);
      heads[h.key] = r.head;
      m[h.key] = r.metrics;
    }
    const matcher = new CatalogMatcher(catalog);
    const samples = sample(rows.filter(r => r.asset_model_id), PLATT_SAMPLE)
      .map(r => ({ ranked: matcher.match(queryOf(r), { k: 2 }), truth: r.asset_model_id }));
    const platt = fitPlatt(samples);
    m.model = { method: 'catalog match', catalogModels: catalog.length, calibrationRows: samples.length, platt };
    this.params = { heads, platt, trainedRows: rows.length };
    this.trainingMetrics = m;
    this._heads = null;
    return this;
  }

  head(key) {
    if (!this._heads) {
      this._heads = {};
      for (const [k, h] of Object.entries(this.params.heads)) this._heads[k] = KINDS[h.kind].fromJSON(h.params);
    }
    return this._heads[key];
  }

  // -> { category: { value, confidence, top, why }, manufacturer: ..., model: ... (when a matcher is given) }
  predict(input, { matcher = null, manufacturerId = null, top = 3 } = {}) {
    const doc = docOf(input);
    const out = {};
    for (const { key } of HEADS) {
      const h = this.head(key);
      const ranked = h.rank(doc, top);
      out[key] = { value: ranked[0].value, confidence: ranked[0].p, top: ranked, why: readable(h.explain(doc, 10)) };
    }
    if (matcher) {
      const ranked = matcher.match(queryOf(input), { manufacturerId, k: top });
      if (ranked.length) {
        out.model = {
          value: ranked[0].id, confidence: confidence(this.params.platt, ranked),
          top: ranked.map(r => ({ value: r.id, p: r.score })),
          why: [{ factor: 'match', text: `the text matches catalog model "${ranked[0].name}" (${Math.round(ranked[0].score * 100)}% similar)`, weight: ranked[0].score }]
        };
      }
    }
    return out;
  }

  explain(input, key = 'category') { return readable(this.head(key).explain(docOf(input), 10)); }

  // Per head: accuracy, macro-F1, top-3, calibration error, precision of confident answers.
  evaluate(rows, { matcher = null } = {}) {
    const out = {};
    const score = (truth, ranked) => {
      const pred = ranked.map(k => (k[0] ? k[0].value : null)), conf = ranked.map(k => (k[0] ? k[0].p : 0));
      const correct = pred.map((p, i) => p === truth[i]);
      const c = metrics.classification(truth, pred.map(p => p ?? '-'));
      const small = Object.keys(c.perClass).length <= 30;
      return {
        n: truth.length, accuracy: c.accuracy, macroF1: c.macroF1, weightedF1: c.weightedF1,
        top3: metrics.topK(truth, ranked.map(k => k.map(x => x.value)), 3),
        calibrationError: metrics.calibrationError(conf, correct),
        at90: metrics.precisionAtConfidence(conf, correct, 0.9),
        ...(small ? { perClass: Object.fromEntries(Object.entries(c.perClass).map(([k, s]) => [k, { support: s.support, precision: s.precision, recall: s.recall, f1: s.f1 }])) } : {})
      };
    };
    for (const h of HEADS) {
      const r = rows.filter(x => x[h.field] !== null && x[h.field] !== undefined);
      const truth = r.map(x => String(x[h.field]));
      out[h.key] = score(truth, r.map(x => this.head(h.key).rank(docOf(x), 3)));
      out[h.key].unseenLabels = truth.filter(t => !this.params.heads[h.key].params.classes.includes(t)).length;
    }
    if (matcher) {
      const r = rows.filter(x => x.asset_model_id);
      out.model = score(r.map(x => String(x.asset_model_id)), r.map(x => {
        const ranked = matcher.match(queryOf(x), { k: 3 });
        const c = confidence(this.params.platt, ranked);
        return ranked.map((m, i) => ({ value: m.id, p: i === 0 ? c : m.score }));
      }));
    }
    return out;
  }
}

// Worker-thread entry: plain rows in, plain params + metrics out.
function trainParams({ rows, catalog }) {
  const m = new IntakeClassifier().train(rows, { catalog });
  return { params: m.toJSON(), metrics: m.trainingMetrics };
}

module.exports = IntakeClassifier;
module.exports.trainParams = trainParams;
module.exports.HEADS = HEADS;
module.exports.queryOf = queryOf;
