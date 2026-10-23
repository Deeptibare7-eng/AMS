// Contract every in-house model follows (algorithms are our own code; no LLM, no ML library).
//
//   train(rows, opts)  -> this        fit parameters from training rows
//   predict(input)     -> { value, confidence }      confidence is 0..1
//   explain(input)     -> [{ factor, text, weight }] top factors, plain language, most important first
//   evaluate(rows)     -> { metric: number, ... }    e.g. precision/recall/F1, AUC, MAE
//   toJSON()           -> plain params; fromJSON(params) rebuilds the model
//   save() / load()    -> through the model registry (ai_models); version is set by the registry
//
// Subclasses set a static modelName (the registry key) and implement the four methods.
class BaseModel {
  static modelName = 'base';

  constructor(params = null) {
    this.params = params;
    this.version = null;
    this.metrics = null;
  }

  get trained() { return this.params !== null && this.params !== undefined; }

  train() { throw new Error(`${this.constructor.name}.train() is not implemented`); }
  predict() { throw new Error(`${this.constructor.name}.predict() is not implemented`); }
  explain() { throw new Error(`${this.constructor.name}.explain() is not implemented`); }
  evaluate() { throw new Error(`${this.constructor.name}.evaluate() is not implemented`); }

  toJSON() { return this.params; }

  static fromJSON(params, { version = null, metrics = null } = {}) {
    const m = new this(params);
    m.version = version;
    m.metrics = metrics;
    return m;
  }

  async save(opts = {}) { return require('../governance/registry').save(this, opts); }
  static async load() { return require('../governance/registry').loadActive(this); }
}

module.exports = BaseModel;
