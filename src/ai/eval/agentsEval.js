// Agents working together, measured on the real register (read-only: the agents' tools only read,
// and nothing is proposed or traced). For every asset the data-health scan says is filed under the
// wrong category, plus a fixed random sample of active assets, the asset-review steps run side by
// side exactly as in a run (IntakeAgent, DataQualityAgent, AnomalyAgent, LifecycleCostAgent, each
// only if its model or scan exists), then the conflict resolution. Reports what would happen.
const db = require('../../core/db');
const assetService = require('../../services/assetService');
const dag = require('../orchestrator/dag');
const Blackboard = require('../orchestrator/blackboard');
const { resolve } = require('../orchestrator/resolve');
const weights = require('../orchestrator/weights');
const handlers = require('../orchestrator/handlers');
const intake = require('../agents/intake');
const dataQuality = require('../agents/dataQuality');
const anomaly = require('../agents/anomaly');
const lifecycleCost = require('../agents/lifecycleCost');

async function run({ sample = 400, seed = 7 } = {}) {
  const mismatched = (await db.query(`SELECT asset_id AS id FROM ai_dq_issues WHERE code = 'category_mismatch' ORDER BY 1`)).map(r => r.id);
  // A fixed sample: ids ordered by a seeded hash, so reruns review the same assets.
  const sampled = (await db.query(
    `SELECT id FROM assets WHERE deleted_at IS NULL ORDER BY md5(id::text || $1) LIMIT $2`, [String(seed), sample])).map(r => r.id);
  const ids = [...new Set([...mismatched, ...sampled])];
  const { weights: w } = await weights.load();
  const tally = { assets: 0, claims: {}, findings: {}, outcomes: {}, steps: { done: 0, failed: 0 }, errors: {}, covered: 0 };
  const mismatch = { assets: mismatched.length, agree: 0, disagree: 0, intake_confirms_recorded: 0, intake_silent: 0, outcomes: {} };
  const times = [];
  const examples = [];
  for (const id of ids) {
    const asset = await assetService.find(id);
    if (!asset) continue;
    const bb = new Blackboard({ asset_id: id });
    const node = (nid, mod, fn) => ({ id: nid, agent: mod.NAME, run: () => fn(mod.make(null), bb, asset) });
    const t0 = process.hrtime.bigint();
    const results = await dag.run([
      node('intake', intake, intake.reviewAsset), node('quality', dataQuality, dataQuality.reviewAsset),
      node('unusual', anomaly, anomaly.reviewAsset), node('risk', lifecycleCost, lifecycleCost.reviewAsset)
    ], {}, { concurrency: 4, retries: 0, timeoutMs: 20000 });
    const decisions = resolve(bb.claims, { weights: w });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    tally.assets++;
    for (const r of results) {
      tally.steps[r.status === 'done' ? 'done' : 'failed']++;
      if (r.status !== 'done') {
        const e = (tally.errors[`${r.agent}: ${r.error}`] = tally.errors[`${r.agent}: ${r.error}`] || { n: 0, tag: asset.asset_tag });
        e.n++;
      }
    }
    for (const c of bb.claims) tally.claims[c.agent] = (tally.claims[c.agent] || 0) + 1;
    for (const f of bb.findings) tally.findings[f.agent] = (tally.findings[f.agent] || 0) + 1;
    for (const d of decisions) {
      const k = `${d.field}:${d.outcome}`;
      tally.outcomes[k] = (tally.outcomes[k] || 0) + 1;
      if ((d.outcome === 'propose' || d.outcome === 'review') && await handlers.coveredBy(id, d.field)) tally.covered++;
    }
    if (mismatched.includes(id)) {
      const cat = decisions.find(d => d.field === 'category_id');
      const dq = bb.claims.find(c => c.agent === 'DataQualityAgent' && c.field === 'category_id');
      const ik = bb.claims.find(c => c.agent === 'IntakeAgent' && c.field === 'category_id');
      if (!ik) mismatch.intake_silent++;
      else if (dq && ik.value === dq.value) mismatch.agree++;
      else if (ik.value === ik.current) mismatch.intake_confirms_recorded++;
      else mismatch.disagree++;
      const o = cat ? cat.outcome : 'none';
      mismatch.outcomes[o] = (mismatch.outcomes[o] || 0) + 1;
      if (examples.length < 5 && cat) examples.push({ tag: asset.asset_tag, recorded: asset.category_name, decided: cat.label, outcome: o, confidence: cat.confidence, why: cat.why.slice(0, 2) });
    }
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const q = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  return { ...tally, mismatch, examples, weights: w, ms: { median: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1] || 0 } };
}

function format(r) {
  const kv = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const lines = [
    `Agents (read-only, nothing proposed): ${r.assets} assets reviewed (${r.mismatch.assets} the data-health scan says are mis-filed, the rest a fixed random sample).`,
    `Steps: ${r.steps.done} done, ${r.steps.failed} failed${Object.keys(r.errors).length ? ` (${Object.entries(r.errors).map(([k, e]) => `${e.n}× ${k}, e.g. ${e.tag}`).join('; ')})` : ''}. Time per asset review: median ${r.ms.median.toFixed(0)} ms, p95 ${r.ms.p95.toFixed(0)} ms.`,
    `Claims by agent: ${kv(r.claims)}.`,
    `Findings by agent: ${kv(r.findings)}.`,
    `Decisions: ${kv(r.outcomes)} (${r.covered} already covered by an open recommendation).`,
    `On the ${r.mismatch.assets} mis-filed assets: IntakeAgent agrees with DataQualityAgent on ${r.mismatch.agree}, confirms the recorded category on ${r.mismatch.intake_confirms_recorded}, proposes a third category on ${r.mismatch.disagree}, says nothing on ${r.mismatch.intake_silent}. Outcomes: ${kv(r.mismatch.outcomes)}.`,
    `Agent weights from past decisions: ${Object.keys(r.weights).length ? kv(Object.fromEntries(Object.entries(r.weights).map(([k, v]) => [k, v.toFixed(2)]))) : 'none yet (all 0.75)'}.`
  ];
  if (r.examples.length) {
    lines.push('', 'Examples:');
    for (const e of r.examples) lines.push(`  ${e.tag}: recorded ${e.recorded}, agents ${e.outcome} "${e.decided}" (${Math.round(e.confidence * 100)}%): ${e.why.join(' | ')}`);
  }
  return lines.join('\n');
}

module.exports = { run, format };
