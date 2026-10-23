// MinHash signatures and locality-sensitive hashing (LSH) for finding similar strings at scale
// without comparing every pair. Used for near-duplicate catalog names (models, suppliers).
//
// Each string becomes a set of k-character shingles. A MinHash signature keeps, for each of
// `numHashes` hash functions, the smallest hash over the set; two sets agree on a signature
// position with probability equal to their Jaccard similarity. LSH splits the signature into
// `bands` of `rows`; strings sharing any whole band land in the same bucket and become candidate
// pairs (pairs with Jaccard s are found with probability 1 - (1 - s^rows)^bands).

// 32-bit FNV-1a hash of a string.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shingles(s, k = 3) {
  const t = ` ${String(s)} `;
  const out = new Set();
  if (t.length <= k) { out.add(t); return out; }
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k));
  return out;
}

const PRIME = 4294967311; // smallest prime above 2^32

// Deterministic hash family h_i(x) = (a_i * x + b_i) mod PRIME, from a seeded generator.
function hashFamily(n, seed = 42) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  return Array.from({ length: n }, () => [BigInt((next() | 1) >>> 0), BigInt(next())]);
}

class MinHasher {
  constructor({ numHashes = 64, bands = 16, k = 3, seed = 42 } = {}) {
    if (numHashes % bands) throw new Error('numHashes must be a multiple of bands');
    this.k = k;
    this.bands = bands;
    this.rows = numHashes / bands;
    this.family = hashFamily(numHashes, seed);
  }

  signature(s) {
    const xs = [...shingles(s, this.k)].map(x => BigInt(fnv1a(x)));
    const P = BigInt(PRIME);
    return this.family.map(([a, b]) => {
      let min = P;
      for (const x of xs) { const h = (a * x + b) % P; if (h < min) min = h; }
      return Number(min);
    });
  }

  // items: [{ id, text }] -> candidate pairs [[idA, idB], ...] (each pair once).
  candidates(items) {
    const buckets = new Map();
    for (const it of items) {
      const sig = this.signature(it.text);
      for (let b = 0; b < this.bands; b++) {
        const key = b + ':' + sig.slice(b * this.rows, (b + 1) * this.rows).join(',');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(it.id);
      }
    }
    const seen = new Set();
    const pairs = [];
    for (const ids of buckets.values()) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [x, y] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
          const key = x + '|' + y;
          if (!seen.has(key)) { seen.add(key); pairs.push([x, y]); }
        }
      }
    }
    return pairs;
  }
}

// Exact Jaccard similarity of two strings' shingle sets (to verify candidates).
function jaccard(a, b, k = 3) {
  const A = shingles(a, k), B = shingles(b, k);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function estimateJaccard(sigA, sigB) {
  let same = 0;
  for (let i = 0; i < sigA.length; i++) if (sigA[i] === sigB[i]) same++;
  return same / sigA.length;
}

module.exports = { MinHasher, shingles, jaccard, estimateJaccard, fnv1a };
