// Refresh (retirement) risk: a Weibull model fitted to "current-status" data, our own code.
//
// The register says, for every asset, its age today and whether it has been retired, but not WHEN it
// was retired. For a Weibull time-to-retirement T with proportional covariate effects,
//     S(a | x) = P(T > a) = exp(-(a / lambda)^k * exp(beta . x)),
// the chance that an asset of age a is already retired is
//     P(retired | a, x) = 1 - exp(-exp(b0 + k * ln a + beta . x)),   b0 = -k ln lambda,
// i.e. a binary regression of "retired" on ln(age) and the covariates with the complementary log-log
// link. Its log-likelihood is concave, so Newton's method (IRLS) finds the maximum in a few steps and the
// Weibull shape k is the coefficient of ln(age). Covariates get an L2 penalty (asset models with few
// assets shrink towards their category).
//
// A single shape k can't follow a refresh policy (few laptops retired at 4 years, most by 6), so the
// shape may change at a few ages ("knots"): ln H(a) = b0 + k ln a + sum_j c_j max(0, ln a - ln t_j),
// i.e. Weibull pieces joined at t_j. That is still a cloglog regression (the hinges are extra columns).
// H is made non-decreasing (running maximum), as a cumulative hazard must be.
//
// From the fitted curve, the risk that an active asset of age a is retired within h more years is
//     1 - S(a + h) / S(a) = 1 - exp(-(H(a + h) - H(a)) * exp(beta . x)).
// One fit per category (laptops and desktops age differently); categories without enough retirements
// get no model.
const BaseModel = require('./baseModel');

const MIN_AGE = 1 / 12; // years (ln of a newer purchase date is not meaningful)
const DEFAULT_KNOTS = [3, 4, 5, 6, 8];

// ln(1 - e^-u) and its first two derivatives with respect to eta, where u = e^eta.
function terms(eta, event) {
  const u = Math.exp(Math.min(eta, 30));
  if (!event) return { ll: -u, g: -u, h: -u };
  const em1 = Math.expm1(u);                         // e^u - 1
  const ll = u > 30 ? -Math.exp(-u) : Math.log(-Math.expm1(-u)); // ln(1 - e^-u)
  const g = u / em1;                                 // d ll / d eta
  const h = u < 700 ? u * (em1 - u * (em1 + 1)) / (em1 * em1) : 0;  // d2 ll / d eta2 (<= 0)
  return { ll, g, h: Number.isFinite(h) ? h : 0 };
}

// Solves A x = b for a symmetric positive-definite A (Cholesky). A is a flat row-major array.
function solveSpd(A, b, p) {
  const L = new Float64Array(p * p);
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * p + j];
      for (let k = 0; k < j; k++) s -= L[i * p + k] * L[j * p + k];
      if (i === j) L[i * p + i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i * p + j] = s / L[j * p + j];
    }
  }
  const y = new Float64Array(p);
  for (let i = 0; i < p; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * p + k] * y[k]; y[i] = s / L[i * p + i]; }
  const x = new Float64Array(p);
  for (let i = p - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < p; k++) s -= L[k * p + i] * x[k]; x[i] = s / L[i * p + i]; }
  return x;
}

// The age part of the linear predictor: [ln a, hinge_1, ..., hinge_K] for knots t_j (years).
function ageColumns(age, knots) {
  const la = Math.log(Math.max(age, MIN_AGE));
  return [la, ...knots.map(t => Math.max(0, la - Math.log(t)))];
}

