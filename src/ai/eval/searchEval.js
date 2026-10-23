// Smart search evaluation on the real register (read-only).
//
// There is no search log to learn from yet, so the labelled query set is generated from the register
// itself, with a fixed seed: for sampled assets, the queries people type to find them (the serial, the
// tag, the host name, the FAMS barcode, the holder's CTID with the category), the same with a typing
// mistake, and set queries ("Latitude 5420 Powai", "BLR OptiPlex 7010", "lappy RaviK7") whose
// relevant assets are known from the columns. Each query is ranked by
//   - the old search: name, tag or serial contains the text, newest first (what the box does today);
//   - smart search: the BM25F index.
// Reported per kind: MRR@10 (1 / rank of the first relevant asset, 0 beyond 10), share with a relevant
// asset in the top 10, precision@10 (relevant share of the top 10, out of at most 10 relevant) and share
// with no result at all. Plus the time to rank, and the full Hardware list query path.
const db = require('../../core/db');
const docs = require('../search/docs');
const assetService = require('../../services/assetService');
const { SearchIndex, evaluateRanking } = require('../search/bm25');

// Small seeded generator (mulberry32), so the query set is the same every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One typing mistake: swap two neighbours, drop, double or replace a character (not the first).
function typo(s, rand) {
  const chars = [...s];
  const i = 1 + Math.floor(rand() * (chars.length - 2));
  const op = Math.floor(rand() * 4);
  if (op === 0 && i + 1 < chars.length && chars[i] !== chars[i + 1]) [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  else if (op === 1) chars.splice(i, 1);
  else if (op === 2) chars.splice(i, 0, chars[i]);
  else {
    const pool = /\d/.test(chars[i]) ? '0123456789' : 'abcdefghijklmnopqrstuvwxyz';
    let c = chars[i];
    while (c.toLowerCase() === chars[i].toLowerCase()) c = pool[Math.floor(rand() * pool.length)];
    chars[i] = c;
  }
  const out = chars.join('');
  return out.toLowerCase() === s.toLowerCase() ? null : out;
}

const PLACEHOLDER = /^(na|n\/a|nil|none|null|pending|tbd|0|-+|client provided|evident)$/i;
const SITE_CODE = { Bangalore: 'BLR', Mindspace: 'MS', Powai: 'L&T', Hyderabad: 'HYD', 'Pune Qubix': 'QBX', USA: 'US', Gurugram: 'GGN' };

async function loadRows(q) {
  return q.query(
    `SELECT a.id, a.name, a.asset_tag, a.serial_number, EXTRACT(EPOCH FROM a.created_at)::float8 AS created,
            a.custom_fields_data->>'FAMS No. / Barcode' AS fams, u.name AS holder, ac.name AS category,
            am.name AS model, a.stock_site, l.name AS location
       FROM assets a LEFT JOIN users u ON u.id = a.assigned_to LEFT JOIN asset_categories ac ON ac.id = a.category_id
       LEFT JOIN asset_models am ON am.id = a.asset_model_id LEFT JOIN locations l ON l.id = a.location_id
      WHERE a.deleted_at IS NULL`);
}

// The labelled queries: [{ kind, q, relevant: [ids] }], about `per` of each kind.
function generate(rows, { per = 100, seed = 7 } = {}) {
  const rand = rng(seed);
  const pick = (list, n) => {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, n);
  };
  const count = key => { const m = new Map(); for (const r of rows) if (r[key]) m.set(String(r[key]).toLowerCase(), (m.get(String(r[key]).toLowerCase()) || 0) + 1); return m; };
  const serials = count('serial_number'), tags = count('asset_tag'), names = count('name'), fams = count('fams');
  const unique = (m, v) => v && m.get(String(v).toLowerCase()) === 1;
  const out = [];
  const add = (kind, q, relevant) => { if (q && relevant.length) out.push({ kind, q, relevant }); };

  const withSerial = rows.filter(r => r.serial_number && String(r.serial_number).length >= 6 && unique(serials, r.serial_number));
  for (const r of pick(withSerial, per)) add('serial', r.serial_number, [r.id]);
  for (const r of pick(withSerial, per)) add('serial with a typo', typo(r.serial_number, rand), [r.id]);
  for (const r of pick(rows.filter(r => r.asset_tag && unique(tags, r.asset_tag)), per)) add('asset tag', r.asset_tag, [r.id]);
  // Host names: one word with a digit or a dash, not a model name such as "Dell Latitude 5420".
  const hosts = rows.filter(r => r.name && /^[A-Za-z0-9-]{6,}$/.test(r.name) && /[\d-]/.test(r.name) && unique(names, r.name));
  for (const r of pick(hosts, per)) add('host name', r.name, [r.id]);
  for (const r of pick(hosts.filter(r => r.name.length >= 8), per)) add('host name with a typo', typo(r.name, rand), [r.id]);
  for (const r of pick(rows.filter(r => r.fams && !PLACEHOLDER.test(String(r.fams).trim()) && unique(fams, r.fams)), per)) add('FAMS barcode', r.fams, [r.id]);

  // Holder + category: "RaviK7 laptop" -> that person's laptops.
  const byHolder = new Map();
  for (const r of rows) if (r.holder && r.category) { const k = r.holder + '\u0001' + r.category; if (!byHolder.has(k)) byHolder.set(k, []); byHolder.get(k).push(r.id); }
  const holderKeys = [...byHolder.keys()].filter(k => /[A-Za-z]/.test(k.split('\u0001')[0]));
  for (const k of pick(holderKeys, per)) { const [h, c] = k.split('\u0001'); add('CTID + category', `${h} ${c.toLowerCase()}`, byHolder.get(k)); }
  for (const k of pick(holderKeys.filter(k => k.endsWith('\u0001Laptop')), per)) add('synonym: "lappy" + CTID', `lappy ${k.split('\u0001')[0]}`, byHolder.get(k));

  // Model + site: "Latitude 5420 Powai" -> that model at that site (Machine Name site or Asset Location).
  const bySite = new Map();
  for (const r of rows) {
    if (!r.model) continue;
    const sites = new Set();
    if (r.stock_site && !r.stock_site.startsWith('_')) sites.add(r.stock_site);
    for (const s of Object.keys(SITE_CODE)) if (r.location && r.location.includes(s)) sites.add(s);
    for (const s of sites) { const k = r.model + '\u0001' + s; if (!bySite.has(k)) bySite.set(k, []); bySite.get(k).push(r.id); }
  }
  const siteKeys = [...bySite.keys()].filter(k => bySite.get(k).length >= 3 && /[A-Za-z]{4,}/.test(k.split('\u0001')[0]));
  for (const k of pick(siteKeys, per)) { const [m, s] = k.split('\u0001'); add('model + site', `${m} ${s}`, bySite.get(k)); }
  for (const k of pick(siteKeys.filter(k => SITE_CODE[k.split('\u0001')[1]]), per)) { const [m, s] = k.split('\u0001'); add('synonym: site code + model', `${SITE_CODE[s]} ${m}`, bySite.get(k)); }
  // Model with a typo in its longest word: "Lattitude 5420" -> every asset of that model.
  const byModel = new Map();
  for (const r of rows) if (r.model) { if (!byModel.has(r.model)) byModel.set(r.model, []); byModel.get(r.model).push(r.id); }
  for (const m of pick([...byModel.keys()].filter(m => byModel.get(m).length >= 3 && /[A-Za-z]{6,}/.test(m)), per)) {
    const word = m.split(/[^A-Za-z]+/).sort((a, b) => b.length - a.length)[0];
    const bad = typo(word, rand);
    if (bad) add('model with a typo', m.replace(word, bad), byModel.get(m));
  }
  return out;
}

