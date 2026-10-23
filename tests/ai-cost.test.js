// AI layer M5: cost forecast (Holt-Winters baseline + replacement need), refresh plan under a budget
// (knapsack) and licence compliance rules. Algorithms on known data, then on the test database: the
// dashboard card, Refresh Planning (scope, export, sign-off that changes nothing), the cost job and
// registry, the compliance engine dormant and then with synthetic licences, switching off.
// The test-database helper must be required before any src/ module.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const { HoltWinters, backtest } = require('../src/ai/models/holtWinters');
const { greedy, optimal, solve } = require('../src/ai/models/knapsack');
const forecast = require('../src/ai/cost/forecast');

test('Holt-Winters finds a quarterly pattern and beats the simple rules on it', () => {
  const y = Array.from({ length: 24 }, (_, i) => 100 + 3 * i + [30, -10, -25, 5][i % 4]);
  const hw = new HoltWinters().train(y);
  assert.notEqual(hw.params.seasonal, 'none');
  const next = hw.forecast(4);
  for (let k = 0; k < 4; k++) {
    const truth = 100 + 3 * (24 + k) + [30, -10, -25, 5][(24 + k) % 4];
    assert.ok(Math.abs(next[k].value - truth) < 12, `step ${k + 1}: ${next[k].value} vs ${truth}`);
    assert.ok(next[k].low <= next[k].value && next[k].value <= next[k].high && next[k].low >= 0);
  }
  const bt = backtest(y, 12);
  assert.ok(bt.holt_winters.mae < bt.same_quarter_last_year.mae && bt.holt_winters.mae < bt.mean_last_4.mae && bt.holt_winters.mae < bt.last_quarter.mae);
  const p = hw.predict(2);
  assert.ok(p.confidence > 0 && p.confidence <= 1);
  assert.equal(hw.explain().length, 3);
  // Waves (big quarters between near-empty ones) are not forecastable, and the pace says so.
  const waves = { quarters: Array.from({ length: 16 }, (_, i) => `20${20 + (i >> 2)}-Q${(i % 4) + 1}`), values: [5, 900, 3, 8, 2, 4, 1200, 6, 3, 2, 7, 800, 4, 5, 3, 1000] };
  assert.equal(forecast.pace(waves).forecastable, false);
});

test('knapsack: the dynamic programme finds what greedy misses and never exceeds the budget', () => {
  const items = [{ id: 'A', value: 7, cost: 6 }, { id: 'B', value: 5, cost: 5 }, { id: 'C', value: 5, cost: 5 }];
  assert.deepEqual(greedy(items, 10).chosen, ['A']);
  const o = optimal(items, 10);
  assert.deepEqual(o.chosen.sort(), ['B', 'C']);
  assert.equal(o.value, 10);
  const s = solve(items, 10);
  assert.equal(s.method, 'optimal');
  assert.equal(s.value, 10);
  let seed = 9;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let round = 0; round < 300; round++) {
    const list = Array.from({ length: 1 + Math.floor(rand() * 40) }, (_, i) => ({ id: i, value: rand(), cost: 1 + Math.floor(rand() * 100) }));
    const budget = Math.floor(rand() * 600);
    const r = solve(list, budget);
    assert.ok(r.cost <= budget, `round ${round}: ${r.cost} > ${budget}`);
    assert.ok(r.value >= greedy(list, budget).value - 1e-9);
  }
  assert.deepEqual(solve([], 100).chosen, []);
});

test('replacement need: quarterly expected retirements add up to the 24-month risk', () => {
  const unit = { Laptop: { cost: 70000 } };
  const f = [{ category: 'Laptop', risk_q: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6] }, { category: 'Laptop', risk6: 0.1, risk12: 0.3, risk24: 0.5 }];
  const n = forecast.aggregateNeed(f, unit, new Date(Date.UTC(2026, 9, 23)));
  assert.equal(n.quarters.length, 8);
  assert.ok(Math.abs(n.next24.units - 1.1) < 1e-9);
  assert.ok(Math.abs(n.next12.units - (0.3 + 0.3)) < 1e-9, 'interpolated from 6/12/24 months');
  assert.ok(Math.abs(n.next12.cost - 0.6 * 70000) < 1e-6);
  assert.equal(n.quarters[0].label, 'Oct 2026 – Dec 2026');
  assert.equal(forecast.money(203000000), '₹20.3 Cr');
  assert.equal(forecast.money(4560000), '₹45.6 L');
  assert.equal(forecast.money(73680), '₹73,680');
  assert.equal(forecast.money(1500000, { code: 'USD', symbol: '$' }), '$1.5M');
});

