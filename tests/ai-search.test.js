// AI layer M3, smart search: the analyzer, the BM25F index (typos, synonyms, completion, AND with a
// fallback, the literal match the old box did, live updates), the evaluation, and on the test
// database the Hardware list, its export, Ctrl+K, location scope, click labels and the nightly job.
// The test-database helper must be required before any src/ module (searchEval loads the db pool).
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const analyzer = require('../src/ai/search/analyzer');
const synonyms = require('../src/ai/search/synonyms');
const { SearchIndex, VERSION } = require('../src/ai/search/bm25');
const docs = require('../src/ai/search/docs');
const searchEval = require('../src/ai/eval/searchEval');
const { osaDistance, osaWithin } = require('../src/ai/models/text/similarity');

const terms = (v, kind) => analyzer.fieldTerms(v, kind).map(([t]) => t);

test('analyzer: CTID parts, model numbers, identifiers, units, plurals, stop words', () => {
  assert.deepEqual(terms('RaviK7-CL'), ['ravik7', 'ravi', 'k7', 'cl']);
  assert.ok(terms('Latitude E5450').includes('5450'), 'model number without its letter prefix');
  assert.ok(terms('NoraQuillT').includes('quill'));
  assert.ok(!terms('NoraQuillT').includes('t'), 'single letters dropped');
  assert.deepEqual(terms('CM7QX512-001', 'id'), ['cm7qx512', '001', 'cm7qx512001']);
  assert.ok(terms('Windows 7').includes('7'), 'single digits kept');
  assert.deepEqual(analyzer.queryTokens('16 GB laptops at L&T').map(t => t.term), ['16gb', 'laptop', 'lnt']);
  assert.deepEqual(analyzer.queryTokens('show me all').map(t => t.term), ['show', 'me', 'all'], 'only stop words: kept');
  assert.equal(analyzer.stem('glass'), 'glass');
  assert.equal(analyzer.stem('status'), 'status');
  assert.ok(synonyms.of('lappy').includes('laptop'));
  assert.ok(synonyms.of('blr').includes('bangalore'));
  assert.ok(synonyms.of('linux').includes('ubuntu') && !synonyms.of('ubuntu').includes('linux'), 'one-way synonym');
});

test('osaWithin agrees with osaDistance up to the limit', () => {
  let seed = 3;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const word = () => Array.from({ length: 3 + Math.floor(rand() * 6) }, () => 'abcde'[Math.floor(rand() * 5)]).join('');
  for (let i = 0; i < 2000; i++) {
    const a = word(), b = word();
    for (const max of [1, 2]) assert.equal(osaWithin(a, b, max), Math.min(osaDistance(a, b), max + 1), `${a} ${b} ${max}`);
  }
});

// A tiny register in the shape docs.js reads from the database.
function row(id, o) {
  return {
    id, created: 1700000000 + id, name: o.name, asset_tag: o.tag, serial_number: o.serial, model_number: o.model_number || null,
    notes: null, stock_site: o.site || '_none', category_text: null, status_text: null, deleted: false,
    model_name: o.model || null, maker: o.maker || null, category: o.category || null, status_label: o.status || 'In Stock',
    location: o.location || null, sub_location: null, supplier: null, holder: o.holder || null, holder_code: o.holder || null, holder_email: null,
    cf_machine: o.machine || null, cf_fams: o.fams || null, cf_processor: null, cf_ram: o.ram || null, cf_os: o.os || null,
    cf_vendor: null, cf_client: null, cf_project: null, cf_source_status: null, cf_order_no: null, cf_invoice_no: null, cf_po_no: null, cf_ctid: null
  };
}
const ROWS = [
  row(1, { name: 'CTAADZQ7AB12', tag: 'T-0001', serial: 'ZQ7AB12', model: 'Latitude 5420', maker: 'Dell', category: 'Laptop', holder: 'ZorawarQ7', location: 'CT Powai', fams: '920000001', os: 'Windows 11 Professional', ram: '16', status: 'Deployed' }),
  row(2, { name: 'Dell Latitude 5420', tag: 'T-0002', serial: 'ZQ7AB21', model: 'Latitude 5420', maker: 'Dell', category: 'Laptop', location: 'CT Powai', site: 'Powai', machine: 'L&T ITSTOCK ON 07/1/2026' }),
  row(3, { name: 'Dell Latitude 5420', tag: 'T-0003', serial: 'XK4PL90', model: 'Latitude 5420', maker: 'Dell', category: 'Laptop', location: 'CT Pune Qubix', site: 'Pune Qubix', machine: 'Pune QBX ITSTOCK' }),
  row(4, { name: 'Dell OptiPlex 7010', tag: 'T-0004', serial: 'OPX7010A', model: 'OptiPlex 7010', maker: 'Dell', category: 'Desktop', location: 'CT Bangalore', site: 'Bangalore', machine: 'BL IT Stock 12/01/26' }),
  row(5, { name: 'ais3vm01-VM', tag: 'T-0005', serial: 'VM01XX', model: 'D4s', maker: 'Azure', category: 'VM', location: 'CT Mindspace-1' }),
  row(6, { name: 'Lenovo ThinkPad L14', tag: 'T-0006', serial: 'PF0ABC12', model: 'ThinkPad L14', maker: 'Lenovo', category: 'Laptop', holder: 'QuinnZ8', location: 'CT Mindspace-1' })
];
const build = () => new SearchIndex().train(ROWS.map(docs.toDoc));
const top = (ix, q) => ix.rank(q).ids;

