// Register Asset suggestions: category, manufacturer and catalog model from the typed text, plus
// the usual warranty, supplier and cost for that model. Each suggestion carries a confidence and a
// plain-language reason; the form only fills a field when the user clicks the suggestion.
// The active model, the catalog matcher and the name lists are cached in memory.
const db = require('../../core/db');
const IntakeClassifier = require('./classifier');
const { CatalogMatcher } = require('./modelMatcher');
const { loadCatalog } = require('./data');
const defaults = require('./defaults');

const SHOW_AT = 0.5;       // below this confidence a suggestion is not shown
const DEFAULTS_AT = 0.8;   // a predicted model must be this sure before its defaults are offered
let cache = { model: null, checkedAt: 0, version: null, matcher: null, matcherAt: 0, names: null, namesAt: 0 };

function invalidate() { cache = { model: null, checkedAt: 0, version: null, matcher: null, matcherAt: 0, names: null, namesAt: 0 }; }

async function activeModel() {
  if (Date.now() - cache.checkedAt > 60000) {
    cache.checkedAt = Date.now();
    const row = await db.get(`SELECT version FROM ai_models WHERE name = $1 AND status = 'active'`, [IntakeClassifier.modelName]);
    if (!row) { cache.model = null; cache.version = null; }
    else if (row.version !== cache.version) { cache.model = await IntakeClassifier.load(); cache.version = row.version; }
  }
  return cache.model;
}

async function matcher() {
  if (!cache.matcher || Date.now() - cache.matcherAt > 300000) {
    cache.matcher = new CatalogMatcher(await loadCatalog(db));
    cache.matcherAt = Date.now();
  }
  return cache.matcher;
}

async function names() {
  if (!cache.names || Date.now() - cache.namesAt > 300000) {
    const map = rows => Object.fromEntries(rows.map(r => [String(r.id), r.name]));
    cache.names = {
      category: map(await db.query('SELECT id, name FROM asset_categories WHERE deleted_at IS NULL')),
      manufacturer: map(await db.query('SELECT id, name FROM manufacturers WHERE deleted_at IS NULL')),
      model: map(await db.query('SELECT id, name FROM asset_models WHERE deleted_at IS NULL'))
    };
    cache.namesAt = Date.now();
  }
  return cache.names;
}

const reasons = why => (why || []).map(w => w.text).filter((t, i, a) => a.indexOf(t) === i).slice(0, 3);

// input: { name, model_number, serial_number, manufacturer_id, asset_model_id, location_id }
async function suggest(input) {
  const model = await activeModel();
  if (!model) return { ready: false, message: 'The intake model has not been trained yet (Settings > AI).' };
  const text = `${input.name || ''} ${input.model_number || ''}`.trim();
  const out = { ready: true, version: cache.version, suggestions: [] };
  const n = await names();
  if (text.length >= 3) {
    const p = model.predict(input, { matcher: await matcher(), manufacturerId: input.manufacturer_id || null });
    const add = (field, head, label) => {
      const h = p[head];
      if (!h || h.confidence < SHOW_AT || !label(h.value)) return;
      out.suggestions.push({ field, value: h.value, label: label(h.value), confidence: Math.round(h.confidence * 100) / 100, why: reasons(h.why) });
    };
    add('category_id', 'category', id => n.category[id]);
    add('manufacturer_id', 'manufacturer', id => n.manufacturer[id]);
    add('asset_model_id', 'model', id => n.model[id]);
    if (!input.asset_model_id && p.model && p.model.confidence >= DEFAULTS_AT) input = { ...input, asset_model_id: p.model.value };
  }
  if (input.asset_model_id) {
    const d = await defaults.forModel(db, parseInt(input.asset_model_id, 10), parseInt(input.location_id, 10) || null);
    const modelName = n.model[String(input.asset_model_id)] || 'this model';
    if (d.warranty) out.suggestions.push({ field: 'warranty_months', value: d.warranty.months, label: `${d.warranty.months} months`, confidence: Math.round(d.warranty.confidence * 100) / 100, why: [`${d.warranty.why} (${modelName})`] });
    if (d.supplier) out.suggestions.push({ field: 'supplier_id', value: d.supplier.id, label: d.supplier.name, confidence: Math.round(d.supplier.confidence * 100) / 100, why: [`${d.supplier.why} (${modelName})`] });
    if (d.cost) out.suggestions.push({ field: 'purchase_cost', value: d.cost.value, label: '₹' + d.cost.value.toLocaleString('en-IN'), confidence: Math.round(d.cost.confidence * 100) / 100, why: [`${d.cost.why} (${modelName})`] });
  }
  return out;
}

module.exports = { suggest, invalidate, activeModel };
