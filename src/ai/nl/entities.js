// Entity extraction for questions in plain language: rules and the register's vocabularies, our own
// code. "laptops in Pune with warranty expiring next month" ->
//   { category: Laptop, place: Pune (sites Pune Qubix, Pune EON + Asset Locations with "Pune"),
//     warranty: 2026-11-01..2026-11-30 }
// and the question with those parts masked ("CAT in PLACE with WARRANTY") for the intent classifier.
// Every value is an id or name from the register, an ISO date, a number in range, or a word from a
// fixed list; nothing from the question text is passed on as is.
const vocab = require('./vocab');
const { osaWithin } = require('../models/text/similarity');

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18, twenty: 20 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIndex = s => MONTHS.findIndex(m => m.startsWith(s.slice(0, 3)));
const num = s => (/^\d+$/.test(s) ? Number(s) : NUM[s] || null);

// Dates as YYYY-MM-DD (UTC).
const iso = d => d.toISOString().slice(0, 10);
const day = (y, m, d) => new Date(Date.UTC(y, m, d));
const monthEnd = (y, m) => day(y, m + 1, 0);
function shift(today, n, unit) {
  const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate();
  if (unit.startsWith('day')) return day(y, m, d + n);
  if (unit.startsWith('week')) return day(y, m, d + 7 * n);
  if (unit.startsWith('month')) return day(y, m + n, d);
  return day(y + n, m, d);
}
// "this|next|last month|quarter|year" -> [from, to]
function period(today, which, unit) {
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  const k = which === 'next' ? 1 : which === 'last' ? -1 : 0;
  if (unit === 'month') return [day(y, m + k, 1), monthEnd(y, m + k)];
  if (unit === 'quarter') { const q = Math.floor(m / 3) + k; return [day(y, 3 * q, 1), monthEnd(y, 3 * q + 2)]; }
  return [day(y + k, 0, 1), day(y + k, 11, 31)];
}

// Changing something is not a question: these verbs are refused (with where to do it instead).
const CHANGE = /\b(retire|delete|remove|assign|reassign|allocate|transfer|move|buy|purchase|order|update|change|edit|set|mark|dispose|scrap|approve)\b(?!d\b)(?=\s+(?:the|this|that|these|all|my|his|her|their|asset|laptop|desktop|it|them|hams-|\d))/;

// Data-health issue phrases -> issue codes (see quality/rules.js).
const ISSUES = [
  [/\b(no|missing|without|blank)\s+(?:an?\s+|any\s+)?(fams|barcode|fams barcode|barcode number)s?\b/, 'fams_missing'],
  [/\b(duplicate|shared|same)\s+(fams|barcode)s?\b/, 'fams_duplicate'],
  [/\b(duplicate|shared)\s+serials?( numbers?)?\b/, 'serial_duplicate'],
  [/\b(duplicate|shared)\s+(host ?names?|machine names?)\b/, 'hostname_duplicate'],
  [/\b(no|missing|without)\s+(?:an?\s+|any\s+)?(purchase\s+)?(cost|price|value)s?\b/, 'missing_cost'],
  [/\b(no|missing|without)\s+(?:an?\s+|any\s+)?(supplier|vendor)s?\b/, 'missing_supplier'],
  [/\b(no|missing|without)\s+(?:an?\s+|any\s+)?(po|purchase orders?)\b|\bnot linked to (a )?(po|purchase order)\b/, 'missing_po'],
  [/\b(wrong|incorrect|mismatched) categor(y|ies)\b/, 'category_mismatch'],
  [/\b(no|missing|without) warranty (term|dates?|recorded)\b/, 'warranty_not_recorded'],
  [/\breturned to (the )?client but (in|still in) stock\b|\bin stock but returned\b/, 'returned_in_stock'],
  [/\b(unusual|odd|outlier) (cost|price)s?\b|\bcost outliers?\b/, 'cost_outlier']
];

