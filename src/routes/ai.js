// In-house AI layer: Settings > AI, the AI Approvals inbox, the Data Health page and the JSON
// endpoints behind the Register Asset suggestions and the asset / dashboard cards.
// Logic lives in src/ai/; this file only wires requests to it.
const express = require('express');
const ai = require('../ai');
const db = require('../core/db');
const snapshots = require('../ai/features/snapshots');
const approvals = require('../ai/governance/approvals');
const registry = require('../ai/governance/registry');
const aiSearch = require('../ai/search/service');
const schedulerService = require('../services/schedulerService');
const assetService = require('../services/assetService');
const authz = require('../services/authorizationService');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { hamsUrl, intOr, HttpError } = require('../core/helpers');
const Paginator = require('../core/paginator');
const { sendWorkbook } = require('../core/excelExport');

const router = express.Router();
const { flags } = ai;
// Idempotent (src/server.js calls it too): the AI jobs and handlers must exist whenever these routes do.
ai.start();

// JSON endpoints answer 404 { off: true } while their capability is off.
const capability = key => (req, res, next) => {
  flags.isOn(key).then(on => (on ? next() : res.status(404).json({ off: true }))).catch(next);
};
const capabilityPage = key => (req, res, next) => {
  flags.isOn(key).then(on => (on ? next() : next(new HttpError('This AI capability is switched off (Settings > AI).', 404)))).catch(next);
};

// ─── Settings > AI ───
router.get('/settings/ai', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const installed = await flags.installed();
    const user = await currentUser(req);
    const data = { installed, active_tab: 'ai', module: null, master: false, capabilities: [], snapshot: null, jobs: [], models: [], pending: 0, dq: null, searchIndex: aiSearch.summary(), nlMisses: null, agentsInfo: null, agents: [],
      modelsOverview: [], feedback: null, drift: [], driftInstalled: false, nlIntents: [] };
    if (installed) {
      data.module = await flags.aiModule();
      data.master = await flags.masterOn();
      data.capabilities = await flags.overview();
      data.snapshot = await snapshots.stats();
      const status = await schedulerService.status();
      data.jobs = status.jobs.filter(j => j.group === 'ai').map(j => ({ ...j, background: !!(ai.JOBS.find(x => x.key === j.key) || {}).background }));
      data.models = await registry.list();
      data.pending = await approvals.pendingCount(user);
      if (await dqInstalled()) data.dq = await require('../ai/quality/dataHealth').latest();
      if (await flags.isOn('nl')) data.nlMisses = await require('../ai/agents/assistant').misses(15);
      const on = await flags.enabledSet();
      // M8: models with versions and actions, the feedback loop, drift.
      data.modelsOverview = await require('../ai/governance/models').overview();
      data.feedback = await require('../ai/governance/feedback').summary();
      data.driftInstalled = await flags.hasTable('ai_drift');
      data.drift = data.driftInstalled ? await require('../ai/governance/driftCheck').latest() : [];
      data.nlIntents = require('../ai/agents/assistant').INTENTS;
      data.agents = require('../ai/agents').describeAll(on);
      if (on.has('agents')) {
        const runTrace = require('../ai/orchestrator/trace');
        data.agentsInfo = { ...(await runTrace.stats()), briefing: await runTrace.latest('fleet.review'), weights: (await require('../ai/orchestrator/weights').load()).weights };
      }
    }
    res.renderPage('settings/ai', data);
  } catch (err) { next(err); }
});

async function dqInstalled() {
  const r = await db.get(`SELECT to_regclass('public.ai_dq_runs') IS NOT NULL AS ok`);
  return !!(r && r.ok);
}

router.post('/settings/ai/master', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const on = req.body.on === '1';
    const user = await currentUser(req);
    try {
      await flags.setMaster(on, user);
      req.flash('success', on ? 'AI switched on. Each capability still has its own switch below.' : 'AI switched off. No AI feature runs.');
      if (on) await ai.onSwitch(user);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/ai'));
  } catch (err) { next(err); }
});

router.post('/settings/ai/flags', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const key = String(req.body.key || '');
    const on = req.body.on === '1';
    const user = await currentUser(req);
    try {
      await flags.setFlag(key, on, user);
      const cap = flags.CAPABILITIES.find(c => c.key === key);
      let msg = `${cap.label} switched ${on ? 'on' : 'off'}.`;
      if (on && ['intake', 'data_quality'].includes(key) && await flags.isOn(key)) {
        await ai.onSwitch(user);
        msg += ' First-time setup (training the intake model, first scan) runs in the background; refresh in a minute.';
      }
      req.flash('success', msg);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/settings/ai'));
  } catch (err) { next(err); }
});

