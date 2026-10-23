// Unit tests for M2: data-health rules, duplicates, catalog findings, catalog model matching and
// the intake classifier, on small hand-made examples (no database).
require('./helpers/testDb'); // points any accidental DB use at the test database
const test = require('node:test');
const assert = require('node:assert/strict');
const dup = require('../src/ai/quality/duplicates');
const cat = require('../src/ai/quality/catalog');
const rules = require('../src/ai/quality/rules');
const { buildContext } = require('../src/ai/quality/dataHealth');
const { CatalogMatcher, fitPlatt, confidence } = require('../src/ai/intake/modelMatcher');
const IntakeClassifier = require('../src/ai/intake/classifier');

test('FAMS numbers and host names are recognised, placeholders and notes are not', () => {
  assert.equal(dup.famsNumber('199000201'), '199000201');
  assert.equal(dup.famsNumber('199000202(Onsite confirmation)'), '199000202');
  for (const v of ['Pending', 'PENDING', 'N/A', 'Client Provided', '0', '', null, '10.1.23.87']) assert.equal(dup.famsNumber(v), null, String(v));
  assert.equal(dup.hostname('NGI-CPACSXXL-4-0-1'), 'ngi-cpacsxxl-4-0-1');
  for (const v of ['BL IT Stock 12/01/26', 'Returned to client on 3/5/2019', 'ms-not physically verified', 'Vendor_Shradha', 'tx-imshandover_31/05/2017', 'ab'])
    assert.equal(dup.hostname(v), null, v);
  const shared = dup.sharedValues([{ id: 1, v: 'a' }, { id: 2, v: 'a' }, { id: 3, v: 'b' }, { id: 4, v: null }], r => r.v);
  assert.deepEqual([...shared], [['a', [1, 2]]]);
});

test('catalog: spelling variants yes, different models no', () => {
  const yes = [['optiplex 5050', 'optiplex 5050'], ['hp elite book 840g3', 'hp elitebook 840 g3'], ['thinkcentre m720 tower', 'thinkcenter m720 tower'], ['imac', 'imac']];
  const no = [['latitude e5450', 'latitude 5450'], ['optiplex 760', 'optiplex 760n'], ['thinkpad p14s gen5 type 21me', 'thinkpad p14s gen5 type 21mc'], ['latitude 5410', 'latitude 5420'], ['elitebook 840', 'elitebook 850']];
  for (const [a, b] of yes) assert.equal(cat.sameModelSpelling(a, b), true, `${a} / ${b}`);
  for (const [a, b] of no) assert.equal(cat.sameModelSpelling(a, b), false, `${a} / ${b}`);
  const groups = cat.modelVariants([
    { id: 1, name: 'OptiPlex 5050', manufacturer_id: 1 }, { id: 2, name: 'Optiplex 5050', manufacturer_id: 1 },
    { id: 3, name: 'Optiplex 5050', manufacturer_id: 2 }, { id: 4, name: 'Latitude E5450', manufacturer_id: 1 }, { id: 5, name: 'Latitude 5450', manufacturer_id: 1 }
  ]);
  assert.deepEqual(groups.map(g => g.ids.sort()), [['1', '2']], 'same maker only, E5450 vs 5450 not merged');
  const majority = new Map([['7', { category_id: '1', count: 90, total: 100, share: 0.9 }], ['8', { category_id: '2', count: 15, total: 18, share: 0.83 }]]);
  const fixes = cat.modelCategoryFixes([{ id: 7, name: 'OptiPlex 7010', category_id: 3 }, { id: 8, name: 'Small', category_id: 1 }], majority);
  assert.deepEqual(fixes.map(f => [f.model_id, f.from, f.to]), [['7', '3', '1']], 'needs 20+ assets');
  assert.deepEqual(cat.supplierGroups([{ name: 'Dell India Pvt Ltd' }, { name: 'DELL MARKETING L.P.' }, { name: 'Lenovo US' }]).map(g => g.names.length), [2]);
});

