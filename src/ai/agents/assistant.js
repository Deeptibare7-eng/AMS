// AssistantAgent: answers questions about the assets in plain language (capability 'nl').
//   question -> entities (nl/entities.js) -> intent (nl/intent.js) -> whitelisted Hardware filters
//   (nl/query.js) -> an answer from existing services, in the user's location scope, with the chips
//   it understood, a confidence and why. Answers are templated sentences (no LLM).
// It only reads. A question asking to change something (retire, assign, delete, buy, ...) is
// refused and sent to the page where a person does it; low confidence falls back to search.
const Agent = require('./agent');
const db = require('../../core/db');
const assetService = require('../../services/assetService');
const authz = require('../../services/authorizationService');
const registry = require('../governance/registry');
const flags = require('../flags');
const vocab = require('../nl/vocab');
const entities = require('../nl/entities');
const query = require('../nl/query');
const seed = require('../nl/seed');
const { IntentClassifier, words, PLACEHOLDERS, FILLER } = require('../nl/intent');

const THRESHOLDS = { act: 0.5, ask_back: 0.3 };
const NL_KEYS = ['near_site', 'near_location', 'holder', 'warranty_from', 'warranty_to', 'bought_from', 'bought_to', 'ram_min', 'ram_max', 'os', 'ai', 'dq', 'sort', 'asked'];

// Pages for "how do I ..." questions: [pattern, path, label].
const PAGES = [
  [/\bimport|upload|asset register\b/i, '/import-data', 'Import Data'],
  [/\b(register|add|create|new)\b.*\b(asset|laptop|desktop|device|CAT)\b|\bregister\b/i, '/assets/create', 'Register Asset'],
  [/\blicen[cs]e/i, '/inventory/licenses', 'Licences'],
  [/\bapprov/i, '/ai/approvals', 'AI Approvals'],
  [/\bdata health|data quality\b/i, '/ai/data-health', 'Data Health'],
  [/\bjoinee|new joiner|onboard/i, '/new-joinees', 'New Joinees'],
  [/\breport/i, '/reports', 'Reports'],
  [/\blabel|print/i, '/assets/labels', 'Labels'],
  [/\bscan|scanner|barcode/i, '/assets/scan', 'Barcode Scanner'],
  [/\bcheck ?out|assign|allocate|hand ?over/i, '/assets', 'Hardware (Assign In-Stock Asset)'],
  [/\bretire|dispose|write ?off/i, '/assets', 'Hardware: open the asset, then Edit and set its status'],
  [/\bmaintenance|repair/i, '/maintenance', 'Maintenance'],
  [/\balert/i, '/alerts', 'Alerts'],
  [/\bplanning|refresh plan|budget/i, '/ai/planning', 'Refresh Planning'],
  [/\bdirectory|users?\b|employees?\b/i, '/users', 'Enterprise Directory'],
  [/\bexcel|export/i, '/assets', 'any list: the Excel icon at the top exports what you see'],
  [/\bsettings?\b/i, '/settings/organization', 'Settings'],
  [/\bdashboard|home\b/i, '/', 'Dashboard']
];

// The classifier learns from the seed set plus the questions people taught it on Settings > AI
// (M8: a question it got wrong, with the kind it should have been). A version is identified by the
// seed version and the taught questions; it is retrained when either changes.
const INTENTS = [...new Set(seed.rows().map(r => r.intent))];
let modelCache = null;
let taughtCache = { at: 0, value: null };
const keyOf = p => p.training_key || `${p.seed_version}:0`;

async function taught() {
  if (taughtCache.value && Date.now() - taughtCache.at < 60000) return taughtCache.value;
  let rows = [];
  try {
    const list = await db.query(`SELECT predicted->>'q' AS q, actual->>'intent' AS intent FROM ai_feedback WHERE capability = 'nl' AND label = 'taught' ORDER BY id`);
    if (list.length) {
      const v = await vocab.load();
      rows = list.filter(r => INTENTS.includes(r.intent)).map(r => ({ text: entities.extract(r.q, v).masked, intent: r.intent, q: r.q }));
    }
  } catch (_) { /* no AI tables (bare test): the seed set alone */ }
  const crypto = require('crypto');
  const key = `${seed.SEED_VERSION}:${rows.length}${rows.length ? ':' + crypto.createHash('sha1').update(rows.map(r => `${r.intent}|${r.text}`).join('\n')).digest('hex').slice(0, 10) : ''}`;
  taughtCache = { at: Date.now(), value: { rows, key } };
  return taughtCache.value;
}

