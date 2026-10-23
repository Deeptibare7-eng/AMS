// What every AI agent declares (M6 starts with the AssistantAgent; M7 adds the others and the
// orchestrator that routes requests and events to them):
//   goal         one sentence
//   tools        a whitelist: name -> async function that calls EXISTING services (read-only unless
//                the tool proposes through AI Approvals); an agent can only act through these
//   input / output  the fields it takes and returns (checked)
//   thresholds   confidence levels for acting, asking back, and falling back
//   escalation   what it does when it can't or mustn't act (hand over to a person or a page)
class Agent {
  constructor({ name, goal, tools, input, output, thresholds, escalation }) {
    Object.assign(this, { name, goal, tools, input, output, thresholds, escalation });
    this.calls = [];
  }

  // Runs a whitelisted tool and records the call (for the answer's "how I got this").
  async use(tool, args) {
    if (!Object.prototype.hasOwnProperty.call(this.tools, tool)) throw new Error(`${this.name}: tool "${tool}" is not on its whitelist`);
    const t0 = Date.now();
    const out = await this.tools[tool](args);
    this.calls.push({ tool, ms: Date.now() - t0 });
    return out;
  }

  check(obj, fields, what) {
    for (const f of fields) if (!(f in obj)) throw new Error(`${this.name}: ${what} is missing "${f}"`);
    return obj;
  }

  describe() {
    return { name: this.name, goal: this.goal, tools: Object.keys(this.tools), input: this.input, output: this.output, thresholds: this.thresholds, escalation: this.escalation };
  }
}

module.exports = Agent;
