// AI layer M2 on the test database: intake training + suggestions + duplicate warnings, the
// data-health scan, its AI Approvals fixes applied through the existing services, and the pages.
// Needs the test database (npm run test:db); skipped when it is missing.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');

test('AI M2: data health and intake on the test database', { timeout: 240000 }, async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  if (!(await db.get(`SELECT to_regclass('public.ai_dq_runs') IS NOT NULL AS ok`)).ok) {
    await db.pool.end();
    return t.skip('it_hams_test is out of date (run: npm run test:db -- --reset)');
  }
  const ai = require('../src/ai');
  const { flags } = ai;
  ai.start();
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const approvals = require('../src/ai/governance/approvals');
  const registry = require('../src/ai/governance/registry');
  const dataHealth = require('../src/ai/quality/dataHealth');
  const training = require('../src/ai/intake/training');
  const suggest = require('../src/ai/intake/suggest');
  const insights = require('../src/ai/quality/insights');
  const duplicates = require('../src/ai/quality/duplicates');

  const resetAi = async () => {
    await db.run('TRUNCATE ai_feedback, ai_recommendations, ai_models, ai_asset_events, ai_feature_snapshots, ai_dq_issues, ai_dq_runs, ai_predictions RESTART IDENTITY CASCADE');
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
    suggest.invalidate();
  };
  const cleanup = async () => {
    await db.run(`DELETE FROM stock_movements WHERE module_key = 'assets' AND item_id IN (SELECT id FROM assets WHERE asset_tag LIKE 'AIT2-%')`);
    await db.run(`DELETE FROM assets WHERE asset_tag LIKE 'AIT2-%'`);
    await db.run(`DELETE FROM asset_models WHERE name LIKE 'AIT2 %'`);
    await db.run(`DELETE FROM asset_categories WHERE name LIKE 'AIT2 %'`);
    await db.run(`DELETE FROM manufacturers WHERE name LIKE 'AIT2 %'`);
    await db.run(`DELETE FROM suppliers WHERE name LIKE 'AIT2 %'`);
    await db.run(`DELETE FROM locations WHERE name LIKE 'AIT2 %'`);
    await db.run(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'ait2_approver')`);
    await db.run(`DELETE FROM roles WHERE name = 'ait2_approver'`);
  };
  await resetAi();
  await cleanup();

  // ── Fixtures: a small register with known problems ──
  const one = async (sql, p) => (await db.get(sql + ' RETURNING id', p)).id;
  const laptop = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIT2 Laptop', 'asset')`);
  const vm = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIT2 VM', 'asset')`);
  const dell = await one(`INSERT INTO manufacturers (name) VALUES ('AIT2 Dell')`);
  const azure = await one(`INSERT INTO manufacturers (name) VALUES ('AIT2 Azure')`);
  const vendor = await one(`INSERT INTO suppliers (name) VALUES ('AIT2 Dell Supplier')`);
  const site = await one(`INSERT INTO locations (name) VALUES ('AIT2 Site')`);
  // Catalog entry filed under the wrong category (VM), as in the real register.
  const lat = await one(`INSERT INTO asset_models (name, model_number, manufacturer_id, category_id, default_warranty_months) VALUES ('AIT2 Latitude 5420', 'Latitude 5420', $1, $2, 36)`, [dell, vm]);
  const d4s = await one(`INSERT INTO asset_models (name, model_number, manufacturer_id, category_id) VALUES ('AIT2 Azure D4s', 'D4s', $1, $2)`, [azure, vm]);
  const instock = (await db.get(`SELECT id FROM status_labels WHERE name = 'In Stock'`)).id;
  const insert = (tag, o) => one(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category_id, manufacturer_id, supplier_id, location_id,
        asset_model_id, status, status_label_id, purchase_date, purchase_cost, warranty_expiry, custom_fields_data)
     VALUES ($1::text, md5($1::text), $2, $3, $4, $5, $6, $7, $8, $9, 'available', $10, $11, $12, $13, $14)`,
    [tag, o.name, o.serial, o.model_number, o.category, o.maker, o.supplier, site, o.model, instock, o.bought, o.cost, o.warrantyEnd, JSON.stringify(o.cf)]);
  const laptops = [];
  for (let i = 1; i <= 26; i++) {
    laptops.push(await insert(`AIT2-L${i}`, {
      name: 'Dell Latitude 5420', serial: `AIT2SER${String(i).padStart(3, '0')}`, model_number: 'Latitude 5420', category: i > 24 ? vm : laptop, maker: dell, supplier: vendor,
      model: lat, bought: `202${i % 4}-03-01`, cost: 60000, warrantyEnd: `202${(i % 4) + 3}-03-01`,
      cf: { 'Machine Name': `AIT2HOST${i}`, 'FAMS No. / Barcode': String(910000000 + i), 'Warranty Start Date': `202${i % 4}-03-01` }
    }));
  }
  const vms = [];
  for (let i = 1; i <= 12; i++) {
    vms.push(await insert(`AIT2-V${i}`, {
      name: `ait2app${i}-VM`, serial: `AIT2VM${i}XX`, model_number: 'D4s', category: vm, maker: azure, supplier: null, model: d4s,
      bought: '2024-05-01', cost: 9000, warrantyEnd: null, cf: { 'Machine Name': `ait2app${i}`, 'FAMS No. / Barcode': 'Client Provided' }
    }));
  }
  // Problems: L1 back with the client but In Stock; L2 shares L3's FAMS barcode; L25/L26 laptops filed as VM.
  await db.run(`UPDATE assets SET custom_fields_data = custom_fields_data || '{"Machine Name": "Returned to client on 3/5/2019"}' WHERE id = $1`, [laptops[0]]);
  await db.run(`UPDATE assets SET custom_fields_data = custom_fields_data || jsonb_build_object('FAMS No. / Barcode', '910000003') WHERE id = $1`, [laptops[1]]);

  const pw = 'Ai-M2-Pass-2026!';
  const admin = await env.ensureUser({ email: 'ai-m2-admin@hams.test', name: 'AI M2 Admin', password: pw });
  await db.run(`INSERT INTO roles (name, display_name, level) VALUES ('ait2_approver', 'AI test approver', 20)`);
  await db.run(`INSERT INTO role_permissions (role_id, permission_id)
                SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'ait2_approver' AND p.name IN ('ai.view', 'ai.approve', 'assets.view', 'dashboard.view')`);
  const approver = await env.ensureUser({ email: 'ai-m2-approver@hams.test', name: 'AI M2 Approver', role: 'ait2_approver', password: pw });

  const app = await env.startApp();
  const browser = new env.Browser(app.base);
  t.after(async () => {
    await app.close();
    await cleanup();
    await resetAi();
    await db.pool.end();
  });
  await browser.login(admin.email, pw);

  await t.test('capabilities are off by default: JSON endpoints 404, pages unchanged', async () => {
    await flags.setMaster(true, admin);
    const r = await browser.get('/api/ai/intake/suggest?name=Dell');
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.text), { off: true });
    assert.equal((await browser.get('/ai/data-health')).status, 404);
    const create = await browser.get('/assets/create');
    assert.equal(create.status, 200);
    assert.ok(!create.text.includes('aiIntake('), 'no intake panel while intake is off');
    assert.ok(!(await browser.get('/')).text.includes('aiHealthCard('));
  });

  await t.test('training: first version is activated, with metrics in the registry', async () => {
    await flags.setFlag('intake', true, admin);
    await flags.setFlag('data_quality', true, admin);
    const r = await training.train({ trigger: 'test', user: admin });
    assert.equal(r.version, 1);
    assert.equal(r.activated, true);
    const [row] = await registry.list('intake_classifier');
    assert.equal(row.status, 'active');
    for (const k of ['category_accuracy', 'category_macroF1', 'manufacturer_accuracy', 'manufacturer_macroF1']) assert.equal(typeof row.metrics[k], 'number', k);
    assert.equal(row.training.trigger, 'test');
  });

  await t.test('suggestions: category, maker and catalog model from the text, then that model\'s defaults', async () => {
    const s = await suggest.suggest({ name: 'Dell Latitude 5420', model_number: 'Latitude 5420', serial_number: 'AIT2SER999' });
    assert.equal(s.ready, true);
    const by = Object.fromEntries(s.suggestions.map(x => [x.field, x]));
    assert.equal(by.category_id.value, String(laptop), JSON.stringify(by.category_id));
    assert.equal(by.manufacturer_id.value, String(dell));
    assert.equal(by.asset_model_id.value, String(lat));
    for (const f of ['category_id', 'manufacturer_id', 'asset_model_id']) {
      assert.ok(by[f].confidence > 0.5 && by[f].confidence <= 1, f);
      assert.ok(by[f].why.length > 0, `${f} explained`);
    }
    // Defaults appear once the model is known (picked, or matched with 80%+ confidence).
    const d = await suggest.suggest({ name: 'Dell Latitude 5420', asset_model_id: lat, location_id: site });
    const dd = Object.fromEntries(d.suggestions.map(x => [x.field, x]));
    assert.equal(dd.warranty_months.value, 36);
    assert.equal(dd.supplier_id.value, String(vendor));
    assert.match(dd.supplier_id.why[0], /at this location/);
    assert.equal(dd.purchase_cost.value, 60000);
    assert.match(dd.warranty_months.why[0], /36 months on \d+ of \d+ assets of this model/);
    // Over HTTP, same answer.
    const http = JSON.parse((await browser.get('/api/ai/intake/suggest?name=Dell+Latitude+5420&model_number=Latitude+5420')).text);
    assert.ok(http.suggestions.some(x => x.field === 'category_id' && x.value === String(laptop)));
    assert.ok((await browser.get('/assets/create')).text.includes('aiIntake('), 'intake panel on Register Asset');
  });

  await t.test('duplicate warnings: same serial written differently, same FAMS barcode', async () => {
    const found = await duplicates.checkCandidate(db, { serial_number: 'ait2-ser-005', fams: '910000007' });
    assert.ok(found.some(d => d.asset_tag === 'AIT2-L5' && /written differently/.test(d.reason)));
    assert.ok(found.some(d => d.asset_tag === 'AIT2-L7' && /FAMS/.test(d.reason)));
    assert.deepEqual(await duplicates.checkCandidate(db, { serial_number: 'NOTHING-LIKE-IT' }), []);
    const http = JSON.parse((await browser.get('/api/ai/intake/duplicates?serial_number=AIT2SER005')).text);
    assert.equal(http.duplicates[0].asset_tag, 'AIT2-L5');
  });

  let scan;
  await t.test('data-health scan: issues with reasons, scores, catalog finding and grouped fixes', async () => {
    scan = await dataHealth.run({ trigger: 'test' });
    assert.ok(scan.assets >= 38);
    const issuesOf = async id => (await db.query('SELECT code, detail FROM ai_dq_issues WHERE asset_id = $1', [id])).map(r => r.code);
    assert.ok((await issuesOf(laptops[0])).includes('returned_in_stock'));
    assert.ok((await issuesOf(laptops[1])).includes('fams_duplicate'));
    assert.ok((await issuesOf(laptops[2])).includes('fams_duplicate'));
    for (const id of [laptops[24], laptops[25]]) {
      const codes = await issuesOf(id);
      assert.ok(codes.includes('category_mismatch'), `laptop filed as VM is flagged: ${codes}`);
    }
    assert.ok(!(await issuesOf(vms[0])).some(c => c.startsWith('category')), 'real VMs are not flagged');
    assert.ok(!(await issuesOf(vms[0])).includes('fams_missing'), 'client-provided assets need no FAMS barcode');
    const score = await db.get(`SELECT score::float8 AS s, label FROM ai_predictions WHERE asset_id = $1 AND capability = 'data_quality'`, [laptops[0]]);
    assert.ok(score.s < 80 && ['Fair', 'Poor'].includes(score.label));
    const recs = await db.query(`SELECT * FROM ai_recommendations WHERE status = 'pending' ORDER BY id`);
    const catalogFix = recs.find(r => r.type === 'catalog.fix_model_category' && r.target_id === lat);
    assert.ok(catalogFix, 'catalog model category fix proposed');
    assert.match(catalogFix.title, /Change catalog model "AIT2 Latitude 5420" from AIT2 VM to AIT2 Laptop/);
    const assetFix = recs.find(r => r.type === 'dq.fix_category' && r.proposed._asset_ids.includes(laptops[24]));
    assert.ok(assetFix, 'asset category fix proposed');
    assert.deepEqual(assetFix.proposed._asset_ids.sort(), [laptops[24], laptops[25]].sort());
    assert.ok(assetFix.why.length === 3 && Number(assetFix.confidence) >= 0.8);
    const again = await dataHealth.run({ trigger: 'test' });
    assert.equal(again.proposed.new, 0, 'a second scan proposes nothing new (one open recommendation per problem)');
  });

  await t.test('insights for the asset page, dashboard and Data Health page', async () => {
    const card = await insights.forAsset({ id: laptops[0], status: 'available' });
    assert.equal(card.scored, true);
    assert.ok(card.issues.some(i => i.code === 'returned_in_stock' && i.label && /client/.test(i.detail)));
    const sum = await insights.summary(admin);
    assert.equal(sum.ready, true);
    assert.ok(sum.top.length && sum.pending >= 2);
    const page = await browser.get('/ai/data-health');
    assert.equal(page.status, 200);
    assert.match(page.text, /Data Health/);
    const list = await browser.get('/ai/data-health?issue=returned_in_stock');
    assert.ok(list.text.includes('AIT2-L1'));
    const api = JSON.parse((await browser.get(`/api/ai/assets/${laptops[0]}/insights`)).text);
    assert.equal(api.scored, true);
    assert.ok((await browser.get(`/assets/${laptops[0]}`)).text.includes('aiAssetInsights('));
    assert.ok((await browser.get('/')).text.includes('aiHealthCard('));
    assert.ok((await browser.get('/')).text.includes('/ai/data-health'), 'sidebar link');
  });

  await t.test('accepting fixes applies them through the existing services, with the right permission', async () => {
    const recs = await db.query(`SELECT * FROM ai_recommendations WHERE status = 'pending'`);
    const assetFix = recs.find(r => r.type === 'dq.fix_category' && r.proposed._asset_ids.includes(laptops[24]));
    const catalogFix = recs.find(r => r.type === 'catalog.fix_model_category' && r.target_id === lat);
    // An approver without assets.edit / inventory.edit can't apply them.
    await assert.rejects(approvals.decide(assetFix.id, 'accept', approver), e => e.status === 403 && /assets\.edit/.test(e.message));
    await assert.rejects(approvals.decide(catalogFix.id, 'accept', approver), e => e.status === 403 && /inventory\.edit/.test(e.message));
    assert.equal((await db.get('SELECT status FROM ai_recommendations WHERE id = $1', [assetFix.id])).status, 'pending', 'still pending after a refused accept');

    const done = await approvals.decide(assetFix.id, 'accept', admin, 'checked');
    assert.equal(done.status, 'accepted');
    assert.equal(done.applied_result.applied, 2);
    for (const id of [laptops[24], laptops[25]]) {
      const a = await db.get('SELECT category_id, custom_fields_data FROM assets WHERE id = $1', [id]);
      assert.equal(a.category_id, laptop);
      assert.ok(a.custom_fields_data['Machine Name'] && a.custom_fields_data['FAMS No. / Barcode'], 'register fields kept');
    }
    assert.ok((await db.query(`SELECT 1 FROM activity_logs WHERE action = 'ASSET_UPDATED' AND description LIKE '%Dell Latitude 5420%'`)).length >= 2, 'audit log via the existing service');
    const cat = await approvals.decide(catalogFix.id, 'accept', admin);
    assert.equal(cat.status, 'accepted');
    assert.equal((await db.get('SELECT category_id FROM asset_models WHERE id = $1', [lat])).category_id, laptop);
    assert.equal((await db.get(`SELECT default_warranty_months FROM asset_models WHERE id = $1`, [lat])).default_warranty_months, 36, 'other catalog fields kept');
  });

  await t.test('fixes whose problem is gone expire at the next scan', async () => {
    const stale = await approvals.propose({ type: 'dq.fix_category', agent: 'DataQualityAgent', target_type: 'asset', target_id: vms[0], title: 'Stale', why: ['Old finding'],
      proposed: { category: { from: 'a', to: 'b' }, _asset_ids: [vms[0]] }, confidence: 0.9, dedupe_key: 'test:stale' });
    assert.ok(stale);
    const after = await dataHealth.run({ trigger: 'test' });
    assert.ok(after.proposed.expired >= 1);
    assert.equal((await db.get('SELECT status FROM ai_recommendations WHERE id = $1', [stale])).status, 'expired');
    assert.ok(!(await db.query('SELECT code FROM ai_dq_issues WHERE asset_id = $1', [laptops[24]])).some(r => r.code.startsWith('category')), 'fixed asset no longer flagged');
  });

  await t.test('switching a capability off stops it at once', async () => {
    await flags.setFlag('intake', false, admin);
    assert.equal((await browser.get('/api/ai/intake/suggest?name=Dell')).status, 404);
    assert.ok(!(await browser.get('/assets/create')).text.includes('aiIntake('));
    await flags.setFlag('data_quality', false, admin);
    assert.equal((await browser.get(`/api/ai/assets/${laptops[0]}/insights`)).status, 404);
    assert.equal(await approvals.propose({ type: 'dq.fix_category', agent: 'x', target_type: 'asset', title: 'x', why: ['x'], confidence: 0.5 }), null);
  });
});