async function model() {
  const { rows: extra, key } = await taught();
  if (modelCache && keyOf(modelCache.params) === key) return modelCache;
  try {
    const active = await IntentClassifier.load();
    if (active && keyOf(active.params) === key) return (modelCache = active);
  } catch (_) { /* registry not reachable: train in memory */ }
  const m = new IntentClassifier().train([...seed.rows(), ...extra.map(r => ({ text: r.text, intent: r.intent }))]);
  m.params.training_key = key;
  m.params.taught = extra.length;
  try {
    const version = await registry.save(m, { metrics: m.metrics, training: { seed_version: seed.SEED_VERSION, utterances: m.metrics.utterances, taught: extra.length } });
    await registry.activate(IntentClassifier.modelName, version);
  } catch (_) { /* the AI tables may be missing in a bare test; the model still works */ }
  return (modelCache = m);
}
function resetModel() { modelCache = null; taughtCache = { at: 0, value: null }; }

// "This question was about X": stored as a training label, audited; the next question retrains.
async function teach(question, intent, user) {
  const q = String(question || '').trim().slice(0, 200);
  if (!q) throw Object.assign(new Error('Which question?'), { status: 422 });
  if (!INTENTS.includes(intent)) throw Object.assign(new Error('Pick one of the kinds of question.'), { status: 422 });
  const before = understand(q, await vocab.load(), await model());
  await db.run(
    `INSERT INTO ai_feedback (capability, model_name, model_version, target_type, label, predicted, actual, user_id)
     VALUES ('nl', 'nl_intent', (SELECT version FROM ai_models WHERE name = 'nl_intent' AND status = 'active'), 'question', 'taught', $1, $2, $3)`,
    [JSON.stringify({ q, intent: before.intent, confidence: before.confidence }), JSON.stringify({ intent }), user ? user.id : null]);
  await require('../../services/auditService').log(user ? user.id : null, 'AI_NL_TAUGHT', `Question "${q}" taught as "${intent}" (it was read as "${before.intent}").`);
  resetModel();
  return { was: before.intent, now: intent };
}

// Retrain on request: only when something new was taught (or the seed set changed).
async function retrain() {
  const cur = modelCache || await IntentClassifier.load().catch(() => null);
  resetModel();
  const { key } = await taught();
  if (cur && keyOf(cur.params) === key) return { summary: `Nothing new to learn: no question taught since v${cur.version || '?'}.` };
  const m = await model();
  return { version: m.version, summary: `Question classifier v${m.version}: ${m.metrics.utterances} training questions (${m.params.taught} taught), cross-validated macro-F1 ${(m.metrics.cv_macroF1 * 100).toFixed(1)}%.` };
}

// Words of the question nothing understood and the seed set never uses: a free-text search term
// ("lenovo thinkpad laptops" -> "thinkpad"). At most three words; filler ("still", "please") never.
const REST = new Set('still currently now only just also more than like about some every each kind type sort please kindly thanks thank hi hello hey right exactly actually really'.split(' '));
function residual(masked, known) {
  const out = words(masked).filter(w => !PLACEHOLDERS.has(w) && !known.has(w) && !FILLER.has(w) && !REST.has(w) && w.length >= 3 && /[a-z]/.test(w));
  return out.length && out.length <= 3 ? out.join(' ') : '';
}

const n = x => Math.round(Number(x) || 0).toLocaleString('en-IN');

// Free text goes through smart search when it is on, exactly as the Hardware list does it.
const resolve = f => require('../search/service').forFilters(f).then(r => r.filters);