test('index: exact identifiers, typos, synonyms, completion, AND, fallback and the literal match', () => {
  const ix = build();
  assert.deepEqual(top(ix, 'ZQ7AB12'), [1], 'exact serial');
  assert.deepEqual(top(ix, 'T-0004'), [4], 'asset tag');
  assert.deepEqual(top(ix, '920000001'), [1], 'FAMS barcode');
  // A swapped character: the serial it was read as comes first; its sibling (1 edit away) is exact here.
  const swapped = ix.rank('ZQ7BA12');
  assert.equal(swapped.ids[0], 1);
  assert.ok(swapped.notes.some(n => n.kind === 'typo' && n.as.includes('ZQ7AB12')), 'shown as the register writes it');
  assert.ok(ix.rank('powai latitude').notes.some(n => n.kind === 'synonym' && n.as.includes('L&T')), 'codes shown in their usual form');
  assert.deepEqual(top(ix, 'lattitude powai').sort(), [1, 2], 'typo + AND: Powai Latitudes only');
  assert.deepEqual(top(ix, 'lappy zorawarq7'), [1], 'lappy = laptop; CTID');
  assert.deepEqual(top(ix, 'zorawar'), [1], 'first name inside a CTID');
  assert.deepEqual(top(ix, 'blr optiplex'), [4], 'site code synonym');
  assert.deepEqual(top(ix, 'qbx latitude'), [3]);
  assert.deepEqual(top(ix, 'win11 16gb'), [1], 'specs');
  assert.deepEqual(top(ix, 'thinkp'), [6], 'last word completed');
  const partial = ix.rank('zorawarq7 desktop');
  assert.equal(partial.partial, true, 'no asset has both: fall back to the best partial matches');
  assert.equal(partial.matched, 1);
  const dropped = ix.rank('latitude qqqqzzzz');
  assert.ok(dropped.notes.some(n => n.kind === 'dropped' && n.word === 'qqqqzzzz'));
  assert.equal(dropped.ids.length, 3);
  // What the box always did: name / tag / serial contains the text (here inside a serial).
  assert.deepEqual(top(ix, 'k4pl'), [3]);
  assert.deepEqual(top(ix, 'nothing-like-this'), []);
});

test('index: why each asset matched, live changes, evaluation and saved settings', () => {
  const ix = build();
  const r = ix.rank('lattitude 5420');
  const e = ix.explainDoc(r.parsed, 2);
  assert.ok(e.match > 0.8 && e.match < 1, 'a typo lowers the match');
  assert.ok(e.factors.some(f => /read as Latitude, 1 letter apart/.test(f.text)), JSON.stringify(e.factors));
  assert.ok(ix.explain('ZQ7AB12', 1).some(f => /serial number/.test(f.text)));
  const p = ix.predict('ZQ7AB12');
  assert.deepEqual(p.value, [1]);
  assert.equal(p.confidence, 1);

  // Changes after the build: a renamed asset is found by its new name only; a removed one is gone.
  assert.equal(ix.upsert(docs.toDoc(ROWS[4])), false, 'unchanged: not re-indexed');
  assert.equal(ix.upsert(docs.toDoc({ ...ROWS[4], name: 'renamedhost42' })), true);
  assert.deepEqual(top(ix, 'renamedhost42'), [5]);
  assert.deepEqual(top(ix, 'ais3vm01'), []);
  assert.deepEqual(top(ix, 'renamedhost'), [5], 'overlay words complete too');
  ix.upsert(docs.toDoc(row(7, { name: 'Brand New Host', tag: 'T-0007', serial: 'NEWSER77', category: 'Laptop' })));
  assert.deepEqual(top(ix, 'newser77'), [7]);
  ix.remove(7);
  assert.deepEqual(top(ix, 'newser77'), []);
  assert.equal(ix.liveCount, 6);

  const m = ix.evaluate([{ q: 'ZQ7AB12', relevant: [1] }, { q: 'qbx latitude', relevant: [3] }, { q: 'nothing-like-this', relevant: [2] }]);
  assert.equal(m.queries, 3);
  assert.ok(Math.abs(m.mrr10 - 2 / 3) < 1e-9);
  assert.ok(Math.abs(m.zero_results - 1 / 3) < 1e-9);
  const params = ix.toJSON();
  assert.equal(params.version, VERSION);
  assert.ok(params.fields.find(f => f.key === 'serial').weight > params.fields.find(f => f.key === 'notes').weight);
  assert.equal(SearchIndex.fromJSON(params).params.k1, params.k1);
});

