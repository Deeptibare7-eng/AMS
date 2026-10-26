// AI feature flags. A capability is on only when all three hold:
//   1. the AI tables exist (database/ai.sql has been applied),
//   2. the 'ai' module is active (the master switch: Settings > AI or Settings > Feature Modules),
//   3. its own switch is on: settings group 'ai', key = capability key, value '1'.
// Everything defaults to off, so without any setting rows the app behaves exactly as before.
const db = require('../core/db');
const settings = require('../services/settingsService');
const moduleService = require('../services/moduleService');
const audit = require('../services/auditService');
const { HttpError } = require('../core/helpers');

// Capabilities that exist in this release (later milestones add theirs here).
const CAPABILITIES = [
  {
    key: 'snapshots', label: 'Feature snapshots & history', icon: 'history',
    description: 'Each night, records the AI features of every asset (only what changed, plus a full copy on the first run of each month) '
      + 'and the lifecycle events seen since the last run, such as when an asset was retired or reassigned. Also runs after each import. '
      + 'Later AI features learn from this history. Reads existing data only; writes only to the ai_* tables.'
  },
  {
    key: 'data_quality', label: 'Data health', icon: 'shield-check',
    description: 'Each night and after imports, scores every active asset\'s data 0-100 with the reasons: stock records that don\'t add up, '
      + 'missing or shared FAMS barcodes, shared host names, costs far from similar assets, categories that look wrong, duplicate catalog '
      + 'spellings. Adds a Data Health page, a card on asset pages and the dashboard, and proposes category fixes in AI Approvals.'
  },
  {
    key: 'intake', label: 'Intake suggestions', icon: 'wand-sparkles',
    description: 'On Register Asset: suggests the category, manufacturer and catalog model from the name and model number, the usual warranty, '
      + 'supplier and cost for that model, and warns about possible duplicates (same serial written differently, same FAMS barcode or host name). '
      + 'Nothing is filled in unless you click it.'
  },
  {
    key: 'search', label: 'Smart search', icon: 'search',
    description: 'The Hardware search box and Ctrl+K find assets by any detail (tag, serial, host name, FAMS barcode, CTID, model, location, '
      + 'specs, client), forgive typing mistakes ("lattitude", a swapped serial character), understand synonyms ("lappy" = laptop, '
      + '"BLR" = Bangalore) and list the best matches first, each with why it matched. Off: the box matches name, tag and serial as before.'
  },
  {
    key: 'lifecycle', label: 'Refresh risk', icon: 'hourglass',
    description: 'Estimates for every active laptop, desktop and thin client the chance of being retired in the next 6, 12 and 24 months, '
      + 'learnt from which assets of each age have been retired so far (a Weibull curve per category), with the reasons and how sure it is. '
      + 'Adds a Refresh risk card on asset pages and a dashboard map of expected retirements by location and age. Changes nothing.'
  },
  {
    key: 'anomaly', label: 'Unusual assets', icon: 'radar',
    description: 'Each night, finds active assets that look unusual next to the other assets of their model (cost, RAM, processor, purchase date, '
      + 'warranty), held by someone with many devices, or very old and still active (Isolation Forest), each with the reasons. '
      + 'Adds a section on Alerts where you mark a finding as a real issue or expected; nothing is changed.'
  },
  {
    key: 'cost', label: 'Cost forecast & refresh plan', icon: 'piggy-bank',
    description: 'Forecasts what replacing the assets expected to be retired will cost, quarter by quarter, next to the pace of past purchase-order '
      + 'spend (dashboard), and adds Refresh Planning: enter a budget and it picks which assets to replace first (0/1 knapsack), with the reasons, '
      + 'an Excel export and sign-off in AI Approvals. It never buys anything. Uses the refresh-risk scores (they are computed even if Refresh risk is off).'
  },
  {
    key: 'compliance', label: 'Licence compliance', icon: 'scale',
    description: 'Checks licences and software subscriptions against 10 rules: more seats in use than bought, expired but still assigned, '
      + 'renewals due, seats held by leavers or retired assets, unused seats, duplicate keys. Shown on Alerts. Dormant until licence or software '
      + 'records exist (none today); it starts on its own when they do. Changes nothing.'
  },
  {
    key: 'nl', label: 'Questions in plain language', icon: 'message-circle-question',
    description: 'An "Ask" mode in Ctrl+K and the Hardware search: "laptops in Pune with warranty expiring next month", "how many desktops are '
      + 'in stock at Mindspace", "who has HAMS-900101", "which laptops are due for refresh". It shows what it understood as filters you can '
      + 'remove, answers with a count and examples, and never builds SQL from your words or changes anything. Uses refresh risk, unusual '
      + 'assets and data health when those are on.'
  },
  {
    key: 'agents', label: 'Agents working together', icon: 'workflow', requires: 'ai_runs',
    description: 'When an asset is added or changed, a repair is logged, a licence changes or an import finishes, the AI agents review it '
      + 'together (intake, data health, refresh risk, unusual assets, maintenance, compliance). Where they disagree, the more trusted and more '
      + 'confident view wins, and close calls go to AI Approvals marked for a closer look. A daily briefing sums up the fleet. Every run is '
      + 'traced on AI Runs. Agents only use the capabilities that are on, and they never change anything themselves.'
  }
];
const BY_KEY = new Map(CAPABILITIES.map(c => [c.key, c]));

