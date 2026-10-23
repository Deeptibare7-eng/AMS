// Smart search index: BM25F ranking over the fields of every asset, with typo tolerance, synonyms
// and prefix completion. Our own code (no search library, no LLM).
//
// Ranking. For a query word q and an asset d, each field f contributes its term count, normalised
// by the field's length (b) and weighted by how telling the field is (w):
//     tf~(t, d) = sum_f  w_f * tf_f(t, d) / (1 - b_f + b_f * len_f(d) / avglen_f)
//     score(q, d) = idf(t) * tf~ * (k1 + 1) / (k1 + tf~),   idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
// An asset's score is the sum over the query words of the best-scoring form of each word:
//     exact word 1.0, synonym 0.9 ("lappy" -> laptop), completion 0.5-0.9 ("lati" -> latitude, more
//     for a longer typed part), typo 0.75 / 0.55 for 1 / 2 edits ("lattitude" -> latitude; 0.6 for a
//     1-edit identifier, where siblings from one order differ by a character).
// Matching. Every query word must match (each word narrows, as people expect). If no asset matches
// them all, the assets matching the most words are shown, and the page says so. A word no asset
// has is left out with a note. On top, an asset whose name, tag or serial contains the typed text
// literally always matches: that is what the search box did before, so nothing it found is lost.
//
// Storage. Postings are flat typed arrays (CSR), built in a worker thread and copied to the web
// process (~10 MB for ~27,000 assets). Assets changed after the build are re-indexed into a small
// overlay; the old version is marked dead. A full rebuild folds the overlay back in.
const BaseModel = require('../models/baseModel');
const analyzer = require('./analyzer');
const synonyms = require('./synonyms');
const { osaWithin } = require('../models/text/similarity');
const { fnv1a } = require('../models/text/minhash');

// Bit order = field order (a posting's mask says which fields hold the word).
const FIELDS = [
  { key: 'tag', label: 'asset tag', weight: 3, b: 0, kind: 'id' },
  { key: 'serial', label: 'serial number', weight: 3, b: 0, kind: 'id' },
  { key: 'fams', label: 'FAMS barcode', weight: 2.5, b: 0, kind: 'id' },
  { key: 'name', label: 'name', weight: 2.5, b: 0.3, kind: 'text' },
  { key: 'holder', label: 'assigned to', weight: 2.5, b: 0, kind: 'text' },
  { key: 'model', label: 'model', weight: 2, b: 0.3, kind: 'text' },
  { key: 'category', label: 'category', weight: 2, b: 0, kind: 'text' },
  { key: 'maker', label: 'manufacturer', weight: 1.5, b: 0, kind: 'text' },
  { key: 'status', label: 'status', weight: 1.5, b: 0.3, kind: 'text' },
  { key: 'place', label: 'location', weight: 1.5, b: 0.3, kind: 'text' },
  { key: 'machine', label: 'Machine Name', weight: 1, b: 0.5, kind: 'text' },
  { key: 'spec', label: 'specs', weight: 1, b: 0.5, kind: 'text' },
  { key: 'supplier', label: 'supplier', weight: 0.6, b: 0.5, kind: 'text' },
  { key: 'project', label: 'client or project', weight: 0.6, b: 0.5, kind: 'text' },
  { key: 'notes', label: 'notes or order numbers', weight: 0.4, b: 0.75, kind: 'text' }
];
const LITERAL_FIELDS = ['name', 'asset tag', 'serial number'];

const DEFAULTS = {
  k1: 1.2,
  synonymWeight: 0.9,
  prefixMin: 3, prefixMax: 50,
  typoWeights: [1, 0.75, 0.55], idTypoWeight: 0.6, typoMax: 8,
  literalBonus: 1
};
const VERSION = 'bm25f-1';

// ─── Build (runs in a worker: plain data in, plain data + typed arrays out) ───

function padGrams(term) {
  const p = ` ${term} `;
  const out = new Set();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return [...out];
}

