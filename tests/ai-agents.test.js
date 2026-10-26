// AI layer M7: the agents and the orchestrator. Unit: the task-graph runner (order, parallel steps,
// retries, timeouts, skips, cycles), the blackboard, confidence-weighted conflict resolution,
// agent weights, every agent's contract, and agent logic with stubbed tools. On the test database:
// off by default; asset reviews (agree -> recommend, disagree -> closer look with options, confirm
// -> nothing, already covered -> skipped); event routing with debounce and the rate limit; retries
// and partial runs in the trace; the full inbox (filters, scope, bulk, picking another option ->
// "edited" and new weights); repair-or-replace; licence checks; questions traced; the daily
// briefing and pruning; the import review through the job runner; trace pages; switching off.
// The test-database helper must be required before any src/ module.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const dag = require('../src/ai/orchestrator/dag');
const Blackboard = require('../src/ai/orchestrator/blackboard');
const { resolve } = require('../src/ai/orchestrator/resolve');
const { weightFor } = require('../src/ai/orchestrator/weights');
const agents = require('../src/ai/agents');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('task graph: dependencies first, independent steps side by side, levels', async () => {
  const log = [];
  const node = (id, deps = [], ms = 40) => ({ id, agent: 'T', deps, run: async () => { log.push(`start ${id}`); await sleep(ms); log.push(`end ${id}`); return id; } });
  const nodes = [node('a'), node('b'), node('c', ['a', 'b']), node('d', ['c'], 5)];
  const t0 = Date.now();
  const out = await dag.run(nodes, {}, { concurrency: 4 });
  const took = Date.now() - t0;
  assert.deepEqual(out.map(r => r.status), ['done', 'done', 'done', 'done']);
  assert.ok(took < 150, `a and b ran side by side (${took} ms)`);
  assert.ok(log.indexOf('end a') < log.indexOf('start c') && log.indexOf('end b') < log.indexOf('start c'));
  assert.ok(log.indexOf('end c') < log.indexOf('start d'));
  assert.deepEqual([...dag.levels(nodes)], [['a', 0], ['b', 0], ['c', 1], ['d', 2]]);
  // concurrency 1: one at a time
  const t1 = Date.now();
  await dag.run([node('x'), node('y')], {}, { concurrency: 1 });
  assert.ok(Date.now() - t1 >= 75);
});

test('task graph: retries, no retry when told, timeouts, skipped dependents, always, cycles', async () => {
  let tries = 0;
  const flaky = { id: 'flaky', agent: 'T', run: async () => { if (++tries < 2) throw new Error('blip'); return 'ok'; } };
  const fatal = { id: 'fatal', agent: 'T', run: async () => { throw Object.assign(new Error('bad input'), { retryable: false }); } };
  const slow = { id: 'slow', agent: 'T', timeoutMs: 30, run: () => sleep(500) };
  const after = { id: 'after', agent: 'T', deps: ['fatal'], run: async () => 'never' };
  const always = { id: 'always', agent: 'T', deps: ['fatal', 'slow'], always: true, run: async () => 'ran' };
  const steps = [];
  const out = await dag.run([flaky, fatal, slow, after, always], {}, { retries: 2, backoffMs: 1, onStep: r => { steps.push(r.id); throw new Error('trace write failed'); } });
  const by = Object.fromEntries(out.map(r => [r.id, r]));
  assert.equal(by.flaky.status, 'done');
  assert.equal(by.flaky.attempts, 2);
  assert.equal(by.fatal.status, 'failed');
  assert.equal(by.fatal.attempts, 1, 'retryable: false is not retried');
  assert.equal(by.slow.status, 'timeout');
  assert.match(by.slow.error, /Timed out after 30 ms/);
  assert.equal(by.after.status, 'skipped');
  assert.match(by.after.error, /fatal did not finish/);
  assert.equal(by.always.status, 'done');
  assert.equal(by.always.output, 'ran');
  assert.equal(steps.length, 5, 'every step reported, and a failing report does not stop the run');
  assert.throws(() => dag.validate([{ id: 'p', deps: ['q'] }, { id: 'q', deps: ['p'] }]), /cycle/);
  assert.throws(() => dag.validate([{ id: 'p', deps: ['zz'] }]), /unknown node/);
  assert.throws(() => dag.validate([{ id: 'p' }, { id: 'p' }]), /duplicate/);
});

