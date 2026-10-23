// From what a question was understood as (entities.js slots + intent) to Hardware list filters:
// query-string pairs for /assets, each from a fixed list of keys with checked values, plus the chips
// shown above the list ("Laptop", "In Pune", "Warranty ends next month"), each removable on its own.
// The list then runs through the normal assetService filters: parameterised, location-scoped.
const rules = require('../quality/rules');

const STATE_PARAMS = {
  stock: [['label_type', 'deployable'], ['assigned', '0']],
  assigned: [['assigned', '1']],
  retired: [['label_type', 'archived']],
  repair: [['label_type', 'undeployable']],
  returned: [['site', '_returned']]
};
const SORT_TEXT = { oldest: 'Oldest first', newest: 'Newest first', cost_high: 'Most expensive first', cost_low: 'Cheapest first', risk: 'Highest refresh risk first' };

// slots + intent -> { chips: [{ label, params: [[key, value], ...] }], params: [[key, value], ...] }
function build(slots, intent, v, { residual = '' } = {}) {
  const chips = [];
  const chip = (label, params) => { if (params.length) chips.push({ label, params }); };
  for (const c of slots.category || []) chip(`Category: ${c.name}`, [['category_id', String(c.id)]]);
  for (const m of slots.maker || []) chip(`Maker: ${m.name}`, [['manufacturer_id', String(m.id)]]);
  if (slots.model && slots.model.length) chip(`Model: ${slots.model.map(m => m.name).join(' or ')}`, slots.model.map(m => ['model', m.name]));
  for (const p of slots.place || []) {
    const parts = [];
    if (p.sites.length) parts.push(`site ${p.sites.join(', ')}`);
    if (p.locations.length) parts.push(`${p.locations.length === 1 ? 'Asset Location ' + v.locations.get(p.locations[0]) : p.locations.length + ' Asset Locations'}`);
    chip(`In ${p.said}: ${parts.join(' or ')}`, [...p.sites.map(s => ['near_site', s]), ...p.locations.map(id => ['near_location', String(id)])]);
  }
  if (slots.status) {
    if (slots.status.state === 'lost') {
      const lost = v.labels.filter(l => /lost|stolen|abscond/i.test(l.name));
      chip(slots.status.text, lost.map(l => ['status_label_id', String(l.id)]));
    } else chip(slots.status.text, STATE_PARAMS[slots.status.state] || []);
  }
  if (slots.holder) chip(`Assigned to ${slots.holder.name}`, [['holder', String(slots.holder.id)]]);
  if (slots.warranty) chip(slots.warranty.text, [...(slots.warranty.from ? [['warranty_from', slots.warranty.from]] : []), ...(slots.warranty.to ? [['warranty_to', slots.warranty.to]] : [])]);
  if (slots.bought) chip(slots.bought.text, [...(slots.bought.from ? [['bought_from', slots.bought.from]] : []), ...(slots.bought.to ? [['bought_to', slots.bought.to]] : [])]);
  if (slots.ram) chip(slots.ram.text, [...(slots.ram.min ? [['ram_min', String(slots.ram.min)]] : []), ...(slots.ram.max ? [['ram_max', String(slots.ram.max)]] : [])]);
  if (slots.os) chip(slots.os.text, [['os', slots.os.value]]);
  if (slots.issue) { const r = rules.BY_CODE.get(slots.issue); chip(`Data issue: ${r ? r.label : slots.issue}`, [['dq', slots.issue]]); }
  if (intent === 'refresh') chip('Refresh risk: high (50%+ chance of retirement in 12 months)', [['ai', 'refresh_high']]);
  if (intent === 'unusual') chip('Flagged as unusual for its model', [['ai', 'unusual']]);
  const sort = slots.sort || (intent === 'refresh' ? 'risk' : null);
  if (sort) chip(SORT_TEXT[sort], [['sort', sort]]);
  if (residual) chip(`Text: "${residual}"`, [['search', residual]]);
  return { chips, params: chips.flatMap(c => c.params) };
}

// A Hardware URL for these params (with the question kept for the banner).
function url(params, question = null) {
  const qs = new URLSearchParams();
  for (const [k, v] of params) qs.append(k, v);
  if (question) qs.set('asked', String(question).slice(0, 200));
  return '/assets?' + qs.toString();
}

module.exports = { build, url, STATE_PARAMS, SORT_TEXT };