router.post('/settings/ai/jobs/:key/run', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    const job = ai.JOBS.find(j => j.key === req.params.key);
    const user = await currentUser(req);
    if (!job) {
      req.flash('error', 'Unknown AI job.');
    } else if (!(await job.enabled())) {
      req.flash('error', `Switch on AI and the capability for "${job.label}" first.`);
    } else if (job.background) {
      ai.runInBackground(job.key, user);
      req.flash('success', `${job.label} started. It takes up to a minute; refresh to see the result below.`);
    } else {
      const r = await schedulerService.runNow(job.key, user);
      if (r.status === 'error') req.flash('error', `${job.label} failed: ${r.error}`);
      else req.flash('success', r.summary || `${job.label} done.`);
    }
    res.redirect(hamsUrl('/settings/ai'));
  } catch (err) { next(err); }
});

// ─── Models, drift and the feedback loop (M8) ───
const governance = require('../ai/governance/models');
const modelAction = (fn, done) => async (req, res, next) => {
  try {
    const name = String(req.params.name || '');
    if (!governance.CATALOG[name]) { req.flash('error', 'Unknown model.'); return res.redirect(hamsUrl('/settings/ai') + '#models'); }
    try {
      const msg = await fn(name, await currentUser(req), req);
      req.flash('success', msg || done);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/settings/ai') + '#models');
  } catch (err) { next(err); }
};
const label = name => governance.CATALOG[name].label;

router.post('/settings/ai/models/:name/retrain', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), modelAction(async (name, user) => {
  const r = await governance.retrain(name, user);
  return r && r.summary ? r.summary : `${label(name)}: retraining started in the background. Refresh in a minute.`;
}));
router.post('/settings/ai/models/:name/rollback', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), modelAction(async (name, user) => {
  const v = await governance.rollback(name, user);
  return `${label(name)} rolled back to v${v} and pinned: scheduled retraining keeps new versions as candidates until you unpin it.`;
}));
router.post('/settings/ai/models/:name/activate', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), modelAction(async (name, user, req) => {
  const v = intOr(req.body.version, 0);
  if (!v) throw Object.assign(new Error('Pick a version.'), { status: 422 });
  await governance.activate(name, v, user);
  return `${label(name)} v${v} is now active and pinned.`;
}));
router.post('/settings/ai/models/:name/unpin', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), modelAction(async (name, user) => {
  await registry.unpin(name, user);
  return `${label(name)} unpinned: scheduled retraining may activate better versions again.`;
}));

// The drift report: per checked model, the latest check feature by feature and the history.
router.get('/settings/ai/drift', authRequired, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    if (!(await flags.hasTable('ai_drift'))) throw new HttpError('Drift checks need a database update: node bin/hams-cli.js migrate', 404);
    const drift = require('../ai/governance/driftCheck');
    const latest = await drift.latest();
    const models = [];
    for (const row of latest) models.push({ ...row, label: (governance.CATALOG[row.model_name] || {}).label || row.model_name, history: await drift.history(row.model_name, 30) });
    res.renderPage('settings/ai-drift', { active_tab: 'ai', models, bands: require('../ai/governance/drift').BANDS, job: (await schedulerService.status()).jobs.find(j => j.key === 'ai_drift') || null });
  } catch (err) { next(err); }
});

