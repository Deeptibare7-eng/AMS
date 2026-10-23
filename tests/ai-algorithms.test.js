// Unit tests for the AI layer's own algorithms, on small known examples (no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const { levenshtein, osaDistance, jaro, jaroWinkler } = require('../src/ai/models/text/similarity');
const { MinHasher, jaccard, estimateJaccard, shingles } = require('../src/ai/models/text/minhash');
const tok = require('../src/ai/models/text/tokenize');
const metrics = require('../src/ai/eval/metrics');
const NaiveBayes = require('../src/ai/models/naiveBayes');
const LogisticRegression = require('../src/ai/models/logisticRegression');

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('edit distances match the textbook examples', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('flaw', 'lawn'), 2);
  assert.equal(osaDistance('ca', 'ac'), 1, 'a swap is one edit');
  assert.equal(levenshtein('ca', 'ac'), 2);
  assert.equal(osaDistance('5CG1234', '5GC1234'), 1);
  assert.equal(osaDistance('abc', 'abc'), 0);
});

test('Jaro and Jaro-Winkler match published values', () => {
  close(jaro('MARTHA', 'MARHTA'), 0.9444);
  close(jaroWinkler('MARTHA', 'MARHTA'), 0.9611);
  close(jaro('DWAYNE', 'DUANE'), 0.8222);
  close(jaroWinkler('DWAYNE', 'DUANE'), 0.84);
  close(jaroWinkler('DIXON', 'DICKSONX'), 0.8133);
  assert.equal(jaro('abc', 'xyz'), 0);
  assert.equal(jaroWinkler('same', 'same'), 1);
});

test('MinHash estimates Jaccard similarity and LSH finds near-duplicates only', () => {
  const mh = new MinHasher({ numHashes: 128, bands: 32 });
  const a = 'thinkpad e15 gen 4 type 21e6', b = 'thinkpad e15 gen4 type 21e6';
  const est = estimateJaccard(mh.signature(a), mh.signature(b));
  assert.ok(Math.abs(est - jaccard(a, b)) < 0.15, `estimate ${est} vs exact ${jaccard(a, b)}`);
  assert.equal(estimateJaccard(mh.signature(a), mh.signature(a)), 1);
  const pairs = mh.candidates([
    { id: 1, text: 'optiplex 5050' }, { id: 2, text: 'optiplex 5050 ' }, { id: 3, text: 'macbook pro 14' }, { id: 4, text: 'latitude 7420' }
  ]);
  assert.deepEqual(pairs, [[1, 2]]);
  assert.equal(shingles('ab', 3).size, 2);
});

test('tokeniser: normalisation, n-grams and asset features', () => {
  assert.equal(tok.normalize('  Dell® Latitude-5420 (i5) '), 'dell latitude 5420 i5');
  assert.deepEqual(tok.words('HP EliteBook 840G3'), ['hp', 'elitebook', '840g3']);
  assert.deepEqual(tok.charNgrams('ab', 3, 3), [' ab', 'ab ']);
  assert.equal(tok.serialKey('abc-12 3'), 'ABC123');
  const f = tok.assetFeatures({ name: 'Dell Latitude 5420', model_number: 'Latitude 5420', serial_number: '5CG12345' });
  assert.equal(f.get('w:latitude'), 2);
  assert.equal(f.get('s:5CG'), 1);
  assert.equal(f.get('m:latitude5420'), 1);
  assert.match(tok.describeFeature('w:latitude'), /the word "latitude"/);
});