function make(user) {
  const tools = {
    count: f => resolve(f).then(r => authz.applyLocationScope(r, user)).then(s => assetService.count(s)),
    sample: f => resolve(f).then(r => assetService.page(1, 5, r, user)).then(r => r.items.map(a => ({ id: a.id, tag: a.asset_tag, name: a.name, holder: a.assigned_to_name, status: a.status_label_name || a.status }))),
    asset: async tag => {
      const a = await db.get(`SELECT id FROM assets WHERE deleted_at IS NULL AND (upper(asset_tag) = $1 OR upper(serial_number) = $1) LIMIT 1`, [tag]);
      return a ? assetService.getAsset(a.id, user) : null;
    },
    cost: () => require('../cost/forecast').forecast(user),
    search: q => require('../search/service').search(q)
  };
  return new Agent({
    name: 'AssistantAgent',
    goal: 'Answer questions about the assets in plain language, from the register, within the asker\'s locations.',
    tools,
    input: ['question'],
    output: ['intent', 'confidence', 'chips', 'answer', 'link', 'why'],
    thresholds: THRESHOLDS,
    escalation: 'Changes (retire, assign, delete, buy, ...) are never made here: the answer points to the page where a person does them. Below the confidence to act, it shows search results and records the question so the seed set can learn it.'
  });
}

// Keeps the question-driven filters only while capability 'nl' is on, and the AI sets only while the
// capability that produces them is on.
async function gate(filters) {
  const on = await flags.enabledSet();
  const out = { ...filters };
  if (!on.has('nl')) { for (const k of NL_KEYS) out[k] = Array.isArray(out[k]) ? [] : null; return out; }
  const hasRisk = on.has('lifecycle') || on.has('cost');
  if (out.ai === 'refresh_high' && !hasRisk) out.ai = null;
  if (out.ai === 'unusual' && !on.has('anomaly')) out.ai = null;
  if (out.sort === 'risk' && !hasRisk) out.sort = null;
  if (out.dq && !on.has('data_quality')) out.dq = null;
  return out;
}

// What a question is (pure: the evaluation runs exactly this). Returns { intent, confidence, ent, guess, text }.
//   intent 'unknown': nothing recognised and the classifier unsure -> fall back to search.
function understand(q, v, clf, today = new Date()) {
  const ent = entities.extract(q, v, { today });
  const guess = clf.predict(ent.masked);
  const slotCount = Object.keys(ent.slots).length;
  let intent = guess.value;
  let confidence = guess.confidence;
  // A request to change something is unambiguous; so is a lone asset tag.
  if (ent.change) { intent = 'change'; confidence = 1; }
  else if (ent.slots.asset && intent !== 'who' && slotCount === 1) { intent = 'who'; confidence = Math.max(confidence, 0.8); }
  else if (confidence < THRESHOLDS.ask_back && slotCount && intent !== 'who') intent = 'find'; // unsure, but it names things: list them
  else if (confidence < THRESHOLDS.ask_back && !slotCount) intent = 'unknown';
  const text = ent.slots.asset ? '' : residual(ent.masked, clf.known);
  return { intent, confidence, ent, guess, text };
}

