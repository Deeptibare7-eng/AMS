// ReportAgent (dashboards): the daily briefing. In the fleet review the other agents post their
// summaries on the blackboard side by side (data health, refresh risk, cost, unusual assets,
// licence compliance); this agent turns them into a few plain sentences with numbers and links,
// adds what waits in AI Approvals, and leaves out what is switched off. It reports; it decides nothing.
const Agent = require('./agent');

const NAME = 'ReportAgent';
const THRESHOLDS = {};
const n = x => Math.round(Number(x) || 0).toLocaleString('en-IN');

function make(user) {
  return new Agent({
    name: NAME,
    goal: 'Sum up the fleet each day in a few plain sentences: data health, refresh risk, unusual assets, cost, compliance and what waits for a decision.',
    tools: { pending: () => require('../governance/approvals').pendingCount(user) },
    input: ['health', 'risk_summary', 'forecast', 'unusual', 'compliance (from the blackboard)'],
    output: ['briefing'],
    thresholds: THRESHOLDS,
    escalation: 'None needed: it only reports, and every line links to the page behind it.'
  });
}

// The sentences, from what the other agents posted (missing parts are left out; a part that
// failed says so).
function compose(bb, failed = new Set()) {
  const lines = [];
  const add = (area, text, link) => lines.push({ area, text, link });
  const h = bb.get('health');
  if (failed.has('health')) add('data_quality', 'Data health could not be read this time.', '/ai/data-health');
  else if (h) {
    if (!h.ready) add('data_quality', h.message, '/ai/data-health');
    else add('data_quality', `Data health averages ${h.avg} over ${n(h.assets)} assets (${n(h.poor)} poor)${h.trend ? `, ${h.trend > 0 ? 'up' : 'down'} ${Math.abs(h.trend)} since the last scan` : ''}.${h.top && h.top[0] ? ` Most common issue: ${h.top[0].label.toLowerCase()} (${n(h.top[0].n)}).` : ''}`, '/ai/data-health');
  }
  const r = bb.get('risk_summary');
  if (failed.has('risk')) add('lifecycle', 'Refresh risk could not be read this time.', '/');
  else if (r) add('lifecycle', r.ready ? `About ${n(r.expected)} assets are expected to be retired in the next 12 months; ${n(r.high)} are at high risk.` : 'There are no refresh-risk scores yet.', '/');
  const f = bb.get('forecast');
  if (failed.has('cost')) add('cost', 'The cost forecast could not be read this time.', '/ai/planning');
  else if (f) {
    const money = require('../cost/forecast').money;
    add('cost', f.ready ? `Replacing what is expected to retire in the next 12 months: about ${n(f.need.next12.units)} assets, ≈ ${money(f.need.next12.cost, f.currency)}.` : 'No cost forecast yet (it needs refresh-risk scores).', '/ai/planning');
  }
  const u = bb.get('unusual');
  if (failed.has('unusual')) add('anomaly', 'Unusual assets could not be read this time.', '/alerts');
  else if (u) {
    const g = u.groups && u.groups[0];
    add('anomaly', u.total ? `${n(u.total)} assets look unusual next to their peers${g ? `, for example ${g.asset_tag} (${g.why[0]})` : ''}.` : 'No asset looks unusual.', '/alerts');
  }
  const c = bb.get('compliance');
  if (failed.has('licences')) add('compliance', 'Licence compliance could not be read this time.', '/alerts');
  else if (c) add('compliance', c.dormant ? 'Licence compliance is waiting for licence or software records.' : `${n(c.findings)} licence and software finding${c.findings === 1 ? '' : 's'}.`, '/alerts');
  return lines;
}

async function brief(agent, bb, failed) {
  const lines = compose(bb, failed);
  const p = await agent.use('pending');
  lines.push({ area: 'approvals', text: p ? `${n(p)} recommendation${p === 1 ? '' : 's'} wait${p === 1 ? 's' : ''} for a decision in AI Approvals.` : 'Nothing waits for a decision in AI Approvals.', link: '/ai/approvals' });
  const briefing = { at: new Date().toISOString(), lines };
  bb.post(NAME, 'briefing', briefing);
  return { lines: lines.length };
}

module.exports = { NAME, make, brief, compose, THRESHOLDS };
