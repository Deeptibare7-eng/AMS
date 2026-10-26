// Task-graph runner for the orchestrator. A node runs as soon as its dependencies are done;
// independent nodes run side by side (up to `concurrency` at a time). Each node has a timeout and
// retries with a short back-off. Pure: no database (the orchestrator records the trace via onStep).
//   node: { id, agent, deps: [ids], run: async (ctx, attempt) => output, timeoutMs, retries, always }
//     always: run even when a dependency failed or was skipped (e.g. resolving whatever claims exist).
//     An error with retryable === false is not retried; a timeout is not retried either.
// Returns one result per node, in the nodes' order:
//   { id, agent, deps, status: 'done' | 'failed' | 'timeout' | 'skipped', attempts, output, error, started, finished, ms }

class DagError extends Error {}

// Checks ids and dependencies; returns a topological order (throws on a cycle).
function validate(nodes) {
  const ids = new Set();
  for (const n of nodes) {
    if (!n || !n.id || ids.has(n.id)) throw new DagError(`Missing or duplicate node id: ${n && n.id}`);
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const d of n.deps || []) if (!ids.has(d)) throw new DagError(`Node "${n.id}" depends on unknown node "${d}"`);
  }
  const indegree = new Map(nodes.map(n => [n.id, (n.deps || []).length]));
  const children = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) for (const d of n.deps || []) children.get(d).push(n.id);
  const queue = nodes.filter(n => !indegree.get(n.id)).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const c of children.get(id)) {
      indegree.set(c, indegree.get(c) - 1);
      if (!indegree.get(c)) queue.push(c);
    }
  }
  if (order.length !== nodes.length) throw new DagError('The task graph has a cycle');
  return order;
}

// Longest path from a root to each node: nodes on the same level can run side by side.
function levels(nodes) {
  const order = validate(nodes);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const level = new Map();
  for (const id of order) level.set(id, Math.max(-1, ...(byId.get(id).deps || []).map(d => level.get(d))) + 1);
  return level;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${ms} ms`), { timeout: true })), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function runNode(n, ctx, opts) {
  const res = { id: n.id, agent: n.agent, deps: n.deps || [], attempts: 0, output: null, error: null, started: new Date() };
  const retries = n.retries ?? opts.retries ?? 1;
  for (;;) {
    res.attempts++;
    try {
      res.output = await withTimeout(Promise.resolve().then(() => n.run(ctx, res.attempts)), n.timeoutMs ?? opts.timeoutMs);
      res.status = 'done';
      res.error = null;
      break;
    } catch (err) {
      res.error = String((err && err.message) || err).slice(0, 1000);
      if (err && err.timeout) { res.status = 'timeout'; break; }
      if (res.attempts > retries || (err && err.retryable === false)) { res.status = 'failed'; break; }
      await sleep((opts.backoffMs ?? 100) * res.attempts);
    }
  }
  res.finished = new Date();
  res.ms = res.finished - res.started;
  return res;
}

async function run(nodes, ctx = {}, opts = {}) {
  validate(nodes);
  const concurrency = Math.max(1, opts.concurrency || 4);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const results = new Map();
  const pending = new Set(nodes.map(n => n.id));
  const running = new Map();
  const report = async r => {
    results.set(r.id, r);
    if (opts.onStep) { try { await opts.onStep(r); } catch (_) { /* a trace write must not stop the run */ } }
  };
  const done = id => results.has(id) && results.get(id).status === 'done';
  while (pending.size || running.size) {
    let started = false;
    for (const id of [...pending]) {
      const n = byId.get(id);
      const deps = n.deps || [];
      if (!deps.every(d => results.has(d))) continue;
      if (!n.always && !deps.every(done)) {
        pending.delete(id);
        const failed = deps.filter(d => !done(d));
        await report({ id, agent: n.agent, deps, status: 'skipped', attempts: 0, output: null, error: `Skipped: ${failed.join(', ')} did not finish`, started: null, finished: null, ms: 0 });
        started = true;
        continue;
      }
      if (running.size >= concurrency) continue;
      pending.delete(id);
      running.set(id, runNode(n, ctx, opts).then(async r => { running.delete(id); await report(r); }));
      started = true;
    }
    if (running.size) await Promise.race(running.values());
    else if (!started && pending.size) throw new DagError('The task graph stalled');
  }
  return nodes.map(n => results.get(n.id));
}

module.exports = { run, validate, levels, DagError };
