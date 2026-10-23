// AI layer M4: refresh risk (current-status Weibull, piecewise shape, covariates) and unusual assets
// (Isolation Forest): the algorithms on known data, then on the test database the jobs, the registry,
// the asset card, the dashboard map, the Alerts section with its reviews, location scope and switching off.
// The test-database helper must be required before any src/ module.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const { WeibullRisk, fitStratum, terms, evaluateProbabilities, isotonicCurve } = require('../src/ai/models/weibullRisk');
const { IsolationForest, c, rng } = require('../src/ai/models/isolationForest');
const detect = require('../src/ai/anomaly/detect');
const risk = require('../src/ai/lifecycle/risk');

// Current-status sample from a Weibull: age uniform 0.5-12 years, retired if T <= age.
function weibullSample(n, { k = 4, lambda = 6, effect = 2, seed = 3 } = {}) {
  const rand = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const x = rand() < 0.5;
    const age = 0.5 + rand() * 11.5;
    // S(t) = exp(-(t/lambda)^k * m)  ->  T = lambda * (-ln U / m)^(1/k)
    const T = lambda * Math.pow(-Math.log(1 - rand()) / (x ? effect : 1), 1 / k);
    rows.push({ stratum: 'Laptop', age, event: T <= age, feats: x ? ['x'] : [] });
  }
  return rows;
}

test('cloglog terms: derivatives match finite differences', () => {
  for (const eta of [-3, -0.5, 0.4, 1.2]) {
    for (const y of [0, 1]) {
      const h = 1e-5;
      const t = terms(eta, y);
      const g = (terms(eta + h, y).ll - terms(eta - h, y).ll) / (2 * h);
      const hh = (terms(eta + h, y).g - terms(eta - h, y).g) / (2 * h);
      assert.ok(Math.abs(t.g - g) < 1e-5, `gradient at ${eta},${y}`);
      assert.ok(Math.abs(t.h - hh) < 1e-4, `curvature at ${eta},${y}`);
      assert.ok(t.h <= 0, 'concave');
    }
  }
});

test('Weibull from current-status data: recovers the shape, the scale and the covariate effect', () => {
  const rows = weibullSample(6000);
  const fit = fitStratum(rows, { knots: [], l2: 0.01, minCount: 10 });
  assert.ok(Math.abs(fit.k - 4) < 0.4, `k ${fit.k}`);
  assert.ok(Math.abs(Math.exp(fit.beta.x) - 2) < 0.35, `effect ${Math.exp(fit.beta.x)}`);
  const model = new WeibullRisk().train(rows, { knots: [], l2: 0.01, minCount: 10 });
  const median = model.medianAge({ stratum: 'Laptop', feats: [] });
  assert.ok(Math.abs(median - 6 * Math.pow(Math.LN2, 1 / 4)) < 0.35, `median ${median}`);
  // Risk grows with the horizon and with age (increasing hazard), never above 1.
  const r = { stratum: 'Laptop', age: 5, feats: [] };
  assert.ok(model.risk(r, 0.5) < model.risk(r, 1) && model.risk(r, 1) < model.risk(r, 2) && model.risk(r, 2) <= 1);
  assert.ok(model.risk({ ...r, age: 3 }, 1) < model.risk(r, 1));
  assert.ok(model.risk({ ...r, feats: ['x'] }, 1) > model.risk(r, 1), 'the covariate doubles the hazard');
  const m = model.evaluate(rows);
  assert.ok(m.auc > 0.85 && m.ece < 0.03, JSON.stringify({ auc: m.auc, ece: m.ece }));
  assert.equal(model.stratum('VM'), null, 'no data, no model');
});

test('piecewise shape follows a refresh policy that one Weibull shape cannot', () => {
  // Retired uniformly between 5 and 6 years (a refresh cycle).
  const rand = rng(11);
  const rows = Array.from({ length: 5000 }, () => { const age = 0.5 + rand() * 9.5; return { stratum: 'Laptop', age, event: 5 + rand() <= age, feats: [] }; });
  const train = rows.slice(0, 4000), test = rows.slice(4000);
  const one = new WeibullRisk().train(train, { knots: [] }).evaluate(test);
  const piece = new WeibullRisk().train(train).evaluate(test);
  assert.ok(piece.logloss < one.logloss, `${piece.logloss} < ${one.logloss}`);
  const iso = isotonicCurve(train);
  assert.ok(iso(4) < 0.05 && iso(7) > 0.95, 'isotonic curve (NPMLE) is the step');
  const w = new WeibullRisk().train(train);
  assert.ok(w.risk({ stratum: 'Laptop', age: 5, feats: [] }, 1) > 0.6, 'a 5-year-old is likely refreshed within a year');
  assert.ok(w.risk({ stratum: 'Laptop', age: 2, feats: [] }, 1) < 0.1);
});

