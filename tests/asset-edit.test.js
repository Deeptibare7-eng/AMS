// Regression: saving an asset from Hardware > Edit (and the REST API update, which passes the whole
// asset) must keep the register fields in custom_fields_data and the stock site derived from them.
// Needs the test database (npm run test:db); skipped when it is missing.
const env = require('./helpers/testDb');
const test = require('node:test');
const assert = require('node:assert/strict');

const REGISTER = { 'Machine Name': 'BL IT Stock 12/01/26', 'Processor': 'i5-1135G7', 'RAM Size (GB)': '16', 'PO #': 'PO-1' };

test('editing an asset keeps its register fields', async t => {
  const why = await env.unavailable();
  if (why) return t.skip(why);
  const db = require('../src/core/db');
  const assetService = require('../src/services/assetService');
  const app = await env.startApp();
  const cleanup = () => db.run(`DELETE FROM stock_movements WHERE module_key = 'assets' AND item_id IN (SELECT id FROM assets WHERE asset_tag = 'EDITTEST-1');
                                DELETE FROM assets WHERE asset_tag = 'EDITTEST-1'`);
  await cleanup();
  t.after(async () => { await cleanup(); await app.close(); await db.pool.end(); });

  const pw = 'Edit-Test-Pass-2026!';
  const admin = await env.ensureUser({ email: 'edit-test@hams.test', name: 'Edit Test', password: pw });
  const { id } = await db.get(
    `INSERT INTO assets (asset_tag, label_token, name, serial_number, status, custom_fields_data)
     VALUES ('EDITTEST-1', md5('edittest'), 'Edit test laptop', 'EDITTEST-SN', 'available', $1) RETURNING id`,
    [JSON.stringify(REGISTER)]);
  const read = () => db.get('SELECT name, stock_site, custom_fields_data FROM assets WHERE id = $1', [id]);
  assert.equal((await read()).stock_site, 'Bangalore');

  // The real Edit form, submitted as a browser would.
  const browser = new env.Browser(app.base);
  await browser.login(admin.email, pw);
  const page = await browser.get(`/assets/${id}/edit`);
  const form = {};
  for (const m of page.text.matchAll(/<(input|select|textarea)\b[^>]*\bname="([^"]+)"[^>]*>/g)) {
    if (/type="(checkbox|radio)"/.test(m[0]) && !/checked/.test(m[0])) continue;
    const v = m[0].match(/value="([^"]*)"/);
    form[m[2]] = v ? v[1] : '';
  }
  form.name = 'Edit test laptop (renamed)';
  const r = await browser.post(`/assets/${id}/update`, form);
  assert.equal(r.status, 302);
  let after = await read();
  assert.equal(after.name, 'Edit test laptop (renamed)', 'the edit itself was saved');
  assert.deepEqual(after.custom_fields_data, REGISTER, 'register fields kept');
  assert.equal(after.stock_site, 'Bangalore', 'stock site kept');

  // A form that does send a register field (cf_ input) still changes it.
  const current = await assetService.find(id);
  await assetService.updateAsset(id, { ...current, 'cf_RAM Size (GB)': '32' }, admin);
  after = await read();
  assert.equal(after.custom_fields_data['RAM Size (GB)'], '32');
  assert.equal(after.custom_fields_data['Machine Name'], REGISTER['Machine Name']);
});
