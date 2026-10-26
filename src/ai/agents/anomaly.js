// AnomalyAgent (Alerts): is this asset unusual next to its peers (Isolation Forest, M4)?
// Unusual assets are findings for a person: nothing about them is claimed or changed.
const Agent = require('./agent');

const NAME = 'AnomalyAgent';
const THRESHOLDS = { report: 0.5 };

function make(user) {
  return new Agent({
    name: NAME,
    goal: 'Spot assets that look unusual next to the others of their model, holder and age, and say why.',
    tools: {
      forAsset: id => require('../anomaly/run').forAsset(id),
      list: () => require('../anomaly/run').list(user, { limit: 5 }),
      scan: () => require('../index').runInBackground('ai_anomaly', user)
    },
    input: ['asset'],
    output: ['findings'],
    thresholds: THRESHOLDS,
    escalation: 'Only reports: a person marks each finding as a real issue or expected on Alerts.'
  });
}

async function reviewAsset(agent, bb, asset) {
  const a = await agent.use('forAsset', asset.id);
  if (!a.scored) return { scored: false, note: 'Not scored yet (scored nightly).' };
  if (a.unusual && a.confidence >= THRESHOLDS.report) {
    bb.finding({ agent: NAME, severity: 'medium', text: `Looks unusual next to similar assets: ${a.why.slice(0, 2).join('; ')}`, target_type: 'asset', target_id: asset.id });
  }
  return { scored: true, unusual: a.unusual, score: a.score };
}

async function scanFleet(agent) {
  const r = await agent.use('scan');
  if (r.status === 'error') throw Object.assign(new Error(r.error || 'Unusual-asset scan failed'), { retryable: false });
  return { status: r.status, summary: r.summary };
}

module.exports = { NAME, make, reviewAsset, scanFleet, THRESHOLDS };
