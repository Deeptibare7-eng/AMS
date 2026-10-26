// What drift is measured on for each model that is trained once and then used for a while: the
// model's inputs (and, for the classifiers, the label mix), read from the register (read-only).
// The same loader runs at training time (the reference profile stored with the version) and in the
// daily drift check, so both sides are measured the same way.
const assetRows = require('../features/assetRows');

const YEAR = 365.25 * 864e5;
const yearsSince = d => (d ? (Date.now() - Date.parse(d)) / YEAR : null);

const SPECS = {
  intake_classifier: {
    label: 'Intake classifier',
    load: q => q.query(
      `SELECT ac.name AS category, m.name AS maker, a.name, a.model_number, EXTRACT(YEAR FROM a.purchase_date)::int AS bought
         FROM assets a LEFT JOIN asset_categories ac ON ac.id = a.category_id LEFT JOIN manufacturers m ON m.id = a.manufacturer_id
        WHERE a.deleted_at IS NULL AND COALESCE(a.name, '') <> ''`),
    spec: [
      { name: 'category', kind: 'cat', get: r => r.category },
      { name: 'maker', kind: 'cat', get: r => r.maker },
      { name: 'first word of the name', kind: 'cat', get: r => String(r.name || '').trim().split(/\s+/)[0].toLowerCase() || null },
      { name: 'has a model number', kind: 'cat', get: r => (String(r.model_number || '').trim() ? 'yes' : 'no') },
      { name: 'purchase year', kind: 'num', get: r => r.bought }
    ]
  },
  lifecycle_weibull: {
    label: 'Refresh-risk curves',
    load: async q => (await assetRows.load(q)).filter(r => !r.deleted),
    spec: [
      { name: 'category', kind: 'cat', get: r => r.category },
      { name: 'age (years)', kind: 'num', get: r => yearsSince(r.purchase_date) },
      { name: 'purchase cost', kind: 'num', get: r => r.cost },
      { name: 'RAM (GB)', kind: 'num', get: r => r.ram_gb },
      { name: 'OS family', kind: 'cat', get: r => r.os_family },
      { name: 'stock site', kind: 'cat', get: r => (r.stock_site && !String(r.stock_site).startsWith('_') ? r.stock_site : r.stock_site ? 'none' : null) },
      { name: 'retired', kind: 'cat', get: r => (r.is_retired ? 'retired' : 'active') }
    ]
  }
};

// The profile of the register now: the reference of a new version (stored in
// ai_models.training.profile), or, with base, today's data to compare with that reference.
async function profileFor(name, q, base = null) {
  const s = SPECS[name];
  if (!s) return null;
  const rows = await s.load(q);
  return require('./drift').profile(rows, s.spec, new Date(), base);
}

module.exports = { SPECS, profileFor };