// A small register: 10 Latitude laptops (one with problems), 5 VMs, catalog and categories.
const CATS = [{ id: 1, name: 'Laptop' }, { id: 2, name: 'VM' }];
const MODELS = [{ id: 10, name: 'Latitude 5420', model_number: 'Latitude 5420', manufacturer_id: '1', category_id: 1 }, { id: 11, name: 'Azure D4s', model_number: 'D4s', manufacturer_id: '2', category_id: 2 }];
function register() {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push({ id: i, asset_tag: `T-${i}`, name: 'Dell Latitude 5420', model_number: 'Latitude 5420', serial_number: `SER00${i}X`, status: 'assigned', assigned_to: 100 + i,
      category_id: '1', manufacturer_id: '1', supplier_id: '5', location_id: 1, asset_model_id: '10', model_name: 'Latitude 5420', procurement_id: 1,
      purchase_cost: 60000, purchase_date: '2023-01-10', warranty_expiry: '2026-01-10', warranty_start: '2023-01-10', label_type: 'deployed',
      machine_name: `HOST-${i}`, fams: String(199100000 + i), stock_site: '_none' });
  }
  for (let i = 11; i <= 15; i++) {
    rows.push({ id: i, asset_tag: `T-${i}`, name: `vmapp${i}-VM`, model_number: 'D4s', serial_number: `VMSER${i}`, status: 'available', assigned_to: null,
      category_id: '2', manufacturer_id: '2', supplier_id: '6', location_id: 1, asset_model_id: '11', model_name: 'Azure D4s', procurement_id: 2,
      purchase_cost: 90000, purchase_date: '2024-01-10', warranty_expiry: '2027-01-10', warranty_start: '2024-01-10', label_type: 'deployable',
      machine_name: 'BL IT Stock 12/01/26', fams: String(199200000 + i), stock_site: 'Bangalore' });
  }
  // Problems on asset 10: filed as VM, in stock though returned to client, shared FAMS, cost typo, no supplier.
  Object.assign(rows[9], { category_id: '2', status: 'available', assigned_to: null, label_type: 'deployable', machine_name: 'Returned to client on 3/5/2019',
    fams: String(199100001), purchase_cost: 60, supplier_id: null });
  return rows;
}

test('data-health rules: a clean asset scores 100, a problem asset explains each issue', () => {
  const rows = register();
  // The out-of-fold classifier also reads asset 10 as a laptop.
  const ctx = buildContext(rows, { oof: [{ id: 10, predicted: '1', p: 0.97, why: [] }], models: MODELS, categories: CATS });
  const clean = rules.evaluate(rows[0], ctx);
  assert.deepEqual(clean.issues.map(i => i.code).filter(c => c !== 'fams_duplicate'), []);
  const bad = rules.evaluate(rows[9], ctx);
  const codes = bad.issues.map(i => i.code).sort();
  assert.deepEqual(codes, ['category_mismatch', 'cost_outlier', 'fams_duplicate', 'missing_supplier', 'returned_in_stock']);
  assert.match(bad.issues.find(i => i.code === 'cost_outlier').detail, /₹60 is far from the usual ₹60,000/);
  const mismatch = bad.issues.find(i => i.code === 'category_mismatch');
  assert.match(mismatch.detail, /Filed as VM, but 9 of 10 "Latitude 5420" assets are Laptop/);
  assert.equal(mismatch.confidence, 0.9, 'the weaker of the two signals (9 of 10)');
  assert.match(bad.issues.find(i => i.code === 'fams_duplicate').detail, /also on T-1/);
  assert.match(bad.issues.find(i => i.code === 'returned_in_stock').detail, /went back to the client/);
  assert.equal(bad.score, Math.round(100 - 15 * 0.9 - 15 * 0.8 - 15 - 5 - 30));
  assert.equal(rules.grade(bad.score), 'Poor');
  // Without the classifier agreeing, it is only a weaker "category and model disagree".
  const ctx2 = buildContext(rows, { oof: [], models: MODELS, categories: CATS });
  assert.deepEqual(rules.evaluate(rows[9], ctx2).issues.filter(i => i.code.startsWith('category')).map(i => i.code), ['category_model_conflict']);
});

