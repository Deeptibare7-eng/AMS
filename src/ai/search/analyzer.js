// Text analysis for smart search. The index and the query go through the same rules, so
// "Latitude5420", "latitude 5420" and "LATITUDE-5420" meet. Plain string work, no library.
//
//   word        "Latitude"      -> "latitude"         (lower case, accents removed)
//   plural      "laptops"       -> "laptop"           (letters only, 4+ characters)
//   parts       "RaviK7"       -> "ravik7" + "ravi" + "k7"   (case changes inside a CTID / host name)
//               "E5450"         -> "e5450" + "5450"   (a short letter prefix on a model number)
//   compact     "CM7QX512-001"  -> "cm7qx512" + "001" + "cm7qx512001"   (identifier fields only)
//   units       "16 GB", "16g"  -> "16gb"
//   "L&T"                       -> "lnt"              (a Machine Name site code)

// Words that carry no meaning in an asset search ("laptops at powai", "show me all dell").
const STOP = new Set(('a an the and or of in on at to for with by from is are be was were it its '
  + 'show me all any list find get give which where what who whose has have having my our please').split(' '));
// Generic nouns that every asset is; dropped from queries only.
const QUERY_ONLY_STOP = new Set(['asset', 'device', 'machine', 'item', 'hardware']);

// Raw words, case kept (for the CTID / host name parts), accents removed.
function rawWords(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\bL\s*&\s*T\b/gi, 'LnT')
    .split(/[^A-Za-z0-9]+/).filter(Boolean);
}

// "laptops" -> "laptop"; leaves "glass", "status", "analysis", "macos" and anything with digits alone.
function stem(w) {
  if (w.length >= 4 && w.endsWith('s') && /^[a-z]+$/.test(w) && !/(ss|us|is|os)$/.test(w)) return w.slice(0, -1);
  return w;
}

// Single letters carry no meaning ("T" in "NoraQuillT"); single digits do ("Windows 7").
const keep = w => w.length > 1 || /\d/.test(w);

// Parts with their spelling: [[lower, as written], ...].
function partsAsWritten(raw) {
  const out = [];
  const camel = raw.split(/(?<=[a-z])(?=[A-Z])/);
  if (camel.length > 1) for (const p of camel) out.push([p.toLowerCase(), p]);
  const m = raw.match(/^([A-Za-z]{1,3})(\d{3,})$/);
  if (m) out.push([m[2], m[2]]);
  return out.filter(([p]) => keep(p));
}

// Index terms of one field value: [term, weight, as written] (a part counts half a word).
// kind 'id': tags, serials and barcodes (whole words + the compact form, no parts).
// kind 'text': everything else (words + parts), stop words dropped.
function fieldTerms(value, kind = 'text') {
  const out = [];
  const raws = rawWords(value);
  for (const raw of raws) {
    const w = raw.toLowerCase();
    if (kind === 'text' && STOP.has(w)) continue;
    if (keep(w)) out.push([stem(w), 1, raw]);
    if (kind === 'text') for (const [p, asWritten] of partsAsWritten(raw)) if (p !== w) out.push([stem(p), 0.5, asWritten]);
  }
  if (kind === 'id' && raws.length > 1) {
    const compact = raws.join('');
    if (compact.length >= 4) out.push([compact.toLowerCase(), 1, compact]);
  }
  return out;
}

// Query tokens: [{ raw, term }], in order, stop words dropped (unless that leaves nothing).
// Joins a number and its unit ("16 gb" -> "16gb").
function queryTokens(q) {
  const raws = rawWords(q);
  const toks = [];
  for (let i = 0; i < raws.length; i++) {
    let raw = raws[i];
    let w = raw.toLowerCase();
    const unit = raws[i + 1] && raws[i + 1].toLowerCase();
    if (/^\d+$/.test(w) && (unit === 'gb' || unit === 'g' || unit === 'tb')) { w += unit === 'tb' ? 'tb' : 'gb'; raw += ' ' + raws[++i]; }
    else if (/^\d+g$/.test(w)) w += 'b';
    if (keep(w)) toks.push({ raw, term: stem(w) });
  }
  const meaningful = toks.filter(t => !STOP.has(t.term) && !QUERY_ONLY_STOP.has(t.term));
  const out = meaningful.length ? meaningful : toks;
  // The same word twice adds nothing.
  const seen = new Set();
  return out.filter(t => (seen.has(t.term) ? false : seen.add(t.term)));
}

// The query as one lower-case string, for the literal "contains" match on name / tag / serial
// (what the Hardware search box has always done).
function literal(q) {
  return String(q ?? '').trim().toLowerCase();
}

module.exports = { fieldTerms, queryTokens, literal, stem, rawWords, STOP };