// Term counts and length of each field of one asset: [{ tf: Map term -> count, len }] in FIELDS order.
// display (optional Map term -> spelling): records how the register writes a word ("FLJ0J10",
// "RaviK") the first time it differs from the lower-case term only by case.
function fieldStats(doc, display = null) {
  return FIELDS.map(f => {
    const tf = new Map();
    let len = 0;
    for (const [t, w, raw] of analyzer.fieldTerms(doc.fields[f.key], f.kind)) {
      tf.set(t, (tf.get(t) || 0) + w);
      len += w;
      if (display && raw !== t && !display.has(t) && raw.toLowerCase() === t) display.set(t, raw);
    }
    return { tf, len };
  });
}

// One asset's weighted term frequencies: Map term -> [tf~, mask of the fields holding it].
function weigh(stats, avg) {
  const out = new Map();
  FIELDS.forEach((f, i) => {
    const { tf, len } = stats[i];
    if (!tf.size) return;
    const norm = 1 - f.b + f.b * (len / (avg[i] || 1));
    for (const [t, c] of tf) {
      const cur = out.get(t) || [0, 0];
      cur[0] += f.weight * c / norm;
      cur[1] |= 1 << i;
      out.set(t, cur);
    }
  });
  return out;
}

const docTerms = (doc, avg, display = null) => weigh(fieldStats(doc, display), avg);

// Content fingerprint, so re-reading an unchanged asset doesn't re-index it.
const docHash = doc => fnv1a(JSON.stringify(doc.fields) + '\u0001' + (doc.literal || '')) | 0;

// docs: [{ id, created, fields: { tag, serial, ... }, literal }] -> parts for SearchIndex.load.
function buildParts(docs, params = {}) {
  const N = docs.length;
  const display = new Map();
  const stats = docs.map(d => fieldStats(d, display));
  const avg = FIELDS.map((_, i) => (N ? stats.reduce((s, st) => s + st[i].len, 0) / N : 1) || 1);
  const postings = new Map(); // term -> [docs[], tf[], mask[]]
  for (let d = 0; d < N; d++) {
    const terms = weigh(stats[d], avg);
    stats[d] = null;
    for (const [t, [tf, mask]] of terms) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = [[], [], []]));
      p[0].push(d); p[1].push(tf); p[2].push(mask);
    }
  }
  const terms = [...postings.keys()].sort();
  const offsets = new Int32Array(terms.length + 1);
  let total = 0;
  terms.forEach((t, i) => { offsets[i] = total; total += postings.get(t)[0].length; });
  offsets[terms.length] = total;
  const pdoc = new Int32Array(total), ptf = new Float32Array(total), pmask = new Uint16Array(total);
  terms.forEach((t, i) => {
    const [ds, tfs, ms] = postings.get(t);
    pdoc.set(ds, offsets[i]); ptf.set(tfs, offsets[i]); pmask.set(ms, offsets[i]);
  });
  // Trigram index over the vocabulary, for typo candidates.
  const gramTerms = new Map();
  terms.forEach((t, i) => {
    if (t.length < 3 || /^\d+$/.test(t)) return;
    for (const g of padGrams(t)) { let a = gramTerms.get(g); if (!a) gramTerms.set(g, (a = [])); a.push(i); }
  });
  const gramKeys = [...gramTerms.keys()];
  const gramOffsets = new Int32Array(gramKeys.length + 1);
  let gtotal = 0;
  gramKeys.forEach((g, i) => { gramOffsets[i] = gtotal; gtotal += gramTerms.get(g).length; });
  gramOffsets[gramKeys.length] = gtotal;
  const gramPost = new Int32Array(gtotal);
  gramKeys.forEach((g, i) => gramPost.set(gramTerms.get(g), gramOffsets[i]));

  return {
    params: { ...DEFAULTS, ...params, version: VERSION },
    N, avg, terms, offsets, pdoc, ptf, pmask,
    ids: Int32Array.from(docs.map(d => d.id)),
    created: Float64Array.from(docs.map(d => Number(d.created) || 0)),
    literal: docs.map(d => d.literal || ''),
    hash: Int32Array.from(docs.map(docHash)),
    display: [...display],
    gramKeys, gramOffsets, gramPost
  };
}

// ─── The model ───

class SearchIndex extends BaseModel {
  static modelName = 'search_bm25';
  static FIELDS = FIELDS;

  constructor(params = null) {
    super(params || { ...DEFAULTS, version: VERSION });
    this.parts = null;
  }

  get ready() { return !!this.parts; }

  // BaseModel contract: train = build the index from asset documents (in this thread).
  train(docs) { return this.load(buildParts(docs, this.params)); }

