// The daily drift check (job ai_drift): for each model trained once and used for a while (intake,
// refresh risk), how far today's register has moved from the data its active version learnt from
// (drift.js: PSI per feature, KS for numbers). Results go to ai_drift and Settings > AI > Drift.
// - The reference is the profile stored with the version at training time. A version trained before
//   drift checks existed gets one at its first check (said so on the report).
// - Significant drift (PSI > 0.25 on any feature): audit entry and a retrain in the background,
//   unless the version is pinned or a drift retrain already ran in the last 7 days. The new version
//   only becomes active if it scores at least as well (the training jobs' own rule).
// - The feedback loop: 20+ category decisions in AI Approvals since the intake model was trained
//   also start a retrain, so it learns from them.
const db = require('../../core/db');
const audit = require('../../services/auditService');
const flags = require('../flags');
const registry = require('./registry');
const drift = require('./drift');
const { SPECS, profileFor } = require('./driftSpecs');
const { CATALOG } = require('./models');

const RETRAIN_GAP_DAYS = 7;
const DECISIONS_TO_RETRAIN = 20;

const readOnly = fn => db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return fn(t); });

// Category decisions made since the active version was trained. The comparison stays in SQL: a
// TIMESTAMP sent back from JavaScript would be shifted by the server's time zone.
async function decisionsSinceTraining(name) {
  const r = await db.get(
    `SELECT COUNT(*)::int AS n FROM ai_feedback f JOIN ai_recommendations r ON r.id = f.recommendation_id
      WHERE f.created_at > (SELECT trained_at FROM ai_models WHERE name = $1 AND status = 'active')
        AND f.label IN ('accepted', 'rejected', 'edited')
        AND (r.type = 'dq.fix_category' OR (r.type = 'agents.set_field' AND r.proposed->>'_field' = 'category_id'))`, [name]);
  return r.n;
}

// At most one retrain per reason a week: if drift stays after a retrain, retraining again won't fix it.
const REASON_TEXT = { drift: 'drift', feedback: 'new decisions to learn from' };
async function recentRetrain(name, reason) {
  return db.get(`SELECT id FROM ai_drift WHERE model_name = $1 AND action LIKE $3 AND checked_at > CURRENT_TIMESTAMP - make_interval(days => $2) LIMIT 1`,
    [name, RETRAIN_GAP_DAYS, `%retraining started (${REASON_TEXT[reason]})%`]);
}

async function checkOne(name, user) {
  const active = await db.get(`SELECT version, training, trained_at FROM ai_models WHERE name = $1 AND status = 'active'`, [name]);
  if (!active) return { name, skipped: 'no active version' };
  let base = active.training && active.training.profile;
  let note = null;
  if (!base) {
    base = await readOnly(t => profileFor(name, t));
    await registry.annotate(name, active.version, { profile: base, profile_note: 'taken at the first drift check, after training' });
    await db.run(`INSERT INTO ai_drift (model_name, model_version, status, max_psi, features, baseline_at, baseline_rows, current_rows, action)
                  VALUES ($1, $2, 'stable', 0, '[]', $3, $4, $4, $5)`,
      [name, active.version, base.at, base.rows, `Reference recorded now (v${active.version} was trained before drift checks); drift is measured from here on.`]);
    return { name, version: active.version, status: 'baseline' };
  } else if (active.training.profile_note) note = active.training.profile_note;
  const cur = await readOnly(t => profileFor(name, t, base));
  const cmp = drift.compare(base, cur);
  const actions = [];
  const c = CATALOG[name];
  const pinned = await registry.pinned(name);
  let retrain = null;
  if (cmp.status === 'significant') {
    const top = cmp.features.filter(f => f.status === 'significant').slice(0, 3).map(f => `${f.feature} (PSI ${f.psi.toFixed(2)})`).join(', ');
    await audit.log(user ? user.id : null, 'AI_DRIFT_DETECTED', `${c.label} v${active.version}: the data has moved since training: ${top}.`);
    retrain = 'drift';
  }
  if (name === 'intake_classifier') {
    const n = await decisionsSinceTraining(name);
    if (n >= DECISIONS_TO_RETRAIN) { retrain = retrain || 'feedback'; actions.push(`${n} category decisions since training`); }
  }
  if (retrain) {
    if (pinned !== null) actions.push(`v${pinned} is pinned: not retrained`);
    else if (await recentRetrain(name, retrain)) actions.push(`already retrained for ${REASON_TEXT[retrain]} in the last ${RETRAIN_GAP_DAYS} days; if it stays, look at the data`);
    else {
      c.retrain(user);
      actions.unshift(`retraining started (${REASON_TEXT[retrain]})`);
    }
  }
  await db.run(
    `INSERT INTO ai_drift (model_name, model_version, status, max_psi, features, baseline_at, baseline_rows, current_rows, action)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [name, active.version, cmp.status, Math.round(cmp.max_psi * 10000) / 10000, JSON.stringify(cmp.features.map(f => ({ ...f, psi: round(f.psi), ks_d: f.ks_d === null ? null : round(f.ks_d), ks_p: f.ks_p === null ? null : round(f.ks_p) }))),
      base.at, base.rows, cur.rows, [note ? `Reference ${note}` : null, ...actions].filter(Boolean).join('; ') || null]);
  return { name, version: active.version, status: cmp.status, max_psi: cmp.max_psi, actions };
}
const round = x => Math.round(x * 10000) / 10000;

async function run({ user = null } = {}) {
  const on = await flags.enabledSet();
  const out = [];
  for (const name of Object.keys(SPECS)) {
    if (!CATALOG[name].capabilities.some(k => on.has(k))) continue;
    out.push(await checkOne(name, user));
  }
  const text = out.map(r => `${CATALOG[r.name].label}: ${r.skipped || (r.status === 'baseline' ? 'reference recorded' : `${r.status} (max PSI ${r.max_psi.toFixed(2)})${r.actions.length ? ', ' + r.actions.join(', ') : ''}`)}`);
  return { results: out, summary: text.join('; ') || 'No model to check (their capabilities are off).' };
}

// Settings > AI and the drift report: the latest check per model and a short history.
async function latest() {
  return db.query(
    `SELECT DISTINCT ON (model_name) * FROM ai_drift ORDER BY model_name, checked_at DESC, id DESC`);
}
async function history(name, limit = 30) {
  return db.query(`SELECT id, model_version, checked_at, status, max_psi, action FROM ai_drift WHERE model_name = $1 ORDER BY checked_at DESC, id DESC LIMIT $2`, [name, limit]);
}

module.exports = { run, checkOne, latest, history, DECISIONS_TO_RETRAIN, RETRAIN_GAP_DAYS };
