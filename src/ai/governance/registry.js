// Model registry (ai_models): every trained version with its parameters, metrics and training
// window. New versions start as 'candidate'; activating one retires the previous active version,
// and rollback re-activates the version that was active before.
const db = require('../../core/db');
const audit = require('../../services/auditService');
const { HttpError } = require('../../core/helpers');

async function save(model, { metrics = null, training = null, userId = null } = {}) {
  const name = model.constructor.modelName;
  if (!name || name === 'base') throw new Error('Model class needs a static modelName');
  return db.tx(async t => {
    await t.run('SELECT pg_advisory_xact_lock(70414, hashtext($1))', [name]);
    const next = (await t.get('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ai_models WHERE name = $1', [name])).v;
    await t.run(
      `INSERT INTO ai_models (name, version, status, params, metrics, training, trained_by) VALUES ($1, $2, 'candidate', $3, $4, $5, $6)`,
      [name, next, JSON.stringify(model.toJSON()), metrics ? JSON.stringify(metrics) : null, training ? JSON.stringify(training) : null, userId]);
    model.version = next;
    model.metrics = metrics;
    return next;
  });
}

async function activate(name, version, user = null) {
  await db.tx(async t => {
    const row = await t.get('SELECT id FROM ai_models WHERE name = $1 AND version = $2 FOR UPDATE', [name, version]);
    if (!row) throw new HttpError(`Model ${name} v${version} not found.`, 404);
    await t.run(`UPDATE ai_models SET status = 'retired' WHERE name = $1 AND status = 'active'`, [name]);
    await t.run(`UPDATE ai_models SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
  });
  await audit.log(user ? user.id : null, 'AI_MODEL_ACTIVATED', `AI model ${name} v${version} activated.`);
}

// Re-activate the version that was active before the current one.
async function rollback(name, user = null) {
  const active = await db.get(`SELECT version FROM ai_models WHERE name = $1 AND status = 'active'`, [name]);
  if (!active) throw new HttpError(`No active version of ${name} to roll back from.`, 422);
  const prev = await db.get(
    `SELECT version FROM ai_models WHERE name = $1 AND version < $2 AND activated_at IS NOT NULL ORDER BY version DESC LIMIT 1`,
    [name, active.version]);
  if (!prev) throw new HttpError(`${name} has no earlier active version.`, 422);
  await activate(name, prev.version, user);
  return prev.version;
}

// The active version as a ready-to-use model instance, or null.
async function loadActive(ModelClass) {
  const row = await db.get(`SELECT * FROM ai_models WHERE name = $1 AND status = 'active'`, [ModelClass.modelName]);
  return row ? ModelClass.fromJSON(row.params, { version: row.version, metrics: row.metrics }) : null;
}

async function list(name = null) {
  return db.query(
    `SELECT id, name, version, status, metrics, training, trained_at, activated_at FROM ai_models
      ${name ? 'WHERE name = $1' : ''} ORDER BY name, version DESC`, name ? [name] : []);
}

module.exports = { save, activate, rollback, loadActive, list };
