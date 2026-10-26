// The orchestrator's flows: which agents work on what, in which order. Each plan() returns the
// task graph (nodes run as soon as their dependencies are done, independent ones side by side),
// the run's target, and the agents left out because their capability is off.
//
//   asset.review        intake ─┐
//   (asset added or      quality ┼─> resolve (conflict resolution -> AI Approvals)
//    changed, or         unusual │
//    "Review now")       risk ───┘
//   maintenance.review  risk ──> risk_view ─┐
//   (repair logged)     repairs ────────────┴─> resolve
//   licence.review      licences (compliance)
//   import.review       quality_scan ─┬─> risk_scores ──> cost_forecast ─┐
//   (import finished)                 └─> unusual_scan ─────────────────┴─> briefing
//   fleet.review        health ∥ risk ∥ cost ∥ unusual ∥ licences ──> briefing   (daily)
//   ask                 assistant (a question in plain language)
const assetService = require('../../services/assetService');
const intake = require('../agents/intake');
const dataQuality = require('../agents/dataQuality');
const anomaly = require('../agents/anomaly');
const lifecycleCost = require('../agents/lifecycleCost');
const maintenance = require('../agents/maintenance');
const compliance = require('../agents/compliance');
const report = require('../agents/report');
const assistant = require('../agents/assistant');

const ORCH = 'Orchestrator';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// A node whose agent is made fresh for the step, so the step's trace has exactly its own tool calls.
function step(ctx, id, agentMod, fn, opts = {}) {
  return {
    id, agent: agentMod.NAME, deps: opts.deps || [], timeoutMs: opts.timeoutMs || 20 * SECOND, retries: opts.retries ?? 1, always: !!opts.always,
    run: async () => {
      const agent = agentMod.make(ctx.user);
      ctx.calls[id] = agent.calls;
      return fn(agent, ctx);
    }
  };
}

const left = (agentMod, capability) => ({ agent: agentMod.NAME, reason: `${capability} is off` });

async function loadAsset(ctx, id) {
  const a = await assetService.find(id);
  if (!a) throw Object.assign(new Error(`Asset ${id} not found`), { retryable: false });
  ctx.asset = a;
  return a;
}

