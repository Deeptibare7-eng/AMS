// Questions in plain language, measured (read-only):
//   - intent accuracy and macro-F1 on the hand-written test set (nl/testset.js; the classifier is
//     trained only on nl/seed.js, in masked form);
//   - entities: per-slot precision, recall and F1 against what each test question should yield;
//   - SQL safety: injection attempts and random noise produce only whitelisted filter keys with
//     checked values (the same checks as the Hardware route), never text that reaches SQL;
//   - time to understand a question.
const vocab = require('../nl/vocab');
const query = require('../nl/query');
const metrics = require('./metrics');
const { TESTS, TEST_HOLDERS } = require('../nl/testset');
const { IntentClassifier } = require('../nl/intent');
const assistant = require('../agents/assistant');

const ALLOWED = {
  category_id: /^\d+$/, manufacturer_id: /^\d+$/, status_label_id: /^\d+$/, model: v => v.length <= 120, site: v => v === '_returned',
  near_site: v => v.length <= 60, near_location: /^\d+$/, holder: /^\d{1,9}$/, warranty_from: /^\d{4}-\d{2}-\d{2}$/, warranty_to: /^\d{4}-\d{2}-\d{2}$/,
  bought_from: /^\d{4}-\d{2}-\d{2}$/, bought_to: /^\d{4}-\d{2}-\d{2}$/, ram_min: /^\d{1,4}$/, ram_max: /^\d{1,4}$/,
  os: /^(windows11|windows10|windows_legacy|eol|macos|linux)$/, ai: /^(refresh_high|unusual)$/, dq: /^[a-z_]{3,40}$/,
  sort: /^(oldest|newest|cost_high|cost_low|risk)$/, label_type: /^(deployable|archived|undeployable)$/, assigned: /^[01]$/,
  search: v => v.length <= 60 && /^[a-z0-9 ]+$/.test(v)
};
const allowed = (k, v) => { const rule = ALLOWED[k]; return !!rule && (typeof rule === 'function' ? rule(String(v)) : rule.test(String(v))); };

// What a test question's slots look like, in the test set's terms.
function shape(slots) {
  const out = {};
  for (const k of ['category', 'maker', 'model']) if (slots[k]) out[k] = slots[k].map(x => x.name).sort();
  if (slots.place) out.place = slots.place.map(p => p.word).sort();
  if (slots.status) out.status = slots.status.state;
  if (slots.holder) out.holder = slots.holder.name;
  for (const k of ['asset', 'issue', 'sort']) if (slots[k]) out[k] = slots[k];
  if (slots.os) out.os = slots.os.value;
  if (slots.warranty) out.warranty = slots.warranty.from && slots.warranty.to ? 'ending' : slots.warranty.to ? 'expired' : 'valid';
  if (slots.bought) out.bought = slots.bought.from && slots.bought.to ? 'range' : slots.bought.to ? 'older' : 'newer';
  if (slots.ram) out.ram = { ...(slots.ram.min ? { min: slots.ram.min } : {}), ...(slots.ram.max ? { max: slots.ram.max } : {}) };
  return out;
}
const same = (a, b) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

const ATTACKS = [
  "laptops'; DROP TABLE assets; --", "1 OR 1=1", "laptops in pune' OR '1'='1", 'robert"); DELETE FROM users; --', '<script>alert(1)</script> laptops',
  "warranty expiring in 2026-11-01'; --", 'UNION SELECT password FROM users', "assigned to admin' --", '%%%%____', "laptops with 8 gb ram; TRUNCATE ai_models",
  '../../etc/passwd', '${process.exit()}', 'laptops in pune\u0000 OR 1=1', 'SELECT * FROM assets WHERE 1=1', "category_id=1&holder=1 OR 1=1"
];