// "This question was about …": a missed question taught its kind (the classifier learns it).
router.post('/settings/ai/nl/teach', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), async (req, res, next) => {
  try {
    try {
      const r = await require('../ai/agents/assistant').teach(req.body.q, String(req.body.intent || ''), await currentUser(req));
      req.flash('success', `Taught: "${String(req.body.q).slice(0, 80)}" is a "${r.now.replace('_', ' ')}" question (it was read as "${r.was.replace('_', ' ')}"). The classifier retrains on the next question.`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/settings/ai') + '#questions');
  } catch (err) { next(err); }
});

// Kept for the M1 button and bookmarks.
router.post('/settings/ai/snapshot/run', authRequired, csrfProtect, perm('settings.manage'), mod('settings'), (req, res) => {
  res.redirect(307, hamsUrl('/settings/ai/jobs/ai_snapshot/run'));
});

// ─── AI Approvals inbox ───
// Filters from the query string, each checked (unknown values are ignored).
function inboxFilters(q) {
  const word = v => (/^[a-z][a-z0-9_.]{1,59}$/i.test(String(v || '')) ? String(v) : null);
  const min = parseFloat(q.min);
  return {
    agent: word(q.agent), type: word(q.type), review: q.review === '1' ? '1' : null,
    min: min >= 0 && min <= 1 ? min : null, location_id: /^\d{1,9}$/.test(String(q.location_id || '')) ? q.location_id : null,
    q: q.q ? String(q.q).trim().slice(0, 100) : null,
    sort: ['confidence', 'newest', 'oldest', 'least_sure'].includes(q.sort) ? q.sort : null
  };
}
const inboxQuery = (view, filters) => {
  const u = new URLSearchParams();
  if (view === 'decided') u.set('view', 'decided');
  for (const [k, v] of Object.entries(filters)) if (v !== null && v !== undefined && v !== '') u.set(k, v);
  return u.toString();
};

router.get('/ai/approvals', authRequired, perm('ai.view'), mod('ai'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const view = req.query.view === 'decided' ? 'decided' : 'pending';
    const page = Math.max(1, intOr(req.query.page, 1));
    const filters = inboxFilters(req.query);
    const result = await approvals.list(user, { view, page, filters });
    const qs = inboxQuery(view, filters);
    res.renderPage('ai/approvals', {
      view, rows: result.rows, total: result.total, facets: result.facets, filters, qs,
      paginator: new Paginator(result.total, result.perPage, result.page),
      baseUrl: hamsUrl('/ai/approvals') + (qs ? '?' + qs : ''),
      canApprove: await authz.can('ai.approve', user),
      agentsOn: await flags.isOn('agents')
    });
  } catch (err) { next(err); }
});

const decidedText = done => {
  const summary = done.applied_result && done.applied_result.summary ? ` ${done.applied_result.summary}.` : '';
  if (done.status === 'rejected') return 'Rejected. The AI will learn from this.';
  return `${done.status === 'edited' ? 'Applied with the option you picked.' : 'Accepted and applied.'}${summary}`;
};

router.post('/ai/approvals/:id/decide', authRequired, csrfProtect, perm('ai.approve'), mod('ai'), async (req, res, next) => {
  try {
    try {
      const done = await approvals.decide(intOr(req.params.id), String(req.body.decision || ''), await currentUser(req), req.body.note,
        { choice: req.body.choice !== undefined ? String(req.body.choice).slice(0, 60) : null });
      req.flash('success', decidedText(done));
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/ai/approvals') + (req.body.back ? '?' + String(req.body.back).replace(/[^\w=&.%-]/g, '').slice(0, 300) : ''));
  } catch (err) { next(err); }
});

// Bulk accept / reject: each recommendation is decided on its own (permission and scope per item).
router.post('/ai/approvals/bulk', authRequired, csrfProtect, perm('ai.approve'), mod('ai'), async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).map(v => intOr(v, 0)).filter(Boolean);
    const decision = String(req.body.decision || '');
    const back = hamsUrl('/ai/approvals') + (req.body.back ? '?' + String(req.body.back).replace(/[^\w=&.%-]/g, '').slice(0, 300) : '');
    if (!ids.length) { req.flash('error', 'Tick at least one recommendation.'); return res.redirect(back); }
    if (!['accept', 'reject'].includes(decision)) { req.flash('error', 'Choose accept or reject.'); return res.redirect(back); }
    const results = await approvals.decideMany(ids, decision, await currentUser(req), req.body.note);
    const ok = results.filter(r => r.ok).length;
    const bad = results.filter(r => !r.ok);
    if (ok) req.flash('success', `${decision === 'accept' ? 'Accepted' : 'Rejected'} ${ok} recommendation${ok === 1 ? '' : 's'}.`);
    if (bad.length) req.flash('error', `${bad.length} not ${decision === 'accept' ? 'applied' : 'rejected'}: ${bad.slice(0, 3).map(b => `#${b.id} ${b.error}`).join(' · ')}${bad.length > 3 ? ' …' : ''}`);
    res.redirect(back);
  } catch (err) { next(err); }
});