test('a covariate that may only raise the risk is dropped when it comes out lowering it', () => {
  const rows = weibullSample(4000, { effect: 0.5 }); // 'x' halves the hazard
  const free = new WeibullRisk().train(rows, { minCount: 10 });
  assert.ok(free.stratum('Laptop').beta.x < 0);
  const constrained = new WeibullRisk().train(rows, { minCount: 10, positive: ['x'] });
  assert.equal(constrained.stratum('Laptop').beta.x, undefined);
  assert.deepEqual(constrained.stratum('Laptop').dropped, ['x']);
  assert.deepEqual(constrained.explain({ stratum: 'Laptop', age: 5, feats: ['x'] }), []);
});

test('probability metrics on a toy example', () => {
  const m = evaluateProbabilities([{ p: 0.9, y: 1 }, { p: 0.8, y: 1 }, { p: 0.2, y: 0 }, { p: 0.1, y: 0 }]);
  assert.equal(m.auc, 1);
  assert.ok(Math.abs(m.brier - (0.01 + 0.04 + 0.04 + 0.01) / 4) < 1e-12);
});

test('Isolation Forest: the normalising constant and planted outliers', () => {
  assert.ok(Math.abs(c(256) - 10.2448) < 1e-3); // 2 (ln 255 + 0.5772) - 2 * 255 / 256
  assert.equal(c(2), 1);
  const rand = rng(5);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const X = Array.from({ length: 2000 }, () => [gauss(), gauss(), gauss()]);
  const outliers = Array.from({ length: 20 }, (_, i) => [6 + i % 3, gauss(), gauss()]);
  const f = new IsolationForest().train([...X, ...outliers], { features: ['a', 'b', 'c'] });
  const ev = f.evaluate([...X.map(x => ({ x, y: 0 })), ...outliers.map(x => ({ x, y: 1 }))], 20);
  assert.ok(ev.auc > 0.97, `auc ${ev.auc}`);
  assert.ok(ev.precision_at_k >= 0.8);
  assert.ok(f.score(outliers[0]) > 0.6 && f.score([0, 0, 0]) < 0.5);
  assert.equal(f.explain(outliers[0])[0].factor, 'a', 'the feature that isolates it comes first');
  const again = new IsolationForest().train([...X, ...outliers], { features: ['a', 'b', 'c'] });
  assert.equal(again.score(outliers[0]), f.score(outliers[0]), 'seeded: the same every run');
});

// Rows in the shape assetRows.load returns.
function assetRow(i, o = {}) {
  return {
    id: i, category: 'Laptop', asset_model_id: 1, model: 'Latitude 5420', manufacturer_id: 1, location_id: 1, holder_user_id: null, holder: null,
    is_retired: false, retired_reason: null, deleted: false, client_provided: false, feature_hash: 'h' + i, asset_tag: 'T' + i, name: 'n' + i,
    purchase_date: '2022-06-01', warranty_expiry: '2025-06-01', cost: 60000 + (i % 7) * 400, ram_gb: 16, cpu: '11th Gen Intel Core i5-1135G7 @ 2.40GHz', ...o
  };
}

