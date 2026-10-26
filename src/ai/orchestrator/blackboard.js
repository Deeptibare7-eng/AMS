// The shared context of one orchestrator run (a "blackboard"). Agents read what earlier agents
// posted and add their own results:
//   post / get   named results (e.g. LifecycleCostAgent posts 'risk', MaintenanceAgent reads it)
//   claim        "this field of this target should be X, this sure, because ..." (resolved later)
//   finding      something for a person to look at (a possible duplicate, an unusual asset)
//   decisions    what the orchestrator made of the claims
// Stored with the run (trimmed) so the trace shows exactly what each agent contributed.

const MAX_WHY = 5;

class Blackboard {
  constructor(input = {}) {
    this.input = input;
    this.entries = {};
    this.claims = [];
    this.findings = [];
    this.decisions = [];
    this.proposals = [];
  }

  post(agent, key, value) {
    this.entries[key] = { agent, value };
    return value;
  }

  get(key) {
    return this.entries[key] ? this.entries[key].value : undefined;
  }

  // { agent, target_type, target_id, field, value, label, current, current_label, confidence, why }
  claim(c) {
    const confidence = Number(c.confidence);
    if (!(confidence >= 0 && confidence <= 1)) throw new Error('A claim needs a confidence between 0 and 1');
    if (!c.agent || !c.target_type || !c.field || c.value === undefined) throw new Error('A claim needs an agent, a target, a field and a value');
    this.claims.push({
      ...c,
      value: c.value === null ? null : String(c.value),
      current: c.current === null || c.current === undefined ? null : String(c.current),
      confidence,
      why: [].concat(c.why || []).map(String).filter(Boolean).slice(0, MAX_WHY)
    });
  }

  // { agent, severity: 'high' | 'medium' | 'low' | 'info', text, target_type, target_id }
  finding(f) {
    this.findings.push({ severity: 'info', ...f, text: String(f.text || '').slice(0, 300) });
  }

  // What the run keeps: everything, with long values cut to fit the trace.
  toJSON() {
    const cut = (v, n) => {
      const s = JSON.stringify(v === undefined ? null : v);
      return s.length > n ? { _truncated: true, preview: s.slice(0, n) } : v;
    };
    return {
      input: cut(this.input, 2000),
      entries: Object.fromEntries(Object.entries(this.entries).map(([k, e]) => [k, { agent: e.agent, value: cut(e.value, 3000) }])),
      claims: this.claims.slice(0, 50),
      findings: this.findings.slice(0, 50),
      decisions: this.decisions.slice(0, 50),
      proposals: this.proposals.slice(0, 50)
    };
  }
}

module.exports = Blackboard;