// ─── Agents and the orchestrator (M7) ───
const orchestrator = require('../ai/orchestrator');
const runTrace = require('../ai/orchestrator/trace');
const FLOW_LABELS = Object.fromEntries(Object.entries(orchestrator.FLOWS).map(([k, f]) => [k, f.label]));

router.get('/ai/runs', authRequired, perm('ai.manage'), mod('ai'), capabilityPage('agents'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const flow = FLOW_LABELS[req.query.flow] ? req.query.flow : null;
    const status = ['running', 'done', 'partial', 'failed'].includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, intOr(req.query.page, 1));
    const result = await runTrace.list(user, { flow, status, page });
    const u = new URLSearchParams();
    if (flow) u.set('flow', flow);
    if (status) u.set('status', status);
    res.renderPage('ai/runs', {
      rows: result.rows, total: result.total, flow, status, FLOW_LABELS, stats: await runTrace.stats(),
      briefing: await runTrace.latest('fleet.review'),
      paginator: new Paginator(result.total, result.perPage, result.page),
      baseUrl: hamsUrl('/ai/runs') + (u.toString() ? '?' + u.toString() : '')
    });
  } catch (err) { next(err); }
});

router.get('/ai/runs/:id', authRequired, perm('ai.manage'), mod('ai'), capabilityPage('agents'), async (req, res, next) => {
  try {
    const run = await runTrace.get(intOr(req.params.id, 0), await currentUser(req));
    if (!run) throw new HttpError('Run not found (or outside your locations).', 404);
    res.renderPage('ai/run', { run, FLOW_LABELS });
  } catch (err) { next(err); }
});

// "Review now" on an asset page: the agents review it together; the run opens when done.
router.post('/ai/assets/:id/review', authRequired, csrfProtect, perm('ai.view'), perm('assets.view'), mod('ai'), capabilityPage('agents'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const asset = await assetService.getAsset(intOr(req.params.id, 0), user);
    if (asset === false) throw new HttpError('This asset is outside your locations.', 403);
    if (!asset) throw new HttpError('Asset not found.', 404);
    const r = await orchestrator.run('asset.review', { asset_id: asset.id }, { trigger: 'request', user });
    req.flash(r.status === 'failed' ? 'error' : 'success', `Agents reviewed ${asset.asset_tag}: ${r.summary}`);
    res.redirect(hamsUrl(await authz.can('ai.manage', user) ? `/ai/runs/${r.id}` : `/assets/${asset.id}`));
  } catch (err) { next(err); }
});

// Asset page card: the agents' last review of the asset, its findings and open recommendations.
router.get('/api/ai/assets/:id/agents', authRequired, perm('ai.view'), perm('assets.view'), mod('ai'), capability('agents'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const asset = await assetService.getAsset(intOr(req.params.id, 0), user);
    if (!asset) return res.status(asset === false ? 403 : 404).json({ error: 'Not available' });
    const last = await db.get(
      `SELECT id, flow, status, summary, started_at, context->'findings' AS findings FROM ai_runs
        WHERE target_type = 'asset' AND target_id = $1 AND status IN ('done', 'partial') ORDER BY id DESC LIMIT 1`, [asset.id]);
    const recs = await db.query(
      `SELECT id, title, needs_review FROM ai_recommendations
        WHERE status = 'pending' AND target_type = 'asset' AND target_id = $1 AND agent = 'Orchestrator' ORDER BY id DESC LIMIT 5`, [asset.id]);
    const canTrace = await authz.can('ai.manage', user);
    const { formatDateTime } = require('../core/helpers');
    res.json({
      last: last ? { id: last.id, summary: last.summary, when: formatDateTime(last.started_at), url: canTrace ? hamsUrl(`/ai/runs/${last.id}`) : null } : null,
      findings: last && Array.isArray(last.findings) ? last.findings.filter(f => f.target_id === asset.id || f.agent === 'IntakeAgent').slice(0, 6) : [],
      recommendations: recs.map(r => ({ ...r, url: hamsUrl(`/ai/approvals?q=${encodeURIComponent(asset.asset_tag)}`) }))
    });
  } catch (err) { next(err); }
});

// Fleet review on request (Settings > AI).
router.post('/ai/runs/briefing', authRequired, csrfProtect, perm('ai.manage'), mod('ai'), capabilityPage('agents'), async (req, res, next) => {
  try {
    const r = await orchestrator.run('fleet.review', {}, { trigger: 'manual', user: await currentUser(req) });
    res.redirect(hamsUrl(`/ai/runs/${r.id}`));
  } catch (err) { next(err); }
});