test('evaluation: the query set is fixed by its seed and the old search is the literal match', () => {
  const rows = ROWS.map(r => ({ id: r.id, name: r.name, asset_tag: r.asset_tag, serial_number: r.serial_number, created: r.created,
    fams: r.cf_fams, holder: r.holder, category: r.category, model: r.model_name, stock_site: r.stock_site, location: r.location }));
  const a = searchEval.generate(rows, { per: 5, seed: 11 });
  assert.deepEqual(a, searchEval.generate(rows, { per: 5, seed: 11 }));
  assert.ok(a.some(q => q.kind === 'serial') && a.some(q => q.kind === 'CTID + category'));
  assert.ok(a.every(q => q.q && q.relevant.length));
  const old = searchEval.oldSearch(rows);
  assert.deepEqual(old('latitude'), [3, 2], 'newest first, name contains');
  assert.deepEqual(old('lattitude'), []);
  let seed = 5;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 50; i++) { const t = searchEval.typo('ABCDEFG', rand); assert.ok(t === null || osaDistance(t.toLowerCase(), 'abcdefg') === 1, t); }
});

// ─── On the test database ───

test('AI M3: smart search on the test database', { timeout: 240000 }, async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const ai = require('../src/ai');
  const { flags } = ai;
  ai.start();
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const assetService = require('../src/services/assetService');
  const automation = require('../src/services/automationService');
  const service = require('../src/ai/search/service');
  const training = require('../src/ai/search/training');
  const registry = require('../src/ai/governance/registry');

  const resetAi = async () => {
    await db.run('TRUNCATE ai_feedback, ai_recommendations, ai_models RESTART IDENTITY CASCADE');
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
    service.reset();
  };
  const cleanup = async () => {
    await db.run(`DELETE FROM assets WHERE asset_tag LIKE 'AIS3-%'`);
    await db.run(`DELETE FROM asset_categories WHERE name LIKE 'AIS3 %'`);
    await db.run(`DELETE FROM locations WHERE name LIKE 'AIS3 %'`);
    await db.run(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'ais3_viewer')`);
    await db.run(`DELETE FROM role_location_scopes WHERE role_id IN (SELECT id FROM roles WHERE name = 'ais3_viewer')`);
    await db.run(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'ais3_viewer')`);
    await db.run(`DELETE FROM roles WHERE name = 'ais3_viewer'`);
    await db.run(`DELETE FROM users WHERE email = 'ais3-holder@hams.test'`);
  };
  await resetAi();
  await cleanup();

  // ── Fixtures ──
  const one = async (sql, p) => (await db.get(sql + ' RETURNING id', p)).id;
  const laptop = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIS3 Laptop', 'asset')`);
  const vm = await one(`INSERT INTO asset_categories (name, type) VALUES ('AIS3 VM', 'asset')`);
  const powai = await one(`INSERT INTO locations (name) VALUES ('AIS3 Powai Site')`);
  const pune = await one(`INSERT INTO locations (name) VALUES ('AIS3 Pune Site')`);
  const holder = await one(`INSERT INTO users (name, email, password, employee_id, role, status) VALUES ('ZorawarQ7', 'ais3-holder@hams.test', 'x', 'ZorawarQ7', 'user', 'active')`);
  const insert = (tag, o) => one(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, model_number, category_id, location_id, assigned_to, status, custom_fields_data)
     VALUES ($1::text, md5($1::text), $2, $3, $4, $5, $6, $7, 'available', $8)`,
    [tag, o.name, o.serial, o.model_number, o.category, o.location, o.holder || null, JSON.stringify(o.cf || {})]);
  const mine = await insert('AIS3-1', { name: 'CTAADZQ7AB12', serial: 'ZQ7AB12', model_number: 'Latitude 5420', category: laptop, location: powai, holder,
    cf: { 'Machine Name': 'CTAADZQ7AB12', 'FAMS No. / Barcode': '920000001', 'OEM OS': 'Windows 11 Professional', 'RAM Size (GB)': '16' } });
  const stockPowai = await insert('AIS3-2', { name: 'Dell Latitude 5420', serial: 'ZQ7AB21', model_number: 'Latitude 5420', category: laptop, location: powai, cf: { 'Machine Name': 'L&T ITSTOCK ON 07/1/2026' } });
  const stockPune = await insert('AIS3-3', { name: 'Dell Latitude 5420', serial: 'XK4PL90', model_number: 'Latitude 5420', category: laptop, location: pune, cf: { 'Machine Name': 'Pune QBX ITSTOCK' } });
  const vmId = await insert('AIS3-4', { name: 'ais3vm01-VM', serial: 'AIS3SER04', model_number: 'D4s', category: vm, location: pune });

  const pw = 'Ai-M3-Pass-2026!';
  const admin = await env.ensureUser({ email: 'ai-m3-admin@hams.test', name: 'AI M3 Admin', password: pw });
  const viewerRole = await one(`INSERT INTO roles (name, display_name, level) VALUES ('ais3_viewer', 'AI search viewer', 20)`);
  await db.run(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE name IN ('assets.view', 'dashboard.view')`, [viewerRole]);
  await db.run(`INSERT INTO role_location_scopes (role_id, location_id) VALUES ($1, $2)`, [viewerRole, powai]);
  const viewer = await env.ensureUser({ email: 'ai-m3-viewer@hams.test', name: 'AI M3 Viewer', role: 'ais3_viewer', password: pw });

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
  const listed = (html, tag) => html.includes(`>${tag}`) || html.includes(`${tag} ·`) || html.includes(`${tag}<`);

  await t.test('off: the box matches name, tag and serial as before; Ctrl+K has no asset results', async () => {
    await flags.setMaster(true, admin);
    const r = await browser.get('/assets?search=ZQ7AB12');
    assert.equal(r.status, 200);
    assert.ok(listed(r.text, 'AIS3-1'));
    assert.ok(!r.text.includes('Smart search'), 'no banner');
    assert.ok(!listed((await browser.get('/assets?search=zorawarq7%20lappy')).text, 'AIS3-1'), 'old search: no holder / synonym match');
    const api = await browser.get('/api/ai/search?q=latitude');
    assert.equal(api.status, 404);
    assert.deepEqual(JSON.parse(api.text), { off: true });
    assert.ok(!(await browser.get('/')).text.includes('aiPaletteSearch('));
    assert.equal(service.state.index, null, 'nothing built while off');
  });

  await t.test('on: ranked matches over every field, with what was understood and why', async () => {
    await flags.setFlag('search', true, admin);
    await service.build({ trigger: 'test' });
    assert.ok(service.state.index.liveCount >= 4);
    const r = await browser.get('/assets?search=' + encodeURIComponent('lappy zorawarq7'));
    assert.equal(r.status, 200);
    assert.ok(listed(r.text, 'AIS3-1'));
    assert.ok(!listed(r.text, 'AIS3-2'));
    assert.ok(r.text.includes('Smart search') && /also finds laptop/i.test(r.text), 'banner says what the synonym did');
    assert.ok(r.text.includes('% match'), 'each row says how well it matches');
    const typo = await browser.get('/assets?search=ZQ7BA12');
    assert.ok(listed(typo.text, 'AIS3-1'), 'a swapped serial character still finds it');
    assert.ok(typo.text.includes('read as'));
    // AND: only the Powai Latitudes; the list keeps every other filter (here: category).
    const both = await browser.get('/assets?search=' + encodeURIComponent('lattitude ais3 powai'));
    assert.ok(listed(both.text, 'AIS3-1') && listed(both.text, 'AIS3-2') && !listed(both.text, 'AIS3-3'));
    const filtered = await browser.get(`/assets?search=ais3&category_id=${vm}`);
    assert.ok(listed(filtered.text, 'AIS3-4') && !listed(filtered.text, 'AIS3-1'));
    // Same matches in the Excel export as in the list.
    const { filters } = await service.forFilters({ search: 'lattitude ais3 powai' });
    const rows = await assetService.exportRows(filters);
    assert.deepEqual(rows.map(x => x.asset_tag).sort(), ['AIS3-1', 'AIS3-2']);
    assert.equal((await browser.get('/assets/export?search=' + encodeURIComponent('lattitude ais3 powai'))).status, 200);
  });

  await t.test('Ctrl+K: up to 8 assets with match and why, inside the user\'s locations', async () => {
    assert.ok((await browser.get('/')).text.includes('aiPaletteSearch('));
    const r = JSON.parse((await browser.get('/api/ai/search?q=' + encodeURIComponent('ais3 latitude 5420'))).text);
    assert.equal(r.ready, true);
    assert.deepEqual(r.hits.map(h => h.tag).sort(), ['AIS3-1', 'AIS3-2', 'AIS3-3']);
    for (const h of r.hits) {
      assert.ok(h.match > 0 && h.match <= 1);
      assert.ok(h.why.length && h.url.includes('/ai/search/open?id='));
    }
    assert.ok(r.all_url.endsWith('/assets?search=ais3%20latitude%205420'));
    const scoped = JSON.parse((await viewerBrowser.get('/api/ai/search?q=' + encodeURIComponent('ais3 latitude 5420'))).text);
    assert.deepEqual(scoped.hits.map(h => h.tag).sort(), ['AIS3-1', 'AIS3-2'], 'Pune asset hidden from a Powai-only user');
    assert.equal(scoped.total, 2);
    assert.deepEqual(JSON.parse((await browser.get('/api/ai/search?q=a')).text).hits, [], 'one letter: nothing');
  });

  await t.test('opening a Ctrl+K result records a search label and goes to the asset', async () => {
    const r = await browser.get(`/ai/search/open?id=${mine}&r=2&q=${encodeURIComponent('lappy zorawar')}`);
    assert.equal(r.status, 302);
    assert.ok(r.location.endsWith(`/assets/${mine}`));
    const fb = await db.get(`SELECT * FROM ai_feedback WHERE capability = 'search' ORDER BY id DESC LIMIT 1`);
    assert.equal(fb.target_id, mine);
    assert.equal(fb.label, 'accepted');
    assert.deepEqual(fb.predicted, { q: 'lappy zorawar', rank: 2 });
    assert.ok((await browser.get('/ai/search/open?id=abc')).location.endsWith('/assets'));
  });

  await t.test('changes reach the index without a rebuild', async () => {
    await db.run(`UPDATE assets SET name = 'ais3renamed-host' WHERE id = $1`, [vmId]);
    automation.publish('asset.updated', { asset_id: vmId });
    const found = await env.eventually(async () => (await service.search('ais3renamed')).ids.includes(vmId), 5000);
    assert.ok(found, 'renamed asset found by its new name');
    assert.ok(!(await service.search('ais3vm01')).ids.includes(vmId), 'old name gone');
    const added = await insert('AIS3-5', { name: 'ais3fresh-host', serial: 'AIS3FRESH5', model_number: 'D4s', category: vm, location: pune });
    service.state.dirty = true;
    assert.ok((await service.search('ais3fresh')).ids.includes(added));
    await db.run(`UPDATE assets SET deleted_at = NOW() WHERE id = $1`, [added]);
    service.state.dirty = true;
    assert.ok(!(await service.search('ais3fresh')).ids.includes(added), 'deleted asset dropped');
  });

  await t.test('nightly job: rebuild, measure, record a version only when the settings change', async () => {
    const first = await training.rebuild({ trigger: 'test', user: admin });
    assert.equal(first.version, 1);
    const [m] = await registry.list('search_bm25');
    assert.equal(m.status, 'active');
    for (const k of ['mrr10', 'hit10', 'old_search_mrr10', 'zero_results', 'p95_ms']) assert.equal(typeof m.metrics[k], 'number', k);
    const second = await training.rebuild({ trigger: 'test', user: admin });
    assert.equal(second.version, 1, 'same settings: no new version');
    assert.equal((await registry.list('search_bm25')).length, 1);
    const page = await browser.get('/settings/ai');
    assert.ok(page.text.includes('Smart search') && page.text.includes('Rebuild search index') && page.text.includes('MRR@10'));
  });

  await t.test('switching it off brings the old search back at once', async () => {
    await flags.setFlag('search', false, admin);
    const r = await browser.get('/assets?search=' + encodeURIComponent('lappy zorawarq7'));
    assert.ok(!listed(r.text, 'AIS3-1') && !r.text.includes('Smart search'));
    assert.equal((await browser.get('/api/ai/search?q=latitude')).status, 404);
    assert.equal(await service.search('latitude'), null);
  });
});
