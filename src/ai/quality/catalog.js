// Catalog findings (Inventory Setup): duplicate model spellings, model categories that disagree
// with the assets using them, and supplier legal entities of the same maker.
const { MinHasher } = require('../models/text/minhash');
const { osaDistance } = require('../models/text/similarity');
const { normalize, words } = require('../models/text/tokenize');

// Two catalog names are spellings of the same model when they are equal ignoring case, spaces
// and punctuation ("HP Elite Book 840G3" / "HP Elitebook 840 G3"), or when they differ only by a
// small typo in one long word without digits ("ThinkCentre" / "ThinkCenter"). Any difference in a
// token with digits means a different model ("Latitude E5450" / "Latitude 5450", "760" / "760n",
// "Type 21ME" / "Type 21MC").
function sameModelSpelling(a, b) {
  const squash = s => s.replace(/ /g, '');
  if (squash(a) === squash(b)) return true;
  const ta = a.split(' '), tb = b.split(' ');
  if (ta.length !== tb.length) return false;
  const diff = ta.map((t, i) => [t, tb[i]]).filter(([x, y]) => x !== y);
  if (diff.length !== 1) return false;
  const [x, y] = diff[0];
  return !/\d/.test(x + y) && Math.min(x.length, y.length) >= 6 && osaDistance(x, y) <= 2;
}

// Spelling variants among Asset Models of the same manufacturer: MinHash/LSH proposes candidate
// pairs from 3-character shingles (no all-pairs comparison), sameModelSpelling() confirms them.
// Returns groups [{ ids, names }].
function modelVariants(models) {
  const items = models.map(m => ({ id: String(m.id), text: normalize(m.name), maker: m.manufacturer_id ?? null, name: m.name }));
  const byId = new Map(items.map(i => [i.id, i]));
  const pairs = new MinHasher({ numHashes: 64, bands: 32 }).candidates(items.filter(i => i.text))
    .filter(([a, b]) => {
      const A = byId.get(a), B = byId.get(b);
      return String(A.maker) === String(B.maker) && sameModelSpelling(A.text, B.text);
    });
  // Union-find into groups.
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const [a, b] of pairs) {
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    parent.set(find(a), find(b));
  }
  const groups = new Map();
  for (const x of parent.keys()) {
    const r = find(x);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(x);
  }
  return [...groups.values()].map(ids => ({ ids, names: ids.map(i => byId.get(i).name) }));
}

// Models whose catalog category differs from what >= 80% of their (20+) assets are filed as.
// modelMajority: Map modelId -> { category_id, count, total, share }
function modelCategoryFixes(models, modelMajority, { minAssets = 20, minShare = 0.8 } = {}) {
  const out = [];
  for (const m of models) {
    const maj = modelMajority.get(String(m.id));
    if (!maj || maj.total < minAssets || maj.share < minShare || !m.category_id) continue;
    if (String(m.category_id) !== maj.category_id) out.push({ model_id: String(m.id), name: m.name, from: String(m.category_id), to: maj.category_id, count: maj.count, total: maj.total, share: maj.share });
  }
  return out;
}

// Suppliers that look like legal entities of the same company (same first word, 2+ entities).
function supplierGroups(suppliers) {
  const by = new Map();
  for (const s of suppliers) {
    const first = words(s.name)[0];
    if (!first || first.length < 3) continue;
    if (!by.has(first)) by.set(first, []);
    by.get(first).push(s.name);
  }
  return [...by.entries()].filter(([, names]) => names.length > 1).map(([key, names]) => ({ key, names }));
}

module.exports = { modelVariants, modelCategoryFixes, supplierGroups, sameModelSpelling };
