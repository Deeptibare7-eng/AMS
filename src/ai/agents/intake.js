// IntakeAgent (asset register): does an asset's category and maker fit its name and model number,
// and is it a possible duplicate? Uses the intake model (M2) and the duplicate checks.
// It claims what it reads (the recorded value when they agree, so it can confirm as well as
// contest) and reports duplicates as findings. It never edits the asset.
const Agent = require('./agent');
const db = require('../../core/db');

const NAME = 'IntakeAgent';
const THRESHOLDS = { claim: 0.6 };
const FIELDS = { category_id: 'category_name', manufacturer_id: 'manufacturer_name' };

function make() {
  return new Agent({
    name: NAME,
    goal: 'Check that an asset\'s category and maker fit its name and model number, and catch possible duplicates.',
    tools: {
      suggest: input => require('../intake/suggest').suggest(input),
      duplicates: input => require('../quality/duplicates').checkCandidate(db, input)
    },
    input: ['asset'],
    output: ['claims', 'findings'],
    thresholds: THRESHOLDS,
    escalation: 'Never edits the asset. What it reads differently goes to the orchestrator as a claim; possible duplicates go to a person as findings.'
  });
}

async function reviewAsset(agent, bb, asset) {
  const cf = asset.custom_fields_data || {};
  const s = await agent.use('suggest', {
    name: asset.name, model_number: asset.model_number, serial_number: asset.serial_number,
    manufacturer_id: asset.manufacturer_id, location_id: asset.location_id
  });
  const out = { ready: !!s.ready, claims: 0, duplicates: 0 };
  if (s.ready) {
    for (const sug of s.suggestions || []) {
      if (!FIELDS[sug.field] || sug.confidence < THRESHOLDS.claim) continue;
      bb.claim({
        agent: NAME, target_type: 'asset', target_id: asset.id, field: sug.field,
        value: sug.value, label: sug.label, current: asset[sug.field], current_label: asset[FIELDS[sug.field]],
        confidence: sug.confidence, why: sug.why
      });
      out.claims++;
    }
  } else out.note = s.message;
  const dups = await agent.use('duplicates', {
    serial_number: asset.serial_number || '', fams: cf['FAMS No. / Barcode'] || '', machine_name: cf['Machine Name'] || '', exclude_id: asset.id
  });
  for (const d of dups) {
    bb.finding({ agent: NAME, severity: d.confidence >= 1 ? 'high' : 'medium', text: `Possible duplicate: ${d.reason}, ${d.asset_tag} (${d.name})`, target_type: 'asset', target_id: d.id });
    out.duplicates++;
  }
  return out;
}

module.exports = { NAME, make, reviewAsset, THRESHOLDS };