// ─── Register Asset: suggestions and duplicate warnings ───
router.get('/api/ai/intake/suggest', authRequired, perm('assets.create'), mod('ai'), capability('intake'), async (req, res, next) => {
  try {
    const q = req.query;
    const s = v => String(v ?? '').slice(0, 200);
    res.json(await require('../ai/intake/suggest').suggest({
      name: s(q.name), model_number: s(q.model_number), serial_number: s(q.serial_number),
      manufacturer_id: intOr(q.manufacturer_id, 0) || null, asset_model_id: intOr(q.asset_model_id, 0) || null, location_id: intOr(q.location_id, 0) || null
    }));
  } catch (err) { next(err); }
});

router.get('/api/ai/intake/duplicates', authRequired, perm('assets.create'), mod('ai'), capability('intake'), async (req, res, next) => {
  try {
    const s = v => String(v ?? '').slice(0, 200);
    const user = await currentUser(req);
    const found = await require('../ai/quality/duplicates').checkCandidate(db, {
      serial_number: s(req.query.serial_number), fams: s(req.query.fams), machine_name: s(req.query.machine_name), exclude_id: req.query.exclude_id
    });
    // Only show records the user may see; others are counted.
    const scope = await authz.locationScopeFor(user);
    let hidden = 0;
    const visible = [];
    for (const d of found) {
      const loc = (await db.get('SELECT location_id FROM assets WHERE id = $1', [d.id])) || {};
      if (scope.global || scope.location_ids.includes(loc.location_id)) visible.push({ id: d.id, asset_tag: d.asset_tag, name: d.name, serial_number: d.serial_number, status: d.status, reason: d.reason, confidence: d.confidence });
      else hidden++;
    }
    res.json({ duplicates: visible, hidden });
  } catch (err) { next(err); }
});

// ─── Asset page card ───
router.get('/api/ai/assets/:id/insights', authRequired, perm('assets.view'), mod('ai'), capability('data_quality'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const asset = await assetService.getAsset(intOr(req.params.id), user);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json(await require('../ai/quality/insights').forAsset(asset));
  } catch (err) { next(err); }
});

// ─── Questions in plain language (M6) ───
// Ctrl+K Ask mode: the answer, the chips it understood, a link to the list, confidence and why.
router.get('/api/ai/ask', authRequired, perm('assets.view'), mod('ai'), capability('nl'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 2) return res.json({ question: q, answer: '', chips: [] });
    const assistant = require('../ai/agents/assistant');
    // Through the orchestrator (a traced run) while the agents are on; directly otherwise.
    const a = await require('../ai/orchestrator').ask(q, user);
    if (a.fallback || a.low_confidence) await assistant.recordMiss(q, a, user).catch(() => {});
    res.json({ ...a, link: a.link ? hamsUrl(a.link) : null, items: (a.items || []).map(i => ({ ...i, url: hamsUrl('/assets/' + i.id) })) });
  } catch (err) { next(err); }
});

// "Not what I meant": keeps the question for the seed set (Settings > AI lists them).
router.post('/ai/ask/miss', authRequired, csrfProtect, perm('assets.view'), mod('ai'), capability('nl'), async (req, res, next) => {
  try {
    const q = String(req.body.q || '').trim().slice(0, 200);
    if (q) await require('../ai/agents/assistant').recordMiss(q, null, await currentUser(req), 'rejected');
    if (req.body.ajax === '1') return res.json({ ok: true });
    req.flash('success', 'Thanks: the question is kept so the assistant can learn it.');
    res.redirect(hamsUrl('/assets') + '?search=' + encodeURIComponent(q));
  } catch (err) { next(err); }
});

// ─── Cost forecast, refresh plan and licence compliance (M5) ───
// Dashboard: replacement need by quarter next to past spend, within the user's locations.
router.get('/api/ai/cost/forecast', authRequired, perm('assets.view'), mod('ai'), capability('cost'), async (req, res, next) => {
  try {
    res.json(await require('../ai/cost/forecast').forecast(await currentUser(req)));
  } catch (err) { next(err); }
});

