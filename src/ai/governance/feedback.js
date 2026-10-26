// The feedback loop in numbers (Settings > AI > Feedback): every label people have given the AI.
// - AI Approvals: accepted, rejected, or accepted with another option ("edited"), by kind and by the
//   model version that made the recommendation (people's verdict on each version).
// - Unusual assets: "real issue" vs "expected" (the share of findings people confirm).
// - Smart search: which result people opened (rank of the clicked result: real-click MRR@10).
// - Questions: missed, "not what I meant", taught.
// - The latest overrides (rejections and other options), with who and when.
const db = require('../../core/db');
const approvals = require('./approvals');

async function summary() {
  const recs = await db.query(
    `SELECT r.type, f.label, COUNT(*)::int AS n FROM ai_feedback f JOIN ai_recommendations r ON r.id = f.recommendation_id
      WHERE f.label IN ('accepted', 'rejected', 'edited') GROUP BY 1, 2`);
  const byType = {};
  for (const r of recs) {
    const t = (byType[r.type] = byType[r.type] || { type: r.type, label: (approvals.handlerFor(r.type) || {}).label || r.type, accepted: 0, rejected: 0, edited: 0 });
    t[r.label] = r.n;
  }
  const byVersion = await db.query(
    `SELECT f.model_name, f.model_version, COUNT(*) FILTER (WHERE f.label = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE f.label = 'rejected')::int AS rejected, COUNT(*) FILTER (WHERE f.label = 'edited')::int AS edited
       FROM ai_feedback f WHERE f.recommendation_id IS NOT NULL AND f.model_name IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1, 2 DESC`);
  const anomaly = await db.get(
    `SELECT COUNT(*) FILTER (WHERE label = 'accepted')::int AS issues, COUNT(*) FILTER (WHERE label = 'rejected')::int AS expected
       FROM ai_feedback WHERE capability = 'anomaly'`);
  const clicks = await db.query(`SELECT (predicted->>'rank')::int AS rank FROM ai_feedback WHERE capability = 'search' AND predicted ? 'rank'`);
  const ranks = clicks.map(c => c.rank).filter(r => r >= 1);
  const search = ranks.length ? {
    clicks: ranks.length,
    mrr10: ranks.reduce((s, r) => s + (r <= 10 ? 1 / r : 0), 0) / ranks.length,
    top1: ranks.filter(r => r === 1).length / ranks.length
  } : { clicks: 0 };
  const nl = await db.get(
    `SELECT COUNT(*) FILTER (WHERE label = 'ignored')::int AS missed, COUNT(*) FILTER (WHERE label = 'rejected')::int AS not_meant,
            COUNT(*) FILTER (WHERE label = 'taught')::int AS taught FROM ai_feedback WHERE capability = 'nl'`);
  const overrides = await db.query(
    `SELECT f.label, f.created_at, f.capability, u.name AS user_name, r.id AS rec_id, r.title, r.agent
       FROM ai_feedback f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN ai_recommendations r ON r.id = f.recommendation_id
      WHERE f.label IN ('rejected', 'edited') ORDER BY f.id DESC LIMIT 8`);
  const total = (await db.get('SELECT COUNT(*)::int AS n FROM ai_feedback')).n;
  return {
    // rate: accepted as proposed (an "edited" decision took another option, so it isn't counted as a hit).
    total, byType: Object.values(byType).map(t => ({ ...t, decided: t.accepted + t.rejected + t.edited, rate: t.accepted / Math.max(1, t.accepted + t.rejected + t.edited) })),
    byVersion, anomaly: { ...anomaly, precision: anomaly.issues + anomaly.expected ? anomaly.issues / (anomaly.issues + anomaly.expected) : null },
    search, nl, overrides, suppressed: approvals.suppressedCount()
  };
}

module.exports = { summary };
