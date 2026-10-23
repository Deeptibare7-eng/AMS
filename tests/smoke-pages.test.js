// Smoke test: every main page still renders for a signed-in super admin, with the AI module off
// and on. Expected statuses were recorded from the code before the AI layer was added.
// Needs the test database (npm run test:db); skipped when it is missing.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');

const PAGES = [
  '/', '/dashboard', '/assets', '/assets/create', '/assets/scan', '/assets/labels', '/assets/:asset', '/assets/:asset/edit',
  '/procurement', '/procurement/create', '/maintenance', '/alerts', '/audit', '/archive', '/advanced',
  '/inventory/accessories', '/inventory/components', '/inventory/consumables', '/inventory/licenses',
  '/licenses/setup', '/inventory-setup', '/inventory-setup/departments', '/stock-movements', '/software', '/license-allocation',
  '/new-joinees', '/location-spocs', '/import', '/import/history', '/import-data', '/data-transfer', '/data-transfer/import',
  '/data-transfer/export', '/reports', '/requests', '/my-requests', '/users', '/users/ldap', '/users/:user', '/users/:user/edit',
  '/profile', '/notifications', '/portal', '/portal/dashboard', '/portal/my-assets', '/portal/requests', '/portal/scan',
  '/logs', '/logs/retention', '/agents', '/timeline/assets/:asset', '/settings/branding', '/settings/organization',
  '/settings/security', '/settings/identity', '/settings/roles', '/settings/modules', '/settings/backups',
  '/settings/notifications', '/settings/monitoring', '/settings/report-schedules', '/settings/api-tokens',
  '/settings/automations', '/settings/ai'
];
// Not 200 by design (same before the AI layer).
const EXPECTED = {
  '/inventory': 302, '/users/departments': 302, '/settings': 302,
  '/location-workspace': 403 // empty test database: no sites yet
};

test('existing pages render with AI off and on', async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const flags = require('../src/ai/flags');
  const app = await env.startApp();
  t.after(async () => {
    await db.run(`UPDATE modules SET is_active = FALSE WHERE name = 'ai'`);
    await db.run(`DELETE FROM settings WHERE group_key = 'ai'`);
    require('../src/services/moduleService').clearCache();
    await app.close();
    await db.pool.end();
  });

  const password = 'Smoke-Test-Pass-2026!';
  const admin = await env.ensureUser({ email: 'smoke-admin@hams.test', name: 'Smoke Admin', password });
  const browser = new env.Browser(app.base);
  await browser.login(admin.email, password);
  const asset = await db.get('SELECT id FROM assets WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
  assert.ok(asset, 'the test database needs at least one asset (seed adds three)');
  const urls = [...PAGES.map(p => [p, 200]), ...Object.entries(EXPECTED)];

  const settings = require('../src/services/settingsService');
  const setCaps = async on => {
    for (const c of flags.CAPABILITIES) await settings.set('ai', c.key, on ? '1' : '0');
  };

  // off: AI module off. on: module on, every capability off. all: every capability on too.
  for (const mode of ['off', 'on', 'all']) {
    const aiOn = mode !== 'off';
    await db.run(`UPDATE modules SET is_active = $1 WHERE name = 'ai'`, [aiOn]);
    require('../src/services/moduleService').clearCache();
    flags.resetCache();
    await setCaps(mode === 'all');
    for (const [page, status] of urls) {
      const url = page.replace(':asset', asset.id).replace(':user', admin.id);
      const r = await browser.get(url);
      assert.equal(r.status, status, `${url} with AI ${mode}: HTTP ${r.status}`);
    }
    const approvals = await browser.get('/ai/approvals');
    assert.equal(approvals.status, aiOn ? 200 : 403, `/ai/approvals with AI ${mode}`);
    const health = await browser.get('/ai/data-health');
    assert.equal(health.status, mode === 'all' ? 200 : mode === 'on' ? 404 : 403, `/ai/data-health with AI ${mode}`);
    const home = await browser.get('/');
    assert.equal(home.text.includes('/ai/approvals'), aiOn, `sidebar link to AI Approvals only when AI is on`);
    assert.equal(home.text.includes('aiHealthCard('), mode === 'all', 'dashboard card only with Data health on');
    assert.equal((await browser.get('/assets/create')).text.includes('aiIntake('), mode === 'all', 'intake panel only with Intake suggestions on');
    assert.equal(home.text.includes('aiPaletteSearch('), mode === 'all', 'Ctrl+K asset results only with Smart search on');
    assert.equal((await browser.get('/assets?search=dell')).status, 200, `Hardware search with AI ${mode}`);
    assert.equal(home.text.includes('aiLifecycleCard('), mode === 'all', 'refresh-risk map only with Refresh risk on');
    assert.equal((await browser.get('/alerts')).text.includes('aiAnomalies('), mode === 'all', 'Alerts section only with Unusual assets on');
    assert.equal((await browser.get(`/assets/${asset.id}`)).text.includes('aiAssetRisk('), mode === 'all', 'risk card only with Refresh risk or Unusual assets on');
    assert.equal(home.text.includes('aiCostCard('), mode === 'all', 'cost card only with Cost forecast on');
    assert.equal((await browser.get('/alerts')).text.includes('aiCompliance('), mode === 'all', 'compliance section only with Licence compliance on');
    const planning = await browser.get('/ai/planning');
    assert.equal(planning.status, mode === 'all' ? 200 : mode === 'on' ? 404 : 403, `/ai/planning with AI ${mode}`);
    assert.equal(home.text.includes('aiPaletteAsk('), mode === 'all', 'Ctrl+K Ask only with Questions in plain language on');
    assert.equal((await browser.get('/assets')).text.includes('aria-label="Search or ask"'), mode === 'all', 'Hardware Ask switch only with Questions on');
    assert.equal((await browser.get('/api/ai/ask?q=laptops')).status, mode === 'all' ? 200 : mode === 'on' ? 404 : 403, `/api/ai/ask with AI ${mode}`);
    const asked = await browser.get('/assets?ask=laptops');
    assert.equal(asked.status, 302, `Hardware Ask with AI ${mode}`);
    const to = String(asked.location).replace(/^https?:\/\/[^/]+/, '');
    assert.ok(mode === 'all' ? /asked=laptops/.test(to) : to.startsWith('/assets?search=laptops'), `${to} with AI ${mode}`);
    assert.equal((await browser.get(to)).status, 200, `${to} with AI ${mode}`);
  }
});
