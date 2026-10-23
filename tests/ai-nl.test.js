// AI layer M6: questions in plain language. Entities, intent and filters on a fake vocabulary (no
// database), the SQL-safety fuzz and the agent's tool whitelist; then on the test database: Ask on the
// Hardware page and in Ctrl+K, the new list filters, location scope, changes refused, misses kept for
// the seed set, the model saved once, switching off.
// The test-database helper must be required before any src/ module.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const { norm, PLACE_ALIASES } = require('../src/ai/nl/vocab');
const query = require('../src/ai/nl/query');
const { TESTS } = require('../src/ai/nl/testset');
const { IntentClassifier } = require('../src/ai/nl/intent');
const assistant = require('../src/ai/agents/assistant');
const Agent = require('../src/ai/agents/agent');
const nlEval = require('../src/ai/eval/nlEval');

const TODAY = new Date(Date.UTC(2026, 9, 23));

// The shape vocab.load() returns, without the database.
function fakeVocab() {
  const named = (list, from) => list.map((name, i) => ({ id: from + i, name, key: norm(name) }));
  const places = new Map();
  const add = (w, kind, val) => { if (!places.has(w)) places.set(w, { sites: new Set(), locations: new Set() }); places.get(w)[kind].add(val); };
  const sites = ['Pune Qubix', 'Pune EON', 'Mindspace', 'Powai', 'Chennai', 'Bangalore', 'Hyderabad', 'USA', 'Gurugram', 'Noida'];
  for (const s of sites) for (const w of norm(s).split(' ')) add(w, 'sites', s);
  add('bengaluru', 'locations', 7);
  for (const [w, aliases] of Object.entries(PLACE_ALIASES)) { const p = places.get(w); if (p) for (const a of aliases) if (!places.has(a)) places.set(a, p); }
  return {
    categories: named(['Laptop', 'Desktop', 'Monitor', 'Thin Client', 'VM', 'Server'], 1),
    labels: [['In Stock', 'deployable'], ['Deployed', 'deployable'], ['Retired', 'archived'], ['Lost / Stolen', 'archived'], ['In Repair', 'undeployable']]
      .map(([name, type], i) => ({ id: 21 + i, name, type, key: norm(name) })),
    makers: named(['Dell', 'Lenovo', 'Apple', 'HP', 'Cisco'], 11),
    models: ['Latitude 5410', 'OptiPlex 7010'].map(name => ({ name, key: norm(name), n: 5 })),
    places, sites, locations: new Map([[7, 'Bengaluru Office']]),
    holders: new Map([['zaraq9', { id: 501, name: 'ZaraQ9' }], ['vikrams', { id: 502, name: 'VikramS' }]]),
    loadedAt: Date.now()
  };
}

let trained = null;
const clf = () => trained || (trained = new IntentClassifier().train());
// Query-string pairs -> { key: value | [values] }
const kv = pairs => pairs.reduce((o, [k, x]) => ((o[k] = k in o ? [].concat(o[k], x) : x), o), {});

