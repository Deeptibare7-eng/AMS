// How much the orchestrator trusts each agent in a conflict: its track record in AI Approvals.
//   weight = 0.5 + 0.5 × (accepted + 1) / (accepted + rejected + 2)
// No history: 0.75. Mostly rejected: towards 0.5. Mostly accepted: towards 1. An agent never counts
// for nothing, and one lucky decision barely moves it.
// Credit goes to every agent that backed the decided value (proposed._agents, else the
// recommendation's agent). "Edited" (a person picked another option) counts against the agents of
// the proposed value and for the agents of the option chosen (actual._agents).
const db = require('../../core/db');

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, value: null };

const weightFor = (accepted, rejected) => 0.5 + 0.5 * (accepted + 1) / (accepted + rejected + 2);

async function load() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await db.query(
    `SELECT r.agent, r.proposed->'_agents' AS agents, f.label, f.actual->'_agents' AS chosen
       FROM ai_feedback f JOIN ai_recommendations r ON r.id = f.recommendation_id
      WHERE f.label IN ('accepted', 'rejected', 'edited')`);
  const tally = {};
  const add = (agent, k) => { (tally[agent] = tally[agent] || { accepted: 0, rejected: 0 })[k]++; };
  for (const r of rows) {
    const backers = Array.isArray(r.agents) && r.agents.length ? r.agents : [r.agent];
    if (r.label === 'accepted') backers.forEach(a => add(a, 'accepted'));
    else {
      backers.forEach(a => add(a, 'rejected'));
      if (r.label === 'edited' && Array.isArray(r.chosen)) r.chosen.forEach(a => add(a, 'accepted'));
    }
  }
  const weights = {};
  for (const [agent, t] of Object.entries(tally)) weights[agent] = weightFor(t.accepted, t.rejected);
  cache = { at: Date.now(), value: { weights, tally } };
  return cache.value;
}

function invalidate() { cache = { at: 0, value: null }; }

module.exports = { load, invalidate, weightFor };