// Status phrases -> what they mean in the register.
const STATUS = [
  [/\b(in stock|in store|spare|unallocated|not (yet )?(assigned|allocated)|unassigned|available|free|idle)\b/, { state: 'stock', text: 'In stock (not assigned)' }],
  [/\b(in use|deployed|allocated|assigned|issued|being used)\b/, { state: 'assigned', text: 'Assigned / in use' }],
  // Not "likely to be retired" / "will get scrapped": that is about the future (refresh risk), not the status.
  [/(?<!\b(?:be|get|getting|being)\s+)\b(retired|disposed|scrapped|recycled|written off|e-?waste|decommissioned)\b/, { state: 'retired', text: 'Retired' }],
  [/\b(in repair|under repair|broken|faulty|damaged|not working|defective)\b/, { state: 'repair', text: 'In repair / broken' }],
  // Not "data is missing for desktops" / "missing FAMS barcode": that is a data issue, not a lost asset.
  [/(?<!\b(?:data|info|information|details?|fields?|values?)\s+(?:is\s+|are\s+)?)\b(lost|stolen|missing)\b(?! (?:for|data|info|information|fields?|details?|values?|fams|barcode|cost|price|supplier|vendor|po|warranty))/, { state: 'lost', text: 'Lost' }],
  [/\breturned to (the )?client\b/, { state: 'returned', text: 'Returned to client (Machine Name)' }]
];

