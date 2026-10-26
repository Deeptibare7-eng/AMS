// The orchestrator: routes events and requests to the agents (flows.js), runs each flow's task
// graph with a shared blackboard (dag.js, blackboard.js), weighs the agents' claims (resolve.js,
// weights.js), proposes the outcome in AI Approvals (handlers.js) and stores a full trace of every
// run (trace.js). It works only while "Agents working together" is on, and only with the agents
// whose capability is on. It never changes anything itself.
//
// Events (from the app's event bus):
//   asset.created / asset.updated / asset.status_changed -> asset.review (3 s after the last change
//     of that asset; at most 60 asset reviews a minute, so a burst can't swamp the server)
//   maintenance.logged -> maintenance.review       license.changed -> licence.review
//   import.applied -> import.review (90 s later, after the import's snapshot)
// Requests: "Review now" on an asset, questions (Ask), and the daily briefing job.
const flags = require('../flags');
const logger = require('../../core/logger');
const events = require('../events');
const dag = require('./dag');
const Blackboard = require('./blackboard');
const { resolve } = require('./resolve');
const weights = require('./weights');
const trace = require('./trace');
const handlers = require('./handlers');
const { FLOWS } = require('./flows');

const timing = { debounceMs: 3000, importDelayMs: 90000, reviewsPerMinute: 60 };
const round = x => Math.round(x * 1000) / 1000;

const available = () => flags.isOn('agents');

async function run(flow, input = {}, { trigger = 'manual', user = null } = {}) {
  const def = FLOWS[flow];
  if (!def) throw new Error(`Unknown flow "${flow}"`);
  if (!(await available())) return null;
  const ctx = { flow, input, user, on: await flags.enabledSet(), bb: new Blackboard(input), calls: {}, failedSteps: new Set(), runId: null, asset: null, resolution: null };
  let plan;
  try {
    plan = await def.plan(ctx);
  } catch (err) {
    const row = await trace.start({ flow, trigger, user, dag: { nodes: [], omitted: [] } });
    await trace.finish(row.id, { status: 'failed', summary: err.message, context: ctx.bb.toJSON(), error: err.message });
    return { id: row.id, status: 'failed', summary: err.message, results: [], bb: ctx.bb };
  }
  const level = plan.nodes.length ? dag.levels(plan.nodes) : new Map();
  const row = await trace.start({
    flow, trigger, user, target_type: plan.target_type, target_id: plan.target_id, location_id: plan.location_id || null,
    dag: { nodes: plan.nodes.map(n => ({ id: n.id, agent: n.agent, deps: n.deps || [], level: level.get(n.id), always: !!n.always })), omitted: plan.omitted }
  });
  ctx.runId = row.id;
  const results = await dag.run(plan.nodes, ctx, {
    concurrency: 3, retries: 1, backoffMs: 200,
    onStep: async r => {
      if (r.status !== 'done') ctx.failedSteps.add(r.id);
      await trace.step(row.id, r, ctx.calls[r.id] || []);
    }
  });
  const failed = results.filter(r => r.status !== 'done');
  const status = !results.length || !failed.length ? 'done' : failed.length === results.length ? 'failed' : 'partial';
  const out = { decisions: [], proposed: 0, review: 0, ...(ctx.resolution || {}), claims: ctx.bb.claims.length, findings: ctx.bb.findings.length, results };
  let summary;
  if (!plan.nodes.length) summary = plan.omitted.map(o => `${o.agent}: ${o.reason}`).join('; ') || 'Nothing to do';
  else { try { summary = def.summarize(ctx, out); } catch (_) { summary = `${results.length} step(s)`; } }
  await trace.finish(row.id, {
    status, summary, context: ctx.bb.toJSON(),
    error: failed.length ? failed.map(f => `${f.id}: ${f.error}`).join('; ').slice(0, 1000) : null
  });
  return { id: row.id, status, summary, results, bb: ctx.bb };
}