// Fits one stratum. rows: [{ age, event, feats: [names] }]. Returns { b0, k, c (per knot), knots, beta: {name: value}, ll, n, events, iterations }.
// l2 penalises the covariates, l2Shape the shape changes at the knots (keeps the curve smooth).
function fitStratum(rows, { l2 = 2, l2Shape = 0.5, knots = DEFAULT_KNOTS, minCount = 20, maxIter = 60 } = {}) {
  const count = new Map();
  for (const r of rows) for (const f of r.feats) count.set(f, (count.get(f) || 0) + 1);
  const names = [...count.keys()].filter(f => count.get(f) >= minCount).sort();
  const A = 1 + knots.length;           // age columns: ln a + hinges
  const first = 1 + A;                  // first covariate column
  const index = new Map(names.map((f, i) => [f, i + first]));
  const p = first + names.length;
  // Sparse design: column 0 = intercept, then the age columns, then 0/1 covariates.
  const X = rows.map(r => ({ age: ageColumns(r.age, knots), idx: r.feats.map(f => index.get(f)).filter(i => i !== undefined), y: r.event ? 1 : 0 }));
  const theta = new Float64Array(p);
  // Start: intercept from the overall rate at the median age, shape 3.
  const rate = Math.min(0.99, Math.max(0.01, X.reduce((s, x) => s + x.y, 0) / X.length));
  const medLa = X.map(x => x.age[0]).sort((a, b) => a - b)[X.length >> 1] || 0;
  theta[1] = 3;
  theta[0] = Math.log(-Math.log(1 - rate)) - 3 * medLa;
  const penalty = i => (i >= first ? l2 : i >= 2 ? l2Shape : 0);
  const eta = x => {
    let e = theta[0];
    for (let j = 0; j < A; j++) e += theta[1 + j] * x.age[j];
    for (const i of x.idx) e += theta[i];
    return e;
  };
  const objective = () => {
    let ll = 0;
    for (const x of X) ll += terms(eta(x), x.y).ll;
    for (let i = 2; i < p; i++) ll -= 0.5 * penalty(i) * theta[i] * theta[i];
    return ll;
  };
  let cur = objective();
  let it = 0;
  for (; it < maxIter; it++) {
    const grad = new Float64Array(p);
    const H = new Float64Array(p * p); // negative Hessian (positive definite)
    for (const x of X) {
      const { g, h } = terms(eta(x), x.y);
      const cols = [0];
      const vals = [1];
      for (let j = 0; j < A; j++) if (x.age[j] !== 0) { cols.push(1 + j); vals.push(x.age[j]); }
      for (const i of x.idx) { cols.push(i); vals.push(1); }
      for (let a = 0; a < cols.length; a++) {
        grad[cols[a]] += g * vals[a];
        for (let b = 0; b < cols.length; b++) H[cols[a] * p + cols[b]] -= h * vals[a] * vals[b];
      }
    }
    for (let i = 2; i < p; i++) { grad[i] -= penalty(i) * theta[i]; H[i * p + i] += penalty(i); }
    for (let i = 0; i < first; i++) H[i * p + i] += 1e-9;
    const step = solveSpd(H, grad, p);
    // Newton step with halving until the penalised log-likelihood improves.
    let t = 1, next = cur;
    const old = Float64Array.from(theta);
    for (let tries = 0; tries < 30; tries++) {
      for (let i = 0; i < p; i++) theta[i] = old[i] + t * step[i];
      next = objective();
      if (next >= cur - 1e-9) break;
      t /= 2;
    }
    const gain = next - cur;
    cur = next;
    if (Math.abs(gain) < 1e-7 * (1 + Math.abs(cur))) { it++; break; }
  }
  const beta = {};
  names.forEach((f, i) => { beta[f] = theta[i + first]; });
  return {
    b0: theta[0], k: theta[1], c: Array.from(theta.slice(2, first)), knots: knots.slice(), beta,
    ll: cur, n: rows.length, events: X.reduce((s, x) => s + x.y, 0), iterations: it
  };
}

