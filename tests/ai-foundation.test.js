// AI layer M1: flags, event bus, snapshots + lifecycle events, approvals, model registry.
// Unit tests run anywhere; the rest need the test database (npm run test:db) and are skipped without it.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');

const tick = () => new Promise(r => setImmediate(r));

// ───────────────────────────── unit ─────────────────────────────

test('TemplateProvider fills placeholders offline', async () => {
  const { provider, joinList } = require('../src/ai/adapters/languageProvider');
  assert.equal(await provider().render('{{n}} laptops at {{sites}}{{missing}}', { n: 3, sites: ['Powai', 'Pune', 'Chennai'] }),
    '3 laptops at Powai, Pune and Chennai');
  assert.equal(joinList(['a']), 'a');
  assert.equal(joinList([]), '');
});

test('BaseModel enforces the model contract', () => {
  const BaseModel = require('../src/ai/models/baseModel');
  class Empty extends BaseModel { static modelName = 'empty'; }
  const m = new Empty();
  for (const fn of ['train', 'predict', 'explain', 'evaluate']) assert.throws(() => m[fn](), /not implemented/);
  const r = Empty.fromJSON({ w: [1, 2] }, { version: 3, metrics: { f1: 0.9 } });
  assert.deepEqual(r.toJSON(), { w: [1, 2] });
  assert.equal(r.version, 3);
  assert.equal(r.trained, true);
  assert.equal(new Empty().trained, false);
});