// agent: pass one in (the orchestrator does) to read its tool calls afterwards for the run's trace.
async function ask(question, user, { today = new Date(), agent = null } = {}) {
  const q = String(question || '').trim().slice(0, 200);
  agent = agent || make(user);
  const on = await flags.enabledSet();
  const v = await vocab.load();
  const clf = await model();
  const { intent, confidence, ent, guess, text } = understand(q, v, clf, today);
  const slotCount = Object.keys(ent.slots).length;
  const why = [];
  why.push(`Read as "${intent.replace('_', ' ')}" (${Math.round(confidence * 100)}% sure)${guess.ranked[1] && intent === guess.value ? `; next best "${guess.ranked[1].value.replace('_', ' ')}"` : ''}`);
  for (const s of ent.spans) why.push(`"${s.text}" → ${s.slot}`);
  for (const t of ent.typos) why.push(`"${t.said}" read as "${t.read}"`);
  const base = { question: q, intent, confidence, chips: [], answer: '', link: null, why, items: [], fallback: false };

  if (intent === 'change') {
    const page = ent.slots.asset ? await agent.use('asset', ent.slots.asset) : null;
    return { ...base, answer: `I can only find and explain things; I don't ${ent.change} anything. ${page ? `Open ${page.asset_tag} and make the change there` : 'Make the change on the asset\'s page'} (or accept a suggestion in AI Approvals), so the usual checks and the audit log apply.`, link: page ? `/assets/${page.id}` : '/assets', escalated: true };
  }
  if (intent === 'navigate' && confidence >= THRESHOLDS.ask_back) {
    const hit = PAGES.find(([re]) => re.test(q) || re.test(ent.masked));
    if (/what can you do|help/i.test(q) || !hit) {
      return { ...base, answer: 'Ask me about the assets, for example: "laptops in Pune with warranty expiring next month", "how many desktops are in stock at Mindspace", "which laptops are due for refresh", "who has HAMS-900101", "assets with no FAMS barcode". I show what I understood as filters you can change.', link: null };
    }
    return { ...base, answer: `That is done on ${hit[2]}.`, link: hit[1] };
  }
  if (intent === 'who' && ent.slots.asset) {
    const a = await agent.use('asset', ent.slots.asset);
    if (!a) return { ...base, answer: `No asset ${ent.slots.asset} in your locations.`, link: `/assets?search=${encodeURIComponent(ent.slots.asset)}` };
    const where = a.stock_site && !String(a.stock_site).startsWith('_') ? ` at ${a.stock_site}` : a.location_name ? ` (${a.location_name})` : '';
    return { ...base, answer: `${a.asset_tag} (${a.name}) is ${a.assigned_to_name ? `assigned to ${a.assigned_to_name}` : `not assigned: ${a.status_label_name || a.status}${where}`}.`, link: `/assets/${a.id}`, items: [{ id: a.id, tag: a.asset_tag, name: a.name }] };
  }
  if (intent === 'cost') {
    if (!on.has('cost')) return { ...base, answer: 'The cost forecast is switched off (Settings > AI > Cost forecast & refresh plan).', link: null };
    const f = await agent.use('cost', null);
    if (!f.ready) return { ...base, answer: 'There are no refresh-risk scores yet, so there is no cost forecast. They are computed tonight, or with Run now on Settings > AI.', link: '/ai/planning' };
    const money = require('../cost/forecast').money;
    const cats = (ent.slots.category || []).map(c => c.name);
    let units = f.need.next12.units, cost = f.need.next12.cost;
    if (cats.length) { units = 0; cost = 0; for (const qq of f.need.quarters.slice(0, 4)) for (const c of cats) { const b = qq.by[c]; if (b) { units += b.units; cost += b.cost; } } }
    return { ...base, answer: `Replacing the ${cats.length ? cats.join(' and ').toLowerCase() + 's' : 'assets'} expected to be retired in the next 12 months: about ${n(units)}, ≈ ${money(cost, f.currency)}${f.pace && !cats.length ? `. Past spending ran at ≈ ${money(f.pace.yearly, f.currency)} a year` : ''}. Plan it within a budget on Refresh Planning.`, link: '/ai/planning' };
  }
  if ((intent === 'unknown' || confidence < THRESHOLDS.ask_back) && !slotCount) {
    return fallback(base, q, agent);
  }
  if (intent === 'refresh' && !(on.has('lifecycle') || on.has('cost'))) why.push('Refresh risk is off, so the oldest matching assets are shown instead');
  if (intent === 'unusual' && !on.has('anomaly')) why.push('Unusual assets is off, so this is a plain list');
  if (intent === 'data_issues' && !on.has('data_quality')) why.push('Data health is off, so issues can\'t be filtered on');
  const useIntent = intent === 'refresh' && !(on.has('lifecycle') || on.has('cost')) ? 'find' : intent === 'unusual' && !on.has('anomaly') ? 'find' : intent;
  const slots = { ...ent.slots };
  if (intent === 'refresh' && useIntent === 'find') slots.sort = 'oldest';
  if (slots.issue && !on.has('data_quality')) delete slots.issue;
  let built = query.build(slots, useIntent, v, { residual: text });
  let filters = await gate(paramsToFilters(built.params));
  let total = await agent.use('count', filters);
  // A leftover word that matches nothing would only empty the answer: drop it and say so.
  if (!total && text && slotCount) {
    const without = query.build(slots, useIntent, v);
    const f2 = await gate(paramsToFilters(without.params));
    const t2 = await agent.use('count', f2);
    if (t2) { why.push(`Ignored "${text}": no asset matches it`); built = without; filters = f2; total = t2; }
  }
  const items = total ? await agent.use('sample', filters) : [];
  const link = query.url(built.params, q);
  const what = describe(slots, useIntent, total);
  return {
    ...base, chips: built.chips, link, items, total,
    answer: intent === 'count' ? `There ${total === 1 ? 'is' : 'are'} ${n(total)} ${what}.` : total ? `${n(total)} ${what}${items.length ? `, for example ${items.slice(0, 3).map(a => a.tag).join(', ')}` : ''}.` : `No ${what.replace(/^assets?/, 'asset')} found${built.chips.length ? '; remove a filter to widen it' : ''}.`,
    low_confidence: confidence < THRESHOLDS.act
  };
}

