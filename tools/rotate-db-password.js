// Rotate the application's PostgreSQL password and update DB_PASS in .env.
//
// Usage:  node tools/rotate-db-password.js            (rotate)
//         node tools/rotate-db-password.js --check    (only test the current .env login)
//
// - Generates a strong random password; it is never printed or logged by this script.
// - Changes it with ALTER ROLE as the current DB user (a role may change its own password).
// - Verifies the new password works before replacing .env; reverts the role if not.
// - Restart the app afterwards so it picks up the new .env.
// Note: if the PostgreSQL server logs all statements (log_statement = 'all'), the ALTER ROLE
// line would appear in the server log; the default ('none') does not log it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { Client } = require('pg');

const ENV_PATH = path.join(__dirname, '..', '.env');

function connInfo(env, password) {
  return {
    host: env.DB_HOST || '127.0.0.1',
    port: parseInt(env.DB_PORT || '5432', 10),
    database: env.DB_NAME,
    user: env.DB_USER,
    password
  };
}

async function canConnect(env, password) {
  const c = new Client(connInfo(env, password));
  try { await c.connect(); await c.query('SELECT 1'); return true; } catch (_) { return false; } finally { await c.end().catch(() => {}); }
}

(async () => {
  if (!fs.existsSync(ENV_PATH)) throw new Error('.env not found next to package.json');
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const env = dotenv.parse(raw);
  if (!env.DB_USER || !env.DB_NAME) throw new Error('DB_USER and DB_NAME must be set in .env');

  if (!(await canConnect(env, env.DB_PASS))) throw new Error('Cannot connect with the current .env credentials; nothing changed.');
  if (process.argv.includes('--check')) { console.log('Current .env database login works.'); return; }

  const newPass = crypto.randomBytes(24).toString('base64url'); // 32 chars, URL/.env safe

  // Prepare the new .env first (same lines, only DB_PASS replaced or appended).
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  let replaced = false;
  const out = lines.map(l => (/^\s*DB_PASS\s*=/.test(l) ? (replaced = true, `DB_PASS=${newPass}`) : l));
  if (!replaced) out.push(`DB_PASS=${newPass}`);
  const tmp = ENV_PATH + '.tmp';
  fs.writeFileSync(tmp, out.join(eol), { mode: 0o600 });

  const admin = new Client(connInfo(env, env.DB_PASS));
  await admin.connect();
  try {
    await admin.query(`ALTER ROLE ${admin.escapeIdentifier(env.DB_USER)} PASSWORD ${admin.escapeLiteral(newPass)}`);
  } catch (err) {
    fs.unlinkSync(tmp);
    throw new Error('ALTER ROLE failed; nothing changed: ' + err.message);
  } finally {
    await admin.end().catch(() => {});
  }

  if (!(await canConnect(env, newPass))) {
    // Revert so the running app (still using the old password) keeps working.
    const revert = new Client(connInfo(env, newPass));
    try {
      await revert.connect();
      await revert.query(`ALTER ROLE ${revert.escapeIdentifier(env.DB_USER)} PASSWORD ${revert.escapeLiteral(env.DB_PASS)}`);
    } catch (_) { /* fall through to the error below */ } finally { await revert.end().catch(() => {}); }
    fs.unlinkSync(tmp);
    throw new Error('New password could not be verified; reverted. .env unchanged.');
  }

  fs.renameSync(tmp, ENV_PATH);
  console.log(`Database password for role "${env.DB_USER}" rotated and saved to .env (not shown).`);
  console.log('Restart the app (VS Code: Shift+F5, then F5) so it uses the new password.');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
