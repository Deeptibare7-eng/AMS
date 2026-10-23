// Reading the data-health results for people: the asset page card, the dashboard card and the
// Data Health page. Everything per asset is limited to the user's location scope; fleet-wide
// figures (modules, catalog findings, trend) are shown only to users who see every location.
const db = require('../../core/db');
const authz = require('../../services/authorizationService');
const rules = require('./rules');

const SEV_ORDER = `CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;
const describe = code => {
  const r = rules.BY_CODE.get(code);
  return r ? { label: r.label, group: r.group, severity: r.severity } : { label: code, group: 'Other', severity: 'low' };
};

async function scopeOf(user) {
  const s = await authz.locationScopeFor(user);
  return s.global ? { global: true, sql: 'TRUE', params: [] } : { global: false, sql: 'a.location_id = ANY($1::int[])', params: [s.location_ids] };
}

async function latestRun() {
  return db.get('SELECT id, run_at, avg_score, assets, modules, catalog, duration_ms, trigger FROM ai_dq_runs ORDER BY run_at DESC, id DESC LIMIT 1');
}

async function forAsset(asset) {
  const pred = await db.get(`SELECT score::float8 AS score, label, computed_at FROM ai_predictions WHERE asset_id = $1 AND capability = 'data_quality'`, [asset.id]);
  const issues = await db.query(`SELECT code, severity, confidence::float8 AS confidence, detail FROM ai_dq_issues WHERE asset_id = $1 ORDER BY ${SEV_ORDER}, code`, [asset.id]);
  const recs = await db.query(
    `SELECT id, title, confidence::float8 AS confidence FROM ai_recommendations
      WHERE status = 'pending' AND ((target_type = 'asset' AND target_id = $1) OR proposed->'_asset_ids' @> to_jsonb($1::int))
      ORDER BY created_at DESC LIMIT 5`, [asset.id]);
  const run = await latestRun();
  return {
    scored: !!pred, retired: asset.status === 'archived',
    score: pred ? pred.score : null, grade: pred ? pred.label : null,
    checked_at: run ? run.run_at : null,
    // A detail that only repeats the issue's name ("Not linked to a purchase order.") is left out.
    issues: issues.map(i => {
      const d = describe(i.code);
      const same = i.detail.replace(/\.$/, '').toLowerCase() === d.label.toLowerCase();
      return { ...i, ...d, severity: i.severity, detail: same ? '' : i.detail };
    }),
    recommendations: recs
  };
}

async function scopedStats(user) {
  const scope = await scopeOf(user);
  const stats = await db.get(
    `SELECT COUNT(*)::int AS assets, ROUND(AVG(p.score), 1)::float8 AS avg,
            COUNT(*) FILTER (WHERE p.score >= 90)::int AS good, COUNT(*) FILTER (WHERE p.score >= 70 AND p.score < 90)::int AS fair,
            COUNT(*) FILTER (WHERE p.score < 70)::int AS poor
       FROM ai_predictions p JOIN assets a ON a.id = p.asset_id
      WHERE p.capability = 'data_quality' AND a.deleted_at IS NULL AND ${scope.sql}`, scope.params);
  const issues = await db.query(
    `SELECT i.code, COUNT(*)::int AS n FROM ai_dq_issues i JOIN assets a ON a.id = i.asset_id
      WHERE a.deleted_at IS NULL AND ${scope.sql} GROUP BY 1 ORDER BY 2 DESC`, scope.params);
  return { scope, stats, issues: issues.map(r => ({ ...r, ...describe(r.code) })) };
}

// Dashboard card.
async function summary(user) {
  const run = await latestRun();
  if (!run) return { ready: false, message: 'The first data-health scan has not run yet.' };
  const { scope, stats, issues } = await scopedStats(user);
  let trend = null;
  if (scope.global) {
    const prev = await db.get('SELECT avg_score::float8 AS avg FROM ai_dq_runs WHERE id < $1 ORDER BY id DESC LIMIT 1', [run.id]);
    if (prev && prev.avg !== null && stats.avg !== null) trend = Math.round((stats.avg - prev.avg) * 10) / 10;
  }
  const pending = await require('../governance/approvals').pendingCount(user);
  return { ready: true, checked_at: run.run_at, ...stats, trend, top: issues.slice(0, 5), pending };
}

// Data Health page.
async function page(user, { issue = '', page: pageNum = 1, perPage = 25 } = {}) {
  const run = await latestRun();
  if (!run) return { ready: false };
  const { scope, stats, issues } = await scopedStats(user);
  const byLocation = await db.query(
    `SELECT COALESCE(l.name, '(no location)') AS location, COUNT(*)::int AS assets, ROUND(AVG(p.score), 1)::float8 AS avg,
            COUNT(*) FILTER (WHERE p.score < 70)::int AS poor
       FROM ai_predictions p JOIN assets a ON a.id = p.asset_id LEFT JOIN locations l ON l.id = a.location_id
      WHERE p.capability = 'data_quality' AND a.deleted_at IS NULL AND ${scope.sql}
      GROUP BY 1 ORDER BY 3 ASC, 2 DESC`, scope.params);
  const groups = [...new Set(rules.RULES.map(r => r.group))].map(g => ({
    group: g, issues: rules.RULES.filter(r => r.group === g).map(r => ({ code: r.code, label: r.label, severity: r.severity, n: (issues.find(i => i.code === r.code) || {}).n || 0 }))
  }));
  let list = null;
  if (issue && rules.BY_CODE.has(issue)) {
    const total = (await db.get(
      `SELECT COUNT(*)::int AS n FROM ai_dq_issues i JOIN assets a ON a.id = i.asset_id WHERE i.code = $${scope.params.length + 1} AND a.deleted_at IS NULL AND ${scope.sql}`,
      [...scope.params, issue])).n;
    const rows = await db.query(
      `SELECT a.id, a.asset_tag, a.name, l.name AS location, sl.name AS status, i.detail, i.confidence::float8 AS confidence
         FROM ai_dq_issues i JOIN assets a ON a.id = i.asset_id LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN status_labels sl ON sl.id = a.status_label_id
        WHERE i.code = $${scope.params.length + 1} AND a.deleted_at IS NULL AND ${scope.sql}
        ORDER BY i.confidence DESC, a.asset_tag LIMIT ${perPage} OFFSET ${(Math.max(1, pageNum) - 1) * perPage}`,
      [...scope.params, issue]);
    list = { code: issue, ...describe(issue), total, perPage, rows };
  }
  const history = scope.global
    ? await db.query('SELECT run_at, avg_score::float8 AS avg, assets FROM ai_dq_runs ORDER BY run_at DESC LIMIT 10') : [];
  return {
    ready: true, global: scope.global, run, stats, groups, byLocation, list,
    modules: scope.global ? run.modules : null, catalog: scope.global ? run.catalog : null, history: history.reverse()
  };
}

module.exports = { forAsset, summary, page };