test('metrics: precision, recall, F1, top-k, calibration', () => {
  const t = ['a', 'a', 'b', 'b', 'c'];
  const p = ['a', 'b', 'b', 'b', 'a'];
  const m = metrics.classification(t, p);
  close(m.accuracy, 0.6);
  close(m.perClass.a.precision, 0.5); close(m.perClass.a.recall, 0.5);
  close(m.perClass.b.precision, 2 / 3); close(m.perClass.b.recall, 1);
  close(m.perClass.c.f1, 0);
  close(m.macroF1, (0.5 + 0.8 + 0) / 3);
  close(metrics.topK(['x', 'y'], [['x', 'y'], ['x', 'z']], 1), 0.5);
  close(metrics.topK(['x', 'y'], [['x', 'y'], ['z', 'y']], 2), 1);
  close(metrics.calibrationError([0.9, 0.9], [true, true]), 0.1);
  assert.deepEqual(metrics.precisionAtConfidence([0.95, 0.5, 0.99], [true, false, false], 0.9), { threshold: 0.9, coverage: 2 / 3, precision: 0.5 });
});

// Tiny corpus where the right answer is obvious.
const corpus = [
  ['dell latitude 5420', 'Laptop'], ['dell latitude 7420', 'Laptop'], ['lenovo thinkpad e14', 'Laptop'], ['hp elitebook 840', 'Laptop'],
  ['dell optiplex 7010', 'Desktop'], ['hp elitedesk 800', 'Desktop'], ['lenovo thinkcentre m70', 'Desktop'], ['dell optiplex 5050', 'Desktop'],
  ['azure vm d4s', 'VM'], ['aws ec2 vm t3', 'VM'], ['vmappd01 vm', 'VM'], ['gcp vm n2', 'VM']
];
const docs = corpus.map(([n]) => tok.assetFeatures({ name: n }));
const labels = corpus.map(([, l]) => l);

test('Naive Bayes: hand-checked probabilities on a two-word example', () => {
  const nb = new NaiveBayes().train(
    [new Map([['a', 2]]), new Map([['a', 1], ['b', 1]]), new Map([['b', 2]])], ['X', 'X', 'Y'], { alpha: 1 });
  // V = 2; X: a=3 b=1 total 4; Y: b=2 total 2. doc {a:1}: X ∝ 2/3 · 4/6, Y ∝ 1/3 · 1/4
  const px = (2 / 3) * (4 / 6), py = (1 / 3) * (1 / 4);
  const p = nb.proba(new Map([['a', 1]]));
  close(p[nb.params.classes.indexOf('X')], px / (px + py));
  close(nb.scores(new Map([['zz', 5]]))[0], Math.log(2 / 3), 1e-9);
});

test('Naive Bayes and logistic regression learn the tiny corpus and explain themselves', () => {
  for (const M of [NaiveBayes, LogisticRegression]) {
    const m = new M().train(docs, labels, M === LogisticRegression ? { dims: 1 << 12, epochs: 30 } : {});
    assert.equal(m.evaluate(docs, labels).accuracy, 1, `${M.name} fits its training data`);
    const q = tok.assetFeatures({ name: 'Dell Latitude 3420' });
    assert.equal(m.predict(q).value, 'Laptop', `${M.name}: unseen laptop model`);
    assert.equal(m.predict(tok.assetFeatures({ name: 'OptiPlex 3080 tower' })).value, 'Desktop', `${M.name}: unseen desktop`);
    const why = m.explain(q);
    assert.ok(why.length && why.some(w => /latitude|lat|itu/.test(w.factor)), `${M.name} explains with the latitude features: ${JSON.stringify(why)}`);
    const p = m.proba(q);
    close(p.reduce((s, x) => s + x, 0), 1, 1e-9);
    const restored = M.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    assert.deepEqual(restored.rank(q, 3), m.rank(q, 3), `${M.name} round-trips through JSON`);
  }
});

test('temperature scaling makes over-confident scores less extreme', () => {
  const nb = new NaiveBayes().train(docs, labels);
  const before = nb.predict(tok.assetFeatures({ name: 'dell thinkpad optiplex' })).confidence;
  const T = nb.fitTemperature(docs, labels.map((l, i) => (i % 4 === 0 ? 'VM' : l)));
  assert.ok(T > 1, `T = ${T}`);
  assert.ok(nb.predict(tok.assetFeatures({ name: 'dell thinkpad optiplex' })).confidence <= before);
});