const CATEGORY_SYNONYMS = { lappy: 'laptop', notebook: 'laptop', pc: 'desktop', workstation: 'desktop', cpu: 'desktop', vdi: 'vm', 'virtual machine': 'vm', tc: 'thin client', thinclient: 'thin client', server: 'vm server' };
const WORD = /[a-z0-9]+(?:[-'][a-z0-9]+)*/g;
const STOP = new Set(('a an the and or of in on at to for with by from is are be was were it its show me all any list find get give which where what who whose how many much do does did we our have has had there that this these those please can could would i my can\'t').split(' '));

function extract(question, v, { today = new Date() } = {}) {
  const t0 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const raw = String(question || '').slice(0, 300);
  // "L&T" (a site code) becomes one word of the same length, so positions stay put.
  const base = (' ' + raw.toLowerCase().replace(/[“”"]/g, ' ').replace(/\s+/g, ' ') + ' ')
    .replace(/\bl\s?&\s?t\b/g, s => 'lnt'.padEnd(s.length, ' '));
  let text = base;
  const slots = {};
  const spans = []; // { start, end, slot, label }
  const take = (m, slot, label) => {
    const start = m.index, end = m.index + m[0].length;
    spans.push({ start, end, slot, label, text: m[0].trim() });
    text = text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
  };
  const change = (CHANGE.exec(text) || [])[1] || null;
  let m;

  // Asset tags (HAMS-000123, 9-digit tags).
  if ((m = /\b(hams-\d{3,7}|\d{9})\b/.exec(text))) { slots.asset = m[1].toUpperCase(); take(m, 'asset', m[1].toUpperCase()); }

  // Warranty.
  const W = '(?:warrant(?:y|ies)|amc|guarantee)';
  const END = '(?:expir(?:ing|es|y|e)|ending|ends|end|runs? out|running out|lapsing|due)';
  if ((m = new RegExp(`${W}\\s+(?:that\\s+|which\\s+)?(?:is\\s+|are\\s+)?${END}\\s+(?:in|within)\\s+(?:the\\s+)?(?:next\\s+)?(\\d+|a|an|one|two|three|four|six|twelve)?\\s*(day|week|month|year)s?`).exec(text))) {
    const n = num(m[1] || 'one') || 1;
    slots.warranty = { from: iso(t0), to: iso(shift(t0, n, m[2])), text: `Warranty ends in the next ${n} ${m[2]}${n > 1 ? 's' : ''}` };
    take(m, 'warranty');
  } else if ((m = new RegExp(`${W}\\s+(?:that\\s+)?(?:is\\s+)?${END}\\s+(this|next)\\s+(month|quarter|year)`).exec(text))) {
    const [a, b] = period(t0, m[1], m[2]);
    slots.warranty = { from: iso(a), to: iso(b), text: `Warranty ends ${m[1]} ${m[2]} (${iso(a)} to ${iso(b)})` };
    take(m, 'warranty');
  } else if ((m = new RegExp(`${W}\\s+(?:that\\s+)?${END}\\s+(?:in\\s+)?${MON}(?:\\s+(\\d{4}))?`).exec(text))) {
    const mi = monthIndex(m[1]);
    let y = m[2] ? Number(m[2]) : t0.getUTCFullYear();
    if (!m[2] && mi < t0.getUTCMonth()) y++;
    slots.warranty = { from: iso(day(y, mi, 1)), to: iso(monthEnd(y, mi)), text: `Warranty ends in ${MONTHS[mi].replace(/^./, c => c.toUpperCase())} ${y}` };
    take(m, 'warranty');
  } else if ((m = new RegExp(`${W}\\s+(?:that\\s+)?(?:is\\s+)?${END}\\s+(?:soon|shortly)`).exec(text))) {
    slots.warranty = { from: iso(t0), to: iso(shift(t0, 90, 'day')), text: 'Warranty ends in the next 90 days' };
    take(m, 'warranty');
  } else if ((m = new RegExp(`\\b(?:out of|expired|without|no|lapsed|outside)\\s+${W}\\b|${W}\\s+(?:has\\s+|have\\s+|is\\s+|are\\s+)?(?:already\\s+)?(?:expired|over|ended|lapsed)`).exec(text))) {
    slots.warranty = { to: iso(shift(t0, -1, 'day')), text: 'Warranty already ended' };
    take(m, 'warranty');
  } else if ((m = new RegExp(`\\b(?:under|in|with|still in|within|valid|active)\\s+${W}\\b`).exec(text))) {
    slots.warranty = { from: iso(t0), text: 'Still under warranty' };
    take(m, 'warranty');
  }

  // Purchase date and age.
  const BUY = '(?:bought|purchased|procured|acquired|ordered|received)';
  if ((m = /\b(?:older than|more than|over|at least|above)\s+(\d+|one|two|three|four|five|six|seven|eight|ten)\s+years?(?:\s+old)?\b|\b(\d+)\+\s*years?(?:\s+old)?\b/.exec(text))) {
    const n = num(m[1] || m[2]);
    slots.bought = { to: iso(shift(t0, -n, 'year')), text: `More than ${n} years old` };
    take(m, 'bought');
  } else if ((m = /\b(?:less than|under|younger than|newer than|below)\s+(\d+|one|two|three|four|five|six)\s+years?(?:\s+old)?\b/.exec(text))) {
    const n = num(m[1]);
    slots.bought = { from: iso(shift(t0, -n, 'year')), text: `Less than ${n} years old` };
    take(m, 'bought');
  } else if ((m = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+old\b/.exec(text))) {
    const n = num(m[1]);
    slots.bought = { from: iso(shift(t0, -(n + 1), 'year')), to: iso(shift(t0, -n, 'year')), text: `${n} years old` };
    take(m, 'bought');
  } else if ((m = new RegExp(`\\b${BUY}\\s+(?:in\\s+|during\\s+)?(?:the\\s+)?(last|past)\\s+(\\d+|one|two|three|six|twelve)\\s+(month|year)s?`).exec(text))) {
    const n = num(m[2]);
    slots.bought = { from: iso(shift(t0, -n, m[3])), text: `Bought in the last ${n} ${m[3]}${n > 1 ? 's' : ''}` };
    take(m, 'bought');
  } else if ((m = new RegExp(`\\b${BUY}\\s+(this|last)\\s+(month|quarter|year)`).exec(text))) {
    const [a, b] = period(t0, m[1], m[2]);
    slots.bought = { from: iso(a), to: iso(b), text: `Bought ${m[1]} ${m[2]}` };
    take(m, 'bought');
  } else if ((m = new RegExp(`\\b${BUY}\\s+(before|prior to|until|by)\\s+(20\\d\\d)\\b`).exec(text))) {
    slots.bought = { to: `${Number(m[2]) - 1}-12-31`, text: `Bought before ${m[2]}` };
    take(m, 'bought');
  } else if ((m = new RegExp(`\\b${BUY}\\s+(after|since)\\s+(20\\d\\d)\\b`).exec(text))) {
    const y = Number(m[2]) + (m[1] === 'after' ? 1 : 0);
    slots.bought = { from: `${y}-01-01`, text: `Bought ${m[1]} ${m[2]}` };
    take(m, 'bought');
  } else if ((m = new RegExp(`\\b(?:${BUY}\\s+(?:in\\s+|during\\s+)?|from\\s+|of\\s+)(?:${MON}\\s+)?(20\\d\\d)\\b`).exec(text))) {
    const y = Number(m[2]);
    if (m[1]) {
      const mi = monthIndex(m[1]);
      slots.bought = { from: iso(day(y, mi, 1)), to: iso(monthEnd(y, mi)), text: `Bought in ${MONTHS[mi].replace(/^./, c => c.toUpperCase())} ${y}` };
    } else slots.bought = { from: `${y}-01-01`, to: `${y}-12-31`, text: `Bought in ${y}` };
    take(m, 'bought');
  } else if ((m = /\b(20[0-3]\d)\s+(?=\w)/.exec(text)) && !slots.warranty) {
    // "2021 laptops": a year just before a word, nothing else dated.
    const y = Number(m[1]);
    slots.bought = { from: `${y}-01-01`, to: `${y}-12-31`, text: `Bought in ${y}` };
    take(m, 'bought');
  }

  // RAM.
  if ((m = /\b(less than|under|below|up to|at most|max(?:imum)?|more than|over|above|at least|min(?:imum)?)?\s*(\d{1,3})\s*(?:gb|g)\b(?:\s+(?:of\s+)?(?:ram|memory))?(\s+or\s+(?:less|lower|below|more|higher|above))?/.exec(text))
    && /ram|memory|gb/.test(m[0])) {
    const n = Number(m[2]);
    const q = (m[1] || '') + (m[3] || '');
    const low = /less|under|below|up to|at most|max|lower/.test(q), high = /more|over|above|at least|min|higher/.test(q);
    const strict = /less than|under|below|more than|over|above/.test(m[1] || '');
    if (n >= 1 && n <= 1024) {
      slots.ram = low ? { max: strict ? n - 1 : n } : high ? { min: strict ? n + 1 : n } : { min: n, max: n };
      slots.ram.text = low ? `${strict ? 'Under' : 'At most'} ${n} GB RAM` : high ? `${strict ? 'Over' : 'At least'} ${n} GB RAM` : `${n} GB RAM`;
      take(m, 'ram');
    }
  }

  // Operating system.
  if ((m = /\b(?:windows|win)\s*(11|10|7|8(?:\.1)?|xp|vista)\b|\b(end[- ]of[- ]life|unsupported|outdated|old)\s+(?:os|operating systems?|windows)\b|\b(mac ?os|os ?x)\b|\b(linux|ubuntu)\b/.exec(text))) {
    const os = m[1] === '11' ? 'windows11' : m[1] === '10' ? 'windows10' : m[1] ? 'windows_legacy' : m[2] ? 'eol' : m[3] ? 'macos' : 'linux';
    const label = { windows11: 'Windows 11', windows10: 'Windows 10', windows_legacy: 'Windows 8 or older', eol: 'OS no longer supported', macos: 'macOS', linux: 'Linux' }[os];
    slots.os = { value: os, text: label };
    take(m, 'os');
  }

  // "Top N" and sort.
  if ((m = /\b(?:top|first)\s+(\d{1,3})\b|\b(\d{1,3})\s+(?=oldest|newest|most|cheapest|latest)/.exec(text))) { slots.limit = Number(m[1] || m[2]); take(m, 'limit'); }
  if ((m = /\b(oldest|newest|latest|most recent(?:ly bought)?|most expensive|costliest|priciest|cheapest|least expensive)\b/.exec(text))) {
    const w = m[1];
    slots.sort = /oldest/.test(w) ? 'oldest' : /newest|latest|recent/.test(w) ? 'newest' : /cheapest|least/.test(w) ? 'cost_low' : 'cost_high';
    take(m, 'sort');
  }

  // Holder, said explicitly ("assigned to X", "held by X", "X's laptop") or a CTID on its own.
  const holderAt = re => {
    const h = re.exec(text);
    if (!h) return false;
    const u = v.holders.get(h[1].replace(/'s$/, ''));
    if (!u) return false;
    slots.holder = { id: u.id, name: u.name };
    take(h, 'holder', u.name);
    return true;
  };
  holderAt(/\b(?:assigned|allocated|issued|given)\s+to\s+([a-z0-9._-]+)/) || holderAt(/\b(?:held|used|owned)\s+by\s+([a-z0-9._-]+)/)
    || holderAt(/\b(?:user|employee|ctid|person)\s+([a-z0-9._-]+)/) || holderAt(/\b([a-z][a-z0-9._-]*)'s\b/);

  // Data-health issues and statuses.
  for (const [re, code] of ISSUES) if (!slots.issue && (m = re.exec(text))) { slots.issue = code; take(m, 'issue'); }
  for (const [re, val] of STATUS) if (!slots.status && (m = re.exec(text))) { slots.status = val; take(m, 'status'); }

  // Dictionary words: categories, makers, models, places (longest phrase first, up to 4 words).
  const words = [];
  let w;
  WORD.lastIndex = 0;
  while ((w = WORD.exec(text))) words.push({ raw: w[0], key: vocab.norm(w[0]), start: w.index, end: w.index + w[0].length, used: false });
  const dict = new Map(); // phrase key -> [{ slot, value }]
  const put = (key, slot, value) => { if (!key) return; if (!dict.has(key)) dict.set(key, []); dict.get(key).push({ slot, value }); };
  for (const c of v.categories) put(c.key, 'category', c);
  for (const [syn, target] of Object.entries(CATEGORY_SYNONYMS)) { const c = v.categories.find(x => x.key === vocab.norm(target)); if (c) put(vocab.norm(syn), 'category', c); }
  for (const mk of v.makers) put(mk.key, 'maker', mk);
  for (const md of v.models) put(md.key, 'model', md);
  for (const [k, p] of v.places) put(k, 'place', { word: k, ...p });
  for (let i = 0; i < words.length; i++) {
    if (words[i].used || STOP.has(words[i].raw)) continue;
    for (let len = Math.min(4, words.length - i); len >= 1; len--) {
      const seg = words.slice(i, i + len);
      if (seg.some(x => x.used)) continue;
      const key = seg.map(x => x.key).join(' ');
      // Short plurals the stemmer leaves alone ("vms", "pcs").
      const hits = dict.get(key) || (key.endsWith('s') ? dict.get(key.slice(0, -1)) : null);
      if (!hits) continue;
      for (const h of hits) addHit(h, seg);
      seg.forEach(x => { x.used = true; });
      break;
    }
  }
  function addHit(h, seg) {
    const span = { start: seg[0].start, end: seg[seg.length - 1].end, slot: h.slot, text: seg.map(x => x.raw).join(' ') };
    if (h.slot === 'place') {
      (slots.place = slots.place || []).push({ word: h.value.word, said: span.text, sites: [...h.value.sites], locations: [...h.value.locations] });
    } else {
      const list = slots[h.slot] = slots[h.slot] || [];
      if (!list.some(x => (x.id || x.name) === (h.value.id || h.value.name))) list.push({ id: h.value.id, name: h.value.name });
    }
    spans.push(span);
  }
  // A small typo in a category, maker or place word ("lenvo", "bangalor", "laptps").
  for (const x of words) {
    if (x.used || x.key.length < 5 || STOP.has(x.raw) || /\d/.test(x.key)) continue;
    let best = null;
    for (const [k, hits] of dict) {
      if (k.includes(' ') || hits[0].slot === 'model' || Math.abs(k.length - x.key.length) > 1) continue;
      if (osaWithin(x.key, k, 1) === 1) { best = { k, hits }; break; }
    }
    if (best) { for (const h of best.hits) addHit(h, [x]); x.used = true; x.typo = best.k; }
  }
  // A CTID on its own ("ZaraQ9 laptops"): letters and a digit, or a known holder name of 6+ letters.
  if (!slots.holder) {
    for (const x of words) {
      if (x.used || STOP.has(x.raw)) continue;
      const u = v.holders.get(x.raw);
      if (u && (/[a-z]/.test(x.raw) && /\d/.test(x.raw) || (/^[a-z]{6,}$/.test(x.raw) && !dict.has(x.key)))) {
        slots.holder = { id: u.id, name: u.name };
        spans.push({ start: x.start, end: x.end, slot: 'holder', text: x.raw });
        x.used = true;
        break;
      }
    }
  }

  // The question with the found parts masked, for the intent classifier.
  const PH = { asset: 'ASSET', warranty: 'WARRANTY', bought: 'AGE', ram: 'RAM', os: 'OS', sort: 'SORT', limit: 'NUM', holder: 'HOLDER', issue: 'ISSUE', status: 'STATUS', category: 'CAT', maker: 'MAKER', model: 'MODEL', place: 'PLACE' };
  const lowered = base;
  let masked = '';
  let pos = 0;
  for (const s of spans.slice().sort((a, b) => a.start - b.start)) {
    if (s.start < pos) continue;
    masked += lowered.slice(pos, s.start) + ' ' + PH[s.slot] + ' ';
    pos = s.end;
  }
  masked = (masked + lowered.slice(pos)).replace(/[^a-zA-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { slots, spans: spans.map(s => ({ slot: s.slot, text: s.text })), masked, change, typos: words.filter(x => x.typo).map(x => ({ said: x.raw, read: x.typo })) };
}

module.exports = { extract, CHANGE, ISSUES };
