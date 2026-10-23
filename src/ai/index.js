// Entry point of the in-house AI layer (see docs/ai/ARCHITECTURE.md).
// start() is called once by src/server.js (and by src/routes/ai.js; it is idempotent). It only
// registers event listeners, recommendation handlers and scheduler jobs; it does no database work
// at boot. While the 'ai' module and every capability switch are off (the default), nothing runs.
const scheduler = require('../services/schedulerService');
const db = require('../core/db');
const logger = require('../core/logger');
const flags = require('./flags');
const events = require('./events');
const snapshots = require('./features/snapshots');
const liveEvents = require('./features/liveEvents');

// Shown on Settings > AI (group 'ai' keeps them off the Automations page). background: "Run now"
// returns at once and the result appears on the page when done.
const JOBS = [
  {
    key: 'ai_snapshot', label: 'AI feature snapshot', group: 'ai', defaultEnabled: false,
    description: 'Records every asset\'s AI features (changes only; a full copy on the first run of each month) and the lifecycle events since the last run.',
    schedule: { type: 'daily', time: '01:30' },
    enabled: () => flags.isOn('snapshots'),
    run: async ctx => (await snapshots.run({ trigger: ctx && ctx.manual ? 'manual' : 'schedule' })).summary
  },
  {
    key: 'ai_dq_scan', label: 'Data health scan', group: 'ai', defaultEnabled: false, background: true,
    description: 'Scores every active asset\'s data, refreshes the Data Health page and proposes category fixes.',
    schedule: { type: 'daily', time: '02:00' },
    enabled: () => flags.isOn('data_quality'),
    run: async ctx => (await require('./quality/dataHealth').run({ trigger: ctx && ctx.manual ? 'manual' : 'schedule' })).summary
  },
  {
    key: 'ai_train_intake', label: 'Train intake model', group: 'ai', defaultEnabled: false, background: true,
    description: 'Retrains the category / manufacturer model on the current register and activates it if it scores at least as well.',
    schedule: { type: 'weekly', day: 0, time: '03:00' },
    enabled: async () => (await flags.isOn('intake')) || flags.isOn('data_quality'),
    run: async ctx => (await require('./intake/training').train({ trigger: ctx && ctx.manual ? 'manual' : 'schedule', user: ctx && ctx.user })).summary
  },
  {
    key: 'ai_search_index', label: 'Rebuild search index', group: 'ai', defaultEnabled: false, background: true,
    description: 'Rebuilds the smart-search index from the register and measures it on labelled queries generated from it (changes in between are picked up within 30 s).',
    schedule: { type: 'daily', time: '02:30' },
    enabled: () => flags.isOn('search'),
    run: async ctx => (await require('./search/training').rebuild({ trigger: ctx && ctx.manual ? 'manual' : 'schedule', user: ctx && ctx.user })).summary
  },
  {
    key: 'ai_lifecycle', label: 'Refresh risk scores', group: 'ai', defaultEnabled: false, background: true,
    description: 'Scores every active asset\'s chance of being retired in 6, 12 and 24 months; retrains the curves weekly (or on Run now) and keeps the new version only if it predicts held-out assets as well.',
    schedule: { type: 'daily', time: '03:30' },
    // The cost forecast and refresh plan are built from these scores too.
    enabled: async () => (await flags.isOn('lifecycle')) || flags.isOn('cost'),
    run: async ctx => (await require('./lifecycle/run').run({ trigger: ctx && ctx.manual ? 'manual' : 'schedule', user: ctx && ctx.user })).summary
  },
  {
    key: 'ai_anomaly', label: 'Find unusual assets', group: 'ai', defaultEnabled: false, background: true,
    description: 'Scores every active asset against the others of its model, its holder\'s devices and its age (Isolation Forest) and lists the unusual ones on Alerts.',
    schedule: { type: 'daily', time: '04:00' },
    enabled: () => flags.isOn('anomaly'),
    run: async ctx => (await require('./anomaly/run').run({ trigger: ctx && ctx.manual ? 'manual' : 'schedule', user: ctx && ctx.user })).summary
  },
  {
    key: 'ai_cost_forecast', label: 'Cost forecast', group: 'ai', defaultEnabled: false, background: true,
    description: 'Refreshes the replacement-cost forecast after the refresh-risk scores, and records the spend model (Holt-Winters) and its backtest when its choice changes.',
    schedule: { type: 'daily', time: '04:30' },
    enabled: () => flags.isOn('cost'),
    run: async ctx => (await require('./cost/forecast').run({ trigger: ctx && ctx.manual ? 'manual' : 'schedule', user: ctx && ctx.user })).summary
  }
];

// Run a job in the background with the scheduler's lock and status (shown on Settings > AI).
function runInBackground(key, user = null) {
  return scheduler.runNow(key, user)
    .then(r => { if (r.status === 'error') logger.error(`[AI] ${key}: ${r.error}`); return r; })
    .catch(err => { logger.error(`[AI] ${key}: ${err.message}`); return { status: 'error', error: err.message }; });
}

// After a capability is switched on: build the search index, train the intake model if none is
// active yet, then run a first data-health scan, so the features work straight away instead of
// after the next night.
async function onSwitch(user = null) {
  const on = await flags.enabledSet();
  if (on.has('search') && !require('./search/service').state.index) runInBackground('ai_search_index', user);
  const never = cap => db.get(`SELECT 1 AS x FROM ai_predictions WHERE capability = $1 LIMIT 1`, [cap]).then(r => !r, () => false);
  if ((on.has('lifecycle') || on.has('cost')) && await never('lifecycle')) {
    (async () => {
      await runInBackground('ai_lifecycle', user);
      if (on.has('cost')) await runInBackground('ai_cost_forecast', user);
    })();
  }
  if (on.has('anomaly') && await never('anomaly')) runInBackground('ai_anomaly', user);
  const needsModel = on.has('intake') || on.has('data_quality');
  if (!needsModel) return;
  const hasModel = !!(await require('./intake/suggest').activeModel());
  (async () => {
    if (!hasModel) await runInBackground('ai_train_intake', user);
    if (on.has('data_quality') && !(await require('./quality/dataHealth').latest())) await runInBackground('ai_dq_scan', user);
  })();
}

let started = false;
let importTimer = null;
function start() {
  if (started) return;
  started = true;
  for (const job of JOBS) scheduler.register(job);
  liveEvents.start();
  require('./search/service').start();
  require('./quality/fixes'); // registers the AI Approvals handlers
  require('./cost/plan'); // the refresh-plan sign-off handler
  // A data-health scan shortly after imports (after the snapshot, which runs 30 s after).
  events.on('import.applied', 'data_quality', async () => {
    clearTimeout(importTimer);
    importTimer = setTimeout(() => runInBackground('ai_dq_scan'), 90000);
    if (importTimer.unref) importTimer.unref();
  });
}

module.exports = { start, JOBS, flags, onSwitch, runInBackground };
