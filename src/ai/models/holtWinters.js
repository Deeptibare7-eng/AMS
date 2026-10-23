// Holt-Winters exponential smoothing for quarterly spend, our own code.
//
//   level   l_t = a (y_t - s_{t-m}) + (1 - a)(l_{t-1} + phi b_{t-1})          (additive seasons; "/" for multiplicative)
//   trend   b_t = b (l_t - l_{t-1}) + (1 - b) phi b_{t-1}                       (damped by phi)
//   season  s_t = g (y_t - l_t) + (1 - g) s_{t-m}
//   forecast h ahead: l + (phi + ... + phi^h) b, plus (or times) the season h steps on.
// The smoothing weights (a, b, g, phi) and the season form (none / additive / multiplicative) are
// picked by a grid search that minimises the one-step-ahead error on the history. Spend can't be
// negative, so forecasts and interval ends are cut at 0. The interval is the one-step error spread,
// widened with the horizon (sqrt(h)) - an approximation, honest about lumpy series.
//
// evaluate(): rolling-origin backtest against simple rules (same quarter last year, mean of the last
// four quarters, last quarter), each refitted with only the data before the quarter it predicts.
const BaseModel = require('./baseModel');

const GRID = {
  alpha: [0.1, 0.2, 0.3, 0.5, 0.7, 0.9],
  beta: [0, 0.05, 0.15, 0.3],
  gamma: [0, 0.1, 0.3, 0.5],
  phi: [0.8, 0.9, 0.98],
  seasonal: ['none', 'additive', 'multiplicative']
};

// One pass over the series: one-step errors and the final state.
function smooth(y, { alpha, beta, gamma, phi, seasonal, m }) {
  const n = y.length;
  const useS = seasonal !== 'none' && n >= 2 * m;
  const mult = seasonal === 'multiplicative';
  const first = y.slice(0, m), second = y.slice(m, 2 * m);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  let level = mean(first);
  let trend = useS && second.length === m ? (mean(second) - mean(first)) / m : (n > 1 ? (y[Math.min(n - 1, m)] - y[0]) / Math.min(n - 1, m) : 0);
  const season = Array.from({ length: m }, (_, i) => (!useS ? (mult ? 1 : 0) : mult ? (level > 0 ? first[i] / level : 1) : first[i] - level));
  if (mult && (level <= 0 || first.some(v => v <= 0))) return null; // multiplicative needs positive values
  const errors = [];
  for (let t = useS ? m : 1; t < n; t++) {
    const s = season[t % m];
    const pred = mult ? (level + phi * trend) * s : level + phi * trend + s;
    errors.push(y[t] - Math.max(0, pred));
    const prevLevel = level;
    level = alpha * (mult ? y[t] / (s || 1) : y[t] - s) + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
    if (useS) season[t % m] = mult ? gamma * (level > 0 ? y[t] / level : 1) + (1 - gamma) * s : gamma * (y[t] - level) + (1 - gamma) * s;
  }
  return { level, trend, season, errors, n, useS };
}

class HoltWinters extends BaseModel {
  static modelName = 'spend_holt_winters';

  // series: numbers, oldest first (one per quarter). m: season length.
  train(series, { m = 4, grid = GRID } = {}) {
    let best = null;
    for (const seasonal of grid.seasonal) {
      for (const alpha of grid.alpha) for (const beta of grid.beta) for (const phi of grid.phi) {
        for (const gamma of seasonal === 'none' ? [0] : grid.gamma) {
          const s = smooth(series, { alpha, beta, gamma, phi, seasonal, m });
          if (!s || s.errors.length < 2) continue;
          const sse = s.errors.reduce((a, e) => a + e * e, 0) / s.errors.length;
          if (!best || sse < best.sse) best = { sse, alpha, beta, gamma, phi, seasonal };
        }
      }
    }
    if (!best) throw new Error('Holt-Winters needs at least 3 values');
    const state = smooth(series, { ...best, m });
    const sigma = Math.sqrt(state.errors.reduce((a, e) => a + e * e, 0) / Math.max(1, state.errors.length - 1));
    this.params = { m, alpha: best.alpha, beta: best.beta, gamma: best.gamma, phi: best.phi, seasonal: best.seasonal, sigma,
      level: state.level, trend: state.trend, season: state.season, n: series.length };
    return this;
  }

  // Next h values: [{ step, value, low, high }] (an 80% band).
  forecast(h = 4) {
    const p = this.params;
    const out = [];
    let damp = 0;
    for (let k = 1; k <= h; k++) {
      damp += Math.pow(p.phi, k);
      const s = p.season[(p.n + k - 1) % p.m];
      const base = p.level + damp * p.trend;
      const v = Math.max(0, p.seasonal === 'multiplicative' ? base * s : base + (p.seasonal === 'additive' ? s : 0));
      const w = 1.2816 * p.sigma * Math.sqrt(k);
      out.push({ step: k, value: v, low: Math.max(0, v - w), high: v + w });
    }
    return out;
  }

  predict(h = 1) {
    const f = this.forecast(h);
    const last = f[f.length - 1];
    // Confidence: how narrow the band is next to the forecast (1 = tight, 0 = as wide as the value).
    return { value: last.value, confidence: last.value > 0 ? Math.max(0, 1 - (last.high - last.low) / (2 * last.value)) : 0, band: [last.low, last.high] };
  }

  explain() {
    const p = this.params;
    return [
      { factor: 'level', weight: p.alpha, text: `Recent quarters count ${Math.round(p.alpha * 100)}% towards the next one` },
      { factor: 'trend', weight: p.beta, text: p.beta > 0 ? `Trend followed, damped by ${p.phi}` : 'No trend' },
      { factor: 'season', weight: p.gamma, text: p.seasonal === 'none' ? 'No quarterly pattern found' : `A ${p.seasonal} quarterly pattern` }
    ];
  }

  // Rolling-origin backtest: for each index from `from` on, fit on the values before it and predict it.
  evaluate(series, { from, m = 4 } = {}) {
    return backtest(series, from, m);
  }
}

// The simple rules a forecast has to beat.
const RULES = {
  holt_winters: (hist, m) => new HoltWinters().train(hist, { m }).forecast(1)[0].value,
  same_quarter_last_year: (hist, m) => (hist.length >= m ? hist[hist.length - m] : hist[hist.length - 1]),
  mean_last_4: hist => hist.slice(-4).reduce((a, v) => a + v, 0) / Math.min(4, hist.length),
  last_quarter: hist => hist[hist.length - 1]
};

function backtest(series, from, m = 4) {
  const out = {};
  for (const [name, rule] of Object.entries(RULES)) {
    const errs = [];
    for (let t = from; t < series.length; t++) errs.push(series[t] - rule(series.slice(0, t), m));
    const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / (errs.length || 1);
    out[name] = { mae, bias: errs.reduce((a, e) => a + e, 0) / (errs.length || 1), quarters: errs.length };
  }
  const actual = series.slice(from);
  const mean = actual.reduce((a, v) => a + v, 0) / (actual.length || 1);
  for (const r of Object.values(out)) r.mae_share = mean ? r.mae / mean : null;
  return out;
}

module.exports = { HoltWinters, backtest, RULES };
