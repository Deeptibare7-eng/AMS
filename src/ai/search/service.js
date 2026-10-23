// Smart search in the web process (capability 'search'): keeps the index in memory and fresh, and
// answers the Hardware search box and Ctrl+K.
//
// Life of the index:
//   - built in a worker thread (about 2 s for ~27,000 assets) when the switch is turned on, on the
//     first search after a restart, nightly (job ai_search_index) and shortly after an import;
//   - kept fresh between builds: before answering, at most every 30 s (or at once after an asset
//     was changed in the app), assets changed since the last look are re-indexed;
//   - until it is ready, searches use the old name / tag / serial match, so the page never waits.
const db = require('../../core/db');
const logger = require('../../core/logger');
const flags = require('../flags');
const events = require('../events');
const worker = require('../worker');
const docs = require('./docs');
const { SearchIndex } = require('./bm25');

const CHECK_EVERY_MS = 30000;
const MAX_OVERLAY = 3000;      // changed assets kept on top of the build before a rebuild
const MAX_QUERY = 200;

const state = { index: null, mark: null, building: null, refreshing: null, builtAt: null, buildMs: null, checkedAt: 0, dirty: false, error: null, trigger: null };

function summary() {
  const ix = state.index;
  return ix ? {
    ready: true, assets: ix.liveCount, words: ix.parts.terms.length, changed_since_build: ix.extra.length,
    built_at: state.builtAt, build_ms: state.buildMs, trigger: state.trigger, version: ix.params.version
  } : { ready: false, building: !!state.building, error: state.error };
}

// (Re)build in a worker; concurrent calls share one build.
function build({ trigger = 'manual' } = {}) {
  if (state.building) return state.building;
  state.building = (async () => {
    const t0 = Date.now();
    try {
      const { mark, parts } = await worker.run('buildSearchIndex', {}, { timeoutMs: 5 * 60 * 1000 });
      state.index = new SearchIndex().load(parts);
      Object.assign(state, { mark, builtAt: new Date(), buildMs: Date.now() - t0, checkedAt: Date.now(), dirty: false, error: null, trigger });
      logger.info(`[AI] search index built: ${parts.N} assets, ${parts.terms.length} words, ${state.buildMs} ms (${trigger})`);
      return summary();
    } catch (err) {
      state.error = err.message;
      logger.error(`[AI] search index build failed: ${err.message}`);
      throw err;
    } finally {
      state.building = null;
    }
  })();
  return state.building;
}

// Re-index what changed since the last look (cheap; skipped within 30 s unless an asset event came).
async function refresh() {
  const ix = state.index;
  if (!ix || state.building) return;
  if (!state.dirty && Date.now() - state.checkedAt < CHECK_EVERY_MS) return;
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    state.dirty = false;
    state.checkedAt = Date.now();
    if (!state.mark) { build({ trigger: 'changes' }).catch(() => {}); return; }
    const { mark, rows } = await docs.loadChanged(db, state.mark, MAX_OVERLAY + 1);
    if (rows.length > MAX_OVERLAY || ix.extra.length + rows.length > MAX_OVERLAY) {
      build({ trigger: 'many changes' }).catch(() => {});
      return;
    }
    for (const r of rows) { if (r.deleted) ix.remove(r.doc.id); else ix.upsert(r.doc); }
    if (mark) state.mark = mark;
  })().catch(err => logger.error(`[AI] search refresh failed: ${err.message}`))
    .finally(() => { state.refreshing = null; });
  return state.refreshing;
}

// Start a build in the background when the switch is on and there is no index yet.
function warm() {
  if (state.index || state.building) return;
  flags.isOn('search').then(on => { if (on) build({ trigger: 'warm-up' }).catch(() => {}); }).catch(() => {});
}

const clean = text => String(text || '').trim().slice(0, MAX_QUERY);

// Ranked matches for a search text, or null (switch off, no text, index not ready yet: the
// caller then uses the old search).
async function search(text) {
  const q = clean(text);
  if (!q || !(await flags.isOn('search'))) return null;
  if (!state.index) { warm(); return null; }
  await refresh();
  return state.index.rank(q);
}

// For the Hardware list (and its Excel export): the filters to use, plus what to show.
// Returns { filters, smart } where smart is null when the old search applies.
async function forFilters(filters) {
  const r = filters && filters.search ? await search(filters.search) : null;
  if (!r) return { filters, smart: null };
  return { filters: { ...filters, search_ids: r.ids }, smart: r };
}

// Why each listed asset matched: { id: { match, why: [text] } }.
function explain(result, ids) {
  const out = {};
  if (!result || !state.index) return out;
  for (const id of ids) {
    const e = state.index.explainDoc(result.parsed, id);
    if (e) out[id] = { match: e.match, why: e.factors.map(f => f.text) };
  }
  return out;
}

// The page banner: what the search understood.
function banner(result) {
  if (!result) return null;
  const lines = [];
  for (const n of result.notes) {
    if (n.kind === 'typo') lines.push(`"${n.word}" read as ${n.as.join(' / ')}`);
    if (n.kind === 'synonym') lines.push(`"${n.word}" also finds ${n.as.join(', ')}`);
    if (n.kind === 'dropped') lines.push(`no asset has "${n.word}", so it was left out`);
  }
  return {
    lines,
    partial: result.partial ? `No asset matches all ${result.words} words; showing those that match ${result.matched}.` : null
  };
}

function reset() { Object.assign(state, { index: null, mark: null, building: null, refreshing: null, builtAt: null, buildMs: null, checkedAt: 0, dirty: false, error: null, trigger: null }); }

let started = false;
let importTimer = null;
function start() {
  if (started) return;
  started = true;
  // An asset changed in the app: look for changes before the next search.
  events.on(['asset.created', 'asset.updated', 'asset.deleted', 'asset.status_changed', 'asset.checked_out', 'asset.checked_in'],
    'search', async () => { state.dirty = true; });
  // An import changes many assets: rebuild shortly after the last one.
  events.on('import.applied', 'search', async () => {
    clearTimeout(importTimer);
    importTimer = setTimeout(() => build({ trigger: 'import' }).catch(() => {}), 15000);
    if (importTimer.unref) importTimer.unref();
  });
}

module.exports = { build, refresh, warm, search, forFilters, explain, banner, summary, start, reset, state, MAX_QUERY };
