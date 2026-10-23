// Time-based evaluation of the intake classifier on the real register: train on assets bought
// before the cut-off date, test on assets bought on or after it (what a model faces when new
// purchases arrive). Model matching uses the whole current catalog, as it would at intake time.
// Read-only: SELECTs only, inside a READ ONLY transaction.
const db = require('../../core/db');
const IntakeClassifier = require('../intake/classifier');
const { CatalogMatcher } = require('../intake/modelMatcher');
const { loadRows, loadCatalog, labelNames } = require('../intake/data');

async function run({ cutoff = '2024-01-01' } = {}) {
  const t0 = Date.now();
  const { rows, catalog, names } = await db.tx(async t => {
    await t.run('SET TRANSACTION READ ONLY');
    return { rows: await loadRows(t), catalog: await loadCatalog(t), names: await labelNames(t) };
  });
  const train = rows.filter(r => r.purchase_date && r.purchase_date < cutoff);
  const test = rows.filter(r => r.purchase_date && r.purchase_date >= cutoff);
  const m = new IntakeClassifier().train(train, { catalog });
  const trainedMs = Date.now() - t0;
  const result = m.evaluate(test, { matcher: new CatalogMatcher(catalog) });
  for (const k of ['category', 'manufacturer']) {
    if (result[k].perClass) result[k].perClass = Object.fromEntries(Object.entries(result[k].perClass).map(([id, v]) => [names[k][id] || id, v]));
  }
  const size = Buffer.byteLength(JSON.stringify(m.toJSON()));
  return { cutoff, trainRows: train.length, testRows: test.length, trainedMs, paramsBytes: size, selection: m.trainingMetrics, test: result };
}

const pct = x => (x * 100).toFixed(1) + '%';

function format(r) {
  const lines = [`Intake classifier, time split at ${r.cutoff}: train ${r.trainRows} assets (older), test ${r.testRows} (newer).`,
    `Training ${(r.trainedMs / 1000).toFixed(1)} s, saved model ${(r.paramsBytes / 1e6).toFixed(1)} MB.`, '',
    'head          method        accuracy  macro-F1  top-3   ECE    precision when confidence >= 0.9 (share of answers)'];
  for (const [k, v] of Object.entries(r.test)) {
    const method = k === 'model' ? 'catalog' : r.selection[k].chosen;
    lines.push(`${k.padEnd(13)} ${method.padEnd(13)} ${pct(v.accuracy).padEnd(9)} ${pct(v.macroF1).padEnd(9)} ${pct(v.top3).padEnd(7)} ${v.calibrationError.toFixed(3).padEnd(6)} ${pct(v.at90.precision)} (${pct(v.at90.coverage)})`);
  }
  lines.push('', 'Model selection on the newest 10% of the training slice (macro-F1):');
  for (const k of ['category', 'manufacturer']) {
    const v = r.selection[k];
    lines.push(`  ${k}: ` + Object.entries(v.candidates).map(([c, s]) => `${c} ${pct(s.macroF1)}`).join(', ') + ` -> ${v.chosen}, temperature ${v.temperature.toFixed(2)}`);
  }
  for (const k of ['category', 'manufacturer']) {
    if (!r.test[k].perClass) continue;
    lines.push('', `${k} per class (test): ` + Object.entries(r.test[k].perClass).sort((a, b) => b[1].support - a[1].support)
      .map(([n, v]) => `${n} n=${v.support} P=${pct(v.precision)} R=${pct(v.recall)}`).join('; '));
  }
  return lines.join('\n');
}

module.exports = { run, format };
