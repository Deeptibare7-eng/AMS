// The specialist agents, each tied to an existing module (Settings > AI lists them with their
// goal, tools, thresholds and escalation). An agent only works while the capability it builds on
// is on; the orchestrator leaves the others out of a run and says so in the trace.
const AGENTS = [
  { mod: require('./intake'), module: 'Asset register (Register Asset, imports)', needs: ['intake'] },
  { mod: require('./dataQuality'), module: 'All modules (Data Health)', needs: ['data_quality'] },
  { mod: require('./maintenance'), module: 'Operations & Maintenance', needs: [] },
  { mod: require('./anomaly'), module: 'Alerts', needs: ['anomaly'] },
  { mod: require('./lifecycleCost'), module: 'Finance / procurement (Refresh Planning, dashboard)', needs: ['lifecycle', 'cost'] },
  { mod: require('./compliance'), module: 'Licences and software', needs: ['compliance'] },
  { mod: require('./assistant'), module: 'Search (Ctrl+K, Hardware)', needs: ['nl'] },
  { mod: require('./report'), module: 'Dashboards (daily briefing)', needs: [] }
];

// needs: any one of the listed capabilities (none = works with Agents working together alone).
const available = (entry, on) => !entry.needs.length || entry.needs.some(k => on.has(k));

function describeAll(on = new Set()) {
  return AGENTS.map(e => ({ ...e.mod.make(null).describe(), module: e.module, needs: e.needs, available: available(e, on) }));
}

module.exports = { AGENTS, describeAll, available };