async function run({ today = new Date() } = {}) {
  const real = await vocab.load(); // selects only
  // The test questions name made-up holders: add them to (a copy of) the vocabulary.
  const v = { ...real, holders: new Map([...real.holders, ...TEST_HOLDERS]) };
  const t0 = Date.now();
  const clf = new IntentClassifier().train();
  const trainMs = Date.now() - t0;
  const rows = [];
  const times = [];
  const slotStats = {};
  const stat = k => (slotStats[k] = slotStats[k] || { tp: 0, fp: 0, fn: 0 });
  for (const tc of TESTS) {
    const s = process.hrtime.bigint();
    const u = assistant.understand(tc.q, v, clf, today);
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
    const got = shape(u.ent.slots);
    rows.push({ q: tc.q, truth: tc.intent, pred: u.intent, confidence: u.confidence, got, expect: tc.expect });
    for (const [k, want] of Object.entries(tc.expect)) {
      if (!(k in got)) stat(k).fn++;
      else if (same(got[k], want)) stat(k).tp++;
      else { stat(k).fp++; stat(k).fn++; }
    }
    for (const k of Object.keys(got)) if (!(k in tc.expect)) stat(k).fp++;
  }
  const intent = metrics.classification(rows.map(r => r.truth), rows.map(r => r.pred));
  const prf = s => { const p = s.tp / ((s.tp + s.fp) || 1), r = s.tp / ((s.tp + s.fn) || 1); return { ...s, precision: p, recall: r, f1: p + r ? 2 * p * r / (p + r) : 0 }; };
  const all = Object.values(slotStats).reduce((a, s) => ({ tp: a.tp + s.tp, fp: a.fp + s.fp, fn: a.fn + s.fn }), { tp: 0, fp: 0, fn: 0 });
  // SQL safety: every key whitelisted, every value checked.
  let rand = 12345;
  const r = () => (rand = (rand * 16807) % 2147483647) / 2147483647;
  const noise = Array.from({ length: 400 }, () => Array.from({ length: 3 + Math.floor(r() * 40) }, () => String.fromCharCode(32 + Math.floor(r() * 94))).join(''));
  const mixed = ATTACKS.flatMap(a => [a, `how many laptops ${a}`, `${a} in mindspace with warranty expiring next month`]);
  let checked = 0;
  const unsafe = [];
  for (const q of [...ATTACKS, ...mixed, ...noise, ...TESTS.map(t => t.q)]) {
    const u = assistant.understand(q, v, clf, today);
    const built = query.build(u.ent.slots, u.intent, v, { residual: u.text });
    for (const [k, val] of built.params) { checked++; if (!allowed(k, val)) unsafe.push({ q, k, val }); }
  }
  const sorted = times.slice().sort((a, b) => a - b);
  return {
    tests: TESTS.length, train_ms: trainMs, model: { kind: clf.params.kind, ...clf.metrics },
    intent: { accuracy: intent.accuracy, macroF1: intent.macroF1, perClass: intent.perClass },
    slots: Object.fromEntries(Object.entries(slotStats).map(([k, s]) => [k, prf(s)])), slots_all: prf(all),
    misses: rows.filter(x => x.truth !== x.pred || Object.entries(x.expect).some(([k, w]) => !same(x.got[k], w))),
    safety: { questions: ATTACKS.length + mixed.length + noise.length + TESTS.length, params: checked, unsafe },
    ms: { median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] }
  };
}

function format(r) {
  const p = x => (x * 100).toFixed(1) + '%';
  const lines = [`Questions in plain language: ${r.tests} hand-written test questions; classifier ${r.model.kind} trained on ${r.model.utterances} seed utterances in ${r.train_ms} ms`
    + ` (5-fold CV on the seed set: macro-F1 ${p(r.model.cv_macroF1)}; Naive Bayes ${p(r.model.nb_macroF1)}, logistic regression ${p(r.model.lr_macroF1)}).`,
  `Intent on the test set: accuracy ${p(r.intent.accuracy)}, macro-F1 ${p(r.intent.macroF1)}.`,
  `Entities: precision ${p(r.slots_all.precision)}, recall ${p(r.slots_all.recall)}, F1 ${p(r.slots_all.f1)} over all slots.`,
  '  ' + Object.entries(r.slots).sort((a, b) => (b[1].tp + b[1].fn) - (a[1].tp + a[1].fn)).map(([k, s]) => `${k} ${p(s.f1)} (${s.tp}/${s.tp + s.fn})`).join(' | '),
  `SQL safety: ${r.safety.questions} questions (injection attempts, random noise, the test set) -> ${r.safety.params} filter values, ${r.safety.unsafe.length} outside the whitelist.`,
  `Time to understand a question: median ${r.ms.median.toFixed(1)} ms, max ${r.ms.max.toFixed(1)} ms.`];
  if (r.misses.length) {
    lines.push('', 'Not fully right:');
    for (const m of r.misses) lines.push(`  "${m.q}": intent ${m.pred}${m.pred !== m.truth ? ' (should be ' + m.truth + ')' : ''}; got ${JSON.stringify(m.got)}; expected ${JSON.stringify(m.expect)}`);
  }
  return lines.join('\n');
}

module.exports = { run, format, ALLOWED, allowed, shape, ATTACKS };