test('questions become whitelisted list filters (dates from a fixed today)', () => {
  const v = fakeVocab();
  const f = q => {
    const u = assistant.understand(q, v, clf(), TODAY);
    return { intent: u.intent, ...kv(query.build(u.ent.slots, u.intent, v, { residual: u.text }).params) };
  };
  assert.deepEqual(f('laptops in Pune with warranty expiring next month'),
    { intent: 'find', category_id: '1', near_site: ['Pune Qubix', 'Pune EON'], warranty_from: '2026-11-01', warranty_to: '2026-11-30' });
  assert.deepEqual(f('desktops bought in the last 2 years'), { intent: 'find', category_id: '2', bought_from: '2024-10-23' });
  assert.deepEqual(f('laptops older than 5 years'), { intent: 'find', category_id: '1', bought_to: '2021-10-23' });
  assert.deepEqual(f('laptops whose warranty expired'), { intent: 'find', category_id: '1', warranty_to: '2026-10-22' });
  assert.deepEqual(f('laptops with at least 16 gb ram'), { intent: 'find', category_id: '1', ram_min: '16' });
  assert.deepEqual(f('machines still on windows 10'), { intent: 'find', os: 'windows10' }, 'filler words never become a text filter');
  assert.deepEqual(f('laptops assigned to ZaraQ9'), { intent: 'find', category_id: '1', holder: '501' });
  assert.deepEqual(f('spare laptops at L&T'), { intent: 'find', category_id: '1', near_site: 'Powai', label_type: 'deployable', assigned: '0' }, 'L&T is Powai');
  assert.deepEqual(f('top 5 most expensive laptops'), { intent: 'find', category_id: '1', sort: 'cost_high' });
  assert.deepEqual(f('lost laptops'), { intent: 'find', category_id: '1', status_label_id: '24' });
  assert.deepEqual(f('how many laptops are retired'), { intent: 'count', category_id: '1', label_type: 'archived' });
  assert.deepEqual(f('assets in bengaluru'), { intent: 'find', near_location: '7' });
  assert.deepEqual(f('laptops with no FAMS barcode'), { intent: 'data_issues', category_id: '1', dq: 'fams_missing' });
  // Future retirement is refresh risk, not the Retired status; missing data is not a lost asset.
  assert.deepEqual(f('which dell laptops are likely to be retired soon'), { intent: 'refresh', category_id: '1', manufacturer_id: '11', ai: 'refresh_high', sort: 'risk' });
  assert.equal(f('what data is missing for desktops').status_label_id, undefined);
  assert.equal(f('missing laptops').status_label_id, '24');
  assert.equal(f('laptops retired last year').label_type, 'archived');
  const typo = assistant.understand('lenvo laptops', v, clf(), TODAY);
  assert.deepEqual(typo.ent.slots.maker.map(m => m.name), ['Lenovo']);
  assert.deepEqual(typo.ent.typos, [{ said: 'lenvo', read: 'lenovo' }]);
  const url = query.url(query.build(typo.ent.slots, 'find', v).params, 'lenvo laptops');
  assert.match(url, /^\/assets\?/);
  assert.match(url, /asked=lenvo\+laptops/);
});

test('changes are refused, lone tags are "who", nonsense is "unknown"', () => {
  const v = fakeVocab();
  const u = q => assistant.understand(q, v, clf(), TODAY);
  for (const q of ['retire HAMS-900101', 'please delete the laptop', 'assign this laptop to ZaraQ9', 'buy 20 laptops', 'mark HAMS-900101 as lost']) {
    assert.equal(u(q).intent, 'change', q);
    assert.equal(u(q).confidence, 1);
  }
  for (const q of ['which laptops were retired', 'assigned laptops in pune', 'laptops removed from stock last month']) assert.notEqual(u(q).intent, 'change', q);
  assert.equal(u('HAMS-900101').intent, 'who');
  assert.equal(u('tell me a joke').intent, 'unknown');
  assert.equal(u('what is the weather in paris').intent, 'unknown');
});

