// AI layer M8: governance and the feedback loop. Unit: PSI and KS on known values, drift profiles
// (same data stable, shifted data significant, new categories named), the "same change" comparison
// behind rejection memory, the model catalog. On the test database: rollback, pins, activating a
// version, unpinning and permissions through Settings; drift (stable, significant -> retrain,
// pinned -> not retrained, a reference taken for an older version, retraining after 20 decisions);
// rejected recommendations not proposed again unless they changed; the feedback numbers; teaching
// the question classifier; the Settings and drift pages; the audit trail.
// The test-database helper must be required before any src/ module.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const drift = require('../src/ai/governance/drift');

test('PSI and KS on known values', () => {
  // (0.9 − 0.5) ln(0.9 / 0.5) + (0.1 − 0.5) ln(0.1 / 0.5) = 0.2351 + 0.6438
  assert.ok(Math.abs(drift.psi([0.5, 0.5], [0.9, 0.1]) - 0.8789) < 1e-4);
  assert.equal(drift.psi([0.2, 0.8], [0.2, 0.8]), 0);
  assert.ok(drift.psi([0.3, 0.7], [0, 1]) > 0, 'an empty bin does not divide by zero');
  const apart = drift.ks([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert.equal(apart.d, 1);
  assert.ok(apart.p < 0.01);
  assert.deepEqual(drift.ks([1, 2, 3], [1, 2, 3]), { d: 0, p: 1 });
  assert.equal(drift.ks([1, 2, 3, 4], [3, 4, 5, 6]).d, 0.5);
  assert.ok(drift.probKS(0.5) > drift.probKS(1) && drift.probKS(1) > drift.probKS(2));
  assert.equal(drift.level(0.05), 'stable');
  assert.equal(drift.level(0.2), 'moderate');
  assert.equal(drift.level(0.3), 'significant');
});

test('drift profiles: the same data is stable, shifted data is significant and says what moved', () => {
  let s = 3;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const gauss = m => m + Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  const rows = (mean, laptops, extra = null) => Array.from({ length: 2500 }, () => ({ cost: gauss(mean), cat: extra && r() < 0.3 ? extra : r() < laptops ? 'Laptop' : 'Desktop', ram: r() < 0.1 ? null : 16 }));
  const spec = [{ name: 'cost', kind: 'num', get: x => x.cost }, { name: 'category', kind: 'cat', get: x => x.cat }, { name: 'ram', kind: 'num', get: x => x.ram }];
  const base = drift.profile(rows(0, 0.7), spec);
  assert.equal(base.features.cost.edges.length, 9);
  assert.ok(base.features.cost.sample.length <= 400);
  const same = drift.compare(base, drift.profile(rows(0, 0.7), spec, new Date(), base));
  assert.equal(same.status, 'stable');
  assert.ok(same.max_psi < 0.02, `same data: ${same.max_psi}`);
  const moved = drift.compare(base, drift.profile(rows(1.2, 0.2, 'Tablet'), spec, new Date(), base));
  assert.equal(moved.status, 'significant');
  const cost = moved.features.find(f => f.feature === 'cost');
  assert.equal(cost.status, 'significant');
  assert.ok(cost.ks_p < 1e-6);
  assert.match(cost.shifts[0], /mean -?0(\.\d+)? → 1\.\d+/);
  const cat = moved.features.find(f => f.feature === 'category');
  assert.ok(cat.shifts.some(x => /Tablet .*\(new\)/.test(x)), cat.shifts.join(' | '));
  assert.equal(moved.features[0].psi >= moved.features[1].psi, true, 'worst first');
});

test('rejection memory compares the change itself, not scores or who backed it', () => {
  const { stableJson } = require('../src/ai/governance/approvals');
  const a = { category: { from: 'VM', to: 'Laptop' }, _to_id: '2', _options: [{ value: '2', label: 'Laptop', score: 0.91, agents: ['IntakeAgent'] }], _agents: ['IntakeAgent'] };
  const b = { _agents: ['DataQualityAgent', 'IntakeAgent'], _to_id: '2', category: { to: 'Laptop', from: 'VM' }, _options: [{ agents: ['IntakeAgent'], score: 0.62, label: 'Laptop', value: '2' }] };
  assert.equal(stableJson(a), stableJson(b));
  assert.notEqual(stableJson(a), stableJson({ ...a, _to_id: '3' }));
  assert.notEqual(stableJson({ _asset_ids: [1, 2] }), stableJson({ _asset_ids: [1, 2, 3] }));
});

test('the model catalog: only models used for a while can be rolled back or are checked for drift', () => {
  const { CATALOG } = require('../src/ai/governance/models');
  const { SPECS } = require('../src/ai/governance/driftSpecs');
  for (const [name, c] of Object.entries(CATALOG)) {
    assert.ok(c.label && c.purpose, name);
    if (!c.versioned) assert.ok(c.note, `${name} explains why its versions are not switched to`);
    assert.equal(!!c.drift, !!SPECS[name], name);
  }
  assert.deepEqual(Object.keys(CATALOG).filter(k => CATALOG[k].versioned).sort(), ['intake_classifier', 'lifecycle_weibull']);
});

// ─── On the test database ───

test('AI M8: governance and the feedback loop on the test database', { timeout: 300000 }, async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const ai = require('../src/ai');
  const { flags } = ai;
  ai.start();
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const scheduler = require('../src/services/schedulerService');
  const registry = require('../src/ai/governance/registry');
  const approvals = require('../src/ai/governance/approvals');
  const training = require('../src/ai/intake/training');
  const suggest = require('../src/ai/intake/suggest');
  const driftCheck = require('../src/ai/governance/driftCheck');
  const assistant = require('../src/ai/agents/assistant');

  const resetAi = async () => {
    await db.run('TRUNCATE ai_drift, ai_feedback, ai_recommendations, ai_models, ai_dq_issues, ai_dq_runs, ai_predictions RESTART IDENTITY CASCADE');
    await db.run(`DELETE FROM settings_history WHERE setting_id IN (SELECT id FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%'))`);
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
    suggest.invalidate();
    assistant.resetModel();
  };
  const cleanup = async () => {
    await db.run(`DELETE FROM assets WHERE asset_tag LIKE 'AIG8-%'`);
    await db.run(`DELETE FROM asset_categories WHERE name LIKE 'AIG8 %'`);
    await db.run(`DELETE FROM manufacturers WHERE name LIKE 'AIG8 %'`);
    await db.run(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'aig8_viewer')`);
    await db.run(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'aig8_viewer')`);
    await db.run(`DELETE FROM roles WHERE name = 'aig8_viewer'`);
    await db.run(`DELETE FROM users WHERE email LIKE 'aig8-%@hams.test'`);
  };
  await resetAi();
  await cleanup();

  const one = async (sql, p) => (await db.get(sql + ' RETURNING id', p)).id;
  const cat = {};
  for (const n of ['Laptop', 'Desktop', 'Tablet', 'Phone']) cat[n] = await one(`INSERT INTO asset_categories (name, type) VALUES ($1, 'asset')`, ['AIG8 ' + n]);
  const dell = await one(`INSERT INTO manufacturers (name) VALUES ('AIG8 Dell')`);
  const samsung = await one(`INSERT INTO manufacturers (name) VALUES ('AIG8 Samsung')`);
  let n = 0;
  const add = (name, mn, c, maker) => one(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category_id, manufacturer_id, status, purchase_date, purchase_cost, custom_fields_data)
     VALUES ($1::text, md5($1::text), $2, $3, $4, $5, $6, 'available', $7, 60000, '{}')`,
    [`AIG8-${++n}`, name, `AIG8SER${n}`, mn, c, maker, `202${n % 4}-0${(n % 9) + 1}-01`]);
  for (let i = 0; i < 40; i++) await add('Dell Latitude 5420', 'Latitude 5420', cat.Laptop, dell);
  for (let i = 0; i < 30; i++) await add('Dell OptiPlex 7070', 'OptiPlex 7070', cat.Desktop, dell);

  const pw = 'Ai-M8-Pass-2026!';
  const admin = await env.ensureUser({ email: 'aig8-admin@hams.test', name: 'AI M8 Admin', password: pw });
  const viewerRole = await one(`INSERT INTO roles (name, display_name, level) VALUES ('aig8_viewer', 'AI M8 approver', 20)`);
  await db.run(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE name IN ('ai.view', 'ai.approve', 'assets.view', 'dashboard.view')`, [viewerRole]);
  const viewer = await env.ensureUser({ email: 'aig8-viewer@hams.test', name: 'AI M8 Viewer', role: 'aig8_viewer', password: pw });
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
  const active = async name => (await db.get(`SELECT version FROM ai_models WHERE name = $1 AND status = 'active'`, [name]) || {}).version;
  const versions = async name => (await db.get(`SELECT COUNT(*)::int AS n FROM ai_models WHERE name = $1`, [name])).n;
  const audited = action => db.get(`SELECT description FROM activity_logs WHERE action = $1 ORDER BY id DESC LIMIT 1`, [action]);
  const post = async (url, form = {}, b = browser) => b.post(url, { _csrf: await b.csrf('/profile'), ...form });
  const I = 'intake_classifier';

  await flags.setMaster(true, admin);
  await flags.setFlag('intake', true, admin);
  await flags.setFlag('data_quality', true, admin);

  await t.test('rollback, pins, activating a version, unpinning: through Settings, audited', async () => {
    assert.equal((await training.train({ trigger: 'test', user: admin })).version, 1);
    const v1 = await db.get(`SELECT training FROM ai_models WHERE name = $1 AND version = 1`, [I]);
    assert.ok(v1.training.profile && v1.training.profile.features.category, 'the reference profile is stored with the version');
    assert.equal((await training.train({ trigger: 'test', user: admin })).activated, true);
    assert.equal(await active(I), 2);
    let page = (await browser.get('/settings/ai')).text;
    assert.ok(page.includes('Roll back to v1') && page.includes('Retrain now'));
    let r = await post(`/settings/ai/models/${I}/rollback`);
    assert.equal(r.status, 302);
    assert.equal(await active(I), 1);
    assert.equal(await registry.pinned(I), 1);
    suggest.invalidate();
    assert.equal((await suggest.suggest({ name: 'Dell Latitude 5420', model_number: 'Latitude 5420' })).version, 1, 'suggestions use the rolled-back version');
    assert.ok(await audited('AI_MODEL_ROLLED_BACK'));
    assert.ok(await audited('AI_MODEL_PINNED'));
    // Retraining while pinned keeps the new version as a candidate.
    const kept = await training.train({ trigger: 'test', user: admin });
    assert.equal(kept.activated, false);
    assert.match(kept.summary, /kept as a candidate \(v1 is pinned\)/);
    assert.equal(await active(I), 1);
    assert.match((await audited('AI_MODEL_KEPT_CANDIDATE')).description, /v3 trained and kept as a candidate/);
    page = (await browser.get('/settings/ai')).text;
    assert.ok(page.includes('pinned to v1') && page.includes('Unpin'));
    r = await post(`/settings/ai/models/${I}/activate`, { version: '3' });
    assert.equal(await active(I), 3);
    assert.equal(await registry.pinned(I), 3);
    await post(`/settings/ai/models/${I}/unpin`);
    assert.equal(await registry.pinned(I), null);
    assert.ok(await audited('AI_MODEL_UNPINNED'));
    assert.equal((await training.train({ trigger: 'test', user: admin })).activated, true, 'unpinned: retraining activates again');
    assert.equal(await active(I), 4);
    // Only people with settings.manage; versions of rebuilt models are not switched to.
    assert.equal((await post(`/settings/ai/models/${I}/rollback`, {}, viewerBrowser)).status, 403);
    assert.equal(await active(I), 4);
    await post('/settings/ai/models/anomaly_iforest/rollback');
    assert.match((await browser.get('/settings/ai')).text, /a record and are not rolled back/);
    // Retrain now: in the background through the job runner.
    await post(`/settings/ai/models/${I}/retrain`);
    assert.ok(await env.eventually(async () => (await versions(I)) === 5, 30000), 'retrained');
    assert.ok(await audited('AI_RETRAIN_REQUESTED'));
  });

  await t.test('drift: stable, then significant -> retrain; pinned -> not retrained; an older version gets a reference', async () => {
    let r = await driftCheck.run({ user: admin });
    assert.equal(r.results[0].status, 'stable', JSON.stringify(r.results));
    // A new kind of device arrives: tablets from another maker.
    for (let i = 0; i < 160; i++) await add('Samsung Galaxy Tab S8', 'SM-X700', cat.Tablet, samsung);
    const before = await versions(I);
    r = await scheduler.runNow('ai_drift', admin);
    assert.equal(r.status, 'ok', r.error);
    const row = await db.get(`SELECT * FROM ai_drift WHERE model_name = $1 ORDER BY id DESC LIMIT 1`, [I]);
    assert.equal(row.status, 'significant');
    assert.ok(Number(row.max_psi) > 0.25);
    const catF = row.features.find(f => f.feature === 'category');
    assert.equal(catF.status, 'significant');
    assert.ok(catF.shifts.some(s => /AIG8 Tablet .*\(new\)/.test(s)), catF.shifts.join(' | '));
    assert.match(row.action, /retraining started \(drift\)/);
    assert.match((await audited('AI_DRIFT_DETECTED')).description, /the data has moved since training: .*category/);
    assert.ok(await env.eventually(async () => (await versions(I)) === before + 1, 30000), 'the drift started a retrain');
    // The new version learnt the tablets: measured against its own reference, the data is stable again.
    await env.eventually(async () => (await active(I)) === before + 1, 10000);
    r = await driftCheck.run({ user: admin });
    assert.equal(r.results[0].status, 'stable');
    // Pinned: more drift is reported, not acted on.
    await registry.activate(I, await active(I), admin, { pin: true });
    for (let i = 0; i < 160; i++) await add('Samsung Galaxy S23', 'SM-S911', cat.Phone, samsung);
    const pinnedBefore = await versions(I);
    r = await driftCheck.run({ user: admin });
    assert.equal(r.results[0].status, 'significant');
    assert.ok(r.results[0].actions.some(a => /is pinned: not retrained/.test(a)));
    assert.equal(await versions(I), pinnedBefore);
    await registry.unpin(I, admin);
    // A version without a stored reference (trained before drift checks) gets one at its first check.
    await db.run(`UPDATE ai_models SET training = training - 'profile' WHERE name = $1 AND status = 'active'`, [I]);
    r = await driftCheck.run({ user: admin });
    assert.equal(r.results[0].status, 'baseline');
    const annotated = await db.get(`SELECT training FROM ai_models WHERE name = $1 AND status = 'active'`, [I]);
    assert.equal(annotated.training.profile_note, 'taken at the first drift check, after training');
    r = await driftCheck.run({ user: admin });
    assert.equal(r.results[0].status, 'stable');
    assert.match((await db.get(`SELECT action FROM ai_drift WHERE model_name = $1 ORDER BY id DESC LIMIT 1`, [I])).action, /Reference taken at the first drift check/);
  });

  await t.test('the feedback loop: 20 category decisions since training start a retrain', async () => {
    const recId = await one(`INSERT INTO ai_recommendations (type, agent, target_type, title, confidence, status, dedupe_key) VALUES ('dq.fix_category', 'DataQualityAgent', 'asset_model', 'AIG8 decided fix', 0.9, 'accepted', 'aig8-decided')`);
    for (let i = 0; i < 20; i++) await db.run(`INSERT INTO ai_feedback (recommendation_id, capability, label, created_at) VALUES ($1, 'data_quality', $2, CURRENT_TIMESTAMP + INTERVAL '1 second')`, [recId, i % 4 ? 'accepted' : 'rejected']);
    const before = await versions(I);
    const r = await driftCheck.run({ user: admin });
    assert.ok(r.results[0].actions.some(a => /20 category decisions since training/.test(a)), JSON.stringify(r.results[0].actions));
    assert.ok(r.results[0].actions.some(a => /retraining started \(new decisions to learn from\)/.test(a)));
    assert.ok(await env.eventually(async () => (await versions(I)) === before + 1, 30000));
  });

  await t.test('rejecting teaches: the same recommendation is not proposed again; a changed one is, and says so', async () => {
    const base = { type: 'dq.fix_category', agent: 'DataQualityAgent', target_type: 'asset_model', title: 'AIG8 group fix', why: ['peers disagree'], confidence: 0.9, dedupe_key: 'aig8-group',
      proposed: { category: { from: 'AIG8 Desktop', to: 'AIG8 Laptop' }, _asset_ids: [1, 2], _from_id: cat.Desktop, _to_id: cat.Laptop } };
    const first = await approvals.propose(base);
    await approvals.decide(first, 'reject', admin, 'these are desktops');
    const held = approvals.suppressedCount();
    assert.equal(await approvals.propose(base), null);
    assert.equal(approvals.suppressedCount(), held + 1);
    const changed = await approvals.propose({ ...base, proposed: { ...base.proposed, _asset_ids: [1, 2, 3] } });
    assert.ok(changed);
    const rec = await db.get('SELECT why FROM ai_recommendations WHERE id = $1', [changed]);
    assert.ok(rec.why.some(w => new RegExp(`similar recommendation \\(#${first}\\) was rejected`).test(w.text)));
  });

  await t.test('feedback numbers: acceptance by kind and version, search clicks, unusual assets, overrides', async () => {
    for (const rank of [1, 1, 2, 5, 12]) await db.run(`INSERT INTO ai_feedback (capability, target_type, label, predicted) VALUES ('search', 'asset', 'accepted', $1)`, [JSON.stringify({ q: 'x', rank })]);
    for (const label of ['accepted', 'accepted', 'rejected']) await db.run(`INSERT INTO ai_feedback (capability, target_type, label) VALUES ('anomaly', 'asset', $1)`, [label]);
    const f = await require('../src/ai/governance/feedback').summary();
    assert.equal(f.search.clicks, 5);
    assert.ok(Math.abs(f.search.mrr10 - (1 + 1 + 0.5 + 0.2 + 0) / 5) < 1e-9);
    assert.equal(f.search.top1, 0.4);
    assert.ok(Math.abs(f.anomaly.precision - 2 / 3) < 1e-9);
    const fix = f.byType.find(x => x.type === 'dq.fix_category');
    assert.equal(fix.accepted, 15);
    assert.equal(fix.rejected, 6, '5 of the 20 plus the one rejected above');
    assert.ok(f.overrides.some(o => o.label === 'rejected' && /AIG8/.test(o.title || '')));
    const page = (await browser.get('/settings/ai')).text;
    assert.ok(page.includes('Feedback') && page.includes('MRR@10 54%') && page.includes('67%'));
  });

  await t.test('teaching the question classifier: a taught question is learnt, audited, retrained once', async () => {
    await flags.setFlag('nl', true, admin);
    assistant.resetModel();
    const q = 'zorbify the laptops';
    const before = JSON.parse((await browser.get('/api/ai/ask?q=' + encodeURIComponent(q))).text);
    assert.notEqual(before.intent, 'count');
    const nlBefore = await versions('nl_intent');
    let page = (await browser.get('/settings/ai')).text;
    assert.ok(page.includes(q) && page.includes('Teach'), 'the miss is listed with a Teach button');
    const r = await post('/settings/ai/nl/teach', { q, intent: 'count' });
    assert.equal(r.status, 302);
    assert.equal((await db.get(`SELECT label, actual FROM ai_feedback WHERE capability = 'nl' AND label = 'taught'`)).actual.intent, 'count');
    assert.match((await audited('AI_NL_TAUGHT')).description, /taught as "count"/);
    const after = JSON.parse((await browser.get('/api/ai/ask?q=' + encodeURIComponent(q))).text);
    assert.equal(after.intent, 'count', 'learnt');
    assert.equal(await versions('nl_intent'), nlBefore + 1);
    const m = await db.get(`SELECT training FROM ai_models WHERE name = 'nl_intent' AND status = 'active'`);
    assert.equal(m.training.taught, 1);
    page = (await browser.get('/settings/ai')).text;
    assert.ok(page.includes('Taught: count'));
    assert.equal((await post('/settings/ai/nl/teach', { q, intent: 'not_an_intent' })).status, 302);
    assert.match((await browser.get('/settings/ai')).text, /Pick one of the kinds of question/);
    // Nothing new: Retrain now says so and makes no version.
    assert.match((await assistant.retrain()).summary, /Nothing new to learn/);
    assert.equal(await versions('nl_intent'), nlBefore + 1);
  });

  await t.test('the drift report and its permissions', async () => {
    const page = await browser.get('/settings/ai/drift');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Drift report') && page.text.includes('Intake classifier') && page.text.includes('Significant') && page.text.includes('History'));
    assert.ok(page.text.includes('first word of the name'));
    assert.equal((await viewerBrowser.get('/settings/ai/drift')).status, 403);
    const s = (await browser.get('/settings/ai')).text;
    assert.ok(s.includes('Drift report') && s.includes('max PSI'));
  });

  await t.test('drift checks stop when their capabilities are off', async () => {
    await flags.setFlag('intake', false, admin);
    await flags.setFlag('data_quality', false, admin);
    const job = ai.JOBS.find(j => j.key === 'ai_drift');
    assert.equal(await job.enabled(), false);
    assert.match((await driftCheck.run({ user: admin })).summary, /No model to check/);
  });
});
