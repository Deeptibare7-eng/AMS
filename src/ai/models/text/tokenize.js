// Text normalisation and feature extraction for asset text (names, model numbers, serials).
// Everything here is plain string work: no dictionary, no external library.

// Lower case, accents removed, anything that isn't a letter or digit becomes a space.
function normalize(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function words(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

// Character n-grams inside each word, padded with spaces so word starts/ends are features too:
// "e5450" -> " e5", "e54", ..., "50 ". Robust to typos and to "Latitude5420" vs "Latitude 5420".
function charNgrams(s, min = 3, max = 5) {
  const out = [];
  for (const w of words(s)) {
    const p = ` ${w} `;
    for (let n = min; n <= max; n++) {
      for (let i = 0; i + n <= p.length; i++) out.push(p.slice(i, i + n));
    }
  }
  return out;
}

// Serial numbers: upper case, only letters and digits ("abc-123 4" -> "ABC1234").
function serialKey(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function addAll(map, keys, weight = 1) {
  for (const k of keys) map.set(k, (map.get(k) || 0) + weight);
  return map;
}

// Features of an asset for the intake classifier, from what the Register Asset form has:
// name and model number (words + character n-grams) and the serial's first three characters
// (makers use recognisable serial formats). Returns Map feature -> count.
function assetFeatures({ name = '', model_number = '', serial_number = '' } = {}) {
  const f = new Map();
  const text = `${name} ${model_number}`;
  addAll(f, words(text).map(w => 'w:' + w));
  addAll(f, charNgrams(text).map(g => 'c:' + g));
  const mn = normalize(model_number).replace(/ /g, '');
  if (mn) f.set('m:' + mn, 1);
  const sk = serialKey(serial_number);
  if (sk.length >= 5) {
    f.set('s:' + sk.slice(0, 3), 1);
    f.set('l:' + sk.length, 1);
  }
  return f;
}

// Plain-language name of a feature, for explanations.
function describeFeature(key) {
  const [kind, ...rest] = key.split(':');
  const v = rest.join(':');
  switch (kind) {
    case 'w': return `the word "${v}"`;
    case 'c': return `the letters "${v.trim()}"`;
    case 'm': return `model number "${v}"`;
    case 's': return `a serial number starting "${v}"`;
    case 'l': return `a ${v}-character serial number`;
    default: return key;
  }
}

module.exports = { normalize, words, charNgrams, serialKey, assetFeatures, describeFeature };
