// ComplianceAgent (licences): runs the ten licence and software rules (M5) when a licence changes
// and in the daily briefing. Findings only; the register has no licence or software records yet,
// so on real data it reports that it is dormant.
const Agent = require('./agent');

const NAME = 'ComplianceAgent';
const THRESHOLDS = { report: 'medium' };

function make(user) {
  return new Agent({
    name: NAME,
    goal: 'Check licences and software subscriptions for over-allocation, expiry, leavers\' seats, unused seats and duplicate keys.',
    tools: { check: () => require('../compliance/rules').check(user) },
    input: ['licence_id?'],
    output: ['findings'],
    thresholds: THRESHOLDS,
    escalation: 'Only reports: each finding links to the licence, where a person acts on it.'
  });
}

async function review(agent, bb, { licenceId = null } = {}) {
  const r = await agent.use('check');
  if (r.dormant) {
    bb.post(NAME, 'compliance', { dormant: true, findings: 0 });
    return { dormant: true, note: 'No licence or software records yet.' };
  }
  const relevant = licenceId ? r.findings.filter(f => f.target && f.target.type === 'license' && String(f.target.id) === String(licenceId)) : r.findings;
  for (const f of relevant.filter(x => x.severity !== 'low').slice(0, 20)) {
    bb.finding({ agent: NAME, severity: f.severity, text: `${f.label}: ${f.title}`, target_type: f.target ? f.target.type : 'license', target_id: f.target ? f.target.id : null });
  }
  bb.post(NAME, 'compliance', { dormant: false, findings: r.findings.length, counts: r.counts });
  return { dormant: false, findings: r.findings.length, about_this_licence: licenceId ? relevant.length : undefined };
}

module.exports = { NAME, make, review, THRESHOLDS };
