// Nightly job ai_search_index: rebuilds the smart-search index, measures it on labelled queries
// generated from the register (read-only, see src/ai/eval/searchEval.js) and records the settings
// and the numbers in the model registry as a new version when the settings changed (or none is active).
const db = require('../../core/db');
const registry = require('../governance/registry');
const service = require('./service');
const searchEval = require('../eval/searchEval');
const { SearchIndex } = require('./bm25');

// JSON with keys sorted (JSONB returns keys in its own order).
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}`;
  return JSON.stringify(v);
}

async function rebuild({ trigger = 'schedule', user = null } = {}) {
  const t0 = Date.now();
  await service.build({ trigger });
  const index = service.state.index;
  const r = await searchEval.run({ index, per: 50, dbTiming: false });
  const metrics = searchEval.metricsOf(r);
  const active = await db.get(`SELECT version, params FROM ai_models WHERE name = $1 AND status = 'active'`, [SearchIndex.modelName]);
  const same = !!active && canon(active.params) === canon(index.toJSON());
  let version = active ? active.version : null;
  if (!same) {
    version = await registry.save(index, {
      metrics, userId: user ? user.id : null,
      training: { trigger, assets: index.liveCount, words: index.parts.terms.length, queries: r.queries, build_ms: service.state.buildMs, ms: Date.now() - t0 }
    });
    await registry.activate(SearchIndex.modelName, version, user);
  }
  const pct = x => (x * 100).toFixed(1) + '%';
  return {
    version, metrics,
    summary: `Search index (${trigger}): ${index.liveCount} assets, ${index.parts.terms.length} words in ${(service.state.buildMs / 1000).toFixed(1)} s; `
      + `MRR@10 ${pct(metrics.mrr10)} on ${r.queries} generated queries (old search ${pct(metrics.old_search_mrr10)}), p95 ${metrics.p95_ms.toFixed(1)} ms`
      + (same ? `; settings unchanged (v${version}).` : `; recorded as v${version}.`)
  };
}

module.exports = { rebuild };