async function fallback(base, q, agent) {
  const r = await agent.use('search', q).catch(() => null);
  return { ...base, fallback: true, answer: r && r.ids.length ? `I'm not sure what you mean, so here is a search for "${q}" instead (${n(r.ids.length)} matches).` : `I didn't understand that. Try something like "laptops in Pune with warranty expiring next month".`, link: `/assets?search=${encodeURIComponent(q)}` };
}

// "laptops in Pune with warranty ending next month" (for the answer sentence).
function describe(slots, intent, total) {
  const cats = (slots.category || []).map(c => c.name.toLowerCase());
  let noun = cats.length ? cats.map(c => (total === 1 ? c : c.endsWith('s') ? c : c + 's')).join(' and ') : (total === 1 ? 'asset' : 'assets');
  if (slots.maker) noun = slots.maker.map(m => m.name).join('/') + ' ' + noun;
  const bits = [];
  if (slots.status) bits.push(slots.status.text.toLowerCase());
  if (slots.place) bits.push('in ' + slots.place.map(p => p.said).join(' or '));
  if (slots.holder) bits.push('assigned to ' + slots.holder.name);
  if (slots.model) bits.push('of model ' + slots.model.map(m => m.name).join(' or '));
  if (slots.warranty) bits.push(slots.warranty.text.charAt(0).toLowerCase() + slots.warranty.text.slice(1));
  if (slots.bought) bits.push(slots.bought.text.toLowerCase());
  if (slots.ram) bits.push(slots.ram.text);
  if (slots.os) bits.push('on ' + slots.os.text);
  if (intent === 'refresh') bits.push('at high refresh risk');
  if (intent === 'unusual') bits.push('flagged as unusual');
  if (slots.issue) bits.push('with that data issue');
  // State and place read as one phrase: "laptops in stock (not assigned) in mindspace, bought before 2020".
  const lead = bits.splice(0, (slots.status ? 1 : 0) + (slots.place ? 1 : 0)).join(' ');
  return [noun + (lead ? ' ' + lead : ''), ...bits].join(', ');
}

// Query-string pairs -> the filter object the Hardware list builds (same keys and checks).
function paramsToFilters(params) {
  const f = { search: '', category_id: [], status_label_id: [], location_id: [], manufacturer_id: [], model: [], site: [], near_site: [], near_location: [] };
  for (const [k, val] of params) {
    if (Array.isArray(f[k])) f[k].push(val); else f[k] = val;
  }
  return f;
}

