// MaintenanceAgent (Operations & Maintenance): when a repair is logged, is the asset still worth
// repairing? It reads the asset's repair history (asset_maintenance) and the category's
// replacement cost, and claims "replace" after repeated or expensive repairs, "repair" when repairs
// are rare and cheap. The orchestrator weighs this against LifecycleCostAgent's view; a replace
// recommendation is a sign-off in AI Approvals and changes nothing.
// The register has no maintenance records yet, so on real data this agent has nothing to say.
const Agent = require('./agent');
const db = require('../../core/db');

const NAME = 'MaintenanceAgent';
const THRESHOLDS = { repairsToReplace: 2, costShareToReplace: 0.5 };

function make() {
  return new Agent({
    name: NAME,
    goal: 'When a repair is logged, say whether the asset is still worth repairing, from its repair history and cost.',
    tools: {
      history: id => db.query(
        `SELECT id, title, maintenance_type, status, start_date, completion_date, cost::float8 AS cost, created_at
           FROM asset_maintenance WHERE asset_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '24 months' ORDER BY created_at DESC`, [id]),
      unitCosts: () => require('../cost/forecast').unitCosts()
    },
    input: ['asset', 'maintenance_id'],
    output: ['claims', 'findings'],
    thresholds: THRESHOLDS,
    escalation: 'Never buys, retires or closes anything. Replacing is a recommendation a person signs off in AI Approvals.'
  });
}

async function reviewRepair(agent, bb, asset) {
  const rows = await agent.use('history', asset.id);
  const yearAgo = Date.now() - 365.25 * 864e5;
  const repairs = rows.filter(r => r.maintenance_type === 'repair');
  const recent = repairs.filter(r => new Date(r.start_date || r.created_at).getTime() >= yearAgo);
  const spent = repairs.reduce((s, r) => s + (r.cost || 0), 0);
  const unit = asset.category_name ? ((await agent.use('unitCosts'))[asset.category_name] || {}).cost || null : null;
  const share = unit ? spent / unit : null;
  bb.post(NAME, 'repairs', { last_12_months: recent.length, last_24_months: repairs.length, spent, replacement_cost: unit });
  if (!repairs.length) return { repairs: 0, note: 'No repairs recorded.' };
  const claim = (value, confidence, why) => bb.claim({
    agent: NAME, target_type: 'asset', target_id: asset.id, field: 'repair_or_replace',
    value, label: value === 'replace' ? 'Replace it' : 'Repair it', current: null, confidence, why
  });
  const money = v => require('../cost/forecast').money(v);
  const why = [`${recent.length} repair${recent.length === 1 ? '' : 's'} in the last 12 months (${repairs.length} in 24)`];
  if (spent) why.push(`Repairs so far cost ${money(spent)}${unit ? `, ${Math.round(share * 100)}% of a new ${asset.category_name.toLowerCase()} (${money(unit)})` : ''}`);
  if (recent.length > THRESHOLDS.repairsToReplace || (share !== null && share >= THRESHOLDS.costShareToReplace)) claim('replace', 0.8, why);
  else if (recent.length === THRESHOLDS.repairsToReplace) claim('replace', 0.65, why);
  else claim('repair', share !== null && share < 0.2 ? 0.7 : 0.6, why);
  return { repairs: repairs.length, recent: recent.length, spent, share };
}

module.exports = { NAME, make, reviewRepair, THRESHOLDS };
