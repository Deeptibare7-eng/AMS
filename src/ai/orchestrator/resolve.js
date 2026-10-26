// Confidence-weighted conflict resolution. Agents claim a value for a field of a target
// (IntakeAgent: "category should be Laptop, 92% sure"; DataQualityAgent: "Desktop, 70%"). For each
// target field, every claimed value gets
//   support = Σ weight(agent) × confidence      over the claims for that value
//   share   = support / Σ support                (how much of the weighted opinion backs it)
//   agree   = 1 − Π (1 − confidence)             (independent agents agreeing make it surer)
//   score   = share × agree
// weight(agent) is its track record in AI Approvals (see weights.js), 0.5 to 1; 0.75 with no history.
// The best value's outcome:
//   keep     it is the current value: the agents confirm what is recorded (unless a strong
//            dissent remains: then review, proposing the dissent)
//   propose  two or more agents back it with score ≥ 0.6, or one with score ≥ 0.9 (no serious rival)
//   review   score ≥ 0.45, or agents disagree: proposed, but marked for a closer look with the
//            alternatives (low confidence goes to a person, never applied on its own)
//   drop     below that: kept in the run's trace only
// Nothing is ever applied here: every outcome other than keep/drop becomes an AI Approvals item.

// strongDissent: agents this sure (agreement ≥ 0.8) carrying a quarter of the weighted opinion are
// never outvoted silently.
const DEFAULTS = { propose: 0.6, proposeAlone: 0.9, review: 0.45, rivalShare: 0.25, strongDissent: 0.8, defaultWeight: 0.75 };

const keyOf = c => `${c.target_type}:${c.target_id}:${c.field}`;
const pct = p => (p >= 0.995 ? 'over 99%' : `${Math.round(p * 100)}%`);

function resolve(claims, { weights = {}, thresholds = {} } = {}) {
  const t = { ...DEFAULTS, ...thresholds };
  const weightOf = agent => (weights[agent] !== undefined ? weights[agent] : t.defaultWeight);
  const groups = new Map();
  for (const c of claims) {
    if (!groups.has(keyOf(c))) groups.set(keyOf(c), []);
    groups.get(keyOf(c)).push(c);
  }
  const decisions = [];
  for (const [key, list] of groups) {
    const byValue = new Map();
    for (const c of list) {
      const v = byValue.get(c.value) || { value: c.value, label: c.label || c.value, claims: [], support: 0 };
      v.claims.push(c);
      v.support += weightOf(c.agent) * c.confidence;
      byValue.set(c.value, v);
    }
    const total = [...byValue.values()].reduce((s, v) => s + v.support, 0) || 1;
    const options = [...byValue.values()].map(v => {
      const agree = 1 - v.claims.reduce((p, c) => p * (1 - c.confidence), 1);
      const share = v.support / total;
      return {
        value: v.value, label: v.label, share, agree, score: share * agree,
        agents: [...new Set(v.claims.map(c => c.agent))],
        claims: v.claims.map(c => ({ agent: c.agent, confidence: c.confidence, weight: weightOf(c.agent), why: c.why }))
      };
    }).sort((a, b) => b.score - a.score || b.agents.length - a.agents.length);
    const first = list[0];
    let best = options[0];
    let outcome;
    if (best.value === first.current) {
      // The agents mostly confirm the record; a strong dissent still goes to a person.
      const challenger = options.find(o => o.value !== first.current);
      const strong = challenger && (challenger.score >= t.review || (challenger.share >= t.rivalShare && challenger.agree >= t.strongDissent));
      if (strong) { best = challenger; outcome = 'review'; } else outcome = 'keep';
    } else {
      const rivals = options.filter(o => o !== best && o.share >= t.rivalShare);
      if (!rivals.length && ((best.agents.length >= 2 && best.score >= t.propose) || best.score >= t.proposeAlone)) outcome = 'propose';
      else if (best.score >= t.review || rivals.length) outcome = 'review';
      else outcome = 'drop';
    }
    decisions.push({
      key, target_type: first.target_type, target_id: first.target_id, field: first.field,
      current: first.current, current_label: first.current_label || first.current,
      outcome, value: best.value, label: best.label, confidence: Math.round(best.score * 1000) / 1000,
      agents: best.agents, options,
      why: explain(outcome, best, options.filter(o => o !== best), first)
    });
  }
  return decisions;
}

// others: the options other than the one decided on.
function explain(outcome, best, others, first) {
  const who = o => o.claims.map(c => `${c.agent} ${pct(c.confidence)}`).join(', ');
  const lines = [];
  if (outcome === 'keep') {
    lines.push(`The agents confirm the recorded ${first.field.replace(/_id$/, '').replace(/_/g, ' ')} "${best.label}" (${who(best)})`);
  } else {
    lines.push(`${best.agents.length > 1 ? 'Agents agree' : best.agents[0] + ' says'}: "${best.label}" (${who(best)})`);
    for (const o of others) lines.push(`${o.agents.join(' and ')} ${o.agents.length > 1 ? 'say' : 'says'} "${o.label}"${o.value === first.current ? ' (as recorded)' : ''} (${who(o)})`);
    if (outcome === 'review') lines.push(others.length ? 'The agents disagree, so a person should decide' : 'Not sure enough to recommend on its own, so a person should decide');
    for (const c of best.claims) for (const w of c.why.slice(0, 2)) lines.push(`${c.agent}: ${w}`);
  }
  return lines.slice(0, 8);
}

module.exports = { resolve, DEFAULTS, keyOf };
