// Shared setup for tests that need PostgreSQL. Require this BEFORE any src/ module: it points the
// app at the test database (TEST_DB_NAME, default it_hams_test; must end in "_test"), never the
// real one. Create that database with:  npm run test:db
const name = process.env.TEST_DB_NAME || 'it_hams_test';
if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`TEST_DB_NAME must end in "_test" (got "${name}")`);
process.env.DB_NAME = name;
process.env.SCHEDULER_ENABLED = '0';

const bcrypt = require('bcryptjs');

// Why the database can't be used (and the pool is closed), or null when it can.
async function unavailable() {
  const db = require('../../src/core/db');
  let why = null;
  let row = null;
  try {
    row = await db.get(`SELECT current_database() AS db, to_regclass('public.migrations') IS NOT NULL AND to_regclass('public.ai_models') IS NOT NULL AS ok`);
    if (!row || !row.ok) why = `${name} has no schema or is out of date (run: npm run test:db -- --reset)`;
  } catch (err) {
    why = `${name} is not reachable (${err.message}); run: npm run test:db`;
  }
  // Last line of defence: if a src/ module was required before this helper, the pool points at
  // the .env database. Fail loudly rather than write test data there.
  if (row && row.db !== name) {
    await db.pool.end().catch(() => {});
    throw new Error(`Connected to "${row.db}", not ${name}: require tests/helpers/testDb before any src/ module.`);
  }
  if (why) await db.pool.end().catch(() => {});
  return why;
}

// Creates or resets a sign-in user with a known password. role: a roles.name.
async function ensureUser({ email, name: userName, role = 'super_admin', password }) {
  const db = require('../../src/core/db');
  const hash = await bcrypt.hash(password, 4);
  const row = await db.get(
    `INSERT INTO users (name, email, password, role, status, must_change_password)
     VALUES ($1, $2, $3, $4, 'active', FALSE)
     ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role, status = 'active',
       must_change_password = FALSE, deleted_at = NULL
     RETURNING *`, [userName || email, email, hash, role]);
  await db.run('DELETE FROM user_roles WHERE user_id = $1', [row.id]);
  await db.run('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2', [row.id, role]);
  return row;
}

// Minimal cookie-keeping HTTP client for the real Express app.
class Browser {
  constructor(base) { this.base = base; this.cookies = new Map(); }

  async request(method, url, form = null) {
    const headers = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(this.base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }

  get(url) { return this.request('GET', url); }
  post(url, form) { return this.request('POST', url, form); }

  async csrf(url = '/login') {
    const r = await this.get(url);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error(`No CSRF token on ${url} (HTTP ${r.status})`);
    return m[1];
  }

  async login(email, password) {
    const _csrf = await this.csrf('/login');
    const r = await this.post('/login', { _csrf, email, password });
    if (r.status !== 302 || /\/login$/.test(r.location || '')) throw new Error(`Login failed for ${email} (HTTP ${r.status} -> ${r.location})`);
    return r;
  }
}

async function startApp() {
  const app = require('../../src/app');
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })
  };
}

// Wait until fn() returns something truthy (for background event handlers).
async function eventually(fn, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > until) return v;
    await new Promise(r => setTimeout(r, 50));
  }
}

module.exports = { name, unavailable, ensureUser, Browser, startApp, eventually };
