// Fixes the data-health scan proposes in AI Approvals. Accepting one applies it through the
// existing services, with the permission a person would need to make the same change by hand.
//
// - dq.fix_category: assets filed under the wrong category, grouped per model, location and
//   category change. Proposed only when two independent signals agree: 80%+ of the model's
//   assets use the other category AND the category classifier (trained without the asset) reads
//   its name and model the same way.
// - catalog.fix_model_category: an Asset Models entry whose category disagrees with 80%+ of the
//   20+ assets using it (Asset Models is where new assets get their default category).
// A pending fix whose problem is gone at the next scan is marked expired.
const db = require('../../core/db');
const approvals = require('../governance/approvals');
const { formatDate, HttpError } = require('../../core/helpers');

const AGENT = 'DataQualityAgent';

approvals.registerHandler('dq.fix_category', {
  label: 'Fix asset category', capability: 'data_quality', permission: 'assets.edit',
  apply: async (rec, user) => {
    const assetService = require('../../services/assetService');
    const { from, to } = rec.proposed.category;
    const result = { applied: 0, skipped: 0, failed: [] };
    for (const id of rec.proposed._asset_ids || []) {
      const a = await assetService.find(id);
      if (!a || a.deleted_at || String(a.category_id) !== String(rec.proposed._from_id)) { result.skipped++; continue; }
      try {
        await assetService.updateAsset(id, {
          ...a, category_id: rec.proposed._to_id,
          purchase_date: a.purchase_date ? formatDate(a.purchase_date) : '', warranty_expiry: a.warranty_expiry ? formatDate(a.warranty_expiry) : ''
        }, user);
        result.applied++;
      } catch (err) {
        result.failed.push({ id, error: err.message });
      }
    }
    if (!result.applied && result.failed.length) throw new HttpError(`No asset changed: ${result.failed[0].error}`, 422);
    result.summary = `${result.applied} moved from ${from} to ${to}` + (result.skipped ? `, ${result.skipped} skipped (changed since)` : '') + (result.failed.length ? `, ${result.failed.length} refused` : '');
    return result;
  }
});

approvals.registerHandler('catalog.fix_model_category', {
  label: 'Fix catalog model category', capability: 'data_quality', permission: 'inventory.edit',
  apply: async (rec, user) => {
    const catalogService = require('../../services/catalogService');
    const m = await db.get('SELECT * FROM asset_models WHERE id = $1 AND deleted_at IS NULL', [rec.target_id]);
    if (!m) throw new HttpError('The catalog model no longer exists.', 404);
    if (String(m.category_id) !== String(rec.proposed._from_id)) throw new HttpError('The model\'s category has changed since this was proposed.', 409);
    await catalogService.update('models', m.id, { ...m, category_id: rec.proposed._to_id }, user);
    return { summary: `Catalog model "${m.name}" moved from ${rec.proposed.category.from} to ${rec.proposed.category.to}` };
  }
});

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// A calibrated 0.999 is not certainty: never print "100%".
const pct = p => (p >= 0.995 ? 'over 99%' : `${Math.round(p * 100)}%`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function categoryGroups({ scored, ctx, catNames }) {
  const groups = new Map();
  for (const s of scored) {
    const i = s.issues.find(x => x.code === 'category_mismatch');
    if (!i) continue;
    const k = [s.row.asset_model_id, s.row.location_id, i.data.from, i.data.to].join('|');
    if (!groups.has(k)) groups.set(k, { rows: [], conf: [], issue: i });
    groups.get(k).rows.push(s.row);
    groups.get(k).conf.push(ctx.oof.get(s.row.id).p);
  }
  return [...groups.entries()].map(([key, g]) => {
    const r0 = g.rows[0];
    const { from, to } = g.issue.data;
    const maj = ctx.modelMajority.get(r0.asset_model_id);
    const fromName = catNames[from], toName = catNames[to];
    const mlP = median(g.conf);
    return {
      type: 'dq.fix_category', agent: AGENT, target_type: 'asset', target_id: g.rows.length === 1 ? r0.id : null,
      location_id: r0.location_id, dedupe_key: `dq.fix_category:${key}`,
      title: `Move ${plural(g.rows.length, `"${r0.model_name}" asset`)}${r0.location_name ? ` at ${r0.location_name}` : ''} from ${fromName} to ${toName}`,
      why: [
        `${maj.count} of ${maj.total} assets of this model (${Math.round(maj.share * 100)}%) are filed as ${toName}.`,
        `Their names and model numbers read like a ${toName} (${pct(mlP)} by the category classifier, trained without these assets).`,
        `For example: ${g.rows.slice(0, 3).map(r => `${r.asset_tag} "${r.name}"`).join(', ')}.`
      ],
      proposed: { category: { from: fromName, to: toName }, assets: g.rows.length, _from_id: from, _to_id: to, _asset_ids: g.rows.map(r => r.id) },
      confidence: Math.min(maj.share, mlP)
    };
  });
}

function catalogFixes({ findings }) {
  return findings.model_category_fixes.map(f => ({
    type: 'catalog.fix_model_category', agent: AGENT, target_type: 'asset_model', target_id: Number(f.model_id),
    dedupe_key: `catalog.fix_model_category:${f.model_id}:${f.from}:${f.to}`,
    title: `Change catalog model "${f.name}" from ${f.from_name} to ${f.to_name}`,
    why: [
      `${f.count} of the ${f.total} assets using this model (${Math.round(f.share * 100)}%) are filed as ${f.to_name}.`,
      `Asset Models sets the default category of new assets, so the ${f.from_name} entry keeps spreading the wrong category.`
    ],
    proposed: { category: { from: f.from_name, to: f.to_name }, _from_id: f.from, _to_id: f.to },
    confidence: f.share
  }));
}

async function proposeAll(scan) {
  const all = [...categoryGroups(scan), ...catalogFixes(scan)];
  let fresh = 0;
  for (const rec of all) if (await approvals.propose({ ...rec, run_id: scan.runId })) fresh++;
  const keys = all.map(r => r.dedupe_key);
  const expired = await db.run(
    `UPDATE ai_recommendations SET status = 'expired', decision_note = 'The data-health scan no longer finds this problem.'
      WHERE agent = $1 AND status = 'pending' AND NOT (dedupe_key = ANY($2::text[]))`, [AGENT, keys]);
  return { total: all.length, new: fresh, expired: expired.rowCount };
}

module.exports = { proposeAll, categoryGroups, catalogFixes, AGENT };