// ─── On the test database ───

test('AI M5: cost forecast, refresh planning and licence compliance on the test database', { timeout: 240000 }, async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const ai = require('../src/ai');
  const { flags } = ai;
  ai.start();
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const registry = require('../src/ai/governance/registry');
  const approvals = require('../src/ai/governance/approvals');
  const lifecycle = require('../src/ai/lifecycle/run');
  const plan = require('../src/ai/cost/plan');
  const rules = require('../src/ai/compliance/rules');

  const resetAi = async () => {
    await db.run('TRUNCATE ai_feedback, ai_recommendations, ai_models RESTART IDENTITY CASCADE');
    await db.run(`DELETE FROM ai_predictions WHERE capability IN ('lifecycle', 'anomaly')`);
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
    lifecycle.invalidate();
    forecast.invalidate();
  };
  const cleanup = async () => {
    await db.run(`DELETE FROM license_assignments WHERE license_id IN (SELECT id FROM licenses WHERE name LIKE 'AIC5 %')`);
    await db.run(`DELETE FROM licenses WHERE name LIKE 'AIC5 %'`);
    await db.run(`DELETE FROM software_assets WHERE sw_name LIKE 'AIC5 %'`);
    await db.run(`DELETE FROM procurement_records WHERE po_number LIKE 'AIC5-%'`);
    await db.run(`DELETE FROM assets WHERE asset_tag LIKE 'AIC5-%'`);
    await db.run(`DELETE FROM asset_models WHERE name LIKE 'AIC5 %'`);
    await db.run(`DELETE FROM asset_categories WHERE name LIKE 'AIC5 %'`);
    await db.run(`DELETE FROM locations WHERE name LIKE 'AIC5 %'`);
    await db.run(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'aic5_viewer')`);
    await db.run(`DELETE FROM role_location_scopes WHERE role_id IN (SELECT id FROM roles WHERE name = 'aic5_viewer')`);
    await db.run(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'aic5_viewer')`);
    await db.run(`DELETE FROM roles WHERE name = 'aic5_viewer'`);
    await db.run(`DELETE FROM users WHERE email LIKE 'aic5-%@hams.test'`);
  };
  await resetAi();
  await cleanup();

  // ── Fixtures: 260 laptops aged 0.5-10 years (older mostly retired), and 12 quarters of purchase orders ──
  const one = async (sql, p) => (await db.get(sql + ' RETURNING id', p)).id;
  const laptop = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIC5 Laptop', 'asset')`);
  const model = await one(`INSERT INTO asset_models (name, model_number, category_id) VALUES ('AIC5 Latitude', 'AIC5L', $1)`, [laptop]);
  const pune = await one(`INSERT INTO locations (name) VALUES ('AIC5 Pune')`);
  const powai = await one(`INSERT INTO locations (name) VALUES ('AIC5 Powai')`);
  const label = async n => (await db.get('SELECT id FROM status_labels WHERE name = $1', [n])).id;
  const inStock = await label('In Stock'), deployed = await label('Deployed'), retired = await label('Retired');
  const day = 864e5;
  for (let i = 0; i < 260; i++) {
    const age = 0.5 + (i % 20) * 0.5;
    const bought = new Date(Date.now() - age * 365.25 * day);
    const isRetired = age >= 7 || (age >= 5 && i % 2 === 0) || (age >= 4 && i % 7 === 0);
    await one(`INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category_id, asset_model_id, location_id, status, status_label_id,
        purchase_date, warranty_expiry, purchase_cost, custom_fields_data)
      VALUES ($1::text, md5($1::text), 'AIC5 Latitude', $1, 'AIC5L', $2, $3, $4, 'available', $5, $6, $7, $8, '{}')`,
      [`AIC5-${i}`, laptop, model, i % 2 ? pune : powai, isRetired ? retired : (i % 3 ? deployed : inStock), bought, new Date(bought.getTime() + 3 * 365.25 * day), 60000 + (i % 5) * 500]);
  }
  for (let q = 1; q <= 12; q++) {
    const d = new Date(Date.UTC(new Date().getUTCFullYear(), Math.floor(new Date().getUTCMonth() / 3) * 3 - 3 * q, 15));
    await one(`INSERT INTO procurement_records (po_number, purchase_date, total_amount, currency) VALUES ($1, $2, $3, 'INR')`, [`AIC5-PO-${q}`, d, q % 4 === 0 ? 9000000 : 400000]);
  }

  const pw = 'Ai-M5-Pass-2026!';
  const admin = await env.ensureUser({ email: 'aic5-admin@hams.test', name: 'AI M5 Admin', password: pw });
  const viewerRole = await one(`INSERT INTO roles (name, display_name, level) VALUES ('aic5_viewer', 'AI M5 viewer', 20)`);
  await db.run(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions
                 WHERE name IN ('assets.view', 'ai.view', 'licenses.view', 'inventory.view', 'audit.view', 'dashboard.view')`, [viewerRole]);
  await db.run(`INSERT INTO role_location_scopes (role_id, location_id) VALUES ($1, $2)`, [viewerRole, powai]);
  const viewer = await env.ensureUser({ email: 'aic5-viewer@hams.test', name: 'AI M5 Viewer', role: 'aic5_viewer', password: pw });

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

  await t.test('off: no card, no Refresh Planning, no compliance section; endpoints answer 404', async () => {
    await flags.setMaster(true, admin);
    for (const url of ['/api/ai/cost/forecast', '/api/ai/compliance']) assert.deepEqual((await json(browser, url)).body, { off: true });
    assert.equal((await browser.get('/ai/planning')).status, 404);
    const home = (await browser.get('/')).text;
    assert.ok(!home.includes('aiCostCard(') && !home.includes('/ai/planning'));
    assert.ok(!(await browser.get('/alerts')).text.includes('aiCompliance('));
  });

  await t.test('cost forecast: replacement need by quarter next to past spend (Refresh risk itself off)', async () => {
    await flags.setFlag('cost', true, admin);
    assert.equal(await flags.isOn('lifecycle'), false);
    const job = ai.JOBS.find(j => j.key === 'ai_lifecycle');
    assert.equal(await job.enabled(), true, 'the scores are computed for the cost forecast');
    await lifecycle.run({ trigger: 'manual', user: admin });
    const f = (await json(browser, '/api/ai/cost/forecast')).body;
    assert.equal(f.ready, true);
    assert.equal(f.currency.code, 'INR');
    assert.equal(f.need.quarters.length, 8);
    assert.ok(f.need.next12.units > 0 && f.need.next12.cost > f.need.next12.units * 50000);
    assert.ok(f.need.next24.units >= f.need.next12.units);
    assert.ok(f.history.quarters.length >= 8 && f.pace && typeof f.pace.backtest.holt_winters.mae === 'number');
    assert.ok(f.unit_costs['AIC5 Laptop'].cost >= 60000 && /median/.test(f.unit_costs['AIC5 Laptop'].basis));
    const home = (await browser.get('/')).text;
    assert.ok(home.includes('aiCostCard(') && home.includes('/ai/planning'));
    const scoped = (await json(viewerBrowser, '/api/ai/cost/forecast')).body;
    assert.ok(scoped.scoped && scoped.need.assets < f.need.assets, 'a Powai-only user sees Powai\'s need');
  });

  await t.test('refresh plan: within budget, scoped, exported; sign-off records the decision and changes nothing', async () => {
    const page = await browser.get('/ai/planning?budget=500000&horizon=12');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Assets in the plan') && page.text.includes('Send for approval'));
    const opts = plan.options({ budget: '5,00,000', horizon: '12' });
    assert.equal(opts.budget, 500000);
    const built = await plan.build(admin, opts);
    assert.ok(built.chosen.length > 0 && built.totals.cost <= 500000);
    assert.ok(built.chosen.every(c => c.in_use), 'spare stock only when asked');
    assert.ok(built.chosen[0].risk >= built.chosen[built.chosen.length - 1].risk);
    assert.match(built.chosen[0].why, /chance of being retired within 12 months/);
    const withStock = await plan.build(admin, plan.options({ budget: '500000', stock: '1' }));
    assert.ok(withStock.candidates > built.candidates);
    const scoped = await plan.build(viewer, opts);
    assert.ok(scoped.chosen.length && scoped.chosen.every(c => c.location === 'AIC5 Powai'));
    const xlsx = await fetch(app.base + '/ai/planning/export?budget=500000', { headers: { cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-type'), /spreadsheet/);
    // Proposing needs ai.manage.
    const denied = await viewerBrowser.post('/ai/planning/propose', { _csrf: await viewerBrowser.csrf('/profile'), budget: '500000', horizon: '12' });
    assert.equal(denied.status, 403);
    const before = await db.get(`SELECT MAX(updated_at) AS m, COUNT(*)::int AS n FROM assets WHERE asset_tag LIKE 'AIC5-%'`);
    const sent = await browser.post('/ai/planning/propose', { _csrf: await browser.csrf('/profile'), budget: '500000', horizon: '12' });
    assert.equal(sent.status, 302);
    assert.ok(sent.location.endsWith('/ai/approvals'));
    const rec = await db.get(`SELECT * FROM ai_recommendations WHERE type = 'plan.refresh' ORDER BY id DESC LIMIT 1`);
    assert.equal(rec.status, 'pending');
    assert.equal(rec.proposed._asset_ids.length, built.chosen.length);
    assert.ok(rec.why.some(w => /nothing is purchased/.test(w.text)));
    const again = await browser.post('/ai/planning/propose', { _csrf: await browser.csrf('/profile'), budget: '500000', horizon: '12' });
    assert.ok(again.location.includes('/ai/planning'), 'the same plan twice: refused with a message');
    const done = await approvals.decide(rec.id, 'accept', admin);
    assert.equal(done.status, 'accepted');
    assert.match(done.applied_result.summary, /Nothing was purchased or changed/);
    assert.deepEqual(await db.get(`SELECT MAX(updated_at) AS m, COUNT(*)::int AS n FROM assets WHERE asset_tag LIKE 'AIC5-%'`), before, 'no asset touched');
    assert.ok(await db.get(`SELECT 1 AS x FROM activity_logs WHERE action = 'AI_PLAN_PROPOSED'`));
  });

  await t.test('cost job: refreshes the forecast and records the spend model once per choice', async () => {
    const r = await forecast.run({ trigger: 'manual', user: admin });
    assert.match(r.summary, /Replacement need, next 12 months: ~\d+ assets ≈ ₹/);
    const [m] = await registry.list('spend_holt_winters');
    assert.equal(m.status, 'active');
    assert.equal(typeof m.metrics.backtest_mae_share, 'number');
    await forecast.run({ trigger: 'schedule' });
    assert.equal((await registry.list('spend_holt_winters')).length, 1);
  });

  await t.test('licence compliance: dormant without data, then the 10 rules on synthetic licences, within scope', async () => {
    await flags.setFlag('compliance', true, admin);
    assert.ok((await browser.get('/alerts')).text.includes('aiCompliance('));
    const idle = (await json(browser, '/api/ai/compliance')).body;
    assert.equal(idle.dormant, true);
    assert.equal(idle.rules.length, 10);
    // Synthetic licences and software.
    const user = async (name, status) => one(`INSERT INTO users (name, email, password, role, status) VALUES ($1, $2, 'x', 'user', $3)`, [name, `aic5-${name.toLowerCase()}@hams.test`, status]);
    const u1 = await user('LicUserA', 'active'), u2 = await user('LicUserB', 'active'), u3 = await user('LicUserC', 'active'), gone = await user('LicLeaver', 'suspended');
    const lic = (name, o) => one(`INSERT INTO licenses (name, seats, available_seats, license_key, purchase_date, purchase_cost, expiration_date, location_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [name, o.seats, o.available, o.key || null, o.bought || null, o.cost || null, o.expires || null, o.location]);
    const assign = (l, u) => db.run('INSERT INTO license_assignments (license_id, user_id) VALUES ($1, $2)', [l, u]);
    const days = n => new Date(Date.now() + n * day).toISOString().slice(0, 10);
    const over = await lic('AIC5 Office', { seats: 2, available: 0, location: powai });
    for (const u of [u1, u2, u3]) await assign(over, u);
    await assign(await lic('AIC5 Expired', { seats: 5, available: 4, expires: days(-10), location: powai }), u1);
    await lic('AIC5 Unused', { seats: 20, available: 20, bought: days(-365), cost: 200000, location: powai });
    const leaver = await lic('AIC5 Leaver', { seats: 5, available: 4, key: 'AAAAA-11111', location: pune });
    await assign(leaver, gone);
    await lic('AIC5 Mismatch', { seats: 10, available: 3, key: 'AAAAA-11111', location: pune });
    await assign(await lic('AIC5 Expiring', { seats: 3, available: 2, expires: days(30), location: pune }), u2);
    await db.run(`INSERT INTO software_assets (sw_name, subscription_end_date, allocated_user_id) VALUES ('AIC5 Cloud IDE', $1, $2)`, [days(-5), u1]);
    await db.run(`INSERT INTO software_assets (sw_name, renewal_date) VALUES ('AIC5 Design Suite', $1)`, [days(10)]);
    await db.run(`INSERT INTO software_assets (sw_name, allocated_user_id) VALUES ('AIC5 Notes', $1)`, [gone]);
    const r = (await json(browser, '/api/ai/compliance')).body;
    assert.equal(r.dormant, false);
    const codes = new Set(r.findings.map(f => f.code));
    for (const c of rules.RULES.map(x => x.code)) assert.ok(codes.has(c), `rule ${c} found something`);
    const of = (code, name) => r.findings.find(f => f.code === code && f.title === name);
    assert.match(of('over_allocated', 'AIC5 Office').why, /3 seats assigned, 2 bought/);
    assert.match(of('unused_seats', 'AIC5 Unused').why, /20 of 20 seats unused/);
    assert.equal(r.savings, 200000);
    assert.equal(r.findings[0].severity, 'high', 'most serious first');
    const scoped = (await json(viewerBrowser, '/api/ai/compliance')).body;
    assert.ok(scoped.findings.length && scoped.findings.every(f => f.target.type === 'license' && ['AIC5 Office', 'AIC5 Expired', 'AIC5 Unused'].includes(f.title)), JSON.stringify(scoped.findings.map(f => f.title)));
  });

  await t.test('Settings > AI lists the new capabilities, the job and the model', async () => {
    const page = (await browser.get('/settings/ai')).text;
    for (const s of ['Cost forecast &amp; refresh plan', 'Licence compliance', 'ai_cost_forecast', 'spend_holt_winters']) assert.ok(page.includes(s) || page.includes(s.replace('&amp;', '&')), s);
  });

  await t.test('switching off hides it all again', async () => {
    await flags.setFlag('cost', false, admin);
    await flags.setFlag('compliance', false, admin);
    assert.equal((await browser.get('/ai/planning')).status, 404);
    assert.equal((await browser.get('/api/ai/cost/forecast')).status, 404);
    assert.ok(!(await browser.get('/')).text.includes('aiCostCard('));
    assert.ok(!(await browser.get('/alerts')).text.includes('aiCompliance('));
    assert.equal(await ai.JOBS.find(j => j.key === 'ai_lifecycle').enabled(), false);
  });
});
