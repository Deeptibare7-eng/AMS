// Intent of a question in plain language, from its masked form ("how many CAT are STATUS at PLACE").
// Our own classifiers (models/naiveBayes.js, models/logisticRegression.js) on word and word-pair
// features, trained on the seed set; the one with the better 5-fold cross-validated macro-F1 wins and
// its confidence is calibrated (temperature). Retrained whenever the seed set changes (SEED_VERSION).
// Questions mostly made of words the seed set never uses ("what is the weather today") are pushed
// towards "unknown": the confidence is multiplied by the share of known words.
const BaseModel = require('../models/baseModel');
const NaiveBayes = require('../models/naiveBayes');
const LogisticRegression = require('../models/logisticRegression');
const metrics = require('../eval/metrics');
const { stem } = require('../search/analyzer');
const seed = require('./seed');

const PLACEHOLDERS = new Set(['CAT', 'PLACE', 'STATUS', 'MAKER', 'MODEL', 'HOLDER', 'ASSET', 'WARRANTY', 'AGE', 'RAM', 'OS', 'SORT', 'NUM', 'ISSUE']);
// Filler words: they say nothing about what is asked, so they don't count towards "known".
const FILLER = new Set(('a an the and or of in on at to for with by from is are be was were it its me my i we our us you your '
  + 'what which who how do does did can could would will should please tell show give get any all there this that these those').split(' '));

function words(masked) {
  return String(masked || '').split(/\s+/).filter(Boolean).map(w => (PLACEHOLDERS.has(w) ? w : stem(w.toLowerCase())));
}

// Map feature -> count: words, word pairs, and which slots are present.
function features(masked) {
  const ws = words(masked);
  const f = new Map();
  const add = k => f.set(k, (f.get(k) || 0) + 1);
  ws.forEach((w, i) => { add('w:' + w); if (i) add('b:' + ws[i - 1] + '_' + w); });
  if (!ws.length) add('w:EMPTY');
  return f;
}

class IntentClassifier extends BaseModel {
  static modelName = 'nl_intent';

  train(rows = seed.rows()) {
    const docs = rows.map(r => features(r.text)), labels = rows.map(r => r.intent);
    const folds = 5;
    const score = Make => {
      const truth = [], pred = [];
      for (let k = 0; k < folds; k++) {
        const tr = docs.filter((_, i) => i % folds !== k), trl = labels.filter((_, i) => i % folds !== k);
        const m = new Make().train(tr, trl);
        docs.forEach((d, i) => { if (i % folds === k) { truth.push(labels[i]); pred.push(m.predict(d).value); } });
      }
      return metrics.classification(truth, pred);
    };
    const cv = { naive_bayes: score(NaiveBayes), logistic_regression: score(LogisticRegression) };
    const kind = cv.logistic_regression.macroF1 > cv.naive_bayes.macroF1 ? 'logistic_regression' : 'naive_bayes';
    const inner = kind === 'logistic_regression' ? new LogisticRegression().train(docs, labels) : new NaiveBayes().train(docs, labels);
    inner.fitTemperature(docs, labels);
    const known = new Set(rows.flatMap(r => words(r.text)));
    this.params = { kind, inner: inner.toJSON(), known: [...known], seed_version: seed.SEED_VERSION };
    this.metrics = { cv_accuracy: cv[kind].accuracy, cv_macroF1: cv[kind].macroF1, nb_macroF1: cv.naive_bayes.macroF1, lr_macroF1: cv.logistic_regression.macroF1, utterances: rows.length };
    this.inner = inner;
    this.known = known;
    return this;
  }

  static fromJSON(params, opts) {
    const m = super.fromJSON(params, opts);
    m.inner = (params.kind === 'logistic_regression' ? LogisticRegression : NaiveBayes).fromJSON(params.inner);
    m.known = new Set(params.known);
    return m;
  }

  // Share of the question's content words (not "what", "is", "the", ...) the seed set knows;
  // placeholders count as known. "tell me a joke": "joke" is unknown -> 0.
  coverage(masked) {
    const ws = words(masked);
    if (!ws.length) return 0;
    const content = ws.filter(w => PLACEHOLDERS.has(w) || !FILLER.has(w));
    const pool = content.length ? content : ws;
    return pool.filter(w => PLACEHOLDERS.has(w) || this.known.has(w)).length / pool.length;
  }

  // { value, confidence, ranked: [{ value, p }] }
  predict(masked) {
    const ranked = this.inner.rank(features(masked), 3);
    const cover = this.coverage(masked);
    return { value: ranked[0].value, confidence: ranked[0].p * cover, ranked, coverage: cover };
  }

  explain(masked) { return this.inner.explain(features(masked), 3); }

  evaluate(rows) {
    return metrics.classification(rows.map(r => r.intent), rows.map(r => this.predict(r.masked || r.text).value));
  }
}

module.exports = { IntentClassifier, features, words, PLACEHOLDERS, FILLER };