  // Adopt parts built by buildParts (e.g. in a worker).
  load(parts) {
    this.parts = parts;
    this.params = parts.params;
    const p = parts;
    this.N = p.N;
    this.termIndex = new Map(p.terms.map((t, i) => [t, i]));
    this.gramIndex = new Map(p.gramKeys.map((g, i) => [g, i]));
    this.display = new Map(p.display || []);
    this.alive = new Uint8Array(p.N).fill(1);
    this.deadCount = 0;
    this.byAsset = new Map();
    for (let d = 0; d < p.N; d++) this.byAsset.set(p.ids[d], d);
    // Overlay for assets changed since the build.
    this.extra = [];            // [{ id, created, literal, hash, alive }]
    this.extraAlive = 0;
    this.extraPost = new Map(); // term -> [[docNo, tf, mask], ...]
    this.scratch(p.N + 256);
    this.termCount = new Uint8Array(p.terms.length);
    return this;
  }

  scratch(size) {
    this.score = new Float64Array(size);
    this.cover = new Uint8Array(size);
    this.best = new Float32Array(size);
    this.hit = new Uint8Array(size);
  }

  get docCount() { return this.N + this.extra.length; }
  get liveCount() { return this.N - this.deadCount + this.extraAlive; }

  isAlive(d) { return d < this.N ? this.alive[d] === 1 : this.extra[d - this.N].alive; }
  assetId(d) { return d < this.N ? this.parts.ids[d] : this.extra[d - this.N].id; }
  createdOf(d) { return d < this.N ? this.parts.created[d] : this.extra[d - this.N].created; }
  literalOf(d) { return d < this.N ? this.parts.literal[d] : this.extra[d - this.N].literal; }

  kill(assetId) {
    const d = this.byAsset.get(assetId);
    if (d === undefined) return;
    if (d < this.N) { if (this.alive[d]) { this.alive[d] = 0; this.deadCount++; } } else if (this.extra[d - this.N].alive) { this.extra[d - this.N].alive = false; this.extraAlive--; }
    this.byAsset.delete(assetId);
  }

  // Re-index one asset (new or changed); false when it is already indexed as it is.
  // Field-length averages stay those of the build.
  upsert(doc) {
    const hash = docHash(doc);
    const cur = this.byAsset.get(doc.id);
    if (cur !== undefined && (cur < this.N ? this.parts.hash[cur] : this.extra[cur - this.N].hash) === hash) return false;
    this.kill(doc.id);
    const d = this.docCount;
    this.extra.push({ id: doc.id, created: Number(doc.created) || 0, literal: doc.literal || '', hash, alive: true });
    this.extraAlive++;
    for (const [t, [tf, mask]] of docTerms(doc, this.parts.avg, this.display)) {
      let a = this.extraPost.get(t);
      if (!a) this.extraPost.set(t, (a = []));
      a.push([d, tf, mask]);
    }
    this.byAsset.set(doc.id, d);
    if (this.docCount > this.score.length) this.scratch(this.docCount + 256);
    return true;
  }

  remove(assetId) { this.kill(assetId); }

  // ─── Query ───

  df(ref) {
    const p = this.parts;
    let n = ref.main >= 0 ? p.offsets[ref.main + 1] - p.offsets[ref.main] : 0;
    if (ref.extra) n += ref.extra.length;
    return n;
  }

  ref(term) {
    const main = this.termIndex.has(term) ? this.termIndex.get(term) : -1;
    const extra = this.extraPost.get(term) || null;
    return main >= 0 || extra ? { main, extra } : null;
  }

