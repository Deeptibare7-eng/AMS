// Category consistency: does each asset's category agree with what its name, model number and
// serial say? Out-of-fold: assets are split into 5 folds by id; each fold is predicted by a model
// trained on the other four, so an asset is never judged by a model that learnt its own label.
// Runs in a worker thread (worker.js task "categoryOutOfFold").
const LogisticRegression = require('../models/logisticRegression');
const { assetFeatures } = require('../models/text/tokenize');

const FOLDS = 5;
const OPTS = { dims: 1 << 17, epochs: 5 };

// rows: [{ id, name, model_number, serial_number, category_id }] -> mismatches
// [{ id, predicted, p, why: [{ factor, text }] }] where the prediction differs with p >= minP.
function outOfFold({ rows, temperature = 0.35, minP = 0.8 }) {
  const labelled = rows.filter(r => r.category_id !== null && r.category_id !== undefined);
  const docs = labelled.map(r => assetFeatures(r));
  const out = [];
  for (let f = 0; f < FOLDS; f++) {
    const trainIdx = [], testIdx = [];
    labelled.forEach((r, i) => (r.id % FOLDS === f ? testIdx : trainIdx).push(i));
    if (!trainIdx.length || !testIdx.length) continue;
    const m = new LogisticRegression().train(trainIdx.map(i => docs[i]), trainIdx.map(i => String(labelled[i].category_id)), OPTS);
    m.params.temperature = temperature;
    for (const i of testIdx) {
      const [best] = m.rank(docs[i], 1);
      if (best.value !== String(labelled[i].category_id) && best.p >= minP) {
        out.push({ id: labelled[i].id, predicted: best.value, p: best.p, why: m.explain(docs[i], 3).map(w => ({ factor: w.factor, text: w.text })) });
      }
    }
  }
  return out;
}

module.exports = { outOfFold };