test('blackboard: claims are checked, results posted, the trace trimmed', () => {
  const bb = new Blackboard({ asset_id: 1 });
  bb.post('A', 'risk', { risk12: 0.4 });
  assert.equal(bb.get('risk').risk12, 0.4);
  assert.throws(() => bb.claim({ agent: 'A', target_type: 'asset', target_id: 1, field: 'x', value: 'y', confidence: 1.2 }), /confidence/);
  assert.throws(() => bb.claim({ agent: 'A', field: 'x', value: 'y', confidence: 0.5 }), /target/);
  bb.claim({ agent: 'A', target_type: 'asset', target_id: 1, field: 'category_id', value: 5, current: 3, confidence: 0.9, why: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.equal(bb.claims[0].value, '5');
  assert.equal(bb.claims[0].current, '3');
  assert.equal(bb.claims[0].why.length, 5);
  bb.post('A', 'big', 'x'.repeat(10000));
  const j = bb.toJSON();
  assert.equal(j.entries.big.value._truncated, true);
  assert.equal(j.claims.length, 1);
});

test('conflict resolution: agreement, disagreement, confirmation, weak claims, weights', () => {
  const c = (agent, value, confidence, current = '1') => ({ agent, target_type: 'asset', target_id: 7, field: 'category_id', value, label: { 1: 'Desktop', 2: 'Laptop', 3: 'Monitor' }[value], current, current_label: 'Desktop', confidence, why: [`${agent} reason`] });
  const one = (claims, opts) => resolve(claims, opts)[0];
  // Two agents agree: share 1, agreement 1 - 0.08 x 0.15.
  const agree = one([c('IntakeAgent', '2', 0.92), c('DataQualityAgent', '2', 0.85)]);
  assert.equal(agree.outcome, 'propose');
  assert.ok(Math.abs(agree.confidence - (1 - 0.08 * 0.15)) < 1e-3);
  assert.deepEqual(agree.agents.sort(), ['DataQualityAgent', 'IntakeAgent']);
  // One very sure agent alone: proposed; one fairly sure: for a closer look; one unsure: dropped.
  assert.equal(one([c('IntakeAgent', '2', 0.93)]).outcome, 'propose');
  assert.equal(one([c('IntakeAgent', '2', 0.65)]).outcome, 'review');
  assert.equal(one([c('IntakeAgent', '2', 0.4)]).outcome, 'drop');
  // Disagreement between two other values: closer look, both options kept.
  const split = one([c('IntakeAgent', '2', 0.92), c('DataQualityAgent', '3', 0.8)]);
  assert.equal(split.outcome, 'review');
  assert.equal(split.value, '2');
  assert.deepEqual(split.options.map(o => o.value), ['2', '3']);
  assert.ok(split.why.some(w => /disagree/.test(w)));
  // The agents confirm what is recorded: nothing to do.
  assert.equal(one([c('IntakeAgent', '1', 0.9), c('DataQualityAgent', '1', 0.6)]).outcome, 'keep');
  // Mostly confirmed, but a strong dissent still reaches a person (proposing the dissent).
  const dissent = one([c('IntakeAgent', '1', 0.95), c('DataQualityAgent', '1', 0.6), c('AnomalyAgent', '2', 0.95)], { weights: { AnomalyAgent: 1 } });
  assert.equal(dissent.outcome, 'review');
  assert.equal(dissent.value, '2');
  // Weights: the same two opinions, but one agent has a much better record.
  const trusted = one([c('IntakeAgent', '2', 0.8), c('DataQualityAgent', '3', 0.8)], { weights: { IntakeAgent: 1, DataQualityAgent: 0.5 } });
  assert.equal(trusted.value, '2');
  const other = one([c('IntakeAgent', '2', 0.8), c('DataQualityAgent', '3', 0.8)], { weights: { IntakeAgent: 0.5, DataQualityAgent: 1 } });
  assert.equal(other.value, '3');
  // Separate fields and targets are resolved separately.
  assert.equal(resolve([c('IntakeAgent', '2', 0.9), { ...c('IntakeAgent', '2', 0.9), target_id: 8 }, { ...c('IntakeAgent', '2', 0.9), field: 'manufacturer_id' }]).length, 3);
  // Agent weights from the record.
  assert.equal(weightFor(0, 0), 0.75);
  assert.ok(weightFor(20, 0) > 0.97 && weightFor(0, 20) < 0.53 && weightFor(1, 0) < 0.85);
});

test('every agent declares a goal, a tool whitelist, thresholds and escalation, and uses only its tools', async () => {
  const list = agents.describeAll(new Set(['intake']));
  assert.deepEqual(list.map(a => a.name), ['IntakeAgent', 'DataQualityAgent', 'MaintenanceAgent', 'AnomalyAgent', 'LifecycleCostAgent', 'ComplianceAgent', 'AssistantAgent', 'ReportAgent']);
  for (const a of list) {
    assert.ok(a.goal && a.goal.length > 20, `${a.name} goal`);
    assert.ok(a.tools.length >= 1, `${a.name} tools`);
    assert.ok(a.escalation && a.thresholds, `${a.name} escalation / thresholds`);
    assert.ok(a.input && a.output, `${a.name} schemas`);
    for (const tool of a.tools) assert.ok(!/^(update|delete|create|apply|retire|assign|buy|set)/i.test(tool), `${a.name}.${tool} must not be a write tool`);
  }
  assert.equal(list.find(a => a.name === 'IntakeAgent').available, true);
  assert.equal(list.find(a => a.name === 'AnomalyAgent').available, false);
  const ag = agents.AGENTS[0].mod.make(null);
  await assert.rejects(ag.use('updateAsset', {}), /not on its whitelist/);
});

test('agent logic with stubbed tools: intake claims and duplicates, repairs, risk, the briefing', async () => {
  const intake = require('../src/ai/agents/intake');
  const ag = intake.make(null);
  ag.tools.suggest = async () => ({ ready: true, suggestions: [
    { field: 'category_id', value: 2, label: 'Laptop', confidence: 0.91, why: ['Reads like a laptop'] },
    { field: 'manufacturer_id', value: 9, label: 'Dell', confidence: 0.5, why: [] },
    { field: 'asset_model_id', value: 4, label: 'Latitude', confidence: 0.99, why: [] }] });
  ag.tools.duplicates = async () => [{ id: 44, asset_tag: 'T-44', name: 'Other', reason: 'Same serial number written differently', confidence: 1 }];
  const bb = new Blackboard();
  const out = await intake.reviewAsset(ag, bb, { id: 1, name: 'Dell Latitude', category_id: 1, category_name: 'Desktop', manufacturer_id: 9, custom_fields_data: {} });
  assert.deepEqual(out, { ready: true, claims: 1, duplicates: 1 });
  assert.equal(bb.claims[0].field, 'category_id');
  assert.equal(bb.claims[0].current, '1');
  assert.equal(bb.findings[0].severity, 'high');
  assert.deepEqual(ag.calls.map(c => c.tool), ['suggest', 'duplicates']);

  const maintenance = require('../src/ai/agents/maintenance');
  const m = maintenance.make(null);
  const recent = d => new Date(Date.now() - d * 864e5);
  m.tools.unitCosts = async () => ({ Laptop: { cost: 70000 } });
  const repairBb = rows => { const b = new Blackboard(); m.tools.history = async () => rows; return maintenance.reviewRepair(m, b, { id: 3, category_name: 'Laptop' }).then(() => b); };
  const many = await repairBb([1, 2, 3].map(i => ({ maintenance_type: 'repair', start_date: recent(30 * i), cost: 5000 })));
  assert.equal(many.claims[0].value, 'replace');
  assert.equal(many.claims[0].confidence, 0.8);
  const costly = await repairBb([{ maintenance_type: 'repair', start_date: recent(10), cost: 40000 }]);
  assert.equal(costly.claims[0].value, 'replace', 'repairs above half the price of a new one');
  const rare = await repairBb([{ maintenance_type: 'repair', start_date: recent(200), cost: 3000 }]);
  assert.equal(rare.claims[0].value, 'repair');
  assert.match(rare.claims[0].why.join(' '), /4% of a new laptop/);
  assert.equal((await repairBb([])).claims.length, 0);

  const lifecycleCost = require('../src/ai/agents/lifecycleCost');
  const rb = new Blackboard();
  rb.post('LifecycleCostAgent', 'risk', { risk12: 0.7, why: ['8.0 years old'] });
  lifecycleCost.claimAction(rb, { id: 3 });
  assert.equal(rb.claims[0].value, 'replace');
  rb.post('LifecycleCostAgent', 'risk', { risk12: 0.05, why: ['1.0 years old'] });
  lifecycleCost.claimAction(rb, { id: 3 });
  assert.equal(rb.claims[1].value, 'repair');
  // Both views on the blackboard: the orchestrator resolves them.
  const d = resolve([...many.claims, rb.claims[1]])[0];
  assert.equal(d.field, 'repair_or_replace');
  assert.equal(d.outcome, 'review', 'repair history and risk disagree');

  const report = require('../src/ai/agents/report');
  const fb = new Blackboard();
  fb.post('DataQualityAgent', 'health', { ready: true, avg: 83, assets: 26736, poor: 3001, trend: 1.5, top: [{ label: 'No FAMS barcode', n: 900 }] });
  fb.post('ComplianceAgent', 'compliance', { dormant: true, findings: 0 });
  const lines = report.compose(fb, new Set(['risk']));
  assert.match(lines[0].text, /Data health averages 83 over 26,736 assets \(3,001 poor\), up 1.5/);
  assert.equal(lines.length, 3, 'parts not posted are left out (cost, unusual)');
  assert.match(lines[1].text, /Refresh risk could not be read/, 'a part that failed says so');
  assert.match(lines[2].text, /waiting for licence/);
});

// ─── On the test database ───

test('AI M7: agents and the orchestrator on the test database', { timeout: 300000 }, async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const ai = require('../src/ai');
  const { flags } = ai;
  ai.start();
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const automation = require('../src/services/automationService');
  const assetService = require('../src/services/assetService');
  const operations = require('../src/services/operationsService');
  const scheduler = require('../src/services/schedulerService');
  const approvals = require('../src/ai/governance/approvals');
  const orchestrator = require('../src/ai/orchestrator');
  const weights = require('../src/ai/orchestrator/weights');
  const training = require('../src/ai/intake/training');
  orchestrator.setTiming({ debounceMs: 30, importDelayMs: 30, reviewsPerMinute: 1000 });

  const resetAi = async () => {
    await db.run('TRUNCATE ai_run_steps, ai_runs, ai_feedback, ai_recommendations, ai_models, ai_dq_issues, ai_dq_runs, ai_predictions RESTART IDENTITY CASCADE');
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
    weights.invalidate();
    require('../src/ai/intake/suggest').invalidate();
  };
  const cleanup = async () => {
    await db.run(`DELETE FROM asset_maintenance WHERE asset_id IN (SELECT id FROM assets WHERE asset_tag LIKE 'AIM7-%')`);
    await db.run(`DELETE FROM license_assignments WHERE license_id IN (SELECT id FROM licenses WHERE name LIKE 'AIM7 %')`);
    await db.run(`DELETE FROM licenses WHERE name LIKE 'AIM7 %'`);
    await db.run(`DELETE FROM assets WHERE asset_tag LIKE 'AIM7-%'`);
    await db.run(`DELETE FROM asset_categories WHERE name LIKE 'AIM7 %'`);
    await db.run(`DELETE FROM manufacturers WHERE name LIKE 'AIM7 %'`);
    await db.run(`DELETE FROM locations WHERE name LIKE 'AIM7 %'`);
    await db.run(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'aim7_viewer')`);
    await db.run(`DELETE FROM role_location_scopes WHERE role_id IN (SELECT id FROM roles WHERE name = 'aim7_viewer')`);
    await db.run(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'aim7_viewer')`);
    await db.run(`DELETE FROM roles WHERE name = 'aim7_viewer'`);
    await db.run(`DELETE FROM users WHERE email LIKE 'aim7-%@hams.test'`);
  };
  await resetAi();
  await cleanup();

  // ── Fixtures: laptops, desktops and monitors to train the intake model on, plus the assets under review ──
  const one = async (sql, p) => (await db.get(sql + ' RETURNING id', p)).id;
  const laptop = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIM7 Laptop', 'asset')`);
  const desktop = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIM7 Desktop', 'asset')`);
  const monitor = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIM7 Monitor', 'asset')`);
  const dell = await one(`INSERT INTO manufacturers (name) VALUES ('AIM7 Dell')`);
  const pune = await one(`INSERT INTO locations (name) VALUES ('AIM7 Pune')`);
  const powai = await one(`INSERT INTO locations (name) VALUES ('AIM7 Powai')`);
  const instock = (await db.get(`SELECT id FROM status_labels WHERE name = 'In Stock'`)).id;
  let serial = 0;
  // The assets under review were bought earlier: the intake model calibrates on the newest 10%, and
  // a calibration set full of deliberately mis-filed assets would (rightly) make it unsure.
  const asset = (tag, name, modelNumber, category, loc = pune, bought = '2023-04-01') => one(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category_id, manufacturer_id, location_id, status, status_label_id, purchase_date, purchase_cost, custom_fields_data)
     VALUES ($1::text, md5($1::text), $2, $3, $4, $5, $6, $7, 'available', $8, $9, 60000, '{}')`,
    [tag, name, `AIM7SER${++serial}`, modelNumber, category, dell, loc, instock, bought]);
  for (let i = 0; i < 30; i++) await asset(`AIM7-L${i}`, 'Dell Latitude 5420', 'Latitude 5420', laptop, i % 2 ? pune : powai);
  for (let i = 0; i < 30; i++) await asset(`AIM7-D${i}`, 'Dell OptiPlex 7070', 'OptiPlex 7070', desktop, i % 2 ? pune : powai);
  for (let i = 0; i < 15; i++) await asset(`AIM7-M${i}`, 'Dell P2419H Monitor', 'P2419H', monitor);
  const old = '2019-06-01';
  const A = await asset('AIM7-A', 'Dell Latitude 5420', 'Latitude 5420', desktop, pune, old);      // agents agree: a laptop
  const B = await asset('AIM7-B', 'Dell Latitude 5420', 'Latitude 5420', monitor, powai, old);     // agents disagree
  const C = await asset('AIM7-C', 'Dell OptiPlex 7070', 'OptiPlex 7070', desktop, pune, old);      // all fine
  const D = await asset('AIM7-D', 'Dell Latitude 5420', 'Latitude 5420', desktop, pune, old);      // already in AI Approvals
  const E = await asset('AIM7-E', 'Dell Latitude 5420', 'Latitude 5420', laptop, powai, old);      // repairs
  const F = await asset('AIM7-F', 'Dell Latitude 5420', 'Latitude 5420', monitor, powai, old);     // for the bulk test

  const pw = 'Ai-M7-Pass-2026!';
  const admin = await env.ensureUser({ email: 'aim7-admin@hams.test', name: 'AI M7 Admin', password: pw });
  const viewerRole = await one(`INSERT INTO roles (name, display_name, level) VALUES ('aim7_viewer', 'AI M7 approver', 20)`);
  await db.run(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE name IN ('ai.view', 'ai.approve', 'assets.view', 'dashboard.view')`, [viewerRole]);
  await db.run(`INSERT INTO role_location_scopes (role_id, location_id) VALUES ($1, $2)`, [viewerRole, powai]);
  const viewer = await env.ensureUser({ email: 'aim7-viewer@hams.test', name: 'AI M7 Viewer', role: 'aim7_viewer', password: pw });

  const app = await env.startApp();
  const browser = new env.Browser(app.base);
  const viewerBrowser = new env.Browser(app.base);
  t.after(async () => {
    await orchestrator.drain();
    await app.close();
    await cleanup();
    await resetAi();
    await db.pool.end();
  });
  await browser.login(admin.email, pw);
  await viewerBrowser.login(viewer.email, pw);
  const runs = () => db.query('SELECT * FROM ai_runs ORDER BY id');
  const lastRun = async flow => db.get('SELECT * FROM ai_runs WHERE flow = $1 ORDER BY id DESC LIMIT 1', [flow]);
  const stepsOf = id => db.query('SELECT * FROM ai_run_steps WHERE run_id = $1 ORDER BY id', [id]);
  const recFor = (assetId, type = 'agents.set_field') => db.get(`SELECT * FROM ai_recommendations WHERE target_type = 'asset' AND target_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1`, [assetId, type]);
  // A fresh data-health result for an asset (as if the nightly scan had just seen it).
  const scanned = async (id, issue = null) => {
    await db.run(`INSERT INTO ai_predictions (asset_id, capability, score, label, computed_at) VALUES ($1, 'data_quality', 80, 'Fair', CURRENT_TIMESTAMP)
                  ON CONFLICT (asset_id, capability) DO UPDATE SET computed_at = EXCLUDED.computed_at`, [id]);
    if (issue) await db.run(`INSERT INTO ai_dq_issues (asset_id, code, severity, confidence, detail, data) VALUES ($1, 'category_mismatch', 'medium', $2, $3, $4)`, [id, issue.confidence, issue.detail, JSON.stringify(issue.data)]);
  };

  await t.test('off by default: no runs from events, no pages, nothing on the asset page', async () => {
    await flags.setMaster(true, admin);
    assert.equal(await flags.isOn('agents'), false);
    automation.publish('asset.updated', { asset_id: A });
    await orchestrator.drain();
    assert.equal((await runs()).length, 0);
    assert.equal((await browser.get('/ai/runs')).status, 404);
    assert.equal((await browser.get(`/api/ai/assets/${A}/agents`)).status, 404);
    assert.ok(!(await browser.get(`/assets/${A}`)).text.includes('aiAssetAgents('));
    assert.equal(await orchestrator.run('asset.review', { asset_id: A }), null, 'the orchestrator itself refuses while off');
    const cap = (await flags.overview()).find(c => c.key === 'agents');
    assert.equal(cap.needs_migration, false);
  });

  await t.test('asset reviews: agree -> recommend, disagree -> closer look, confirm -> nothing, covered -> skipped', async () => {
    for (const k of ['intake', 'data_quality', 'agents']) await flags.setFlag(k, true, admin);
    assert.ok((await training.train({ trigger: 'test', user: admin })).version);
    require('../src/ai/intake/suggest').invalidate();
    await scanned(A, { confidence: 0.85, detail: 'Filed as Desktop, but its model reads like a Laptop', data: { from: desktop, to: laptop } });
    await scanned(B, { confidence: 0.8, detail: 'Filed as Monitor, but its peers are Desktops', data: { from: monitor, to: desktop } });
    await scanned(C);
    await scanned(D, { confidence: 0.85, detail: 'Filed as Desktop, but its model reads like a Laptop', data: { from: desktop, to: laptop } });
    await scanned(F, { confidence: 0.85, detail: 'Filed as Monitor, but its model reads like a Laptop', data: { from: monitor, to: laptop } });
    const covering = await approvals.propose({ type: 'dq.fix_category', agent: 'DataQualityAgent', target_type: 'asset_model', title: 'AIM7 group fix',
      why: ['test'], confidence: 0.9, dedupe_key: 'aim7-d', location_id: pune,
      proposed: { category: { from: 'AIM7 Desktop', to: 'AIM7 Laptop' }, _asset_ids: [D], _from_id: desktop, _to_id: laptop } });
    assert.ok(covering);

    const a = await orchestrator.run('asset.review', { asset_id: A }, { trigger: 'request', user: admin });
    assert.equal(a.status, 'done');
    const dagA = (await db.get('SELECT dag FROM ai_runs WHERE id = $1', [a.id])).dag;
    assert.deepEqual(dagA.nodes.map(n => [n.id, n.level]), [['intake', 0], ['quality', 0], ['resolve', 1]]);
    assert.deepEqual(dagA.omitted.map(o => o.agent).sort(), ['AnomalyAgent', 'LifecycleCostAgent']);
    const stepsA = await stepsOf(a.id);
    assert.deepEqual(stepsA.map(s => s.node).sort(), ['intake', 'quality', 'resolve']);
    assert.deepEqual(stepsA.find(s => s.node === 'intake').tool_calls.map(c => c.tool), ['suggest', 'duplicates']);
    assert.deepEqual(stepsA.find(s => s.node === 'quality').tool_calls.map(c => c.tool), ['score', 'issues']);
    const recA = await recFor(A);
    assert.equal(String(recA.run_id), String(a.id));
    assert.equal(recA.needs_review, false);
    assert.equal(recA.agent, 'Orchestrator');
    assert.equal(String(recA.proposed._to_id), String(laptop));
    assert.deepEqual(recA.proposed._agents.sort(), ['DataQualityAgent', 'IntakeAgent']);
    assert.ok(Number(recA.confidence) >= 0.9);
    assert.equal(recA.location_id, pune);
    assert.equal((await assetService.find(A)).category_id, desktop, 'nothing changes without a person');

    const b = await orchestrator.run('asset.review', { asset_id: B }, { trigger: 'request', user: admin });
    const recB = await recFor(B);
    assert.equal(recB.needs_review, true);
    assert.match(recB.title, /agents disagree/);
    assert.deepEqual(recB.proposed._options.map(o => String(o.value)).sort(), [String(laptop), String(desktop)].sort());
    const ctxB = (await db.get('SELECT context FROM ai_runs WHERE id = $1', [b.id])).context;
    assert.equal(ctxB.decisions[0].outcome, 'review');

    await orchestrator.run('asset.review', { asset_id: C }, { trigger: 'request', user: admin });
    assert.equal(await recFor(C), null);
    assert.equal((await lastRun('asset.review')).context.decisions[0].outcome, 'keep');

    await orchestrator.run('asset.review', { asset_id: D }, { trigger: 'request', user: admin });
    assert.equal(await recFor(D), null);
    assert.match((await lastRun('asset.review')).context.decisions[0].proposal.skipped, new RegExp(`Already in AI Approvals \\(#${covering}\\)`));
    await orchestrator.run('asset.review', { asset_id: F }, { trigger: 'request', user: admin });
    assert.ok(await recFor(F));
    // Every run has a step per node of its graph.
    for (const r of await runs()) assert.equal((await stepsOf(r.id)).length, r.dag.nodes.length, `run ${r.id}`);
  });

  await t.test('events: routed after a short pause, bursts merged, a rate limit, the real update hook', async () => {
    const before = (await runs()).length;
    automation.publish('asset.updated', { asset_id: C });
    automation.publish('asset.status_changed', { asset_id: C });
    automation.publish('asset.updated', { asset_id: C });
    await orchestrator.drain();
    const fresh = (await runs()).slice(before);
    assert.equal(fresh.length, 1, 'three quick events, one review');
    assert.equal(fresh[0].trigger, 'asset.updated');
    orchestrator.setTiming({ reviewsPerMinute: 1 });
    const dropped = orchestrator.stats().dropped;
    automation.publish('asset.updated', { asset_id: A });
    automation.publish('asset.updated', { asset_id: C });
    await orchestrator.drain();
    assert.equal((await runs()).length, before + 2, 'one more review, the other dropped');
    assert.equal(orchestrator.stats().dropped, dropped + 1);
    orchestrator.setTiming({ reviewsPerMinute: 1000 });
    // Through the real service: an edit fires asset.updated.
    const c = await assetService.find(C);
    await assetService.updateAsset(C, { ...c, name: 'Dell OptiPlex 7070 (edited)', purchase_date: '2023-04-01', warranty_expiry: '' }, admin);
    await orchestrator.drain();
    const r = await lastRun('asset.review');
    assert.equal(r.trigger, 'asset.updated');
    assert.equal(r.target_id, C);
    const q = (await stepsOf(r.id)).find(s => s.node === 'quality');
    assert.match(JSON.stringify(q.output), /predates the asset's last change/, 'a scan older than the edit says nothing');
  });

  await t.test('retries and partial runs are in the trace', async () => {
    const dq = require('../src/ai/agents/dataQuality');
    const orig = dq.reviewAsset;
    let n = 0;
    dq.reviewAsset = async (...args) => { if (n++ === 0) throw new Error('database blip'); return orig(...args); };
    const ok = await orchestrator.run('asset.review', { asset_id: A }, { trigger: 'request', user: admin });
    const q = (await stepsOf(ok.id)).find(s => s.node === 'quality');
    assert.equal(q.status, 'done');
    assert.equal(q.attempts, 2);
    dq.reviewAsset = async () => { throw Object.assign(new Error('bad data'), { retryable: false }); };
    const part = await orchestrator.run('asset.review', { asset_id: A }, { trigger: 'request', user: admin });
    dq.reviewAsset = orig;
    assert.equal(part.status, 'partial');
    const steps = await stepsOf(part.id);
    assert.equal(steps.find(s => s.node === 'quality').status, 'failed');
    assert.equal(steps.find(s => s.node === 'resolve').status, 'done', 'resolve runs on what the others produced');
    assert.match((await db.get('SELECT error FROM ai_runs WHERE id = $1', [part.id])).error, /quality: bad data/);
    const missing = await orchestrator.run('asset.review', { asset_id: 99999999 }, { trigger: 'request', user: admin });
    assert.equal(missing.status, 'failed');
  });

  await t.test('inbox: filters, facets, location scope, picking another option, bulk decisions, weights', async () => {
    const recA = await recFor(A), recB = await recFor(B), recF = await recFor(F);
    const page = async (b, qs) => (await b.get('/ai/approvals' + qs)).text;
    let html = await page(browser, '?review=1');
    assert.ok(html.includes(recB.title) && !html.includes(recA.title));
    assert.ok(html.includes('Closer look (1)'));
    html = await page(browser, '?agent=IntakeAgent');
    assert.ok(html.includes(recA.title) && html.includes(recB.title) && !html.includes('AIM7 group fix'));
    html = await page(browser, '?agent=DataQualityAgent&type=dq.fix_category');
    assert.ok(html.includes('AIM7 group fix') && !html.includes(recA.title));
    html = await page(browser, '?min=0.9&q=AIM7-A');
    assert.ok(html.includes(recA.title) && !html.includes(recB.title));
    assert.ok(html.includes('How the agents decided'));
    assert.equal((await browser.get('/ai/approvals?agent=%27%3Bdrop&min=7&location_id=x&sort=evil')).status, 200, 'bad filter values are ignored');
    html = await page(viewerBrowser, '');
    assert.ok(html.includes(recB.title) && html.includes(recF.title) && !html.includes(recA.title), 'a Powai approver sees Powai only');

    // Picking DataQualityAgent's option instead of the top one: "edited".
    const csrf = await browser.csrf('/profile');
    const r = await browser.post(`/ai/approvals/${recB.id}/decide`, { _csrf: csrf, decision: 'accept', choice: String(desktop) });
    assert.equal(r.status, 302);
    const doneB = await db.get('SELECT status, applied_result FROM ai_recommendations WHERE id = $1', [recB.id]);
    assert.equal(doneB.status, 'edited');
    assert.equal((await assetService.find(B)).category_id, desktop);
    const fb = await db.get(`SELECT label, actual FROM ai_feedback WHERE recommendation_id = $1`, [recB.id]);
    assert.equal(fb.label, 'edited');
    assert.deepEqual(fb.actual._agents, ['DataQualityAgent']);
    assert.ok(await db.get(`SELECT 1 AS x FROM activity_logs WHERE action = 'AI_RECOMMENDATION_EDITED' AND description LIKE $1`, [`%#${recB.id} %`]));
    const w = (await weights.load()).weights;
    assert.ok(w.DataQualityAgent > 0.75 && w.IntakeAgent < 0.75, `weights follow the decision: ${JSON.stringify(w)}`);
    assert.ok((await page(browser, '?view=decided')).includes('accepted (other option)'));

    // Bulk: the Powai approver can reject but not apply (applying needs assets.edit); an admin applies two at once.
    const vcsrf = await viewerBrowser.csrf('/profile');
    await viewerBrowser.post('/ai/approvals/bulk', { _csrf: vcsrf, ids: String(recF.id), decision: 'accept' });
    assert.equal((await db.get('SELECT status FROM ai_recommendations WHERE id = $1', [recF.id])).status, 'pending', 'refused: needs assets.edit');
    await viewerBrowser.post('/ai/approvals/bulk', { _csrf: vcsrf, ids: String(recA.id), decision: 'reject' });
    assert.equal((await db.get('SELECT status FROM ai_recommendations WHERE id = $1', [recA.id])).status, 'pending', 'refused: outside the viewer\'s locations');
    const body = new URLSearchParams({ _csrf: csrf, decision: 'accept' });
    body.append('ids', String(recA.id));
    body.append('ids', String(recF.id));
    const res = await fetch(app.base + '/ai/approvals/bulk', { method: 'POST', redirect: 'manual', body, headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(res.status, 302);
    assert.equal((await db.get('SELECT status FROM ai_recommendations WHERE id = $1', [recA.id])).status, 'accepted');
    assert.equal((await db.get('SELECT status FROM ai_recommendations WHERE id = $1', [recF.id])).status, 'accepted');
    assert.equal((await assetService.find(A)).category_id, laptop);
    assert.equal((await assetService.find(F)).category_id, laptop);
    // The accepted change is an ordinary edit: the agents now confirm it.
    await orchestrator.drain();
    const after = await orchestrator.run('asset.review', { asset_id: A }, { trigger: 'request', user: admin });
    assert.ok(after.bb.decisions.every(d => d.outcome !== 'propose'), 'no new proposal for A');
  });

  await t.test('repair or replace: repeated repairs -> a sign-off that changes nothing', async () => {
    const before = (await runs()).length;
    for (const days of [20, 90, 200]) {
      await operations.createMaintenance({ asset_id: E, title: `AIM7 repair ${days}`, maintenance_type: 'repair', status: 'completed',
        start_date: new Date(Date.now() - days * 864e5).toISOString().slice(0, 10), completion_date: new Date(Date.now() - (days - 2) * 864e5).toISOString().slice(0, 10), cost: 9000 }, admin.id);
    }
    await orchestrator.drain();
    const fresh = (await runs()).slice(before).filter(r => r.flow === 'maintenance.review');
    assert.equal(fresh.length, 1, 'three repairs logged in a row, one review');
    const steps = await stepsOf(fresh[0].id);
    assert.deepEqual(steps.map(s => s.node).sort(), ['repairs', 'resolve']);
    assert.deepEqual(fresh[0].dag.omitted.map(o => o.agent), ['LifecycleCostAgent']);
    const rec = await recFor(E, 'agents.replace_instead');
    assert.ok(rec, 'replace sign-off proposed');
    assert.equal(rec.needs_review, true, 'one agent alone at 80%: a person decides');
    assert.match(rec.why.map(x => x.text).join(' '), /3 repairs in the last 12 months/);
    const assetBefore = await assetService.find(E);
    const done = await approvals.decide(rec.id, 'accept', admin);
    assert.match(done.applied_result.summary, /Nothing was bought, retired or closed/);
    const assetAfter = await assetService.find(E);
    assert.equal(assetAfter.status_label_id, assetBefore.status_label_id);
    assert.equal(assetAfter.deleted_at, null);
  });

  await t.test('licence changes: ComplianceAgent checks them', async () => {
    await flags.setFlag('compliance', true, admin);
    const lic = await one(`INSERT INTO licenses (name, seats, available_seats, location_id) VALUES ('AIM7 Office', 1, 0, $1)`, [powai]);
    const users = await db.query(`SELECT id FROM users WHERE email LIKE 'aim7-%@hams.test'`);
    for (const u of users) await db.run('INSERT INTO license_assignments (license_id, user_id) VALUES ($1, $2)', [lic, u.id]);
    automation.publish('license.changed', { license_id: lic, action: 'updated' });
    await orchestrator.drain();
    const r = await lastRun('licence.review');
    assert.equal(r.trigger, 'license.changed');
    assert.equal(r.target_id, lic);
    assert.ok(r.context.findings.some(f => /More seats in use than bought: AIM7 Office/.test(f.text)));
  });

  await t.test('questions go through the orchestrator and are traced', async () => {
    await flags.setFlag('nl', true, admin);
    const r = JSON.parse((await browser.get('/api/ai/ask?q=' + encodeURIComponent('how many laptops'))).text);
    assert.equal(r.intent, 'count');
    assert.ok(r.run_id);
    const steps = await stepsOf(r.run_id);
    assert.equal(steps[0].agent, 'AssistantAgent');
    assert.ok(steps[0].tool_calls.some(c => c.tool === 'count'));
  });

  await t.test('daily briefing through the job runner; old traces pruned unless still needed', async () => {
    const old = await one(`INSERT INTO ai_runs (flow, trigger, status, started_at) VALUES ('asset.review', 'test', 'done', CURRENT_TIMESTAMP - INTERVAL '40 days')`);
    const kept = await one(`INSERT INTO ai_runs (flow, trigger, status, started_at) VALUES ('asset.review', 'test', 'done', CURRENT_TIMESTAMP - INTERVAL '40 days')`);
    await db.run(`UPDATE ai_recommendations SET run_id = $1 WHERE id = (SELECT id FROM ai_recommendations WHERE status = 'pending' ORDER BY id LIMIT 1)`, [kept]);
    const r = await scheduler.runNow('ai_agents_review', admin);
    assert.equal(r.status, 'ok', r.error);
    assert.match(r.summary, /1 old trace\(s\) removed/);
    assert.ok(!(await db.get('SELECT id FROM ai_runs WHERE id = $1', [old])), 'the old trace is gone');
    assert.ok(await db.get('SELECT id FROM ai_runs WHERE id = $1', [kept]));
    const brief = await lastRun('fleet.review');
    const lines = brief.context.entries.briefing.value.lines.map(l => l.text);
    assert.ok(lines.some(l => /data-health scan has not run yet/.test(l)), lines.join(' | '));
    assert.ok(lines.some(l => /licence and software finding/.test(l)));
    assert.ok(lines.some(l => /AI Approvals/.test(l)));
    const settingsPage = (await browser.get('/settings/ai')).text;
    assert.ok(settingsPage.includes('Latest briefing') && settingsPage.includes('IntakeAgent') && settingsPage.includes('Run the briefing now'));
    assert.ok((await browser.get('/ai/runs')).text.includes('Today&#39;s briefing') || (await browser.get('/ai/runs')).text.includes("Today's briefing"));
  });

  await t.test('after an import: the scans run through the job runner, then the briefing', async () => {
    automation.publish('import.applied', { import_job_id: null, source: 'test' });
    await orchestrator.drain(60000);
    const r = await lastRun('import.review');
    assert.ok(r, 'import review ran');
    const steps = await stepsOf(r.id);
    // In the order they finished: the scan first, the briefing last, the two summaries in between (side by side).
    assert.equal(steps[0].node, 'quality_scan');
    assert.equal(steps[steps.length - 1].node, 'briefing');
    assert.deepEqual(steps.map(s => s.node).sort(), ['briefing', 'health', 'licences', 'quality_scan']);
    assert.equal(steps.find(s => s.node === 'quality_scan').status, 'done');
    assert.deepEqual(r.dag.nodes.map(n => [n.id, n.level]), [['quality_scan', 0], ['health', 1], ['licences', 1], ['briefing', 2]]);
    assert.ok(await db.get('SELECT id FROM ai_dq_runs LIMIT 1'), 'the data-health scan really ran');
  });

  await t.test('trace pages, Review now, the asset card and their permissions', async () => {
    const b = await db.get(`SELECT id FROM ai_runs WHERE flow = 'asset.review' AND target_id = $1 ORDER BY id LIMIT 1`, [B]);
    const page = (await browser.get(`/ai/runs/${b.id}`)).text;
    assert.ok(page.includes('Task graph') && page.includes('views were settled') && page.includes('DataQualityAgent') && page.includes('For a closer look'));
    assert.ok((await browser.get('/ai/runs?flow=asset.review&status=done')).text.includes(`#${b.id}`));
    assert.equal((await viewerBrowser.get('/ai/runs')).status, 403, 'traces need ai.manage');
    const csrf = await browser.csrf('/profile');
    const go = await browser.post(`/ai/assets/${C}/review`, { _csrf: csrf });
    assert.equal(go.status, 302);
    assert.match(go.location, /\/ai\/runs\/\d+$/);
    const vcsrf = await viewerBrowser.csrf('/profile');
    assert.equal((await viewerBrowser.post(`/ai/assets/${A}/review`, { _csrf: vcsrf })).status, 403, 'outside the viewer\'s locations');
    assert.ok((await browser.get(`/assets/${A}`)).text.includes('aiAssetAgents('));
    const card = JSON.parse((await browser.get(`/api/ai/assets/${A}/agents`)).text);
    assert.ok(card.last && card.last.url);
    assert.ok((await browser.get('/')).text.includes('/ai/runs'), 'sidebar link');
  });

  await t.test('switching off stops the agents', async () => {
    await flags.setFlag('agents', false, admin);
    const before = (await runs()).length;
    automation.publish('asset.updated', { asset_id: A });
    await orchestrator.drain();
    assert.equal((await runs()).length, before);
    assert.equal((await browser.get('/ai/runs')).status, 404);
    assert.ok(!(await browser.get('/')).text.includes('/ai/runs'));
  });
});
