// `node bin/hams-cli.js ai:eval [cutoff | search | lifecycle | anomaly | cost | nl]`: measures the AI on the real
// register, read-only.
// 1. Intake classifier, time split (train on assets bought before the cut-off, test on newer).
// 2. Data-health scan dry run: what it would find, score and propose, without writing anything.
// 3. Smart search: old search vs BM25F on labelled queries generated from the register.
// 4. Refresh risk (held-out assets, baselines, calibration) and unusual assets (corrupted copies).
// 5. Cost forecast backtest and refresh plans; questions in plain language (intent, entities, SQL safety).
const db = require('../../core/db');
const intakeEval = require('./intakeEval');
const searchEval = require('./searchEval');
const riskEval = require('./riskEval');
const costEval = require('./costEval');
const nlEval = require('./nlEval');
const dataHealth = require('../quality/dataHealth');
const fixes = require('../quality/fixes');
const rules = require('../quality/rules');

async function dataHealthDryRun() {
  const t0 = Date.now();
  const a = await db.tx(async t => { await t.run('SET TRANSACTION READ ONLY'); return dataHealth.analyse(t); });
  const grades = { Good: 0, Fair: 0, Poor: 0 };
  for (const s of a.scored) grades[rules.grade(s.score)]++;
  const recs = [...fixes.categoryGroups(a), ...fixes.catalogFixes(a)];
  const lines = [`Data-health dry run: ${a.scored.length} active assets in ${((Date.now() - t0) / 1000).toFixed(1)} s, average score ${a.avg}.`,
    `Grades: ${grades.Good} good (90+), ${grades.Fair} fair (70-89), ${grades.Poor} poor (<70).`, '', 'Issues (assets affected):'];
  for (const [code, n] of Object.entries(a.issueCounts).sort((x, y) => y[1] - x[1])) {
    const r = rules.BY_CODE.get(code);
    lines.push(`  ${String(n).padStart(6)}  ${r.label} [${r.severity}]`);
  }
  lines.push('', 'Modules:');
  for (const m of a.modules) lines.push(`  ${m.module.padEnd(12)} ${String(m.score).padStart(3)}  ` + m.checks.map(c => `${c.label} ${c.ok}/${c.total}`).join('; '));
  lines.push('', `Catalog: ${a.findings.model_category_fixes.length} model categor(ies) to fix, ${a.findings.model_variants.length} duplicate spelling group(s), ${a.findings.supplier_groups.length} supplier group(s).`);
  lines.push(`AI Approvals: ${recs.length} fix(es) would be proposed (${recs.filter(r => r.type === 'dq.fix_category').length} asset groups covering ${recs.filter(r => r.type === 'dq.fix_category').reduce((s, r) => s + r.proposed.assets, 0)} assets, ${recs.filter(r => r.type !== 'dq.fix_category').length} catalog).`);
  return lines.join('\n');
}

// arg: a cut-off date for the intake split, or one part only: "search", "lifecycle", "anomaly", "cost" or "nl".
async function main(arg = '2024-01-01') {
  const only = ['search', 'lifecycle', 'anomaly', 'cost', 'nl'].includes(arg) ? arg : null;
  if (only === 'cost') { console.log(costEval.format(await costEval.run())); return; }
  if (only === 'nl') { console.log(nlEval.format(await nlEval.run())); return; }
  if (!only) {
    const r = await intakeEval.run({ cutoff: arg });
    console.log(intakeEval.format(r));
    console.log('\n' + await dataHealthDryRun() + '\n');
  }
  if (!only || only === 'search') console.log(searchEval.format(await searchEval.run()) + '\n');
  if (!only || only === 'lifecycle' || only === 'anomaly') {
    const rows = await riskEval.load();
    if (only !== 'anomaly') console.log(riskEval.formatLifecycle(await riskEval.lifecycle(rows)) + '\n');
    if (only !== 'lifecycle') console.log(riskEval.formatAnomaly(await riskEval.anomaly(rows)));
  }
  if (!only) console.log('\n' + costEval.format(await costEval.run()));
  if (!only) console.log('\n' + nlEval.format(await nlEval.run()));
}

module.exports = { main, dataHealthDryRun };