test('cost outliers need 10+ priced peers and a big gap', () => {
  const rows = register();
  rows.push({ ...rows[0], id: 16, asset_tag: 'T-16', fams: '199100099', purchase_cost: 60000 });
  rows.push({ ...rows[0], id: 17, asset_tag: 'T-17', fams: '199100098', purchase_cost: 600000 });
  const ctx = buildContext(rows, { models: MODELS, categories: CATS });
  assert.ok(rules.evaluate(rows.find(r => r.id === 17), ctx).issues.some(i => i.code === 'cost_outlier'));
  assert.ok(!rules.evaluate(rows.find(r => r.id === 16), ctx).issues.some(i => i.code === 'cost_outlier'));
});

test('catalog matcher finds the model from free text and calibrates its confidence', () => {
  const catalog = [
    { id: 1, name: 'Latitude 5420', model_number: 'Latitude 5420', manufacturer_id: 'd' }, { id: 2, name: 'Latitude 5430', model_number: '', manufacturer_id: 'd' },
    { id: 3, name: 'ThinkPad E14 Gen 4', model_number: '', manufacturer_id: 'l' }, { id: 4, name: 'MacBook Pro 14', model_number: '', manufacturer_id: 'a' }
  ];
  const m = new CatalogMatcher(catalog);
  assert.equal(m.match('Dell Latitude-5420 laptop')[0].id, '1');
  assert.equal(m.match('thinkpad e14 gen4')[0].id, '3');
  assert.equal(m.match('MacBookPro 14 inch')[0].id, '4');
  assert.deepEqual(m.match('Latitude 5420', { manufacturerId: 'l' }), [], 'maker filter');
  const samples = [['latitude 5420', '1'], ['dell latitude 5430', '2'], ['thinkpad e14', '3'], ['macbook pro', '4'], ['latitude', '2']]
    .map(([t, truth]) => ({ ranked: m.match(t, { k: 2 }), truth }));
  const platt = fitPlatt(samples);
  assert.ok(confidence(platt, m.match('Latitude 5420', { k: 2 })) > confidence(platt, m.match('latitude', { k: 2 })), 'clear matches are surer than vague ones');
});

test('intake classifier learns category and manufacturer, matches the model, and evaluates', () => {
  const rows = [];
  const kinds = [['Dell Latitude', 'Laptop', 'Dell', 'L'], ['Lenovo ThinkPad', 'Laptop', 'Lenovo', 'T'], ['Dell OptiPlex', 'Desktop', 'Dell', 'O'], ['Azure VM', 'VM', 'Azure', 'Z']];
  let id = 1;
  for (const [name, c, m, code] of kinds) {
    for (let i = 0; i < 25; i++) rows.push({ id: id++, name: `${name} ${3400 + i * 10}`, model_number: `${code}${3400 + i * 10}`, serial_number: `${code}X${1000 + i}AB`, category_id: c, manufacturer_id: m, asset_model_id: null, purchase_date: `202${i % 5}-01-01` });
  }
  const catalog = [{ id: 'm1', name: 'Latitude 3400', model_number: '', manufacturer_id: 'Dell' }, { id: 'm2', name: 'OptiPlex 3410', model_number: '', manufacturer_id: 'Dell' }];
  rows[0].asset_model_id = 'm1';
  rows[51].asset_model_id = 'm2';
  const model = new IntakeClassifier().train(rows, { catalog });
  const p = model.predict({ name: 'Dell Latitude 3999', model_number: 'L3999', serial_number: 'LX1099AB' }, { matcher: new CatalogMatcher(catalog) });
  assert.equal(p.category.value, 'Laptop');
  assert.equal(p.manufacturer.value, 'Dell');
  assert.ok(p.category.confidence > 0.5 && p.category.confidence <= 1);
  assert.ok(p.category.why.length > 0, 'explained');
  assert.equal(p.model.value, 'm1');
  const ev = model.evaluate(rows.slice(0, 40), { matcher: new CatalogMatcher(catalog) });
  assert.ok(ev.category.accuracy >= 0.95 && ev.manufacturer.accuracy >= 0.95, JSON.stringify({ c: ev.category.accuracy, m: ev.manufacturer.accuracy }));
  assert.ok(['nb', 'logreg'].includes(model.trainingMetrics.category.chosen));
  const restored = IntakeClassifier.fromJSON(JSON.parse(JSON.stringify(model.toJSON())));
  assert.equal(restored.predict({ name: 'Azure VM 9999' }).category.value, 'VM');
});