test('intent classifier: the hand-written test set and the model contract', () => {
  const v = fakeVocab();
  const m = clf();
  assert.ok(['naive_bayes', 'logistic_regression'].includes(m.params.kind));
  assert.ok(m.metrics.cv_macroF1 > 0.75, `cross-validated macro-F1 ${m.metrics.cv_macroF1}`);
  const rows = TESTS.map(tc => ({ tc, u: assistant.understand(tc.q, v, m, TODAY) }));
  const correct = rows.filter(r => r.u.intent === r.tc.intent).length;
  assert.ok(correct / TESTS.length >= 0.95, `intent ${correct}/${TESTS.length}`);
  let tp = 0, total = 0;
  for (const { tc, u } of rows) {
    const got = nlEval.shape(u.ent.slots);
    for (const [k, want] of Object.entries(tc.expect)) { total++; if (JSON.stringify(Array.isArray(want) ? [...want].sort() : want) === JSON.stringify(Array.isArray(got[k]) ? [...got[k]].sort() : got[k])) tp++; }
  }
  assert.ok(tp / total >= 0.95, `entities ${tp}/${total}`);
  // Saved and loaded, it answers the same; it explains; it evaluates.
  const back = IntentClassifier.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), { version: 3 });
  assert.equal(back.version, 3);
  for (const q of ['how many CAT are in PLACE', 'who has ASSET', 'CAT due for refresh']) assert.deepEqual(back.predict(q), m.predict(q));
  assert.ok(m.explain('how many CAT are in PLACE').length > 0);
  assert.ok(m.evaluate([{ intent: 'count', masked: 'how many CAT are in PLACE' }]).accuracy === 1);
});

test('SQL safety: injection attempts and noise produce only whitelisted keys with checked values', () => {
  const v = fakeVocab();
  let rand = 7;
  const r = () => (rand = (rand * 16807) % 2147483647) / 2147483647;
  const noise = Array.from({ length: 300 }, () => Array.from({ length: 3 + Math.floor(r() * 50) }, () => String.fromCharCode(32 + Math.floor(r() * 94))).join(''));
  let checked = 0;
  for (const q of [...nlEval.ATTACKS, ...nlEval.ATTACKS.map(a => `laptops in pune ${a} warranty expiring next month`), ...noise]) {
    const u = assistant.understand(q, v, clf(), TODAY);
    for (const [k, val] of query.build(u.ent.slots, u.intent, v, { residual: u.text }).params) {
      checked++;
      assert.ok(nlEval.allowed(k, val), `${JSON.stringify(q)} -> ${k}=${JSON.stringify(val)}`);
    }
  }
  assert.ok(checked > 50);
  assert.equal(nlEval.allowed('holder', '1 OR 1=1'), false);
  assert.equal(nlEval.allowed('drop', '1'), false);
  assert.equal(nlEval.allowed('search', "x'; --"), false);
});

test('agents act only through their whitelisted tools', async () => {
  const a = new Agent({ name: 'T', goal: 'g', tools: { twice: async x => x * 2 }, input: ['q'], output: ['a'], thresholds: { act: 0.5 }, escalation: 'e' });
  assert.equal(await a.use('twice', 4), 8);
  assert.equal(a.calls.length, 1);
  for (const t of ['delete', 'constructor', '__proto__', 'toString']) await assert.rejects(a.use(t), /not on its whitelist/);
  assert.throws(() => a.check({ q: 1 }, ['q', 'a'], 'output'), /missing "a"/);
  const d = assistant.make(null).describe();
  assert.deepEqual(d.tools, ['count', 'sample', 'asset', 'cost', 'search'], 'read-only tools only');
  assert.equal(d.name, 'AssistantAgent');
  assert.deepEqual(d.thresholds, { act: 0.5, ask_back: 0.3 });
});

// ─── On the test database ───