// Refresh Planning: a budget in, the assets to replace first out (nothing is bought).
async function planningPage(req, res, next) {
  try {
    const user = await currentUser(req);
    const plan = require('../ai/cost/plan');
    const opts = plan.options(req.query);
    const built = await plan.build(user, opts);
    const scope = await authz.locationScopeFor(user);
    const locations = await db.query(
      `SELECT DISTINCT l.id, l.name FROM ai_predictions p JOIN assets a ON a.id = p.asset_id JOIN locations l ON l.id = a.location_id
        WHERE p.capability = 'lifecycle'${scope.global ? '' : ' AND l.id = ANY($1::int[])'} ORDER BY l.name`, scope.global ? [] : [scope.location_ids]);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) [].concat(v).forEach(x => qs.append(k, x));
    res.renderPage('ai/planning', {
      plan: built, opts, locations, money: v => require('../ai/cost/forecast').money(v, built.currency),
      canPropose: await authz.can('ai.manage', user), exportUrl: hamsUrl('/ai/planning/export') + '?' + qs.toString(), shown: 300
    });
  } catch (err) { next(err); }
}
router.get('/ai/planning', authRequired, perm('assets.view'), perm('ai.view'), mod('ai'), capabilityPage('cost'), planningPage);

router.get('/ai/planning/export', authRequired, perm('assets.view'), perm('ai.view'), mod('ai'), capabilityPage('cost'), async (req, res, next) => {
  try {
    const plan = require('../ai/cost/plan');
    const built = await plan.build(await currentUser(req), plan.options(req.query));
    await sendWorkbook(res, 'Refresh_plan_' + new Date().toISOString().slice(0, 10), [{ name: 'Refresh plan', columns: plan.EXPORT_COLUMNS, rows: plan.exportRows(built) }]);
  } catch (err) { next(err); }
});

router.post('/ai/planning/propose', authRequired, csrfProtect, perm('assets.view'), perm('ai.manage'), mod('ai'), capabilityPage('cost'), async (req, res, next) => {
  try {
    const plan = require('../ai/cost/plan');
    const opts = plan.options(req.body);
    const done = await plan.propose(await currentUser(req), opts);
    if (done.id) {
      req.flash('success', 'Plan sent to AI Approvals for sign-off. Accepting it records the decision; nothing is purchased.');
      return res.redirect(hamsUrl('/ai/approvals'));
    }
    req.flash('error', done.reason);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body)) if (k !== '_csrf') [].concat(v).forEach(x => qs.append(k, x));
    res.redirect(hamsUrl('/ai/planning') + '?' + qs.toString());
  } catch (err) { next(err); }
});

// Alerts: licence and software findings (dormant without licence data).
router.get('/api/ai/compliance', authRequired, perm('licenses.view'), mod('ai'), capability('compliance'), async (req, res, next) => {
  try {
    res.json(await require('../ai/compliance/rules').check(await currentUser(req)));
  } catch (err) { next(err); }
});

// ─── Refresh risk and unusual-asset findings (M4) ───
// The asset page card: whichever of the two capabilities is on.
router.get('/api/ai/assets/:id/risk', authRequired, perm('assets.view'), mod('ai'), async (req, res, next) => {
  try {
    const on = await flags.enabledSet();
    if (!on.has('lifecycle') && !on.has('anomaly')) return res.status(404).json({ off: true });
    const asset = await assetService.getAsset(intOr(req.params.id), await currentUser(req));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({
      lifecycle: on.has('lifecycle') ? await require('../ai/lifecycle/run').forAsset(asset.id) : null,
      anomaly: on.has('anomaly') ? await require('../ai/anomaly/run').forAsset(asset.id) : null
    });
  } catch (err) { next(err); }
});

// Dashboard: expected retirements by location and age, within the user's locations.
router.get('/api/ai/lifecycle/summary', authRequired, perm('assets.view'), mod('ai'), capability('lifecycle'), async (req, res, next) => {
  try {
    res.json(await require('../ai/lifecycle/run').summary(await currentUser(req)));
  } catch (err) { next(err); }
});

// Alerts: unusual assets not yet reviewed, within the user's locations.
router.get('/api/ai/anomalies', authRequired, perm('assets.view'), mod('ai'), capability('anomaly'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json({ ...(await require('../ai/anomaly/run').list(user)), can_review: await authz.can('ai.approve', user) });
  } catch (err) { next(err); }
});