test('feature SQL selects every snapshot column plus the hash', () => {
  const { COLUMNS, featureSql } = require('../src/ai/features/assetFeatures');
  const sql = featureSql();
  for (const c of COLUMNS) assert.match(sql, new RegExp(`\\b${c}\\b`), c);
  assert.match(sql, /md5\(ROW\(/);
  assert.equal(new Set(COLUMNS).size, COLUMNS.length);
});

test('event bus: listeners get meta at once, the payload lazily and only once', async () => {
  const automation = require('../src/services/automationService');
  let built = 0;
  const got = [];
  const listener = msg => got.push(msg);
  automation.bus.on('test.event', listener);
  try {
    automation.publish('test.event', { asset_id: 7 }, () => { built++; return { x: 1 }; });
    await tick();
    assert.equal(got.length, 1);
    assert.equal(got[0].event, 'test.event');
    assert.equal(got[0].meta.asset_id, 7);
    assert.equal(built, 0, 'payload is not built until asked for');
    assert.deepEqual(await got[0].payload(), { x: 1 });
    await got[0].payload();
    assert.equal(built, 1, 'payload is built once');
    automation.publish('nobody.listens', {}, () => { built++; });
    await tick();
    assert.equal(built, 1, 'no work without listeners');
  } finally {
    automation.bus.off('test.event', listener);
  }
});

// ───────────────────────────── database ─────────────────────────────

test('AI foundation on the test database', async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);

  const db = require('../src/core/db');
  const ai = require('../src/ai');
  const { flags } = ai;
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const scheduler = require('../src/services/schedulerService');
  const snapshots = require('../src/ai/features/snapshots');
  const approvals = require('../src/ai/governance/approvals');
  const registry = require('../src/ai/governance/registry');
  const BaseModel = require('../src/ai/models/baseModel');
  const assetService = require('../src/services/assetService');
  ai.start();

  const resetAi = async () => {
    await db.run('TRUNCATE ai_feedback, ai_recommendations, ai_models, ai_asset_events, ai_feature_snapshots RESTART IDENTITY');
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
  };
  const deleteFixtures = async () => {
    const ids = (await db.query(`SELECT id FROM assets WHERE asset_tag LIKE 'AITEST-%'`)).map(r => r.id);
    if (ids.length) {
      await db.run('DELETE FROM asset_maintenance WHERE asset_id = ANY($1::int[])', [ids]);
      await db.run('DELETE FROM assignments WHERE asset_id = ANY($1::int[])', [ids]);
      await db.run(`DELETE FROM stock_movements WHERE module_key = 'assets' AND item_id = ANY($1::int[])`, [ids]);
      await db.run('DELETE FROM assets WHERE id = ANY($1::int[])', [ids]);
    }
    await db.run(`DELETE FROM licenses WHERE name = 'AITEST licence'`);
  };
  await resetAi();
  await deleteFixtures();

  const pw = 'Ai-Test-Pass-2026!';
  const admin = await env.ensureUser({ email: 'ai-admin@hams.test', name: 'AI Test Admin', password: pw });
  const employee = await env.ensureUser({ email: 'ai-employee@hams.test', name: 'AI Test Employee', role: 'employee', password: pw });
  const spoc = await env.ensureUser({ email: 'ai-spoc@hams.test', name: 'AI Test SPOC', role: 'location_spoc', password: pw });
  await db.run('DELETE FROM site_spocs WHERE user_id = $1', [spoc.id]);
  await db.run(`INSERT INTO site_spocs (user_id, name, site, created_by) VALUES ($1, $2, 'Powai', $3)`, [spoc.id, spoc.name, admin.id]);
  t.after(async () => {
    await db.run('DELETE FROM site_spocs WHERE user_id = $1', [spoc.id]);
    await deleteFixtures();
    await resetAi();
    await db.pool.end();
  });

  const assetA = await assetService.registerAsset({ name: 'AITEST laptop A', asset_tag: 'AITEST-A', serial_number: 'AITEST-SN-A' }, admin);
  const assetB = await assetService.registerAsset({ name: 'AITEST laptop B', asset_tag: 'AITEST-B', serial_number: 'AITEST-SN-B' }, admin);
  const eventsOf = (id, type) => db.query(`SELECT * FROM ai_asset_events WHERE asset_id = $1 AND event_type = $2 ORDER BY id`, [id, type]);

  await t.test('everything is off by default', async () => {
    assert.equal(await flags.installed(), true);
    assert.equal(await flags.masterOn(), false);
    assert.equal(await flags.isOn('snapshots'), false);
    assert.equal(await flags.isOn('no-such-capability'), false);
    const job = (await scheduler.status()).jobs.find(j => j.key === 'ai_snapshot');
    assert.ok(job, 'AI job registered');
    assert.equal(job.enabled, false);
    approvals.registerHandler('test.noop', { capability: 'snapshots', apply: async () => ({}) });
    assert.equal(await approvals.propose({ type: 'test.noop', target_type: 'asset', target_id: assetA, title: 'x', why: ['y'], confidence: 0.5 }), null);
    // A check-out while AI is off records nothing.
    await assetService.checkoutAsset(assetA, { user_id: employee.id }, admin);
    await assetService.checkinAsset(assetA, {}, admin);
    await new Promise(r => setTimeout(r, 200));
    assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM ai_asset_events')).n, 0);
  });

  await t.test('a capability is on only with its switch AND the master switch', async () => {
    await assert.rejects(flags.setFlag('nope', true, admin), /Unknown AI capability/);
    await flags.setFlag('snapshots', true, admin);
    assert.equal(await flags.isOn('snapshots'), false, 'master still off');
    await flags.setMaster(true, admin);
    assert.equal(await flags.isOn('snapshots'), true);
    const logs = await db.query(`SELECT action FROM activity_logs WHERE user_id = $1 AND action IN ('AI_FLAG_CHANGED', 'AI_MASTER_SWITCHED')`, [admin.id]);
    assert.ok(logs.some(l => l.action === 'AI_FLAG_CHANGED') && logs.some(l => l.action === 'AI_MASTER_SWITCHED'));
    assert.equal((await scheduler.status()).jobs.find(j => j.key === 'ai_snapshot').enabled, true);
  });

  await t.test('snapshots: baseline, change-only rows, lifecycle events from differences', async () => {
    const first = await snapshots.run({ trigger: 'test' });
    assert.equal(first.kind, 'full');
    assert.equal(first.written, first.assets);
    assert.deepEqual(first.events, {}, 'baseline has no events');
    const again = await snapshots.run({ trigger: 'test' });
    assert.equal(again.kind, 'change');
    assert.equal(again.written, 0, 'nothing changed');

    // What a bulk import does: change the row directly, without any app event.
    await db.run(`UPDATE assets SET status = 'archived', status_label_id = (SELECT id FROM status_labels WHERE name = 'Retired'),
                    custom_fields_data = '{"Machine Name": "BL IT Stock 12/01/26", "OEM OS": "Windows 7 Professional", "RAM Size (GB)": "8"}'
                  WHERE id = $1`, [assetB]);
    const changed = await snapshots.run({ trigger: 'test' });
    assert.equal(changed.written, 1);
    for (const type of ['retired', 'status_changed', 'site_changed']) assert.ok(changed.events[type] >= 1, `${type} event`);
    const [retired] = await eventsOf(assetB, 'retired');
    assert.equal(retired.precision, 'snapshot');
    assert.equal(retired.to_value, 'Retired');
    const row = await db.get(`SELECT * FROM ai_feature_snapshots WHERE asset_id = $1 ORDER BY snapshot_date DESC LIMIT 1`, [assetB]);
    assert.equal(row.is_retired, true);
    assert.equal(row.stock_site, 'Bangalore');
    assert.equal(row.os_family, 'windows_legacy');
    assert.equal(row.os_eol, true);
    assert.equal(row.ram_gb, 8);
    assert.equal(row.kind, 'full', 'same-day change updates the day\'s full row');
    assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM ai_feature_snapshots WHERE asset_id = $1', [assetB])).n, 1);
    const quiet = await snapshots.run({ trigger: 'test' });
    assert.equal(quiet.written, 0);
    assert.deepEqual(quiet.events, {});
  });

  await t.test('live events: check-out/in are recorded exactly once', async () => {
    await assetService.checkoutAsset(assetA, { user_id: employee.id }, admin);
    const assigned = await env.eventually(async () => (await eventsOf(assetA, 'assigned'))[0]);
    assert.ok(assigned, 'assigned event captured');
    assert.equal(assigned.precision, 'exact');
    assert.equal(assigned.to_value, String(employee.id));
    await snapshots.run({ trigger: 'test' });
    assert.equal((await eventsOf(assetA, 'assigned')).length, 1, 'the snapshot does not record it twice');
    await assetService.checkinAsset(assetA, {}, admin);
    const back = await env.eventually(async () => (await eventsOf(assetA, 'unassigned'))[0]);
    assert.ok(back && back.precision === 'exact' && back.from_value === String(employee.id));
  });

  await t.test('existing services publish maintenance.logged and license.changed', async () => {
    const automation = require('../src/services/automationService');
    const got = [];
    const l = msg => got.push(msg);
    automation.bus.on('*', l);
    try {
      const mid = await require('../src/services/operationsService').createMaintenance(
        { asset_id: assetA, title: 'AITEST inspection', maintenance_type: 'inspection' }, admin.id);
      await require('../src/services/operationsService').updateMaintenance(mid, { title: 'AITEST inspection', status: 'completed' }, admin.id);
      await require('../src/services/inventoryService').create('licenses', { name: 'AITEST licence', seats: 2 }, admin);
      await env.eventually(() => got.some(m => m.event === 'license.changed'));
      const maint = got.filter(m => m.event === 'maintenance.logged');
      assert.deepEqual(maint.map(m => m.meta.action), ['created', 'updated']);
      assert.ok(maint.every(m => m.meta.asset_id === assetA));
      assert.equal(got.find(m => m.event === 'license.changed').meta.action, 'created');
    } finally {
      automation.bus.off('*', l);
    }
  });

  await t.test('approvals: propose, scope, accept via handler, reject, feedback, audit', async () => {
    approvals.registerHandler('test.set_note', {
      label: 'Test: set note', capability: 'snapshots',
      apply: async rec => {
        await db.run('UPDATE assets SET notes = $1 WHERE id = $2', [rec.proposed.notes, rec.target_id]);
        return { notes: rec.proposed.notes };
      }
    });
    approvals.registerHandler('test.fail', { capability: 'snapshots', apply: async () => { throw new Error('asset changed meanwhile'); } });
    const base = { type: 'test.set_note', agent: 'test', target_type: 'asset', target_id: assetA, title: 'Set a note', why: ['Because this is a test'], proposed: { notes: 'AI note' }, confidence: 0.9 };
    const powai = await approvals.propose({ ...base, site: 'Powai', dedupe_key: 'test:powai' });
    assert.ok(powai);
    assert.equal(await approvals.propose({ ...base, site: 'Powai', dedupe_key: 'test:powai' }), null, 'one open recommendation per key');
    const chennai = await approvals.propose({ ...base, site: 'Chennai', dedupe_key: 'test:chennai' });
    await assert.rejects(approvals.propose({ ...base, confidence: 1.5 }), /confidence/);
    await assert.rejects(approvals.propose({ ...base, why: [] }), /reason/);
    await assert.rejects(approvals.propose({ ...base, type: 'test.unknown' }), /No handler/);

    assert.deepEqual((await approvals.list(admin)).rows.map(r => Number(r.id)).sort(), [Number(powai), Number(chennai)].sort());
    assert.deepEqual((await approvals.list(spoc)).rows.map(r => Number(r.id)), [Number(powai)], 'SPOC sees own site only');
    assert.equal(await approvals.pendingCount(spoc), 1);

    await assert.rejects(approvals.decide(powai, 'accept', employee), e => e.status === 403);
    await assert.rejects(approvals.decide(chennai, 'accept', spoc), e => e.status === 403);
    await assert.rejects(approvals.decide(powai, 'maybe', admin), e => e.status === 422);

    const done = await approvals.decide(powai, 'accept', spoc, 'fine');
    assert.equal(done.status, 'accepted');
    assert.equal((await db.get('SELECT notes FROM assets WHERE id = $1', [assetA])).notes, 'AI note');
    await assert.rejects(approvals.decide(powai, 'reject', admin), e => e.status === 409);
    const rejected = await approvals.decide(chennai, 'reject', admin, 'not needed');
    assert.equal(rejected.status, 'rejected');
    const labels = await db.query('SELECT recommendation_id, label, user_id FROM ai_feedback ORDER BY id');
    assert.deepEqual(labels.map(l => [Number(l.recommendation_id), l.label]), [[Number(powai), 'accepted'], [Number(chennai), 'rejected']]);

    const failing = await approvals.propose({ ...base, type: 'test.fail', dedupe_key: 'test:fail' });
    await assert.rejects(approvals.decide(failing, 'accept', admin), /asset changed meanwhile/);
    assert.equal((await db.get('SELECT status FROM ai_recommendations WHERE id = $1', [failing])).status, 'failed');
    const audit = (await db.query(`SELECT action FROM activity_logs WHERE action LIKE 'AI_RECOMMENDATION_%'`)).map(a => a.action);
    for (const a of ['AI_RECOMMENDATION_ACCEPTED', 'AI_RECOMMENDATION_REJECTED', 'AI_RECOMMENDATION_FAILED']) assert.ok(audit.includes(a), a);
    assert.equal((await approvals.list(admin, { view: 'decided' })).total, 3);

    // With the capability switched off nothing new is proposed and nothing is applied.
    const later = await approvals.propose({ ...base, dedupe_key: 'test:later' });
    await flags.setFlag('snapshots', false, admin);
    assert.equal(await approvals.propose({ ...base, dedupe_key: 'test:off' }), null);
    await assert.rejects(approvals.decide(later, 'accept', admin), /switched off/);
    await flags.setFlag('snapshots', true, admin);
  });

  await t.test('model registry: versions, activate, load, rollback', async () => {
    class MeanModel extends BaseModel {
      static modelName = 'test_mean';
      train(xs) { this.params = { mean: xs.reduce((s, x) => s + x, 0) / xs.length }; return this; }
      predict() { return { value: this.params.mean, confidence: 0.5 }; }
      explain() { return [{ factor: 'mean', text: 'Average of the training values', weight: 1 }]; }
      evaluate(xs) { return { mae: xs.reduce((s, x) => s + Math.abs(x - this.params.mean), 0) / xs.length }; }
    }
    const m1 = new MeanModel().train([1, 2, 3]);
    assert.equal(await m1.save({ metrics: m1.evaluate([2, 4]), userId: admin.id }), 1);
    await registry.activate('test_mean', 1, admin);
    const m2 = new MeanModel().train([10]);
    assert.equal(await m2.save({ metrics: m2.evaluate([10]) }), 2);
    assert.equal((await MeanModel.load()).version, 1, 'a new version stays a candidate until activated');
    await registry.activate('test_mean', 2, admin);
    const live = await MeanModel.load();
    assert.equal(live.version, 2);
    assert.equal(live.predict().value, 10);
    assert.equal(await registry.rollback('test_mean', admin), 1);
    assert.equal((await MeanModel.load()).predict().value, 2);
    assert.deepEqual((await registry.list('test_mean')).map(r => [r.version, r.status]), [[2, 'retired'], [1, 'active']]);
  });

  await t.test('the scheduled job runs a snapshot when switched on', async () => {
    const r = await scheduler.runNow('ai_snapshot', admin);
    assert.equal(r.status, 'ok', r.error || '');
    assert.match(r.summary, /snapshot \(manual\)/);
  });
});