// Chips for the Hardware banner from the URL itself (so they follow manual changes), each with the
// link that removes it.
async function chipsFromQuery(qs, filters) {
  const v = await vocab.load();
  const chips = [];
  const without = keys => { const u = new URLSearchParams(qs); for (const k of keys) u.delete(k); u.delete('page'); return '/assets?' + u.toString(); };
  const add = (label, keys) => chips.push({ label, keys, remove: without(keys) });
  const nameOf = (list, id) => (list.find(x => String(x.id) === String(id)) || {}).name || id;
  if (filters.category_id.length) add(`Category: ${filters.category_id.map(id => nameOf(v.categories, id)).join(' or ')}`, ['category_id']);
  if (filters.manufacturer_id.length) add(`Maker: ${filters.manufacturer_id.map(id => nameOf(v.makers, id)).join(' or ')}`, ['manufacturer_id']);
  if (filters.model.length) add(`Model: ${filters.model.join(' or ')}`, ['model']);
  if (filters.near_site.length || filters.near_location.length) {
    const parts = [...filters.near_site, ...filters.near_location.map(id => v.locations.get(Number(id)) || id)];
    add(`Place: ${parts.slice(0, 4).join(', ')}${parts.length > 4 ? ' …' : ''}`, ['near_site', 'near_location']);
  }
  if (filters.label_type === 'deployable' && filters.assigned === '0') add('In stock (not assigned)', ['label_type', 'assigned']);
  else {
    if (filters.assigned === '1') add('Assigned / in use', ['assigned']);
    if (filters.label_type === 'archived') add('Retired', ['label_type']);
    if (filters.label_type === 'undeployable') add('In repair / broken', ['label_type']);
  }
  if (filters.site.includes('_returned')) add('Returned to client (Machine Name)', ['site']);
  if (filters.holder) {
    const u = await db.get('SELECT name FROM users WHERE id = $1', [Number(filters.holder)]);
    add(`Assigned to ${u ? u.name : '#' + filters.holder}`, ['holder']);
  }
  if (filters.warranty_from || filters.warranty_to) add(`Warranty ends ${filters.warranty_from ? 'from ' + filters.warranty_from : ''}${filters.warranty_from && filters.warranty_to ? ' ' : ''}${filters.warranty_to ? 'until ' + filters.warranty_to : ''}`, ['warranty_from', 'warranty_to']);
  if (filters.bought_from || filters.bought_to) add(`Bought ${filters.bought_from ? 'from ' + filters.bought_from : ''}${filters.bought_from && filters.bought_to ? ' ' : ''}${filters.bought_to ? 'until ' + filters.bought_to : ''}`, ['bought_from', 'bought_to']);
  if (filters.ram_min || filters.ram_max) add(`RAM ${filters.ram_min ? '≥ ' + filters.ram_min : ''}${filters.ram_min && filters.ram_max ? ', ' : ''}${filters.ram_max ? '≤ ' + filters.ram_max : ''} GB`, ['ram_min', 'ram_max']);
  if (filters.os) add(`OS: ${{ windows11: 'Windows 11', windows10: 'Windows 10', windows_legacy: 'Windows 8 or older', eol: 'no longer supported', macos: 'macOS', linux: 'Linux' }[filters.os]}`, ['os']);
  if (filters.ai === 'refresh_high') add('Refresh risk: high', ['ai']);
  if (filters.ai === 'unusual') add('Flagged as unusual', ['ai']);
  if (filters.dq) { const r = require('../quality/rules').BY_CODE.get(filters.dq); add(`Data issue: ${r ? r.label : filters.dq}`, ['dq']); }
  if (filters.sort) add(query.SORT_TEXT[filters.sort], ['sort']);
  if (filters.search) add(`Text: "${filters.search}"`, ['search']);
  return chips;
}

// Where a question typed in the Hardware box (Ask mode) goes. With the capability off it is a plain search.
async function redirectFor(question, user) {
  const q = String(question || '').trim().slice(0, 200);
  if (!q) return '/assets';
  if (!(await flags.isOn('nl'))) return '/assets?search=' + encodeURIComponent(q);
  const a = await require('../orchestrator').ask(q, user); // a traced run while the agents are on
  if (a.fallback || a.low_confidence) await recordMiss(q, a, user).catch(() => {});
  if (a.link && a.link.startsWith('/assets?') && !a.link.includes('asked=')) return a.link + '&asked=' + encodeURIComponent(q);
  return a.link || '/assets?search=' + encodeURIComponent(q) + '&asked=' + encodeURIComponent(q);
}

// Records a question the assistant couldn't answer well (or "not what I meant"), so it can join the
// seed set (Settings > AI lists them).
async function recordMiss(question, answer, user, label = 'ignored') {
  await db.run(
    `INSERT INTO ai_feedback (capability, model_name, model_version, target_type, label, predicted, user_id)
     VALUES ('nl', 'nl_intent', (SELECT version FROM ai_models WHERE name = 'nl_intent' AND status = 'active'), 'question', $1, $2, $3)`,
    [label, JSON.stringify({ q: String(question).slice(0, 200), intent: answer ? answer.intent : null, confidence: answer ? answer.confidence : null }), user ? user.id : null]);
}

// Missed questions, each with what it was taught as (if it was).
async function misses(limit = 20) {
  return db.query(
    `SELECT f.predicted, f.label, f.created_at,
            (SELECT t.actual->>'intent' FROM ai_feedback t WHERE t.capability = 'nl' AND t.label = 'taught' AND t.predicted->>'q' = f.predicted->>'q' ORDER BY t.id DESC LIMIT 1) AS taught
       FROM ai_feedback f WHERE f.capability = 'nl' AND f.label <> 'taught' ORDER BY f.id DESC LIMIT $1`, [limit]);
}

module.exports = { ask, understand, gate, redirectFor, chipsFromQuery, recordMiss, misses, model, resetModel, teach, retrain, INTENTS, make, THRESHOLDS, NL_KEYS, describe, residual, paramsToFilters };
