// What the orchestrator can put in AI Approvals, and what accepting does.
// - agents.set_field: the agents' resolved view of an asset's category or maker. Accepting changes
//   that one field through assetService.updateAsset (needs assets.edit, location scope applies).
//   When the agents disagree, the approver may pick another option the agents put forward
//   (recorded as "edited", which teaches the agents' weights).
// - agents.replace_instead: repair-or-replace came out as "replace". Accepting records the sign-off
//   only; nothing is bought, retired or closed.
const db = require('../../core/db');
const approvals = require('../governance/approvals');
const { formatDate, HttpError } = require('../../core/helpers');

const FIELD_LABELS = { category_id: 'category', manufacturer_id: 'manufacturer' };

approvals.registerHandler('agents.set_field', {
  label: 'Agents: fix an asset field', capability: 'agents', permission: 'assets.edit',
  apply: async (rec, user, { choice = null } = {}) => {
    const assetService = require('../../services/assetService');
    const p = rec.proposed;
    const field = p._field;
    if (!FIELD_LABELS[field]) throw new HttpError('This field can\'t be changed from AI Approvals.', 422);
    const options = p._options || [];
    const picked = choice === null || choice === undefined || choice === '' ? options.find(o => o.value === p._to_id) || { value: p._to_id, label: p[FIELD_LABELS[field]].to, agents: p._agents }
      : options.find(o => String(o.value) === String(choice));
    if (!picked) throw new HttpError('Pick one of the options the agents put forward.', 422);
    if (picked.value === p._from_id) throw new HttpError('That is the value already recorded; reject the recommendation to keep it.', 422);
    const a = await assetService.find(rec.target_id);
    if (!a) throw new HttpError('The asset no longer exists.', 404);
    if (String(a[field] ?? '') !== String(p._from_id ?? '')) throw new HttpError(`The asset's ${FIELD_LABELS[field]} has changed since this was proposed.`, 409);
    await assetService.updateAsset(a.id, {
      ...a, [field]: picked.value,
      purchase_date: a.purchase_date ? formatDate(a.purchase_date) : '', warranty_expiry: a.warranty_expiry ? formatDate(a.warranty_expiry) : ''
    }, user);
    return { summary: `${a.asset_tag}: ${FIELD_LABELS[field]} changed from ${p[FIELD_LABELS[field]].from || '—'} to ${picked.label}`, value: picked.value, _agents: picked.agents || [] };
  }
});

approvals.registerHandler('agents.replace_instead', {
  label: 'Agents: replace instead of repair', capability: 'agents', permission: null,
  apply: async rec => ({ summary: `Signed off: replace ${rec.proposed._asset_tag || 'the asset'} instead of repairing it. Nothing was bought, retired or closed.` })
});

// An open recommendation that already covers this asset's field (e.g. a data-health category fix
// for its model group): the agents don't add a second one.
async function coveredBy(assetId, field) {
  const types = field === 'category_id' ? ['dq.fix_category', 'agents.set_field'] : ['agents.set_field'];
  const r = await db.get(
    `SELECT id FROM ai_recommendations WHERE status IN ('pending', 'applying') AND type = ANY($2::text[])
        AND ((target_type = 'asset' AND target_id = $1 AND (type <> 'agents.set_field' OR proposed->>'_field' = $3))
          OR proposed->'_asset_ids' @> to_jsonb($1::int))
      LIMIT 1`, [assetId, types, field]);
  return r ? r.id : null;
}

// " (agents disagree)" only when they do; a lone, not-quite-sure agent is "for a closer look".
const reviewNote = d => (d.outcome !== 'review' ? '' : d.options.length > 1 ? ' (agents disagree)' : ' (for a closer look)');

// One resolved decision -> a recommendation (or why not). Returns { id } or { skipped: reason }.
async function propose(decision, asset, runId) {
  const site = asset.stock_site && !String(asset.stock_site).startsWith('_') ? asset.stock_site : null;
  const base = {
    agent: 'Orchestrator', target_type: 'asset', target_id: asset.id, location_id: asset.location_id || null, site,
    why: decision.why, confidence: decision.confidence, run_id: runId, needs_review: decision.outcome === 'review'
  };
  if (FIELD_LABELS[decision.field]) {
    const covered = await coveredBy(asset.id, decision.field);
    if (covered) return { skipped: `Already in AI Approvals (#${covered})`, existing: covered };
    const name = FIELD_LABELS[decision.field];
    const id = await approvals.propose({
      ...base, type: 'agents.set_field',
      title: `${asset.asset_tag}: change ${name} from ${decision.current_label || '—'} to ${decision.label}${reviewNote(decision)}`,
      proposed: {
        [name]: { from: decision.current_label || null, to: decision.label },
        _field: decision.field, _from_id: decision.current, _to_id: decision.value, _agents: decision.agents,
        _options: decision.options.filter(o => o.value !== decision.current).map(o => ({ value: o.value, label: o.label, score: Math.round(o.score * 1000) / 1000, agents: o.agents }))
      },
      dedupe_key: `agents.set_field:${asset.id}:${decision.field}:${decision.value}`
    });
    return id ? { id } : { skipped: 'Not proposed (capability off or already open)' };
  }
  if (decision.field === 'repair_or_replace') {
    if (decision.value !== 'replace') return { skipped: 'Repairing is the agents\' view: nothing to sign off' };
    const id = await approvals.propose({
      ...base, type: 'agents.replace_instead',
      title: `${asset.asset_tag}: consider replacing instead of repairing${reviewNote(decision)}`,
      proposed: { action: 'Replace instead of repairing (sign-off only)', _asset_tag: asset.asset_tag, _agents: decision.agents },
      dedupe_key: `agents.replace_instead:${asset.id}`
    });
    return id ? { id } : { skipped: 'Not proposed (capability off or already open)' };
  }
  return { skipped: `No recommendation type for ${decision.field}` };
}

module.exports = { propose, coveredBy, FIELD_LABELS };
