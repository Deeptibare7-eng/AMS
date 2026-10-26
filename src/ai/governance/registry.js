// Model registry (ai_models): every trained version with its parameters, metrics and training
// window. New versions start as 'candidate'; activating one retires the previous active version,
// and rollback re-activates the version that was active before.
// Pins (M8): a version a person activates or rolls back to is pinned (setting ai.pin_<model>), so
// scheduled retraining keeps new versions as candidates instead of activating them (autoActivate)
// until someone unpins it.
const db = require('../../core/db');
const audit = require('../../services/auditService');
const settings = require('../../services/settingsService');
const { HttpError } = require('../../core/helpers');

const pinKey = name => `pin_${name}`;
async function pinned(name) {
  const v = parseInt(await settings.get('ai', pinKey(name), ''), 10);
  return Number.isFinite(v) ? v : null;
}
async function pin(name, version, user = null) {
  await settings.set('ai', pinKey(name), String(version), user ? user.id : null);
  await audit.log(user ? user.id : null, 'AI_MODEL_PINNED', `AI model ${name} pinned to v${version}: retraining keeps new versions as candidates.`);
}
async function unpin(name, user = null) {
  await settings.set('ai', pinKey(name), '', user ? user.id : null);
  await audit.log(user ? user.id : null, 'AI_MODEL_UNPINNED', `AI model ${name} unpinned: retraining may activate better versions again.`);
}

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

// pin: true when a person chooses the version (Settings > AI), so retraining doesn't replace it.
async function activate(name, version, user = null, { pin: pinIt = false } = {}) {
  await db.tx(async t => {
    const row = await t.get('SELECT id FROM ai_models WHERE name = $1 AND version = $2 FOR UPDATE', [name, version]);
    if (!row) throw new HttpError(`Model ${name} v${version} not found.`, 404);
    await t.run(`UPDATE ai_models SET status = 'retired' WHERE name = $1 AND status = 'active'`, [name]);
    await t.run(`UPDATE ai_models SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
  });
  await audit.log(user ? user.id : null, 'AI_MODEL_ACTIVATED', `AI model ${name} v${version} activated${pinIt ? ' by hand' : ''}.`);
  if (pinIt) await pin(name, version, user);
}

// For training jobs: activate unless a person has pinned a version. Returns whether it activated.
async function autoActivate(name, version, user = null) {
  const p = await pinned(name);
  if (p !== null) {
    await audit.log(user ? user.id : null, 'AI_MODEL_KEPT_CANDIDATE', `AI model ${name} v${version} trained and kept as a candidate: v${p} is pinned.`);
    return false;
  }
  await activate(name, version, user);
  return true;
}

// Re-activate the version that was active before the current one (and pin it).
async function rollback(name, user = null) {
  const active = await db.get(`SELECT version FROM ai_models WHERE name = $1 AND status = 'active'`, [name]);
  if (!active) throw new HttpError(`No active version of ${name} to roll back from.`, 422);
  const prev = await db.get(
    `SELECT version FROM ai_models WHERE name = $1 AND version < $2 AND activated_at IS NOT NULL ORDER BY version DESC LIMIT 1`,
    [name, active.version]);
  if (!prev) throw new HttpError(`${name} has no earlier active version.`, 422);
  await activate(name, prev.version, user, { pin: !!user });
  await audit.log(user ? user.id : null, 'AI_MODEL_ROLLED_BACK', `AI model ${name} rolled back from v${active.version} to v${prev.version}.`);
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

// Store something learnt about a version after training (e.g. the drift baseline profile).
async function annotate(name, version, patch) {
  await db.run(`UPDATE ai_models SET training = COALESCE(training, '{}'::jsonb) || $3::jsonb WHERE name = $1 AND version = $2`, [name, version, JSON.stringify(patch)]);
}

module.exports = { save, activate, autoActivate, rollback, loadActive, list, pinned, pin, unpin, annotate };
