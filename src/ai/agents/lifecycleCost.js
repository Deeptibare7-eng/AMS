// LifecycleCostAgent (finance / procurement): how likely an asset is to be retired soon (refresh
// risk, M4) and what replacing the fleet will cost (cost forecast and plan, M5).
// For a repair it also takes a side on repair-or-replace: a likely retirement argues for replacing,
// a young, low-risk asset for repairing. Its claims go to the orchestrator; it never buys anything.
const Agent = require('./agent');

const NAME = 'LifecycleCostAgent';
const THRESHOLDS = { replace: 0.5, repair: 0.2 };

function make(user) {
  return new Agent({
    name: NAME,
    goal: 'Estimate when assets will need replacing and what that will cost, and weigh in on repair-or-replace.',
    tools: {
      risk: id => require('../lifecycle/run').forAsset(id),
      summary: () => require('../lifecycle/run').summary(user),
      forecast: () => require('../cost/forecast').forecast(user),
      score: () => require('../index').runInBackground('ai_lifecycle', user),
      costRun: () => require('../index').runInBackground('ai_cost_forecast', user)
    },
    input: ['asset'],
    output: ['risk', 'claims', 'findings'],
    thresholds: THRESHOLDS,
    escalation: 'Never buys or retires anything. A high risk is a finding; repair-or-replace is a claim the orchestrator weighs against the maintenance history, and a person signs off.'
  });
}

async function reviewAsset(agent, bb, asset) {
  const r = await agent.use('risk', asset.id);
  if (!r || !r.ready) return { scored: false, note: 'No refresh-risk model yet.' };
  if (r.skip) return { scored: false, note: r.skip };
  bb.post(NAME, 'risk', { risk6: r.risk6, risk12: r.risk12, risk24: r.risk24, label: r.label, age: r.age, confidence: r.confidence, why: r.why });
  if (r.label === 'high') {
    bb.finding({ agent: NAME, severity: 'medium', text: `${r.summary} (${r.why[0]})`, target_type: 'asset', target_id: asset.id });
  }
  return { scored: true, risk12: r.risk12, label: r.label };
}

// Repair or replace, from the risk alone (MaintenanceAgent adds the repair history).
function claimAction(bb, asset) {
  const r = bb.get('risk');
  if (!r) return { claimed: false };
  const claim = (value, confidence, why) => bb.claim({
    agent: NAME, target_type: 'asset', target_id: asset.id, field: 'repair_or_replace',
    value, label: value === 'replace' ? 'Replace it' : 'Repair it', current: null, confidence, why
  });
  if (r.risk12 >= THRESHOLDS.replace) {
    claim('replace', Math.min(0.95, r.risk12), [`${Math.round(r.risk12 * 100)}% chance of being retired in the next 12 months`, r.why[0]]);
    return { claimed: 'replace' };
  }
  if (r.risk12 < THRESHOLDS.repair) {
    claim('repair', Math.min(0.9, 1 - r.risk12), [`Only ${Math.round(r.risk12 * 100)}% chance of being retired in the next 12 months`, r.why[0]]);
    return { claimed: 'repair' };
  }
  return { claimed: false, note: 'Risk in between: no view on repair or replace' };
}

module.exports = { NAME, make, reviewAsset, claimAction, THRESHOLDS };
