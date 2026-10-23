// Evaluation metrics, from their definitions.

function accuracy(yTrue, yPred) {
  if (!yTrue.length) return 0;
  let ok = 0;
  for (let i = 0; i < yTrue.length; i++) if (String(yTrue[i]) === String(yPred[i])) ok++;
  return ok / yTrue.length;
}

// Per-class precision, recall and F1, plus their unweighted (macro) averages over the classes
// that occur in yTrue, and the support-weighted F1.
function classification(yTrue, yPred) {
  const classes = [...new Set(yTrue.map(String))];
  const per = {};
  for (const c of classes) per[c] = { tp: 0, fp: 0, fn: 0, support: 0 };
  for (let i = 0; i < yTrue.length; i++) {
    const t = String(yTrue[i]), p = String(yPred[i]);
    per[t].support++;
    if (t === p) per[t].tp++;
    else {
      per[t].fn++;
      if (per[p]) per[p].fp++;
    }
  }
  let mp = 0, mr = 0, mf = 0, wf = 0;
  for (const c of classes) {
    const s = per[c];
    s.precision = s.tp + s.fp ? s.tp / (s.tp + s.fp) : 0;
    s.recall = s.tp + s.fn ? s.tp / (s.tp + s.fn) : 0;
    s.f1 = s.precision + s.recall ? (2 * s.precision * s.recall) / (s.precision + s.recall) : 0;
    mp += s.precision; mr += s.recall; mf += s.f1; wf += s.f1 * s.support;
  }
  const k = classes.length || 1;
  return {
    accuracy: accuracy(yTrue, yPred), macroPrecision: mp / k, macroRecall: mr / k, macroF1: mf / k,
    weightedF1: yTrue.length ? wf / yTrue.length : 0, perClass: per, n: yTrue.length
  };
}

// Share of rows whose true label is among the top-k predictions (each a ranked label list).
function topK(yTrue, ranked, k) {
  if (!yTrue.length) return 0;
  let ok = 0;
  for (let i = 0; i < yTrue.length; i++) if (ranked[i].slice(0, k).map(String).includes(String(yTrue[i]))) ok++;
  return ok / yTrue.length;
}

// Mean negative log-likelihood of the true label (probs: array of {label: p} objects).
function logLoss(yTrue, probs, eps = 1e-12) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) s -= Math.log(Math.max(eps, probs[i][String(yTrue[i])] || 0));
  return yTrue.length ? s / yTrue.length : 0;
}

// Expected calibration error: in confidence bins, |accuracy - mean confidence| weighted by bin size.
function calibrationError(confidences, correct, bins = 10) {
  const b = Array.from({ length: bins }, () => ({ n: 0, conf: 0, ok: 0 }));
  for (let i = 0; i < confidences.length; i++) {
    const idx = Math.min(bins - 1, Math.floor(confidences[i] * bins));
    b[idx].n++; b[idx].conf += confidences[i]; b[idx].ok += correct[i] ? 1 : 0;
  }
  let e = 0;
  for (const x of b) if (x.n) e += (x.n / confidences.length) * Math.abs(x.ok / x.n - x.conf / x.n);
  return e;
}

// Precision of predictions kept when confidence >= threshold, and how many are kept.
function precisionAtConfidence(confidences, correct, threshold) {
  let kept = 0, ok = 0;
  for (let i = 0; i < confidences.length; i++) if (confidences[i] >= threshold) { kept++; if (correct[i]) ok++; }
  return { threshold, coverage: confidences.length ? kept / confidences.length : 0, precision: kept ? ok / kept : 0 };
}

module.exports = { accuracy, classification, topK, logLoss, calibrationError, precisionAtConfidence };