test('AI M6: questions in plain language on the test database', { timeout: 240000 }, async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const ai = require('../src/ai');
  const { flags } = ai;
  ai.start();
  const settings = require('../src/services/settingsService');
  const moduleService = require('../src/services/moduleService');
  const vocab = require('../src/ai/nl/vocab');

  const resetAi = async () => {
    await db.run('TRUNCATE ai_feedback, ai_recommendations, ai_models RESTART IDENTITY CASCADE');
    await db.run(`DELETE FROM settings WHERE group_key = 'ai' OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\\_%')`);
    await settings.loadSettings();
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    moduleService.clearCache();
    flags.resetCache();
    assistant.resetModel();
    vocab.invalidate();
  };
  const cleanup = async () => {
    await db.run(`DELETE FROM assets WHERE asset_tag LIKE 'HAMS-9600%'`);
    await db.run(`DELETE FROM locations WHERE name LIKE 'AIN6 %'`);
    await db.run(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'ain6_viewer')`);
    await db.run(`DELETE FROM role_location_scopes WHERE role_id IN (SELECT id FROM roles WHERE name = 'ain6_viewer')`);
    await db.run(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'ain6_viewer')`);
    await db.run(`DELETE FROM roles WHERE name = 'ain6_viewer'`);
    await db.run(`DELETE FROM users WHERE email LIKE 'ain6-%@hams.test'`);
  };
  await resetAi();
  await cleanup();

  // ── Fixtures: four assets in two places (one in Pune EON stock), a holder, a Powai-only viewer ──
  const one = async (sql, p) => (await db.get(sql + ' RETURNING id', p)).id;
  const pune = await one(`INSERT INTO locations (name) VALUES ('AIN6 Pune')`);
  const powai = await one(`INSERT INTO locations (name) VALUES ('AIN6 Powai')`);
  const id = async (table, name) => (await db.get(`SELECT id FROM ${table} WHERE name = $1`, [name])).id;
  const laptop = await id('asset_categories', 'Laptop'), desktop = await id('asset_categories', 'Desktop');
  const dell = await id('manufacturers', 'Dell'), lenovo = await id('manufacturers', 'Lenovo');
  const inStock = await id('status_labels', 'In Stock'), deployed = await id('status_labels', 'Deployed'), retired = await id('status_labels', 'Retired');
  const pw = 'Ai-M6-Pass-2026!';
  const admin = await env.ensureUser({ email: 'ain6-admin@hams.test', name: 'AI M6 Admin', password: pw });
  const holder = await env.ensureUser({ email: 'ain6-holder@hams.test', name: 'AIN6holder1', role: 'employee', password: pw });
  const viewerRole = await one(`INSERT INTO roles (name, display_name, level) VALUES ('ain6_viewer', 'AI M6 viewer', 20)`);
  await db.run(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE name IN ('assets.view', 'dashboard.view')`, [viewerRole]);
  await db.run(`INSERT INTO role_location_scopes (role_id, location_id) VALUES ($1, $2)`, [viewerRole, powai]);
  const viewer = await env.ensureUser({ email: 'ain6-viewer@hams.test', name: 'AI M6 Viewer', role: 'ain6_viewer', password: pw });

  const now = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const nextMonth15 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
  const yearsAgo = n => new Date(Date.UTC(now.getUTCFullYear() - n, now.getUTCMonth(), 1));
  const asset = (tag, o) => one(`INSERT INTO assets (asset_tag, label_token, name, serial_number, category_id, manufacturer_id, location_id, status, status_label_id,
      assigned_to, purchase_date, warranty_expiry, purchase_cost, custom_fields_data)
    VALUES ($1::text, md5($1::text), $2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [tag, o.name, o.cat, o.maker, o.loc, o.assigned ? 'deployed' : 'available', o.label, o.assigned || null, o.bought, o.warranty, o.cost,
      JSON.stringify({ 'Machine Name': o.machine, 'RAM Size (GB)': o.ram, 'OEM OS': o.os })]);
  const a0 = await asset('HAMS-960001', { name: 'AIN6 Latitude', cat: laptop, maker: dell, loc: pune, label: inStock, machine: 'Pune EON IT Stock 01', bought: yearsAgo(1), warranty: nextMonth15, cost: 70000, ram: '16 GB', os: 'Windows 11 Pro' });
  const a1 = await asset('HAMS-960002', { name: 'AIN6 ThinkPad', cat: laptop, maker: lenovo, loc: powai, label: deployed, assigned: holder.id, machine: 'AIN6-LT-02', bought: new Date(Date.UTC(2018, 2, 1)), warranty: new Date(Date.UTC(2021, 2, 1)), cost: 50000, ram: '8', os: 'Windows 10 Enterprise' });
  const a2 = await asset('HAMS-960003', { name: 'AIN6 OptiPlex', cat: desktop, maker: dell, loc: pune, label: deployed, assigned: holder.id, machine: 'AIN6-DT-03', bought: yearsAgo(2), warranty: new Date(Date.UTC(now.getUTCFullYear() + 2, 0, 1)), cost: 90000, ram: '32 GB', os: 'Windows 11' });
  await asset('HAMS-960004', { name: 'AIN6 Old Latitude', cat: laptop, maker: dell, loc: powai, label: retired, machine: 'Chennai IT Stock', bought: new Date(Date.UTC(2015, 5, 1)), warranty: new Date(Date.UTC(2018, 5, 1)), cost: 40000, ram: '4', os: 'Windows 7' });
  assert.equal((await db.get(`SELECT stock_site FROM assets WHERE id = $1`, [a0])).stock_site, 'Pune EON', 'the site comes from the Machine Name');

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
  const ask = async (q, b = browser) => (await json(b, '/api/ai/ask?q=' + encodeURIComponent(q))).body;
  const path = loc => String(loc).replace(/^https?:\/\/[^/]+/, '');
  const ours = ['HAMS-960001', 'HAMS-960002', 'HAMS-960003', 'HAMS-960004'];
  const listed = async url => { const text = (await browser.get(url)).text; return ours.filter(tag => text.includes(tag)); };

  await t.test('off: no Ask anywhere, questions are plain searches, question filters ignored', async () => {
    await flags.setMaster(true, admin);
    const r = await browser.get('/api/ai/ask?q=laptops');
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.text), { off: true });
    const go = await browser.get('/assets?ask=' + encodeURIComponent('laptops in pune'));
    assert.equal(go.status, 302);
    assert.ok(path(go.location).startsWith('/assets?search=laptops%20in%20pune'));
    assert.deepEqual(await listed(`/assets?holder=${holder.id}`), ours, 'holder ignored while off');
    const home = (await browser.get('/')).text;
    assert.ok(!home.includes('aiPaletteAsk('));
    assert.ok(!(await browser.get('/assets')).text.includes('aria-label="Search or ask"'));
    assert.ok(!(await browser.get('/settings/ai')).text.includes('didn\'t answer well'));
  });

  await t.test('on: counts, lists, who-has and how-to, in plain language with why and confidence', async () => {
    await flags.setFlag('nl', true, admin);
    vocab.invalidate();
    const c = await ask('how many laptops in pune');
    assert.equal(c.intent, 'count');
    assert.equal(c.total, 1);
    assert.match(c.answer, /^There is 1 laptop in pune/);
    assert.ok(c.confidence >= 0.5 && c.why.some(w => /"pune" → place/.test(w)));

    const f = await ask('dell laptops in pune with warranty expiring next month');
    assert.equal(f.intent, 'find');
    assert.equal(f.total, 1);
    assert.deepEqual(f.items.map(i => i.tag), ['HAMS-960001']);
    assert.ok(f.items[0].url.endsWith(`/assets/${a0}`));
    assert.ok(f.chips.some(ch => ch.label === 'Category: Laptop') && f.chips.some(ch => /^Warranty/.test(ch.label)));
    assert.match(f.link, /near_site=Pune\+EON/);
    assert.match(f.link, new RegExp(`warranty_from=${ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)))}`));
    assert.match(f.link, /asked=/);

    assert.equal((await ask('laptops assigned to AIN6holder1')).total, 1);
    const w = await ask('who has HAMS-960002');
    assert.equal(w.intent, 'who');
    assert.match(w.answer, /assigned to AIN6holder1/);
    assert.ok(w.link.endsWith(`/assets/${a1}`));
    const nav = await ask('how do I import assets');
    assert.equal(nav.intent, 'navigate');
    assert.ok(nav.link.endsWith('/import-data'));
  });

  await t.test('changes are refused and nothing changes; nonsense falls back to search and is kept', async () => {
    const before = await db.get('SELECT status_label_id, assigned_to FROM assets WHERE id = $1', [a1]);
    const r = await ask('retire HAMS-960002');
    assert.equal(r.intent, 'change');
    assert.equal(r.escalated, true);
    assert.match(r.answer, /I don't retire anything/);
    assert.ok(r.link.endsWith(`/assets/${a1}`));
    assert.deepEqual(await db.get('SELECT status_label_id, assigned_to FROM assets WHERE id = $1', [a1]), before);
    assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM ai_recommendations')).n, 0);

    const n0 = (await db.get(`SELECT COUNT(*)::int AS n FROM ai_feedback WHERE capability = 'nl'`)).n;
    const fb = await ask('tell me a joke');
    assert.equal(fb.fallback, true);
    assert.match(fb.link, /\/assets\?search=tell/);
    const kept = await db.get(`SELECT label, predicted, target_type FROM ai_feedback WHERE capability = 'nl' ORDER BY id DESC LIMIT 1`);
    assert.equal((await db.get(`SELECT COUNT(*)::int AS n FROM ai_feedback WHERE capability = 'nl'`)).n, n0 + 1);
    assert.equal(kept.label, 'ignored');
    assert.equal(kept.target_type, 'question');
    assert.equal(kept.predicted.q, 'tell me a joke');

    const count = (await db.get('SELECT COUNT(*)::int AS n FROM assets')).n;
    const bad = await browser.get('/api/ai/ask?q=' + encodeURIComponent("laptops'; DROP TABLE assets; --"));
    assert.equal(bad.status, 200);
    assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM assets')).n, count);
  });

  await t.test('Hardware: Ask redirects to the list with the question shown as removable chips', async () => {
    const go = await browser.get('/assets?ask=' + encodeURIComponent('laptops in pune'));
    assert.equal(go.status, 302);
    const to = path(go.location);
    assert.match(to, /^\/assets\?/);
    assert.match(to, /near_site=Pune\+EON/);
    assert.match(to, /asked=laptops\+in\+pune/);
    const page = await browser.get(to);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('You asked') && page.text.includes('laptops in pune'));
    assert.ok(page.text.includes('Remove this filter') && page.text.includes('Not what I meant'));
    assert.ok(page.text.includes('aria-label="Search or ask"'));
    assert.deepEqual(ours.filter(tag => page.text.includes(tag)), ['HAMS-960001']);
    // A chip's remove link drops only its own filter.
    const removePlace = page.text.match(/href="([^"]+)"[^>]*title="Remove this filter">Place: /);
    assert.ok(removePlace, 'place chip');
    const wider = path(removePlace[1].replace(/&amp;/g, '&'));
    assert.ok(!/near_site/.test(wider) && /category_id=/.test(wider));
  });

  await t.test('the new list filters: place, holder, warranty, bought, RAM, OS, sort; bad values ignored', async () => {
    assert.deepEqual(await listed('/assets?near_site=Chennai'), ['HAMS-960004']);
    assert.deepEqual(await listed(`/assets?near_location=${pune}`), ['HAMS-960001', 'HAMS-960003']);
    assert.deepEqual(await listed(`/assets?holder=${holder.id}`), ['HAMS-960002', 'HAMS-960003']);
    assert.deepEqual(await listed(`/assets?warranty_to=${ymd(new Date(Date.now() - 864e5))}`), ['HAMS-960002', 'HAMS-960004']);
    assert.deepEqual(await listed('/assets?bought_to=2019-12-31'), ['HAMS-960002', 'HAMS-960004']);
    assert.deepEqual(await listed('/assets?ram_min=16'), ['HAMS-960001', 'HAMS-960003']);
    assert.deepEqual(await listed('/assets?ram_max=8'), ['HAMS-960002', 'HAMS-960004']);
    assert.deepEqual(await listed('/assets?os=windows10'), ['HAMS-960002']);
    assert.deepEqual(await listed('/assets?os=windows_legacy'), ['HAMS-960004']);
    const order = async url => { const text = (await browser.get(url)).text; return ours.map(tag => [tag, text.indexOf(tag)]).sort((x, y) => x[1] - y[1]).map(x => x[0]); };
    assert.deepEqual(await order('/assets?sort=oldest'), ['HAMS-960004', 'HAMS-960002', 'HAMS-960003', 'HAMS-960001']);
    assert.deepEqual(await order('/assets?sort=cost_high'), ['HAMS-960003', 'HAMS-960001', 'HAMS-960002', 'HAMS-960004']);
    for (const bad of ['holder=1%20OR%201%3D1', 'ram_min=abc', "os=x'%3B%20drop", 'near_location=1%3BDROP', 'warranty_to=tomorrow', 'sort=id%3Bdrop']) {
      const r = await browser.get('/assets?' + bad);
      assert.equal(r.status, 200, bad);
      assert.deepEqual(ours.filter(tag => r.text.includes(tag)), ours, `${bad} is ignored`);
    }
    // AI sets only while the capability that makes them is on.
    assert.deepEqual(await listed('/assets?ai=unusual'), ours, 'unusual assets off');
    assert.deepEqual(await listed('/assets?dq=fams_missing'), ours, 'data health off');
    assert.deepEqual(await listed('/assets?ai=refresh_high'), ours, 'refresh risk off');
  });

  await t.test('location scope: a Powai-only user counts only Powai', async () => {
    const r = await ask('how many laptops', viewerBrowser);
    assert.equal(r.total, 2);
    const s = await ask('laptops in pune', viewerBrowser);
    assert.equal(s.total, 0);
    assert.equal((await ask('who has HAMS-960001', viewerBrowser)).answer, 'No asset HAMS-960001 in your locations.');
  });

  await t.test('Ctrl+K Ask, "Not what I meant", Settings lists the misses, the model is saved once', async () => {
    assert.ok((await browser.get('/')).text.includes('aiPaletteAsk('));
    const r = await browser.post('/ai/ask/miss', { _csrf: await browser.csrf('/profile'), q: 'laptops by colour', ajax: '1' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
    assert.equal((await db.get(`SELECT label FROM ai_feedback WHERE capability = 'nl' ORDER BY id DESC LIMIT 1`)).label, 'rejected');
    const s = (await browser.get('/settings/ai')).text;
    assert.ok(s.includes('Questions the assistant didn\'t answer well') && s.includes('laptops by colour') && s.includes('tell me a joke'));
    assert.ok(s.includes('Not what I meant') && s.includes('nl_intent'));
    const models = await db.query(`SELECT version, status, metrics FROM ai_models WHERE name = 'nl_intent'`);
    assert.equal(models.length, 1);
    assert.equal(models[0].status, 'active');
    assert.ok(models[0].metrics.cv_macroF1 > 0.75);
    assistant.resetModel();
    await ask('how many laptops');
    assert.equal((await db.get(`SELECT COUNT(*)::int AS n FROM ai_models WHERE name = 'nl_intent'`)).n, 1, 'loaded, not trained again');
  });

  await t.test('switching off hides Ask again and ignores the filters', async () => {
    await flags.setFlag('nl', false, admin);
    assert.equal((await browser.get('/api/ai/ask?q=laptops')).status, 404);
    assert.equal((await browser.post('/ai/ask/miss', { _csrf: await browser.csrf('/profile'), q: 'x', ajax: '1' })).status, 404);
    assert.ok(path((await browser.get('/assets?ask=laptops')).location).startsWith('/assets?search=laptops'));
    assert.deepEqual(await listed('/assets?os=windows10'), ours);
    assert.ok(!(await browser.get('/')).text.includes('aiPaletteAsk('));
  });
});
