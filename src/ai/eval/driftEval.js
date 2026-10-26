// Drift on the real register (read-only): would the drift check notice how the fleet changes?
// For each checked model's features, assets bought before the cut-off are the reference and
// assets bought since are "today", so the report shows which features move as the fleet is renewed
// and by how much (PSI, KS). The live check compares the whole register with what a version was
// trained on, which moves more slowly than this.
const db = require('../../core/db');
const drift = require('../governance/drift');
const { SPECS } = require('../governance/driftSpecs');

async function run({ cutoff = '2024-01-01' } = {}) {
  const out = [];
  for (const [name, s] of Object.entries(SPECS)) {
    const rows = await db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return s.load(t); });
    const year = r => (r.purchase_date ? Number(String(r.purchase_date).slice(0, 4)) : r.bought || null);
    const cut = Number(cutoff.slice(0, 4));
    const before = rows.filter(r => year(r) && year(r) < cut);
    const since = rows.filter(r => year(r) && year(r) >= cut);
    if (before.length < 50 || since.length < 50) { out.push({ name, label: s.label, skipped: `${before.length} before / ${since.length} since` }); continue; }
    // Purchase year and age obviously move with this split: leave them out.
    const spec = s.spec.filter(f => !/purchase year|age/.test(f.name));
    const base = drift.profile(before, spec);
    const cmp = drift.compare(base, drift.profile(since, spec, new Date(), base));
    out.push({ name, label: s.label, before: before.length, since: since.length, ...cmp });
  }
  return { cutoff, models: out };
}

function format(r) {
  const lines = [`Drift on the real register (read-only): assets bought before ${r.cutoff} as the reference, bought since as "today" (purchase year and age left out).`];
  for (const m of r.models) {
    if (m.skipped) { lines.push(`  ${m.label}: not enough assets (${m.skipped}).`); continue; }
    lines.push(`  ${m.label}: ${m.status} (max PSI ${m.max_psi.toFixed(2)}; ${m.before.toLocaleString('en-IN')} before, ${m.since.toLocaleString('en-IN')} since)`);
    for (const f of m.features) lines.push(`    ${(f.feature + (f.discrete ? ' (few values)' : '')).padEnd(24)} PSI ${f.psi.toFixed(3)} ${f.status.padEnd(11)}${f.ks_d !== null ? ` KS D ${f.ks_d.toFixed(2)} p ${f.ks_p < 0.001 ? '<0.001' : f.ks_p.toFixed(3)}` : ''}  ${f.shifts.join('; ')}`);
  }
  return lines.join('\n');
}

module.exports = { run, format };
