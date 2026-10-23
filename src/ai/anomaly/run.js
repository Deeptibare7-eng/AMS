// Unusual assets job (ai_anomaly) and the Alerts-page section.
//   - Daily: scores every active asset in a worker (detect.js) and keeps the scores in ai_predictions
//     (capability 'anomaly'); the unusual ones carry their reasons.
//   - People review a finding as "Real issue" or "Expected". That is a label in ai_feedback (no asset
//     is changed); a reviewed finding stays hidden while the asset's features stay the same (once the
//     asset is corrected, or changes again, it is looked at afresh).
//     Labels give the precision of the detector on this register.
// Reads existing tables only; writes ai_predictions, ai_feedback, ai_models (settings) and the audit log.
const db = require('../../core/db');
const authz = require('../../services/authorizationService');
const audit = require('../../services/auditService');
const worker = require('../worker');
const registry = require('../governance/registry');
const assetRows = require('../features/assetRows');
const { IsolationForest } = require('../models/isolationForest');
const { SETTINGS } = require('./detect');
const { HttpError } = require('../../core/helpers');

const canon = v => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}` : JSON.stringify(v));

async function run({ trigger = 'schedule', user = null } = {}) {
  const t0 = Date.now();
  const rows = await db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return assetRows.load(t); });
  const { results, threshold, metrics } = await worker.run('scoreAnomalies', { rows, now: Date.now() });
  if (metrics.skipped) return { skipped: true, summary: `Not run: ${metrics.assets} active assets (needs 50+).` };
  // The settings and measured detection in the registry: a new version only when the settings change.
  const model = new IsolationForest(SETTINGS);
  const active = await db.get(`SELECT version, params FROM ai_models WHERE name = $1 AND status = 'active'`, [IsolationForest.modelName]);
  let version = active ? active.version : null;
  if (!active || canon(active.params) !== canon(model.toJSON())) {
    version = await registry.save(model, {
      metrics: { injected_auc: metrics.injected_auc, flagged_share: metrics.flagged / metrics.assets },
      userId: user ? user.id : null,
      training: { trigger, assets: metrics.assets, threshold, injected_by_kind: metrics.injected_by_kind }
    });
    await registry.activate(IsolationForest.modelName, version, user);
  }
  await db.tx(async t => {
    await t.run(`DELETE FROM ai_predictions WHERE capability = 'anomaly'`);
    const out = results.map(r => ({
      asset_id: r.id, score: Math.round(r.score * 1000) / 1000, confidence: Math.round(Math.max(0, Math.min(1, (r.score - 0.5) / 0.25)) * 1000) / 1000,
      label: r.flagged ? 'unusual' : 'ordinary', factors: r.flagged ? { why: r.factors, hash: r.hash, threshold } : null
    }));
    for (let i = 0; i < out.length; i += 4000) {
      await t.run(`INSERT INTO ai_predictions (asset_id, capability, score, confidence, label, factors, model_name, model_version)
        SELECT asset_id, 'anomaly', score, confidence, label, factors, $2, $3 FROM jsonb_to_recordset($1::jsonb)
          AS x(asset_id int, score numeric, confidence numeric, label text, factors jsonb)`,
        [JSON.stringify(out.slice(i, i + 4000)), IsolationForest.modelName, version]);
    }
  });
  return {
    ...metrics,
    summary: `Unusual assets: ${metrics.flagged} of ${metrics.assets} active assets (score ${threshold.toFixed(2)}+). `
      + `Detection of corrupted test copies: AUC ${metrics.injected_auc.toFixed(2)}. ${((Date.now() - t0) / 1000).toFixed(1)} s.`
  };
}

// Location scope for lists: same rule as the Hardware list.
async function scopeSql(user, params) {
  const scope = await authz.locationScopeFor(user);
  if (scope.global) return '';
  params.push(scope.location_ids);
  return ` AND a.location_id = ANY($${params.length}::int[])`;
}

// The Alerts section: unusual assets not yet reviewed (or reviewed "Expected" but changed since),
// grouped when the same holder / model / reason repeats. Also the review tally.
async function list(user, { limit = 25 } = {}) {
  const params = [];
  const scope = await scopeSql(user, params);
  const rows = await db.query(
    `SELECT p.asset_id, p.score::float8 AS score, p.confidence::float8 AS confidence, p.factors, p.computed_at,
            a.asset_tag, a.name, a.asset_model_id, a.assigned_to, am.name AS model, ac.name AS category, u.name AS holder, l.name AS location
       FROM ai_predictions p JOIN assets a ON a.id = p.asset_id
       LEFT JOIN asset_models am ON am.id = a.asset_model_id LEFT JOIN asset_categories ac ON ac.id = a.category_id
       LEFT JOIN users u ON u.id = a.assigned_to LEFT JOIN locations l ON l.id = a.location_id
      WHERE p.capability = 'anomaly' AND p.label = 'unusual' AND a.deleted_at IS NULL${scope}
        AND NOT EXISTS (SELECT 1 FROM ai_feedback f WHERE f.capability = 'anomaly' AND f.target_type = 'asset' AND f.target_id = p.asset_id
                          AND f.predicted->>'hash' = p.factors->>'hash')
      ORDER BY p.score DESC`, params);
  const groups = new Map();
  for (const r of rows) {
    const top = r.factors && r.factors.why && r.factors.why[0] ? r.factors.why[0].feature : '';
    const key = `${r.asset_model_id}|${top === 'holder_devices' ? r.assigned_to : ''}|${top}|${top === 'holder_devices' ? '' : r.factors.why.map(w => w.text).join(';')}`;
    if (!groups.has(key)) groups.set(key, { ...r, why: r.factors.why.map(w => w.text), assets: [] });
    groups.get(key).assets.push({ id: r.asset_id, tag: r.asset_tag });
  }
  const tally = await db.get(
    `SELECT COUNT(*) FILTER (WHERE label = 'accepted')::int AS issues, COUNT(*) FILTER (WHERE label = 'rejected')::int AS expected
       FROM ai_feedback WHERE capability = 'anomaly'`);
  const all = [...groups.values()];
  return {
    total: rows.length, groups: all.slice(0, limit), more: Math.max(0, all.length - limit),
    computed_at: rows[0] ? rows[0].computed_at : null,
    reviewed: tally, precision: tally.issues + tally.expected ? tally.issues / (tally.issues + tally.expected) : null
  };
}

// "Real issue" (accepted) or "Expected" (rejected) for one or more flagged assets the user can see.
async function review(assetIds, verdict, user, note = null) {
  if (!['issue', 'expected'].includes(verdict)) throw new HttpError('Choose "Real issue" or "Expected".', 422);
  const ids = [...new Set([].concat(assetIds || []).map(n => parseInt(n, 10)).filter(Number.isFinite))].slice(0, 500);
  if (!ids.length) throw new HttpError('No asset selected.', 422);
  const params = [ids];
  const scope = await scopeSql(user, params);
  const rows = await db.query(
    `SELECT p.asset_id, p.score::float8 AS score, p.factors, p.model_version, a.asset_tag FROM ai_predictions p JOIN assets a ON a.id = p.asset_id
      WHERE p.capability = 'anomaly' AND p.label = 'unusual' AND p.asset_id = ANY($1::int[]) AND a.deleted_at IS NULL${scope}`, params);
  if (!rows.length) throw new HttpError('Those findings are not in your locations or no longer flagged.', 404);
  const label = verdict === 'issue' ? 'accepted' : 'rejected';
  for (const r of rows) {
    await db.run(
      `INSERT INTO ai_feedback (capability, model_name, model_version, target_type, target_id, label, predicted, actual, user_id)
       VALUES ('anomaly', $1, $2, 'asset', $3, $4, $5, $6, $7)`,
      [IsolationForest.modelName, r.model_version, r.asset_id, label,
        JSON.stringify({ score: r.score, why: (r.factors.why || []).map(w => w.text), hash: r.factors.hash }), JSON.stringify(note ? { note } : {}), user ? user.id : null]);
  }
  await audit.log(user ? user.id : null, 'AI_ANOMALY_REVIEWED',
    `Unusual asset finding marked "${verdict === 'issue' ? 'Real issue' : 'Expected'}": ${rows.map(r => r.asset_tag).join(', ').slice(0, 400)}.`);
  return { reviewed: rows.length };
}

// For the asset page: this asset's latest anomaly score and reasons.
async function forAsset(assetId) {
  const r = await db.get(`SELECT score::float8 AS score, confidence::float8 AS confidence, label, factors, computed_at FROM ai_predictions WHERE asset_id = $1 AND capability = 'anomaly'`, [assetId]);
  if (!r) return { scored: false };
  return { scored: true, unusual: r.label === 'unusual', score: r.score, confidence: r.confidence, why: r.factors ? r.factors.why.map(w => w.text) : [], computed_at: r.computed_at };
}

module.exports = { run, list, review, forAsset };
