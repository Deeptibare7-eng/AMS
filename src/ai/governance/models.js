// What Settings > AI > Models can do with each model in the registry. Versions matter at run time
// only for the models trained once and used for a while (intake, refresh risk): those can be rolled
// back or activated by hand (which pins the version) and are checked for drift. The others are
// rebuilt from the data on every run, so their versions are a record, not something to switch to.
const registry = require('./registry');

const job = key => user => require('../index').runInBackground(key, user);

const CATALOG = {
  intake_classifier: {
    label: 'Intake classifier', capabilities: ['intake', 'data_quality'], versioned: true, drift: true,
    purpose: 'Reads the category and maker from an asset\'s name and model number (Register Asset suggestions, the data-health category check, IntakeAgent).',
    retrain: job('ai_train_intake'), retrainLabel: 'Retrains in the background on the current register',
    afterActivate: async () => require('../intake/suggest').invalidate()
  },
  lifecycle_weibull: {
    label: 'Refresh-risk curves', capabilities: ['lifecycle', 'cost'], versioned: true, drift: true,
    purpose: 'Chance of being retired in 6, 12 and 24 months (asset cards, dashboard map, cost forecast, refresh plan, LifecycleCostAgent).',
    retrain: job('ai_lifecycle'), retrainLabel: 'Retrains and re-scores every asset in the background',
    // The scores in ai_predictions come from the version that made them: re-score with the new one.
    afterActivate: async user => {
      const lifecycle = require('../lifecycle/run');
      lifecycle.invalidate();
      require('../cost/forecast').invalidate();
      lifecycle.run({ trigger: 'rescore', user, retrain: false })
        .then(() => require('../cost/forecast').invalidate())
        .catch(err => require('../../core/logger').error(`[AI] re-scoring after a version change failed: ${err.message}`));
    }
  },
  anomaly_iforest: {
    label: 'Unusual assets', capabilities: ['anomaly'], versioned: false,
    purpose: 'Isolation Forest over each model\'s peers (Alerts, asset cards, AnomalyAgent).',
    note: 'Fitted to the current fleet on every run with fixed settings; a version records the settings and how well it found corrupted copies, so there is nothing to roll back to.',
    retrain: job('ai_anomaly'), retrainLabel: 'Re-scores every asset in the background'
  },
  search_bm25: {
    label: 'Smart search index', capabilities: ['search'], versioned: false,
    purpose: 'BM25F ranking for the Hardware search and Ctrl+K.',
    note: 'Rebuilt from the register every night with fixed settings; a version records the settings and the measured ranking.',
    retrain: job('ai_search_index'), retrainLabel: 'Rebuilds the index in the background'
  },
  spend_holt_winters: {
    label: 'Spend pace', capabilities: ['cost'], versioned: false,
    purpose: 'Holt-Winters on quarterly purchase-order spend (the cost forecast card).',
    note: 'Re-chosen from the purchase orders every night; recorded for reference.',
    retrain: job('ai_cost_forecast'), retrainLabel: 'Recomputes the forecast in the background'
  },
  nl_intent: {
    label: 'Question classifier', capabilities: ['nl'], versioned: false,
    purpose: 'What kind of question a plain-language question is (Ask in Ctrl+K and on Hardware).',
    note: 'Retrained whenever its training questions change: the seed set, or questions taught below.',
    retrain: async () => require('../agents/assistant').retrain(), retrainLabel: 'Retrains now if questions were taught since',
    afterActivate: async () => require('../agents/assistant').resetModel()
  }
};

// Settings view: each model with its versions (newest first, at most 6), active version, pin and
// the action buttons that apply.
async function overview() {
  const rows = await registry.list();
  const out = [];
  for (const [name, c] of Object.entries(CATALOG)) {
    const versions = rows.filter(r => r.name === name);
    if (!versions.length) continue;
    const active = versions.find(v => v.status === 'active') || null;
    const pin = c.versioned ? await registry.pinned(name) : null;
    out.push({
      name, ...c, retrain: undefined, afterActivate: undefined, canRetrain: !!c.retrain,
      active, pinned: pin, versions: versions.slice(0, 6).map(v => ({ ...v, training: v.training ? { trigger: v.training.trigger, has_profile: !!v.training.profile } : null })),
      previous: c.versioned && active ? versions.find(v => v.version < active.version && v.activated_at) || null : null
    });
  }
  // Models in the registry that this list doesn't know (shown read-only).
  for (const name of [...new Set(rows.map(r => r.name))].filter(n => !CATALOG[n])) {
    const versions = rows.filter(r => r.name === name);
    out.push({ name, label: name, versioned: false, canRetrain: false, active: versions.find(v => v.status === 'active') || null, versions: versions.slice(0, 6), note: 'Recorded by an earlier release.' });
  }
  return out;
}

async function activate(name, version, user) {
  const c = CATALOG[name];
  if (!c || !c.versioned) throw Object.assign(new Error('Versions of this model are a record and are not switched to.'), { status: 422 });
  await registry.activate(name, version, user, { pin: true });
  if (c.afterActivate) await c.afterActivate(user);
}

async function rollback(name, user) {
  const c = CATALOG[name];
  if (!c || !c.versioned) throw Object.assign(new Error('Versions of this model are a record and are not rolled back.'), { status: 422 });
  const v = await registry.rollback(name, user);
  if (c.afterActivate) await c.afterActivate(user);
  return v;
}

async function retrain(name, user) {
  const c = CATALOG[name];
  if (!c || !c.retrain) throw Object.assign(new Error('This model can\'t be retrained from here.'), { status: 422 });
  await require('../../services/auditService').log(user ? user.id : null, 'AI_RETRAIN_REQUESTED', `Retraining ${c.label} (${name}) requested.`);
  return c.retrain(user);
}

module.exports = { CATALOG, overview, activate, rollback, retrain };