// The resolve step: weigh every claim on the blackboard, propose what comes out, record why.
async function resolveAndPropose(ctx) {
  const { weights: w } = await weights.load();
  const decisions = resolve(ctx.bb.claims, { weights: w });
  let proposed = 0;
  let review = 0;
  for (const d of decisions) {
    const entry = {
      key: d.key, field: d.field, outcome: d.outcome, value: d.value, label: d.label, current: d.current, current_label: d.current_label,
      confidence: d.confidence, agents: d.agents, why: d.why,
      options: d.options.map(o => ({ value: o.value, label: o.label, score: round(o.score), share: round(o.share), agents: o.agents, claims: o.claims.map(c => ({ agent: c.agent, confidence: c.confidence, weight: round(c.weight) })) }))
    };
    if ((d.outcome === 'propose' || d.outcome === 'review') && ctx.asset) {
      entry.proposal = await handlers.propose(d, ctx.asset, ctx.runId);
      if (entry.proposal.id) {
        proposed++;
        if (d.outcome === 'review') review++;
        ctx.bb.proposals.push({ id: entry.proposal.id, key: d.key, needs_review: d.outcome === 'review' });
      }
    }
    ctx.bb.decisions.push(entry);
  }
  ctx.resolution = { decisions, proposed, review };
  return { decisions: decisions.length, proposed, review, outcomes: decisions.map(d => `${d.field}: ${d.outcome}`), weights: w };
}

// A question in plain language: traced as a run while the agents are on, answered directly otherwise.
async function ask(question, user) {
  const assistant = require('../agents/assistant');
  if (!(await available())) return assistant.ask(question, user);
  const r = await run('ask', { question: String(question || '').slice(0, 200) }, { trigger: 'request', user });
  const answer = r && r.bb.get('answer');
  if (!answer) throw new Error(r ? r.summary : 'The question could not be answered');
  return { ...answer, run_id: r.id };
}

// ─── Event routing ───
const timers = new Map();
const inflight = new Set();
let bucket = { tokens: timing.reviewsPerMinute, at: Date.now() };
let dropped = 0;

function take() {
  const now = Date.now();
  bucket.tokens = Math.min(timing.reviewsPerMinute, bucket.tokens + (now - bucket.at) * timing.reviewsPerMinute / 60000);
  bucket.at = now;
  if (bucket.tokens < 1) { dropped++; return false; }
  bucket.tokens -= 1;
  return true;
}

// Runs fn once, ms after the last call with the same key.
function later(key, ms, fn) {
  clearTimeout(timers.get(key));
  const t = setTimeout(() => {
    timers.delete(key);
    const p = fn().catch(err => logger.error(`[AI] orchestrator ${key}: ${err.message}`)).finally(() => inflight.delete(p));
    inflight.add(p);
  }, ms);
  if (t.unref) t.unref();
  timers.set(key, t);
}

let started = false;
function start() {
  if (started) return;
  started = true;
  events.on(['asset.created', 'asset.updated', 'asset.status_changed'], 'agents', async msg => {
    const id = parseInt(msg.meta && msg.meta.asset_id, 10);
    if (!id) return;
    later(`asset:${id}`, timing.debounceMs, async () => {
      if (!take()) return;
      await run('asset.review', { asset_id: id }, { trigger: msg.event });
    });
  });
  events.on('maintenance.logged', 'agents', async msg => {
    const id = parseInt(msg.meta && msg.meta.asset_id, 10);
    if (!id) return;
    later(`maintenance:${id}`, timing.debounceMs, () => run('maintenance.review', { asset_id: id, maintenance_id: msg.meta.maintenance_id }, { trigger: msg.event }));
  });
  events.on('license.changed', 'agents', async msg => {
    const id = msg.meta && msg.meta.license_id;
    later(`licence:${id || 'all'}`, timing.debounceMs, () => run('licence.review', { licence_id: id || null }, { trigger: msg.event }));
  });
  events.on('import.applied', 'agents', async msg => {
    later('import', timing.importDelayMs, () => run('import.review', {}, { trigger: msg.event }));
  });
}

// Tests: shorter delays, and waiting until every scheduled run has finished.
function setTiming(t) { Object.assign(timing, t); bucket = { tokens: timing.reviewsPerMinute, at: Date.now() }; }
async function drain(ms = 15000) {
  const until = Date.now() + ms;
  // An event reaches the handler only after the capability check (a database read): let it land.
  await new Promise(r => setTimeout(r, Math.max(150, timing.debounceMs * 3)));
  while ((timers.size || inflight.size) && Date.now() < until) {
    if (inflight.size) await Promise.allSettled([...inflight]);
    else await new Promise(r => setTimeout(r, 50));
  }
}
const stats = () => ({ scheduled: timers.size, running: inflight.size, dropped });

module.exports = { run, resolveAndPropose, ask, start, available, setTiming, drain, stats, FLOWS, timing };
