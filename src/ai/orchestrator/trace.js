// Execution traces: one ai_runs row per orchestrator run and one ai_run_steps row per step (agent,
// tools called, output, retries, timing). Shown on AI Runs; kept 30 days, or longer while a
// recommendation from the run is still open.
const db = require('../../core/db');
const approvals = require('../governance/approvals');

const KEEP_DAYS = 30;
const cut = (v, n) => {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  return s.length > n ? { _truncated: true, preview: s.slice(0, n) } : v;
};

async function start({ flow, trigger, user = null, target_type = null, target_id = null, location_id = null, dag = [] }) {
  const row = await db.get(
    `INSERT INTO ai_runs (flow, trigger, target_type, target_id, location_id, user_id, dag)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, started_at`,
    [flow, String(trigger).slice(0, 40), target_type, target_id, location_id, user ? user.id : null, JSON.stringify(dag)]);
  return row;
}

async function step(runId, r, calls = []) {
  await db.run(
    `INSERT INTO ai_run_steps (run_id, node, agent, depends_on, status, attempts, tool_calls, output, error, started_at, finished_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [runId, r.id, r.agent, JSON.stringify(r.deps || []), r.status, r.attempts, JSON.stringify(calls.slice(0, 30)),
      JSON.stringify(cut(r.output, 4000)), r.error, r.started, r.finished, r.ms]);
}

async function finish(runId, { status, summary, context, error = null }) {
  await db.run(
    `UPDATE ai_runs SET status = $2, summary = $3, context = $4, error = $5, finished_at = CURRENT_TIMESTAMP,
            duration_ms = (EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at)) * 1000)::int
      WHERE id = $1`,
    [runId, status, String(summary || '').slice(0, 1000), JSON.stringify(context || {}), error]);
}

// Who sees which traces: the same location rule as AI Approvals. Runs without a location (imports,
// the fleet review, questions) only for users who see every location.
function scopeWhere(scope, params) {
  if (scope.all) return 'TRUE';
  if (scope.location_ids) { params.push(scope.location_ids); return `r.location_id = ANY($${params.length}::int[])`; }
  return 'FALSE';
}

async function list(user, { flow = null, status = null, page = 1, perPage = 25 } = {}) {
  const scope = await approvals.scopeFor(user);
  const params = [];
  const where = [scopeWhere(scope, params)];
  if (flow) { params.push(flow); where.push(`r.flow = $${params.length}`); }
  if (status) { params.push(status); where.push(`r.status = $${params.length}`); }
  const sql = where.join(' AND ');
  const total = (await db.get(`SELECT COUNT(*)::int AS n FROM ai_runs r WHERE ${sql}`, params)).n;
  const rows = await db.query(
    `SELECT r.id, r.flow, r.trigger, r.target_type, r.target_id, r.status, r.summary, r.started_at, r.duration_ms, u.name AS user_name,
            a.asset_tag, (SELECT COUNT(*)::int FROM ai_run_steps s WHERE s.run_id = r.id) AS steps,
            (SELECT COUNT(*)::int FROM ai_recommendations x WHERE x.run_id = r.id) AS recommendations
       FROM ai_runs r LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN assets a ON r.target_type = 'asset' AND a.id = r.target_id
      WHERE ${sql} ORDER BY r.id DESC LIMIT ${perPage} OFFSET ${(Math.max(1, page) - 1) * perPage}`, params);
  return { total, page: Math.max(1, page), perPage, rows };
}

// One run with its steps and recommendations, or null when missing or outside the user's scope.
async function get(id, user) {
  const scope = await approvals.scopeFor(user);
  const params = [id];
  const run = await db.get(
    `SELECT r.*, u.name AS user_name, a.asset_tag FROM ai_runs r LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN assets a ON r.target_type = 'asset' AND a.id = r.target_id
      WHERE r.id = $1 AND ${scopeWhere(scope, params)}`, params);
  if (!run) return null;
  run.steps = await db.query('SELECT * FROM ai_run_steps WHERE run_id = $1 ORDER BY id', [id]);
  run.recommendations = await db.query('SELECT id, type, title, status, confidence::float8 AS confidence, needs_review FROM ai_recommendations WHERE run_id = $1 ORDER BY id', [id]);
  return run;
}

async function latest(flow) {
  return db.get(`SELECT id, flow, status, summary, context, started_at FROM ai_runs WHERE flow = $1 AND status IN ('done', 'partial') ORDER BY id DESC LIMIT 1`, [flow]);
}

async function stats() {
  return db.get(
    `SELECT COUNT(*) FILTER (WHERE started_at >= CURRENT_DATE)::int AS runs_today,
            COUNT(*) FILTER (WHERE started_at >= CURRENT_DATE AND status = 'failed')::int AS failed_today,
            (SELECT row_to_json(x) FROM (SELECT id, flow, status, started_at FROM ai_runs ORDER BY id DESC LIMIT 1) x) AS last
       FROM ai_runs`);
}

// Old traces go; a run whose recommendation is still open stays.
async function prune(days = KEEP_DAYS) {
  const r = await db.get(
    `WITH gone AS (
       DELETE FROM ai_runs r WHERE r.started_at < CURRENT_TIMESTAMP - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM ai_recommendations x WHERE x.run_id = r.id AND x.status IN ('pending', 'applying'))
       RETURNING 1) SELECT COUNT(*)::int AS n FROM gone`, [days]);
  return r.n;
}

module.exports = { start, step, finish, list, get, latest, stats, prune, KEEP_DAYS };
