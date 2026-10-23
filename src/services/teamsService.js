// Microsoft Teams messages via an incoming webhook URL (a Teams "Workflows" webhook
// or a classic Incoming Webhook connector). Sends an Adaptive Card, which both accept.
const config = require('../config');

const isTeamsUrl = url => /^https:\/\/\S+$/i.test(String(url || '').trim());

// card: { title, text?, facts?: [[label, value]], lines?: [string], link?: { title, url } }
function buildCard({ title, text, facts = [], lines = [], link }) {
  const body = [{ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: String(title || 'IT-HAMS'), wrap: true }];
  if (text) body.push({ type: 'TextBlock', text: String(text), wrap: true, spacing: 'Small' });
  if (facts.length) {
    body.push({ type: 'FactSet', facts: facts.map(([t, v]) => ({ title: String(t), value: String(v ?? '—') })) });
  }
  for (const line of lines.slice(0, 25)) body.push({ type: 'TextBlock', text: String(line), wrap: true, spacing: 'Small' });
  const target = link || { title: 'Open IT-HAMS', url: config.appUrl };
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard', version: '1.4', body,
        actions: [{ type: 'Action.OpenUrl', title: target.title, url: target.url }]
      }
    }]
  };
}

// Returns { ok, status?, error? }; never throws.
async function post(url, card) {
  if (!isTeamsUrl(url)) return { ok: false, error: 'Teams webhook URL must start with https://' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(String(url).trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCard(card)),
      signal: controller.signal
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `Teams returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Teams did not respond within 10 seconds' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { post, buildCard, isTeamsUrl };