test('unusual assets: the odd one out is flagged with plain reasons; ordinary ones are not', () => {
  const rows = Array.from({ length: 300 }, (_, i) => assetRow(i + 1, { purchase_date: `202${1 + (i % 3)}-0${1 + (i % 9)}-15`, warranty_expiry: `202${4 + (i % 3)}-0${1 + (i % 9)}-15` }));
  rows.push(assetRow(999, { ram_gb: 4, cost: 5000 }));
  const out = detect.scoreAll({ rows, now: Date.parse('2026-10-23') });
  const odd = out.results.find(r => r.id === 999);
  assert.ok(odd.flagged, `score ${odd.score}`);
  const text = odd.factors.map(f => f.text).join(' | ');
  assert.match(text, /4 GB RAM; Latitude 5420 usually has 16 GB/);
  assert.match(text, /Cost 5,000; Latitude 5420 usually cost 6\d,\d{3}/);
  assert.deepEqual(out.results.filter(r => r.flagged).map(r => r.id), [999], 'ordinary laptops are not flagged, even near the top 1%');
  // Corrupted copies are measured on the real register (ai:eval); here most features never vary, and
  // an Isolation Forest can't see a change in a feature it never split on.
  assert.equal(typeof out.metrics.injected_auc, 'number');
  assert.equal(detect.scoreAll({ rows: rows.slice(0, 20) }).metrics.skipped, true, 'too few assets: no run');
});

test('refresh risk: what is not scored, and why', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const age = 0.5 + (i % 20) * 0.5;
    const bought = new Date(Date.parse('2026-10-23') - age * 365.25 * 864e5).toISOString().slice(0, 10);
    rows.push(assetRow(i + 1, { purchase_date: bought, warranty_expiry: null, is_retired: age >= 7 || (age >= 5 && i % 2 === 0), retired_reason: 'Retired', ram_gb: i % 3 ? 16 : 8 }));
  }
  const now = Date.parse('2026-10-23');
  const model = new WeibullRisk().train(risk.trainingRows(rows, now), { positive: ['ram_le_8'] });
  assert.ok(model.stratum('Laptop'));
  const d = risk.describe(model, rows.find(r => !r.is_retired && r.ram_gb === 8 && Math.abs(require('../src/ai/features/assetRows').ageYears(r.purchase_date, now) - 5) < 0.3), now);
  assert.ok(d.risk12 > 0.2 && d.risk6 < d.risk12 && d.risk12 < d.risk24, JSON.stringify(d));
  assert.match(d.why[0], /half of laptops here are retired by \d/);
  assert.ok(d.confidence > 0 && d.confidence <= 1);
  assert.match(risk.describe(model, assetRow(1, { client_provided: true }), now).skip, /Client-provided/);
  assert.match(risk.describe(model, assetRow(2, { is_retired: true }), now).skip, /Retired/);
  assert.match(risk.describe(model, assetRow(3, { category: 'VM' }), now).skip, /Not enough retirement history for VM/);
  assert.equal(risk.trainingRows([assetRow(4, { is_retired: true, retired_reason: 'Retired - Lost' })], now).length, 0, 'lost assets are not refreshes');
});

// ─── On the test database ───