// "Real issue" / "Expected" on a finding: a label only; no asset is changed.
router.post('/ai/anomalies/review', authRequired, csrfProtect, perm('assets.view'), perm('ai.approve'), mod('ai'), capabilityPage('anomaly'), async (req, res, next) => {
  try {
    try {
      const ids = [].concat(req.body['asset_ids[]'] || req.body.asset_ids || []);
      const done = await require('../ai/anomaly/run').review(ids, String(req.body.verdict || ''), await currentUser(req), req.body.note || null);
      req.flash('success', `${done.reviewed} finding(s) marked ${req.body.verdict === 'issue' ? '"Real issue"' : '"Expected"'}. Thank you: this measures how often the detector is right.`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/alerts') + '#ai-anomalies');
  } catch (err) { next(err); }
});

// ─── Data Health ───
router.get('/api/ai/data-health/summary', authRequired, perm('assets.view'), mod('ai'), capability('data_quality'), async (req, res, next) => {
  try {
    res.json(await require('../ai/quality/insights').summary(await currentUser(req)));
  } catch (err) { next(err); }
});

router.get('/ai/data-health', authRequired, perm('assets.view'), perm('ai.view'), mod('ai'), capabilityPage('data_quality'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const insights = require('../ai/quality/insights');
    const issue = String(req.query.issue || '');
    const page = Math.max(1, intOr(req.query.page, 1));
    const data = await insights.page(user, { issue, page });
    res.renderPage('ai/data-health', {
      ...data, issue, canRun: await authz.can('settings.manage', user),
      paginator: data.list ? new Paginator(data.list.total, data.list.perPage, page) : null,
      baseUrl: hamsUrl('/ai/data-health') + (issue ? '?issue=' + encodeURIComponent(issue) : '')
    });
  } catch (err) { next(err); }
});

// ─── Smart search (Ctrl+K) ───
// Up to 8 assets for the palette, ranked, each with how well it matches and why. Same matching
// and location scope as the Hardware list (while the index is still being built: the old search).
router.get('/api/ai/search', authRequired, perm('assets.view'), mod('assets'), mod('ai'), capability('search'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const q = String(req.query.q || '').trim().slice(0, aiSearch.MAX_QUERY);
    if (q.length < 2) return res.json({ q, hits: [], total: 0 });
    const r = await aiSearch.search(q);
    const page = await assetService.page(1, 8, r ? { search: q, search_ids: r.ids } : { search: q }, user);
    const why = aiSearch.explain(r, page.items.map(a => a.id));
    res.json({
      q, total: page.total, ready: !!r, banner: aiSearch.banner(r),
      all_url: hamsUrl('/assets') + '?search=' + encodeURIComponent(q),
      hits: page.items.map((a, i) => ({
        id: a.id, tag: a.asset_tag, name: a.name, serial: a.serial_number,
        model: a.model_name || a.model_number || null, category: a.category_name || a.category || null,
        status: a.status_label_name || a.status || null, holder: a.assigned_to_name || null,
        site: a.stock_site && !String(a.stock_site).startsWith('_') ? a.stock_site : (a.location_name || null),
        match: why[a.id] ? why[a.id].match : null,
        why: why[a.id] ? why[a.id].why : [`Name, tag or serial contains "${q}"`],
        url: hamsUrl(`/ai/search/open?id=${a.id}&r=${i + 1}&q=${encodeURIComponent(q)}`)
      }))
    });
  } catch (err) { next(err); }
});

// A Ctrl+K result was opened: keep (query, asset, rank) as a search label for measuring the
// ranking on real searches later (ai_feedback), then go to the asset (its page checks access).
router.get('/ai/search/open', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const id = intOr(req.query.id, 0);
    if (id <= 0) return res.redirect(hamsUrl('/assets'));
    if (await flags.isOn('search')) {
      const user = await currentUser(req);
      const predicted = { q: String(req.query.q || '').slice(0, aiSearch.MAX_QUERY), rank: intOr(req.query.r, 0) };
      await db.run(
        `INSERT INTO ai_feedback (capability, model_name, model_version, target_type, target_id, label, predicted, user_id)
         VALUES ('search', 'search_bm25', (SELECT version FROM ai_models WHERE name = 'search_bm25' AND status = 'active'), 'asset', $1, 'accepted', $2, $3)`,
        [id, JSON.stringify(predicted), user ? user.id : null]
      ).catch(() => {}); // never in the way of opening the asset
    }
    res.redirect(hamsUrl('/assets/' + id));
  } catch (err) { next(err); }
});

module.exports = router;
