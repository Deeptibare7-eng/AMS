// DataQualityAgent (all modules): the data-health scan's view of an asset (M2) and fleet scans.
// For one asset it reads the last scan's issues: a "category looks wrong" issue becomes a claim
// for the other category; a scan that saw the asset as it is now and found no category issue
// confirms the recorded one (a weaker claim). Other issues are findings. A scan that predates the
// asset's last change says nothing about it.
const Agent = require('./agent');
const db = require('../../core/db');

const NAME = 'DataQualityAgent';
const THRESHOLDS = { claim: 0.6, confirm: 0.6 };

function make(user) {
  return new Agent({
    name: NAME,
    goal: 'Score how complete and consistent each asset\'s record is, and say what is wrong with it.',
    tools: {
      issues: id => db.query(`SELECT code, severity, confidence::float8 AS confidence, detail, data FROM ai_dq_issues WHERE asset_id = $1`, [id]),
      score: id => db.get(`SELECT score::float8 AS score, label, computed_at FROM ai_predictions WHERE asset_id = $1 AND capability = 'data_quality'`, [id]),
      scan: () => require('../index').runInBackground('ai_dq_scan', user),
      summary: () => require('../quality/insights').summary(user)
    },
    input: ['asset'],
    output: ['claims', 'findings', 'score'],
    thresholds: THRESHOLDS,
    escalation: 'Never edits a record. Category problems go to the orchestrator as claims, other problems to a person as findings; fleet fixes are proposed in AI Approvals by the scan itself.'
  });
}

async function reviewAsset(agent, bb, asset) {
  const score = await agent.use('score', asset.id);
  if (!score) return { scanned: false, note: 'Not scanned yet.' };
  if (asset.updated_at && new Date(score.computed_at) < new Date(asset.updated_at)) {
    return { scanned: false, note: 'The last scan predates the asset\'s last change.' };
  }
  const issues = await agent.use('issues', asset.id);
  const mismatch = issues.find(i => i.code === 'category_mismatch' && i.data && i.data.to);
  if (mismatch && mismatch.confidence >= THRESHOLDS.claim) {
    const to = await db.get('SELECT name FROM asset_categories WHERE id = $1', [mismatch.data.to]);
    bb.claim({
      agent: NAME, target_type: 'asset', target_id: asset.id, field: 'category_id',
      value: mismatch.data.to, label: to ? to.name : String(mismatch.data.to), current: asset.category_id, current_label: asset.category_name,
      confidence: mismatch.confidence, why: [mismatch.detail]
    });
  } else if (asset.category_id && !mismatch) {
    bb.claim({
      agent: NAME, target_type: 'asset', target_id: asset.id, field: 'category_id',
      value: asset.category_id, label: asset.category_name, current: asset.category_id, current_label: asset.category_name,
      confidence: THRESHOLDS.confirm, why: ['The last data-health scan found nothing wrong with its category']
    });
  }
  for (const i of issues.filter(x => x.code !== 'category_mismatch' && x.severity !== 'low')) {
    bb.finding({ agent: NAME, severity: i.severity, text: i.detail, target_type: 'asset', target_id: asset.id });
  }
  bb.post(NAME, 'data_health', { score: score.score, grade: score.label, issues: issues.length });
  return { scanned: true, score: score.score, issues: issues.length, category_issue: !!mismatch };
}

// Import / fleet runs: the scan through the existing job runner, then the fleet summary.
async function scanFleet(agent) {
  const r = await agent.use('scan');
  if (r.status === 'error') throw Object.assign(new Error(r.error || 'Data health scan failed'), { retryable: false });
  return { status: r.status, summary: r.summary };
}

module.exports = { NAME, make, reviewAsset, scanFleet, THRESHOLDS };