// The old search, exactly: name, tag or serial contains the text (any case), newest first.
function oldSearch(rows) {
  const sorted = rows.slice().sort((a, b) => b.created - a.created);
  const text = sorted.map(r => [r.name, r.asset_tag, r.serial_number].map(v => String(v || '').toLowerCase()).join('\u0001'));
  return q => {
    const t = String(q).trim().toLowerCase();
    const ids = [];
    for (let i = 0; i < sorted.length; i++) if (text[i].includes(t)) ids.push(sorted[i].id);
    return ids;
  };
}

const pctl = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

// opts.index: rank with this index (the live one); otherwise one is built here from the same read.
async function run({ per = 100, seed = 7, index = null, dbTiming = true } = {}) {
  const t0 = Date.now();
  const { rows, all } = await db.tx(async t => {
    await t.run('SET TRANSACTION READ ONLY');
    return { rows: await loadRows(t), all: index ? null : await docs.loadAll(t) };
  });
  let buildMs = 0;
  if (!index) { const b = Date.now(); index = new SearchIndex().train(all.docs); buildMs = Date.now() - b; }
  const queries = generate(rows, { per, seed });
  const old = oldSearch(rows);
  const times = [];
  const smartRank = q => { const s = process.hrtime.bigint(); const ids = index.rank(q).ids; times.push(Number(process.hrtime.bigint() - s) / 1e6); return ids; };
  const kinds = [...new Set(queries.map(x => x.kind))];
  const byKind = kinds.map(kind => {
    const qs = queries.filter(x => x.kind === kind);
    return { kind, n: qs.length, old: evaluateRanking(qs, old), smart: evaluateRanking(qs, smartRank) };
  });
  const overall = { old: evaluateRanking(queries, old), smart: evaluateRanking(queries, q => index.rank(q).ids) };
  const out = {
    assets: rows.length, queries: queries.length, build_ms: buildMs, byKind, overall,
    rank_ms: { p50: pctl(times, 0.5), p95: pctl(times, 0.95), max: Math.max(0, ...times) }, ms: 0
  };
  // The Hardware list's database part with the ranked ids: count + first page of 15.
  if (dbTiming) {
    const list = [];
    for (const x of queries.filter((_, i) => i % 5 === 0)) {
      const ids = index.rank(x.q).ids;
      const s = Date.now();
      const f = { search: x.q, search_ids: ids };
      await assetService.count(f);
      await assetService.fetch(15, 0, f);
      list.push(Date.now() - s);
    }
    out.list_ms = { p50: pctl(list, 0.5), p95: pctl(list, 0.95), max: Math.max(0, ...list), n: list.length };
  }
  out.ms = Date.now() - t0;
  return out;
}