// Baseline cumulative hazard H0(a) = exp(b0 + k ln a + sum c_j hinge_j), made non-decreasing: the
// running maximum over ages up to a (the curve is piecewise linear in ln a, so checking the knots
// below a and a itself is enough).
function baseHazard(m, age) {
  const lin = a => { const cols = ageColumns(a, m.knots); let e = m.b0 + m.k * cols[0]; for (let j = 0; j < m.knots.length; j++) e += m.c[j] * cols[j + 1]; return e; };
  let best = lin(age);
  for (const t of [MIN_AGE, ...m.knots]) if (t < age) best = Math.max(best, lin(t));
  return Math.exp(best);
}

class WeibullRisk extends BaseModel {
  static modelName = 'lifecycle_weibull';

  // rows: [{ stratum, age, event, feats }]. Strata with fewer than minEvents retirements or minRows
  // assets get no model. opts.l2 penalises covariates; knots: [] gives a plain Weibull. Covariates in
  // `positive` may only raise the risk: one that comes out lowering it is dropped and the stratum
  // refitted (a cohort artefact, not a reason to show anyone).
  train(rows, { l2 = 2, l2Shape = 0.5, knots = DEFAULT_KNOTS, minEvents = 50, minRows = 200, minCount = 20, positive = [] } = {}) {
    const by = new Map();
    for (const r of rows) { if (!by.has(r.stratum)) by.set(r.stratum, []); by.get(r.stratum).push(r); }
    const strata = {};
    for (const [s, rs] of by) {
      const events = rs.filter(r => r.event).length;
      if (rs.length < minRows || events < minEvents) continue;
      // Knots only where there are assets on both sides.
      const ages = rs.map(r => r.age);
      const kn = knots.filter(t => ages.filter(a => a < t).length >= 30 && ages.filter(a => a >= t).length >= 30);
      const dropped = new Set();
      let fit = fitStratum(rs, { l2, l2Shape, knots: kn, minCount });
      for (;;) {
        const wrong = positive.filter(f => fit.beta[f] !== undefined && fit.beta[f] < 0);
        if (!wrong.length) break;
        wrong.forEach(f => dropped.add(f));
        fit = fitStratum(rs.map(r => ({ ...r, feats: r.feats.filter(f => !dropped.has(f)) })), { l2, l2Shape, knots: kn, minCount });
      }
      fit.dropped = [...dropped];
      // Ages seen, for the confidence of a prediction: assets per half-year of age.
      const ageBins = {};
      for (const r of rs) { const b = Math.floor(r.age * 2); ageBins[b] = (ageBins[b] || 0) + 1; }
      strata[s] = { ...fit, ageBins, maxAge: Math.max(...ages) };
    }
    this.params = { l2, l2Shape, knots, positive, strata };
    return this;
  }

  stratum(s) { return this.params && this.params.strata[s] ? this.params.strata[s] : null; }

  // ln of the covariate multiplier: beta . x.
  linear(m, feats) { let e = 0; for (const f of feats) if (m.beta[f] !== undefined) e += m.beta[f]; return e; }

  // Cumulative hazard of this asset at age a.
  hazard(m, row, age) { return baseHazard(m, age) * Math.exp(this.linear(m, row.feats)); }

  // P(already retired at this age).
  probRetired(row) {
    const m = this.stratum(row.stratum);
    if (!m) return null;
    return 1 - Math.exp(-this.hazard(m, row, row.age));
  }

  // Risk that an active asset is retired within `years` more years: 1 - S(a + h) / S(a).
  risk(row, years) {
    const m = this.stratum(row.stratum);
    if (!m) return null;
    const a = Math.max(row.age, MIN_AGE);
    return 1 - Math.exp(-Math.max(0, this.hazard(m, row, a + years) - this.hazard(m, row, a)));
  }

