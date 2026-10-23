// Vocabularies for questions in plain language, read from the register (read-only), cached 10 minutes:
// categories, statuses, makers, model numbers, places (Machine Name sites + Asset Locations), holders
// (CTIDs), and the data-health issue codes. Every value an answer can filter on comes from here, so a
// question can only ever produce known ids and names.
const db = require('../../core/db');
const { stem } = require('../search/analyzer');

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, value: null };
function invalidate() { cache = { at: 0, value: null }; }

// Lower case, letters/digits, plurals off: "Laptops" -> "laptop", "Pune (E) - EON" -> "pune e eon".
const norm = s => String(s || '').toLowerCase().replace(/l\s*&\s*t/g, 'lnt').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(stem).join(' ');

// Words that name a place but say nothing on their own in location names.
const PLACE_NOISE = new Set(['ct', 'sez', 'sez1', 'sez2', 'source', 'citiustech', 'chc', 'e', 'india']);
// Site codes and other names people use for the same places (confirmed site codes only).
const PLACE_ALIASES = {
  // ("us" and "bl" are left out: too easily ordinary words in a question.)
  powai: ['lnt', 'tx'], bangalore: ['bengaluru', 'blr'], mindspace: ['ms', 'airoli'], pune: ['qbx', 'qubix', 'qbix'],
  hyderabad: ['hyd', 'hybd'], usa: ['america'], gurugram: ['gurgaon', 'ggn'], chennai: ['madras']
};

async function load() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [cats, labels, makers, models, sites, locs, users] = [
    await db.query('SELECT id, name FROM asset_categories ORDER BY name'),
    await db.query('SELECT id, name, type FROM status_labels ORDER BY name'),
    await db.query(`SELECT m.id, m.name, COUNT(a.id)::int AS n FROM manufacturers m LEFT JOIN assets a ON a.manufacturer_id = m.id AND a.deleted_at IS NULL GROUP BY m.id ORDER BY n DESC`),
    await db.query(`SELECT model_number AS name, COUNT(*)::int AS n FROM assets WHERE deleted_at IS NULL AND model_number IS NOT NULL AND btrim(model_number) <> '' GROUP BY 1`),
    await db.query(`SELECT stock_site AS name, COUNT(*)::int AS n FROM assets WHERE deleted_at IS NULL AND stock_site NOT LIKE '\\_%' GROUP BY 1`),
    await db.query('SELECT id, name FROM locations ORDER BY name'),
    await db.query(`SELECT id, name, employee_id FROM users WHERE deleted_at IS NULL`)
  ];
  // Places: a word (or two) -> the Machine Name sites and Asset Locations containing it.
  const places = new Map();
  const addPlace = (word, kind, value) => {
    if (!word || PLACE_NOISE.has(word) || /^\d+$/.test(word)) return;
    if (!places.has(word)) places.set(word, { sites: new Set(), locations: new Set() });
    places.get(word)[kind].add(value);
  };
  for (const s of sites) { const w = norm(s.name).split(' '); w.forEach(x => addPlace(x, 'sites', s.name)); if (w.length > 1) addPlace(w.join(' '), 'sites', s.name); }
  for (const l of locs) { const w = norm(l.name).split(' ').filter(x => !PLACE_NOISE.has(x)); w.forEach(x => addPlace(x, 'locations', l.id)); if (w.length > 1) addPlace(w.join(' '), 'locations', l.id); }
  for (const [word, aliases] of Object.entries(PLACE_ALIASES)) {
    const p = places.get(word);
    if (p) for (const a of aliases) if (!places.has(a)) places.set(a, p);
  }
  const holders = new Map();
  for (const u of users) for (const k of [u.name, u.employee_id]) if (k && String(k).trim()) holders.set(String(k).trim().toLowerCase(), { id: u.id, name: u.name });
  const value = {
    categories: cats.map(c => ({ id: c.id, name: c.name, key: norm(c.name) })),
    labels: labels.map(l => ({ ...l, key: norm(l.name) })),
    makers: makers.map(m => ({ id: m.id, name: m.name, key: norm(m.name) })),
    // Model numbers worth matching: two words, or one with letters and digits ("MT22", "Latitude 5420").
    models: models.filter(m => /[a-z]/i.test(m.name) && (/\s/.test(m.name.trim()) || /\d/.test(m.name))).map(m => ({ name: m.name, key: norm(m.name), n: m.n })),
    places, sites: sites.map(s => s.name), locations: new Map(locs.map(l => [l.id, l.name])),
    holders, loadedAt: Date.now()
  };
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { load, invalidate, norm, PLACE_ALIASES };
