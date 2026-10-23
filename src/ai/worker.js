// Runs CPU-heavy AI work (training, fleet scans) in a worker thread so the web process keeps
// answering requests. A task is a function exported by a module under src/ai; it receives plain
// data and returns plain data (structured-clone rules).
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const TASKS = {
  trainIntake: ['./intake/classifier', 'trainParams'],
  categoryOutOfFold: ['./quality/categoryCheck', 'outOfFold'],
  buildSearchIndex: ['./search/build', 'inWorker'],
  trainLifecycle: ['./lifecycle/risk', 'trainParams'],
  scoreAnomalies: ['./anomaly/detect', 'scoreAll']
};

function run(task, payload, { timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!TASKS[task]) return Promise.reject(new Error(`Unknown AI worker task: ${task}`));
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { task, payload } });
    const timer = setTimeout(() => { w.terminate(); reject(new Error(`AI task ${task} timed out`)); }, timeoutMs);
    w.once('message', msg => { clearTimeout(timer); msg.error ? reject(new Error(msg.error)) : resolve(msg.result); });
    w.once('error', err => { clearTimeout(timer); reject(err); });
    w.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`AI task ${task} stopped (exit ${code})`)); });
  });
}

if (!isMainThread && workerData && workerData.task) {
  try {
    const [mod, fn] = TASKS[workerData.task];
    Promise.resolve(require(path.join(__dirname, mod))[fn](workerData.payload))
      .then(result => parentPort.postMessage({ result }))
      .catch(err => parentPort.postMessage({ error: String(err && err.stack || err) }));
  } catch (err) {
    parentPort.postMessage({ error: String(err && err.stack || err) });
  }
}

module.exports = { run };