  // Forms of one query word that occur in the register: [{ term, weight, kind, ref }].
  expand(tok, isLast) {
    const P = this.params;
    const term = tok.term;
    const out = new Map();
    const put = (t, weight, kind, extra = {}) => {
      const ref = this.ref(t);
      if (!ref) return;
      const cur = out.get(t);
      if (!cur || cur.weight < weight) out.set(t, { term: t, weight, kind, ref, ...extra });
    };
    const exact = this.ref(term);
    if (exact) put(term, 1, 'exact');
    let synonymHit = false;
    for (const s of synonyms.of(term)) { if (this.ref(s)) { synonymHit = true; put(s, P.synonymWeight, 'synonym'); } }
    let prefixes = 0;
    if (term.length >= P.prefixMin && (isLast || !exact)) {
      for (const t of this.prefixTerms(term)) { prefixes++; put(t, 0.5 + 0.4 * (term.length / t.length), 'prefix'); }
    }
    const alphaRare = exact && /^[a-z]{5,}$/.test(term) && this.df(exact) <= 2;
    if ((!exact && !synonymHit && (!prefixes || term.length >= 6)) || alphaRare) {
      for (const c of this.typoTerms(term)) {
        if (alphaRare && this.df(this.ref(c.term)) < 20) continue;
        const w = c.d === 1 && /\d/.test(term) ? P.idTypoWeight : P.typoWeights[c.d];
        put(c.term, w, 'typo', { distance: c.d });
      }
    }
    return [...out.values()];
  }