test('AI M4: refresh risk and unusual assets on the test database', { timeout: 240000 }, async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const ai = require('../src/ai');
  const { flags } = ai;
  ai.start();
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const registry = require('../src/ai/governance/registry');
  const lifecycle = require('../src/ai/lifecycle/run');
  const anomaly = require('../src/ai/anomaly/run');

  const resetAi = async () => {
    await db.run('TRUNCATE ai_feedback, ai_recommendations, ai_models RESTART IDENTITY CASCADE');
    await db.run(`DELETE FROM ai_predictions WHERE capability IN ('lifecycle', 'anomaly')`);
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
    lifecycle.invalidate();
  };
  const cleanup = async () => {
    await db.run(`DELETE FROM assets WHERE asset_tag LIKE 'AIR4-%'`);
    await db.run(`DELETE FROM asset_models WHERE name LIKE 'AIR4 %'`);
    await db.run(`DELETE FROM asset_categories WHERE name LIKE 'AIR4 %'`);
    await db.run(`DELETE FROM locations WHERE name LIKE 'AIR4 %'`);
    await db.run(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'air4_viewer')`);
    await db.run(`DELETE FROM role_location_scopes WHERE role_id IN (SELECT id FROM roles WHERE name = 'air4_viewer')`);
    await db.run(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'air4_viewer')`);
    await db.run(`DELETE FROM roles WHERE name = 'air4_viewer'`);
    await db.run(`DELETE FROM users WHERE email LIKE 'air4-%@hams.test'`);
  };
  await resetAi();
  await cleanup();

  // ── Fixtures: 260 laptops aged 0.5-10 years, the older ones mostly retired; one odd laptop ──
  const one = async (sql, p) => (await db.get(sql + ' RETURNING id', p)).id;
  const laptop = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIR4 Laptop', 'asset')`);
  const vm = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIR4 VM', 'asset')`);
  const model = await one(`INSERT INTO asset_models (name, model_number, category_id) VALUES ('AIR4 Latitude', 'AIR4L', $1)`, [laptop]);
  const pune = await one(`INSERT INTO locations (name) VALUES ('AIR4 Pune')`);
  const powai = await one(`INSERT INTO locations (name) VALUES ('AIR4 Powai')`);
  const label = async n => (await db.get('SELECT id FROM status_labels WHERE name = $1', [n])).id;
  const inStock = await label('In Stock'), retired = await label('Retired');
  const holder = await one(`INSERT INTO users (name, email, password, employee_id, role, status) VALUES ('AirHolder7', 'air4-holder@hams.test', 'x', 'AirHolder7', 'user', 'active')`);
  const day = 864e5;
  const insert = (tag, o) => one(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category_id, asset_model_id, location_id, assigned_to, status,
        status_label_id, purchase_date, warranty_expiry, purchase_cost, custom_fields_data)
     VALUES ($1::text, md5($1::text), $2, $3, 'AIR4L', $4, $5, $6, $7, 'available', $8, $9, $10, $11, $12)`,
    [tag, o.name || 'AIR4 Latitude', tag + 'SER', o.category || laptop, o.model === undefined ? model : o.model, o.location, o.holder || null,
      o.retired ? retired : inStock, o.bought, o.warranty, o.cost, JSON.stringify(o.cf || {})]);
  const ids = {};
  for (let i = 0; i < 260; i++) {
    const age = 0.5 + (i % 20) * 0.5;
    const bought = new Date(Date.now() - age * 365.25 * day);
    const warranty = new Date(bought.getTime() + 3 * 365.25 * day);
    const isRetired = age >= 7 || (age >= 5 && i % 2 === 0) || (age >= 4 && i % 7 === 0);
    const id = await insert(`AIR4-${i}`, { location: i % 2 ? pune : powai, bought, warranty, cost: 60000 + (i % 5) * 500, retired: isRetired,
      holder: i % 40 === 3 ? holder : null, cf: { 'RAM Size (GB)': i % 6 ? '16' : '8', Processor: '11th Gen Intel Core i5-1135G7 @ 2.40GHz' } });
    if (age === 5 && !isRetired && i % 2 && !ids.five) ids.five = id;
  }
  const twoYears = new Date(Date.now() - 2 * 365.25 * day);
  ids.odd = await insert('AIR4-ODD', { location: pune, bought: twoYears, warranty: new Date(twoYears.getTime() + 3 * 365.25 * day), cost: 5000, cf: { 'RAM Size (GB)': '4', Processor: '11th Gen Intel Core i5-1135G7 @ 2.40GHz' } });
  ids.client = await insert('AIR4-CLIENT', { location: pune, bought: twoYears, warranty: twoYears, cost: 60000, cf: { 'Client Provided Asset': 'Yes', 'RAM Size (GB)': '16' } });
  ids.vm = await insert('AIR4-VM', { category: vm, model: null, location: powai, bought: twoYears, warranty: twoYears, cost: 9000 });
  assert.ok(ids.five, 'fixture: an active 5-year-old');

  const pw = 'Ai-M4-Pass-2026!';
  const admin = await env.ensureUser({ email: 'air4-admin@hams.test', name: 'AI M4 Admin', password: pw });
  const viewerRole = await one(`INSERT INTO roles (name, display_name, level) VALUES ('air4_viewer', 'AI M4 viewer', 20)`);
  await db.run(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE name IN ('assets.view', 'dashboard.view', 'inventory.view', 'audit.view')`, [viewerRole]);
  await db.run(`INSERT INTO role_location_scopes (role_id, location_id) VALUES ($1, $2)`, [viewerRole, powai]);
  const viewer = await env.ensureUser({ email: 'air4-viewer@hams.test', name: 'AI M4 Viewer', role: 'air4_viewer', password: pw });

  const app = await env.startApp();
  const browser = new env.Browser(app.base);
  const viewerBrowser = new env.Browser(app.base);
  t.after(async () => {
    await app.close();
    await cleanup();
    await resetAi();
    await db.pool.end();
  });
  await browser.login(admin.email, pw);
  await viewerBrowser.login(viewer.email, pw);
  const json = async (b, url) => { const r = await b.get(url); return { status: r.status, body: JSON.parse(r.text) }; };

  await t.test('off: no card, no map, no Alerts section; endpoints answer 404 { off }', async () => {
    await flags.setMaster(true, admin);
    for (const url of [`/api/ai/assets/${ids.five}/risk`, '/api/ai/lifecycle/summary', '/api/ai/anomalies']) {
      const r = await json(browser, url);
      assert.equal(r.status, 404, url);
      assert.deepEqual(r.body, { off: true });
    }
    assert.ok(!(await browser.get(`/assets/${ids.five}`)).text.includes('aiAssetRisk('));
    assert.ok(!(await browser.get('/')).text.includes('aiLifecycleCard('));
    assert.ok(!(await browser.get('/alerts')).text.includes('aiAnomalies('));
  });

  await t.test('refresh risk: trained, registered, every active asset scored with reasons', async () => {
    await flags.setFlag('lifecycle', true, admin);
    const r = await lifecycle.run({ trigger: 'manual', user: admin });
    assert.ok(r.trained && r.trained.activated, r.summary);
    assert.match(r.summary, /active assets scored/);
    const [m] = await registry.list('lifecycle_weibull');
    assert.equal(m.status, 'active');
    for (const k of ['brier', 'auc', 'ece']) assert.equal(typeof m.metrics[k], 'number', k);
    assert.ok(m.training.strata['AIR4 Laptop'].baseline.age_curve_isotonic > 0, 'baselines recorded');
    const p = await db.get(`SELECT * FROM ai_predictions WHERE asset_id = $1 AND capability = 'lifecycle'`, [ids.five]);
    assert.ok(p && Number(p.score) > 0 && p.factors.why.length >= 1);
    assert.equal(await db.get(`SELECT 1 FROM ai_predictions WHERE capability = 'lifecycle' AND asset_id = ANY($1::int[])`, [[ids.client, ids.vm]]), null, 'client-provided and VMs not scored');
    // Within a week the daily run only scores; Run now retrains.
    const again = await lifecycle.run({ trigger: 'schedule' });
    assert.equal(again.trained, null);
    assert.equal((await registry.list('lifecycle_weibull')).length, 1);
  });

  await t.test('asset card: risk at 6/12/24 months with confidence and why; skips explained', async () => {
    assert.ok((await browser.get(`/assets/${ids.five}`)).text.includes('aiAssetRisk('));
    const r = await json(browser, `/api/ai/assets/${ids.five}/risk`);
    assert.equal(r.status, 200);
    const l = r.body.lifecycle;
    assert.ok(l.ready && l.risk6 < l.risk12 && l.risk12 < l.risk24, JSON.stringify(l));
    assert.ok(l.confidence > 0 && ['low', 'medium', 'high'].includes(l.label));
    assert.match(l.why[0], /years old; half of air4 laptops here are retired by/);
    assert.equal(r.body.anomaly, null, 'Unusual assets is off');
    assert.match((await json(browser, `/api/ai/assets/${ids.client}/risk`)).body.lifecycle.skip, /Client-provided/);
    assert.match((await json(browser, `/api/ai/assets/${ids.vm}/risk`)).body.lifecycle.skip, /Not enough retirement history/);
    assert.equal((await json(viewerBrowser, `/api/ai/assets/${ids.odd}/risk`)).status, 404, 'Pune asset hidden from a Powai-only user');
  });

  await t.test('dashboard map: expected retirements by location and age, within the user\'s locations', async () => {
    assert.ok((await browser.get('/')).text.includes('aiLifecycleCard('));
    const all = (await json(browser, '/api/ai/lifecycle/summary')).body;
    assert.ok(all.ready && all.expected > 0 && all.bands.length === 6);
    const names = all.locations.map(l => l.location);
    assert.ok(names.includes('AIR4 Pune') && names.includes('AIR4 Powai'));
    const total = all.locations.reduce((s, l) => s + l.cells.reduce((x, c) => x + c.n, 0), 0);
    assert.equal(total, all.assets);
    const scoped = (await json(viewerBrowser, '/api/ai/lifecycle/summary')).body;
    assert.deepEqual(scoped.locations.map(l => l.location), ['AIR4 Powai']);
  });

  await t.test('unusual assets: the odd laptop is found, reviewed on Alerts, and hidden while unchanged', async () => {
    await flags.setFlag('anomaly', true, admin);
    const r = await anomaly.run({ trigger: 'manual', user: admin });
    assert.match(r.summary, /Unusual assets: \d+ of \d+ active assets/);
    assert.equal((await registry.list('anomaly_iforest')).filter(m => m.status === 'active').length, 1);
    await anomaly.run({ trigger: 'schedule' });
    assert.equal((await registry.list('anomaly_iforest')).length, 1, 'same settings: no new version');
    assert.ok((await browser.get('/alerts')).text.includes('aiAnomalies('));
    const list = (await json(browser, '/api/ai/anomalies')).body;
    assert.equal(list.can_review, true);
    const g = list.groups.find(x => x.assets.some(a => a.id === ids.odd));
    assert.ok(g, JSON.stringify(list.groups.map(x => x.asset_tag)));
    assert.ok(g.why.some(w => /4 GB RAM; AIR4 Latitude usually has 16 GB/.test(w)) && g.why.some(w => /Cost 5,000/.test(w)), JSON.stringify(g.why));
    const card = (await json(browser, `/api/ai/assets/${ids.odd}/risk`)).body.anomaly;
    assert.ok(card.unusual && card.why.length);
    // The Powai-only viewer neither sees nor reviews the Pune finding.
    const scoped = (await json(viewerBrowser, '/api/ai/anomalies')).body;
    assert.equal(scoped.can_review, false);
    assert.ok(!scoped.groups.some(x => x.assets.some(a => a.id === ids.odd)));
    const denied = await viewerBrowser.post('/ai/anomalies/review', { _csrf: await viewerBrowser.csrf('/alerts'), 'asset_ids[]': ids.odd, verdict: 'issue' });
    assert.equal(denied.status, 403);
    // Review as admin: a label and an audit line, no change to the asset.
    const before = await db.get('SELECT updated_at FROM assets WHERE id = $1', [ids.odd]);
    const done = await browser.post('/ai/anomalies/review', { _csrf: await browser.csrf('/alerts'), 'asset_ids[]': ids.odd, verdict: 'issue' });
    assert.equal(done.status, 302);
    assert.ok(done.location.endsWith('/alerts#ai-anomalies'));
    const fb = await db.get(`SELECT * FROM ai_feedback WHERE capability = 'anomaly' AND target_id = $1`, [ids.odd]);
    assert.equal(fb.label, 'accepted');
    assert.ok(fb.predicted.why.length && fb.predicted.hash);
    assert.ok(await db.get(`SELECT 1 AS x FROM activity_logs WHERE action = 'AI_ANOMALY_REVIEWED' AND description LIKE '%AIR4-ODD%'`));
    assert.deepEqual(await db.get('SELECT updated_at FROM assets WHERE id = $1', [ids.odd]), before, 'the asset is untouched');
    const after = (await json(browser, '/api/ai/anomalies')).body;
    assert.ok(!after.groups.some(x => x.assets.some(a => a.id === ids.odd)), 'reviewed: hidden while unchanged');
    assert.equal(after.reviewed.issues, 1);
    assert.equal(after.precision, 1);
    const bad = await browser.post('/ai/anomalies/review', { _csrf: await browser.csrf('/alerts'), 'asset_ids[]': ids.five, verdict: 'maybe' });
    assert.equal(bad.status, 302, 'refused with a message, not an error page');
  });

  await t.test('Settings > AI lists the capabilities, the jobs and the model numbers', async () => {
    const page = (await browser.get('/settings/ai')).text;
    for (const s of ['Refresh risk', 'Unusual assets', 'Refresh risk scores', 'Find unusual assets', 'lifecycle_weibull', 'anomaly_iforest', 'Brier score', 'Detection AUC']) {
      assert.ok(page.includes(s), s);
    }
  });

  await t.test('switching off hides everything again at once', async () => {
    await flags.setFlag('lifecycle', false, admin);
    await flags.setFlag('anomaly', false, admin);
    assert.equal((await browser.get(`/api/ai/assets/${ids.five}/risk`)).status, 404);
    assert.ok(!(await browser.get('/')).text.includes('aiLifecycleCard('));
    assert.ok(!(await browser.get('/alerts')).text.includes('aiAnomalies('));
    assert.ok(!(await browser.get(`/assets/${ids.five}`)).text.includes('aiAssetRisk('));
  });
});