  // Age by which half of such assets are retired (bisection on the non-decreasing hazard).
  medianAge(row) {
    const m = this.stratum(row.stratum);
    if (!m) return null;
    let lo = MIN_AGE, hi = 40;
    if (this.hazard(m, row, hi) < Math.LN2) return null;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (this.hazard(m, row, mid) < Math.LN2) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  // Confidence 0..1: how many assets of this category had a similar age (within half a year), times
  // how well the category's curve told retired from active on held-out assets (AUC 0.5 -> 0, 0.9+ -> 1;
  // set by the trainer as m.quality), lowered when the asset is older than nearly all the history.
  confidence(row) {
    const m = this.stratum(row.stratum);
    if (!m) return 0;
    const b = Math.floor(row.age * 2);
    const n = (m.ageBins[b - 1] || 0) + (m.ageBins[b] || 0) + (m.ageBins[b + 1] || 0);
    const c = (n / (n + 60)) * (m.quality === undefined ? 1 : m.quality);
    return row.age > m.maxAge ? c * 0.6 : c;
  }

  // value: risk within 12 months; confidence as above.
  predict(row) {
    const r = this.risk(row, 1);
    return { value: r, confidence: r === null ? 0 : this.confidence(row), risk6: this.risk(row, 0.5), risk24: this.risk(row, 2) };
  }

  // Factors: the covariates that change the risk, as hazard ratios, largest effect first.
  explain(row, labels = f => f) {
    const m = this.stratum(row.stratum);
    if (!m) return [];
    return row.feats.filter(f => m.beta[f] !== undefined && Math.abs(m.beta[f]) >= 0.1)
      .map(f => ({ factor: f, weight: m.beta[f], ratio: Math.exp(m.beta[f]), text: labels(f, Math.exp(m.beta[f])) }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  }

  // rows with known status -> Brier score, log loss, AUC and calibration of P(retired at this age).
  evaluate(rows) {
    return evaluateProbabilities(rows.map(r => ({ p: this.probRetired(r), y: r.event ? 1 : 0 })).filter(x => x.p !== null));
  }
}

// Brier score, log loss, ROC AUC, expected calibration error (10 bins) and the reliability table.
function evaluateProbabilities(xs) {
  const n = xs.length;
  if (!n) return { n: 0 };
  let brier = 0, logloss = 0, pos = 0;
  for (const { p, y } of xs) {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
    brier += (p - y) ** 2;
    logloss -= y ? Math.log(q) : Math.log(1 - q);
    pos += y;
  }
  // AUC by ranks (ties get the average rank).
  const sorted = xs.map((x, i) => [x.p, x.y, i]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && sorted[j + 1][0] === sorted[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (sorted[k][1]) rankSum += avg;
    i = j + 1;
  }
  const neg = n - pos;
  const auc = pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : null;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const { p, y } of xs) { const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += y; }
  let ece = 0;
  const reliability = bins.map((b, i) => {
    if (b.n) ece += (b.n / n) * Math.abs(b.p / b.n - b.y / b.n);
    return { bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, predicted: b.n ? b.p / b.n : null, observed: b.n ? b.y / b.n : null };
  });
  return { n, rate: pos / n, brier: brier / n, logloss: logloss / n, auc, ece, reliability };
}

// Non-parametric baseline: isotonic regression of "retired" on age (pool-adjacent-violators). For
// current-status data this is the maximum-likelihood estimate of the retirement curve.
function isotonicCurve(rows) {
  const sorted = rows.map(r => [r.age, r.event ? 1 : 0]).sort((a, b) => a[0] - b[0]);
  const blocks = [];
  for (const [age, y] of sorted) {
    blocks.push({ lo: age, hi: age, sum: y, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n >= blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop(); const a = blocks[blocks.length - 1];
      a.hi = b.hi; a.sum += b.sum; a.n += b.n;
    }
  }
  return age => {
    let lo = 0, hi = blocks.length - 1;
    if (!blocks.length) return null;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (blocks[mid].lo <= age) lo = mid; else hi = mid - 1; }
    return blocks[lo].sum / blocks[lo].n;
  };
}

module.exports = { WeibullRisk, fitStratum, baseHazard, evaluateProbabilities, isotonicCurve, terms, DEFAULT_KNOTS };
