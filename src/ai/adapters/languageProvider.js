// All AI-written text (insight summaries, explanations) goes through a LanguageProvider, so an
// optional LLM could be plugged in later without touching callers. The app must work fully with
// the built-in TemplateProvider: deterministic, offline, no API key. No LLM provider exists.
class LanguageProvider {
  get name() { return 'abstract'; }
  // template: text with {{key}} placeholders; data: values. Returns plain text (views escape it).
  async render() { throw new Error('LanguageProvider.render() is not implemented'); }
}

class TemplateProvider extends LanguageProvider {
  get name() { return 'template'; }

  async render(template, data = {}) {
    return String(template || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => {
      const v = data[k];
      return v === null || v === undefined ? '' : Array.isArray(v) ? joinList(v) : String(v);
    });
  }
}

// ['a', 'b', 'c'] -> 'a, b and c'
function joinList(items) {
  const xs = items.map(String).filter(Boolean);
  return xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const defaultProvider = new TemplateProvider();
function provider() { return defaultProvider; }

module.exports = { LanguageProvider, TemplateProvider, provider, joinList };