// Capabilities that need a later migration (e.g. agents: ai_m7.sql). Cached for 30 s like installed().
const tableCache = new Map();
async function hasTable(name) {
  const hit = tableCache.get(name);
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  const row = await db.get(`SELECT to_regclass($1) IS NOT NULL AS ok`, ['public.' + name]);
  tableCache.set(name, { at: Date.now(), value: !!(row && row.ok) });
  return tableCache.get(name).value;
}
const requirementMet = cap => (cap.requires ? hasTable(cap.requires) : true);

// Cached for 30 s so a migrate or rollback is noticed without a restart.
let installedCache = { at: 0, value: false };
async function installed() {
  if (Date.now() - installedCache.at < 30000) return installedCache.value;
  const row = await db.get(`SELECT to_regclass('public.ai_recommendations') IS NOT NULL AND to_regclass('public.ai_feature_snapshots') IS NOT NULL AS ok`);
  installedCache = { at: Date.now(), value: !!(row && row.ok) };
  return installedCache.value;
}
function resetCache() { installedCache = { at: 0, value: false }; tableCache.clear(); }

async function aiModule() {
  return db.get(`SELECT id, name, label, is_active FROM modules WHERE name = 'ai'`);
}

async function masterOn() {
  return (await installed()) && moduleService.isEnabled('ai');
}

async function switchOn(key) {
  return (await settings.get('ai', key, '0')) === '1';
}

async function isOn(key) {
  if (!BY_KEY.has(key)) return false;
  return (await masterOn()) && (await requirementMet(BY_KEY.get(key))) && switchOn(key);
}

async function setFlag(key, on, user) {
  const cap = BY_KEY.get(key);
  if (!cap) throw new HttpError('Unknown AI capability.', 422);
  if (on && !(await requirementMet(cap))) {
    throw new HttpError(`"${cap.label}" needs a database update first: node bin/hams-cli.js migrate (it only adds new ai_* tables).`, 422);
  }
  await settings.set('ai', key, on ? '1' : '0', user ? user.id : null);
  await audit.log(user ? user.id : null, 'AI_FLAG_CHANGED', `AI capability "${cap.label}" switched ${on ? 'on' : 'off'}.`);
}

async function setMaster(on, user) {
  const mod = await aiModule();
  if (!mod) throw new HttpError('The AI tables are not installed. Run: node bin/hams-cli.js migrate', 422);
  if (!!mod.is_active !== !!on) {
    await moduleService.toggleModule(mod.id);
    await audit.log(user ? user.id : null, 'AI_MASTER_SWITCHED', `AI module switched ${on ? 'on' : 'off'}.`);
  }
}

// The capabilities that are really on (for views: one lookup per page, all cached).
async function enabledSet() {
  const out = new Set();
  try {
    if (!(await masterOn())) return out;
    for (const c of CAPABILITIES) if ((await switchOn(c.key)) && (await requirementMet(c))) out.add(c.key);
  } catch (_) { /* AI tables missing or DB hiccup: behave as all off */ }
  return out;
}

// For Settings > AI: each capability with its own switch, whether it is really on, and whether it
// still needs a database update.
async function overview() {
  const master = await masterOn();
  const out = [];
  for (const c of CAPABILITIES) {
    const sw = await switchOn(c.key);
    const ready = await requirementMet(c);
    out.push({ ...c, switch: sw, needs_migration: !ready, effective: master && sw && ready });
  }
  return out;
}

module.exports = { CAPABILITIES, installed, resetCache, aiModule, masterOn, isOn, enabledSet, setFlag, setMaster, overview, hasTable };