// Flat numbers for the model registry.
function metricsOf(r) {
  return {
    mrr10: r.overall.smart.mrr10, hit10: r.overall.smart.hit10, old_search_mrr10: r.overall.old.mrr10,
    zero_results: r.overall.smart.zero_results, p95_ms: r.rank_ms.p95
  };
}

function format(r) {
  const p = x => (x * 100).toFixed(1).padStart(5) + '%';
  const lines = [
    `Smart search on ${r.assets} assets: ${r.queries} labelled queries generated from the register (fixed seed).`,
    r.build_ms ? `Index built in ${(r.build_ms / 1000).toFixed(1)} s.` : 'Ranked with the live index.',
    '',
    `${'Query kind'.padEnd(30)} ${'n'.padStart(4)}   ${'MRR@10 old → smart'.padEnd(20)} ${'top-10 hit old → smart'.padEnd(24)} ${'P@10 old → smart'.padEnd(20)} no result old → smart`
  ];
  for (const k of [...r.byKind, { kind: 'All', n: r.queries, ...r.overall }]) {
    lines.push(`${k.kind.padEnd(30)} ${String(k.n).padStart(4)}   ${p(k.old.mrr10)} → ${p(k.smart.mrr10)}      ${p(k.old.hit10)} → ${p(k.smart.hit10)}        ${p(k.old.p10)} → ${p(k.smart.p10)}      ${p(k.old.zero_results)} → ${p(k.smart.zero_results)}`);
  }
  lines.push('', `Time to rank (in memory): median ${r.rank_ms.p50.toFixed(1)} ms, p95 ${r.rank_ms.p95.toFixed(1)} ms, max ${r.rank_ms.max.toFixed(1)} ms.`);
  if (r.list_ms) lines.push(`Hardware list database part (count + page of 15, ${r.list_ms.n} queries): median ${r.list_ms.p50} ms, p95 ${r.list_ms.p95} ms, max ${r.list_ms.max} ms.`);
  return lines.join('\n');
}

module.exports = { run, generate, oldSearch, typo, metricsOf, format };