  // Vocabulary words starting with `prefix` (not equal to it), the most common first.
  prefixTerms(prefix) {
    const terms = this.parts.terms;
    let lo = 0, hi = terms.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (terms[mid] < prefix) lo = mid + 1; else hi = mid; }
    const found = [];
    for (let i = lo; i < terms.length && terms[i].startsWith(prefix); i++) {
      if (terms[i] !== prefix) found.push([terms[i], this.parts.offsets[i + 1] - this.parts.offsets[i]]);
    }
    for (const [t, a] of this.extraPost) if (t !== prefix && t.startsWith(prefix) && !this.termIndex.has(t)) found.push([t, a.length]);
    found.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
    return found.slice(0, this.params.prefixMax).map(f => f[0]);
  }

  // Vocabulary words within 1 edit (4-7 characters) or 2 edits (8+) of `term`. Candidates share
  // enough letter triples (an edit changes at most 4 of them: a swap of two neighbours touches 4);
  // then the edit distance decides.
  typoTerms(term) {
    if (term.length < 4 || /^\d+$/.test(term)) return [];
    const maxD = term.length >= 8 && !/\d/.test(term) ? 2 : 1;
    const p = this.parts;
    const grams = padGrams(term);
    const need = Math.max(maxD, grams.length - 4 * maxD);
    const cnt = this.termCount;
    const touched = [];
    for (const g of grams) {
      const gi = this.gramIndex.get(g);
      if (gi === undefined) continue;
      for (let k = p.gramOffsets[gi]; k < p.gramOffsets[gi + 1]; k++) {
        const t = p.gramPost[k];
        if (cnt[t] === 0) touched.push(t);
        if (cnt[t] < 255) cnt[t]++;
      }
    }
    const out = [];
    for (const t of touched) {
      if (cnt[t] >= need) {
        const s = p.terms[t];
        const d = osaWithin(term, s, maxD);
        if (d > 0 && d <= maxD) out.push({ term: s, d, df: p.offsets[t + 1] - p.offsets[t] });
      }
      cnt[t] = 0;
    }
    for (const [s, a] of this.extraPost) {
      if (this.termIndex.has(s)) continue;
      const d = osaWithin(term, s, maxD);
      if (d > 0 && d <= maxD) out.push({ term: s, d, df: a.length });
    }
    out.sort((a, b) => a.d - b.d || b.df - a.df);
    return out.slice(0, this.params.typoMax);
  }

  // Calls fn(docNo, tf, mask) for every live posting of an expansion.
  eachPosting(ref, fn) {
    const p = this.parts;
    if (ref.main >= 0) {
      for (let k = p.offsets[ref.main]; k < p.offsets[ref.main + 1]; k++) {
        const d = p.pdoc[k];
        if (this.alive[d]) fn(d, p.ptf[k], p.pmask[k]);
      }
    }
    if (ref.extra) for (const [d, tf, mask] of ref.extra) if (this.extra[d - this.N].alive) fn(d, tf, mask);
  }

  // The posting of one asset for an expansion, or null.
  postingOf(ref, d) {
    const p = this.parts;
    if (ref.main >= 0 && d < this.N) {
      let lo = p.offsets[ref.main], hi = p.offsets[ref.main + 1] - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (p.pdoc[mid] === d) return [p.ptf[mid], p.pmask[mid]];
        if (p.pdoc[mid] < d) lo = mid + 1; else hi = mid - 1;
      }
    }
    if (ref.extra) for (const [x, tf, mask] of ref.extra) if (x === d) return [tf, mask];
    return null;
  }

  idf(ref) { return this.idfOf(this.df(ref)); }

  idfOf(df) {
    const N = Math.max(1, this.liveCount);
    df = Math.max(1, df);
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }

  // Parses the query once: its words with their expansions, and the words nothing matches.
  parse(q) {
    const tokens = analyzer.queryTokens(q);
    const words = [];
    const dropped = [];
    tokens.forEach((tok, i) => {
      const exps = this.expand(tok, i === tokens.length - 1);
      if (exps.length) words.push({ tok, exps }); else dropped.push(tok.raw);
    });
    return { q, words, dropped, literal: analyzer.literal(q) };
  }

  // Ranked matches: { ids (asset ids, best first), words, matched, partial, dropped, notes, literalHits }.
  rank(q) {
    const parsed = typeof q === 'string' ? this.parse(q) : q;
    const { words, literal } = parsed;
    const K1 = this.params.k1;
    const D = this.docCount;
    const { score, cover, best, hit } = this;
    const touched = [];
    const touch = d => { if (!hit[d]) { hit[d] = 1; touched.push(d); } };
    const bestTouched = [];
    for (const w of words) {
      // A word and its synonyms count as one word for rarity, so a rare spelling ("blr") doesn't
      // outrank the word itself ("bangalore").
      const same = w.exps.filter(e => e.kind === 'exact' || e.kind === 'synonym');
      const sharedIdf = same.length ? this.idfOf(Math.max(...same.map(e => this.df(e.ref)))) : 0;
      for (const e of w.exps) {
        const idf = e.kind === 'exact' || e.kind === 'synonym' ? sharedIdf : this.idf(e.ref);
        e.hits = 0;
        this.eachPosting(e.ref, (d, tf) => {
          const s = e.weight * idf * tf * (K1 + 1) / (K1 + tf);
          if (s > best[d]) { if (best[d] === 0) bestTouched.push(d); best[d] = s; }
          e.hits++;
        });
      }
      for (const d of bestTouched) { touch(d); score[d] += best[d]; cover[d]++; best[d] = 0; }
      bestTouched.length = 0;
    }
    const n = words.length;
    // The old search: name, tag or serial contains the typed text.
    let literalHits = 0;
    if (literal.length >= 2) {
      for (let d = 0; d < D; d++) {
        if (!this.isAlive(d) || !this.literalOf(d).includes(literal)) continue;
        touch(d);
        score[d] += this.params.literalBonus;
        if (cover[d] < n) cover[d] = n;
        literalHits++;
        hit[d] = 2; // a literal hit (still in touched)
      }
    }
    let need = n;
    let partial = false;
    let docs = touched.filter(d => cover[d] >= need && (need > 0 || hit[d] === 2));
    if (!docs.length && n > 1) {
      let maxC = 0;
      for (const d of touched) if (cover[d] > maxC) maxC = cover[d];
      if (maxC > 0) { need = maxC; partial = true; docs = touched.filter(d => cover[d] === maxC); }
    }
    docs.sort((a, b) => score[b] - score[a] || this.createdOf(b) - this.createdOf(a));
    const ids = docs.map(d => this.assetId(d));
    for (const d of touched) { score[d] = 0; cover[d] = 0; hit[d] = 0; }
    return {
      ids, words: n, matched: need, partial, dropped: parsed.dropped, literalHits,
      notes: this.notes(parsed), parsed
    };
  }

  // A word as people know it: a code's usual form ("L&T"), else as the register writes it.
  label(term) { return synonyms.DISPLAY[term] || this.display.get(term) || term; }

  // What the search understood, for the page: typos read as, synonyms used, words left out.
  notes(parsed) {
    const out = [];
    for (const w of parsed.words) {
      const used = w.exps.filter(e => e.hits > 0 && e.kind !== 'exact' && e.kind !== 'prefix');
      const typos = used.filter(e => e.kind === 'typo').slice(0, 3).map(e => this.label(e.term));
      const syns = used.filter(e => e.kind === 'synonym').slice(0, 3).map(e => this.label(e.term));
      if (typos.length && !w.exps.some(e => e.kind === 'exact' && e.hits > 0)) out.push({ kind: 'typo', word: w.tok.raw, as: typos });
      if (syns.length) out.push({ kind: 'synonym', word: w.tok.raw, as: syns });
    }
    for (const word of parsed.dropped) out.push({ kind: 'dropped', word });
    return out;
  }

  // Why one asset matched: { match 0..1, factors: [{ factor, text, weight }] }.
  explainDoc(parsed, assetId) {
    const d = this.byAsset.get(assetId);
    if (d === undefined) return null;
    const factors = [];
    let sum = 0;
    const lit = parsed.literal.length >= 2 && this.literalOf(d).includes(parsed.literal);
    for (const w of parsed.words) {
      let bestE = null, bestS = 0, bestMask = 0;
      for (const e of w.exps) {
        const post = this.postingOf(e.ref, d);
        if (!post) continue;
        const s = e.weight * post[0];
        if (s > bestS) { bestS = s; bestE = e; bestMask = post[1]; }
      }
      if (!bestE) { sum += lit ? 0.8 : 0; continue; }
      sum += bestE.weight;
      factors.push({ factor: w.tok.raw, weight: bestE.weight, text: this.why(w.tok.raw, bestE, bestMask) });
    }
    if (lit) {
      const which = this.literalOf(d).split('\u0001').findIndex(s => s.includes(parsed.literal));
      factors.unshift({ factor: parsed.literal, weight: 1, text: `${capital(LITERAL_FIELDS[which] || 'name')} contains "${parsed.q.trim()}"` });
    }
    const n = parsed.words.length;
    const match = n ? Math.min(1, sum / n) : (lit ? 1 : 0);
    return { match, factors };
  }

  why(raw, e, mask) {
    const where = FIELDS.filter((_, i) => mask & (1 << i)).map(f => f.label);
    const fields = where.length > 2 ? `${where.slice(0, 2).join(', ')} and more` : where.join(' and ');
    const term = this.label(e.term);
    switch (e.kind) {
      case 'exact': return `"${raw}" in ${fields}`;
      case 'synonym': return `"${raw}" means ${term} (${fields})`;
      case 'prefix': return `"${raw}" completed to ${term} (${fields})`;
      case 'typo': return `"${raw}" read as ${term}, ${e.distance === 1 ? '1 letter' : '2 letters'} apart (${fields})`;
      default: return `"${raw}" in ${fields}`;
    }
  }

  // ─── BaseModel contract ───

  // The top results and how well the best one matches every word.
  predict(q, k = 10) {
    const r = this.rank(q);
    const top = r.ids.slice(0, k);
    const e = top.length ? this.explainDoc(r.parsed, top[0]) : null;
    return { value: top, confidence: e ? e.match : 0, partial: r.partial, total: r.ids.length };
  }

  explain(q, assetId) {
    const e = this.explainDoc(this.parse(q), assetId);
    return e ? e.factors : [];
  }

  // queries: [{ q, relevant: [asset ids] }] -> MRR@10, share with a relevant hit in the top 10,
  // precision@10, share with no result at all.
  evaluate(queries, rankFn = q => this.rank(q).ids) {
    return evaluateRanking(queries, rankFn);
  }

  // Only the settings are saved: the postings are rebuilt from the register in a few seconds.
  toJSON() { return { ...this.params, fields: FIELDS.map(f => ({ key: f.key, weight: f.weight, b: f.b })) }; }
  static fromJSON(params, opts = {}) {
    const { fields, ...rest } = params || {};
    return super.fromJSON(rest, opts);
  }
}

function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function evaluateRanking(queries, rankFn) {
  let rr = 0, hit10 = 0, p10 = 0, zero = 0;
  for (const qq of queries) {
    const rel = new Set(qq.relevant);
    const ids = rankFn(qq.q);
    if (!ids.length) zero++;
    const top = ids.slice(0, 10);
    const first = top.findIndex(id => rel.has(id));
    if (first >= 0) { rr += 1 / (first + 1); hit10++; }
    p10 += top.filter(id => rel.has(id)).length / Math.min(10, rel.size || 1);
  }
  const n = queries.length || 1;
  return { mrr10: rr / n, hit10: hit10 / n, p10: p10 / n, zero_results: zero / n, queries: queries.length };
}

module.exports = { SearchIndex, buildParts, evaluateRanking, FIELDS, VERSION };
