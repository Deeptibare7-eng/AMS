// Trains the intake classifier from the register (read-only) in a worker thread, saves the new
// version in the model registry and activates it when nothing is active yet or when it scores at
// least as well on held-out data (newest 10% of assets) as the active version, within 0.01 macro-F1.
const db = require('../../core/db');
const worker = require('../worker');
const registry = require('../governance/registry');
const IntakeClassifier = require('./classifier');
const { loadRows, loadCatalog } = require('./data');

const MIN_ROWS = 30;
const score = m => (m && typeof m.category_macroF1 === 'number' ? (m.category_macroF1 + m.manufacturer_macroF1) / 2 : -1);

async function train({ trigger = 'schedule', user = null } = {}) {
  const t0 = Date.now();
  const { rows, catalog } = await db.tx(async t => {
    await t.run('SET TRANSACTION READ ONLY');
    return { rows: await loadRows(t), catalog: await loadCatalog(t) };
  });
  if (rows.length < MIN_ROWS) return { skipped: true, summary: `Not trained: ${rows.length} assets (needs ${MIN_ROWS}+).` };
  const { params, metrics } = await worker.run('trainIntake', { rows, catalog });
  const model = IntakeClassifier.fromJSON(params);
  const flat = {
    category_accuracy: metrics.category.validation.accuracy, category_macroF1: metrics.category.validation.macroF1,
    manufacturer_accuracy: metrics.manufacturer.validation.accuracy, manufacturer_macroF1: metrics.manufacturer.validation.macroF1
  };
  const version = await registry.save(model, {
    metrics: flat, userId: user ? user.id : null,
    training: { trigger, rows: rows.length, catalog_models: catalog.length, validation: 'newest 10% of assets by purchase date', heads: metrics, ms: Date.now() - t0 }
  });
  const active = (await registry.list(IntakeClassifier.modelName)).find(r => r.status === 'active');
  const better = !active || score(flat) >= score(active.metrics) - 0.01;
  if (better) await registry.activate(IntakeClassifier.modelName, version, user);
  require('./suggest').invalidate();
  const pct = x => (x * 100).toFixed(1) + '%';
  return {
    version, activated: better, metrics: flat,
    summary: `Intake model v${version} (${trigger}): category ${pct(flat.category_accuracy)} / manufacturer ${pct(flat.manufacturer_accuracy)} correct on the newest 10%; `
      + (better ? 'activated' : `kept v${active.version} active (it scores better)`) + `; ${((Date.now() - t0) / 1000).toFixed(1)} s.`
  };
}

module.exports = { train };