const FLOWS = {
  'asset.review': {
    label: 'Asset review',
    async plan(ctx) {
      const asset = await loadAsset(ctx, ctx.input.asset_id);
      const nodes = [];
      const omitted = [];
      const on = ctx.on;
      if (on.has('intake')) nodes.push(step(ctx, 'intake', intake, (ag, c) => intake.reviewAsset(ag, c.bb, asset)));
      else omitted.push(left(intake, 'Intake suggestions'));
      if (on.has('data_quality')) nodes.push(step(ctx, 'quality', dataQuality, (ag, c) => dataQuality.reviewAsset(ag, c.bb, asset)));
      else omitted.push(left(dataQuality, 'Data health'));
      if (on.has('anomaly')) nodes.push(step(ctx, 'unusual', anomaly, (ag, c) => anomaly.reviewAsset(ag, c.bb, asset)));
      else omitted.push(left(anomaly, 'Unusual assets'));
      if (on.has('lifecycle') || on.has('cost')) nodes.push(step(ctx, 'risk', lifecycleCost, (ag, c) => lifecycleCost.reviewAsset(ag, c.bb, asset)));
      else omitted.push(left(lifecycleCost, 'Refresh risk'));
      nodes.push(resolveNode(ctx, nodes.map(n => n.id)));
      return { nodes, omitted, target_type: 'asset', target_id: asset.id, location_id: asset.location_id };
    },
    summarize: (ctx, out) => `${ctx.asset.asset_tag}: ${out.claims} claim(s), ${out.findings} finding(s), ${out.proposed} recommendation(s)${out.review ? ` (${out.review} for a closer look)` : ''}`
  },

  'maintenance.review': {
    label: 'Repair or replace',
    async plan(ctx) {
      const asset = await loadAsset(ctx, ctx.input.asset_id);
      const nodes = [];
      const omitted = [];
      if (ctx.on.has('lifecycle') || ctx.on.has('cost')) {
        nodes.push(step(ctx, 'risk', lifecycleCost, (ag, c) => lifecycleCost.reviewAsset(ag, c.bb, asset)));
        nodes.push({ id: 'risk_view', agent: lifecycleCost.NAME, deps: ['risk'], run: async c => lifecycleCost.claimAction(c.bb, asset) });
      } else omitted.push(left(lifecycleCost, 'Refresh risk'));
      nodes.push(step(ctx, 'repairs', maintenance, (ag, c) => maintenance.reviewRepair(ag, c.bb, asset)));
      nodes.push(resolveNode(ctx, nodes.map(n => n.id)));
      return { nodes, omitted, target_type: 'asset', target_id: asset.id, location_id: asset.location_id };
    },
    summarize: (ctx, out) => `${ctx.asset.asset_tag}: ${out.decisions.find(d => d.field === 'repair_or_replace') ? `agents say "${out.decisions.find(d => d.field === 'repair_or_replace').label}"` : 'no view on repair or replace'}${out.proposed ? ', sent for sign-off' : ''}`
  },

  'licence.review': {
    label: 'Licence check',
    async plan(ctx) {
      if (!ctx.on.has('compliance')) return { nodes: [], omitted: [left(compliance, 'Licence compliance')], target_type: 'license', target_id: ctx.input.licence_id || null };
      return {
        nodes: [step(ctx, 'licences', compliance, (ag, c) => compliance.review(ag, c.bb, { licenceId: c.input.licence_id }))],
        omitted: [], target_type: 'license', target_id: ctx.input.licence_id || null
      };
    },
    summarize: (ctx, out) => `${out.findings} finding(s)`
  },

  'import.review': {
    label: 'After an import',
    async plan(ctx) {
      const on = ctx.on;
      const nodes = [];
      const omitted = [];
      const scans = { timeoutMs: 15 * MINUTE, retries: 0 };
      if (on.has('data_quality')) nodes.push(step(ctx, 'quality_scan', dataQuality, ag => dataQuality.scanFleet(ag), scans));
      else omitted.push(left(dataQuality, 'Data health'));
      const after = nodes.length ? ['quality_scan'] : [];
      if (on.has('lifecycle') || on.has('cost')) {
        nodes.push(step(ctx, 'risk_scores', lifecycleCost, async ag => { const r = await ag.use('score'); if (r.status === 'error') throw Object.assign(new Error(r.error), { retryable: false }); return { status: r.status, summary: r.summary }; }, { ...scans, deps: after, always: true }));
        if (on.has('cost')) nodes.push(step(ctx, 'cost_forecast', lifecycleCost, async ag => { const r = await ag.use('costRun'); if (r.status === 'error') throw Object.assign(new Error(r.error), { retryable: false }); return { status: r.status, summary: r.summary }; }, { ...scans, deps: ['risk_scores'] }));
      } else omitted.push(left(lifecycleCost, 'Refresh risk'));
      if (on.has('anomaly')) nodes.push(step(ctx, 'unusual_scan', anomaly, ag => anomaly.scanFleet(ag), { ...scans, deps: after, always: true }));
      else omitted.push(left(anomaly, 'Unusual assets'));
      nodes.push(...fleetSummaries(ctx, nodes.map(n => n.id)));
      return { nodes, omitted, target_type: null, target_id: null };
    },
    summarize: ctx => briefingText(ctx)
  },

  'fleet.review': {
    label: 'Daily briefing',
    async plan(ctx) {
      return { nodes: fleetSummaries(ctx, []), omitted: [], target_type: null, target_id: null };
    },
    summarize: ctx => briefingText(ctx)
  },

  ask: {
    label: 'Question',
    async plan(ctx) {
      return {
        nodes: [step(ctx, 'assistant', { NAME: 'AssistantAgent', make: assistant.make }, async (ag, c) => {
          const a = await assistant.ask(c.input.question, c.user, { agent: ag });
          c.bb.post('AssistantAgent', 'answer', a);
          return { intent: a.intent, confidence: a.confidence, total: a.total, fallback: a.fallback || false };
        }, { retries: 0 })],
        omitted: [], target_type: null, target_id: null
      };
    },
    summarize: ctx => { const a = ctx.bb.get('answer'); return a ? `"${a.question}": ${a.intent} (${Math.round(a.confidence * 100)}%)` : 'No answer'; }
  }
};

// Each agent posts its summary side by side; ReportAgent writes the briefing from them.
function fleetSummaries(ctx, after) {
  const on = ctx.on;
  const nodes = [];
  const post = (id, mod, tool, key, cap) => {
    if (cap && !cap.some(k => on.has(k))) return;
    nodes.push(step(ctx, id, mod, async (ag, c) => { const v = await ag.use(tool); c.bb.post(mod.NAME, key, v); return { ready: v && v.ready !== false }; }, { deps: after, always: true }));
  };
  post('health', dataQuality, 'summary', 'health', ['data_quality']);
  post('risk', lifecycleCost, 'summary', 'risk_summary', ['lifecycle', 'cost']);
  post('cost', lifecycleCost, 'forecast', 'forecast', ['cost']);
  post('unusual', anomaly, 'list', 'unusual', ['anomaly']);
  if (on.has('compliance')) nodes.push(step(ctx, 'licences', compliance, (ag, c) => compliance.review(ag, c.bb), { deps: after, always: true }));
  const ids = nodes.map(n => n.id);
  nodes.push(step(ctx, 'briefing', report, (ag, c) => report.brief(ag, c.bb, c.failedSteps), { deps: [...after, ...ids], always: true }));
  return nodes;
}

function briefingText(ctx) {
  const b = ctx.bb.get('briefing');
  return b ? b.lines.map(l => l.text).join(' ').slice(0, 900) : 'No briefing';
}

// The orchestrator's own step: weigh the claims, propose what comes out (see resolve.js).
function resolveNode(ctx, deps) {
  return {
    id: 'resolve', agent: ORCH, deps, always: true, retries: 0, timeoutMs: 20 * SECOND,
    run: async c => require('./index').resolveAndPropose(c)
  };
}

module.exports = { FLOWS, ORCH };
