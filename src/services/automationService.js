// Port of AutomationEngine + rules CRUD.
// Rules: when <event> happens and all <conditions> match the event payload, run the
// <actions> (email, Microsoft Teams, in-app notification, webhook, log). Events are
// fired from the asset / user / request services and from the daily scheduler checks.
// fire() runs in the background so a slow or failing rule never blocks or breaks
// the operation that triggered it.
const { EventEmitter } = require('events');
const db = require('../core/db');
const logger = require('../core/logger');
const { e } = require('../core/helpers');

// Event key -> description shown when creating a rule.
const EVENTS = {
  'asset.created': 'An asset is registered',
  'asset.updated': 'An asset is edited',
  'asset.status_changed': 'An asset\'s status changes (e.g. to Broken or Lost)',
  'asset.deleted': 'An asset is deleted',
  'asset.checked_out': 'An asset is checked out to an employee',
  'asset.checked_in': 'An asset is returned',
  'user.deactivated': 'An employee is set to a non-active status (leaver)',
  'request.created': 'An employee submits an asset request',
  'request.approved': 'An asset request is approved',
  'warranty.expiring': 'Daily check: an asset\'s warranty ends in 90 / 60 / 30 days',
  'low_stock': 'Daily check: spare stock at a site falls below the minimum'
};

// Fields available in conditions and {{placeholders}}, per event family.
const FIELDS = {
  asset: ['asset_tag', 'name', 'serial_number', 'model', 'category', 'manufacturer', 'location', 'status', 'previous_status',
    'assigned_to', 'assigned_to_email', 'previous_holder', 'purchase_cost', 'warranty_expiry', 'days_left', 'actor'],
  user: ['name', 'email', 'employee_id', 'status', 'previous_status', 'location', 'devices_held', 'device_tags', 'actor'],
  request: ['title', 'requested_by', 'requested_by_email', 'category', 'status', 'actor'],
  low_stock: ['location', 'category', 'in_stock', 'threshold']
};
const fieldsFor = event => FIELDS[event.startsWith('asset.') || event === 'warranty.expiring' ? 'asset'
  : event.startsWith('user.') ? 'user' : event.startsWith('request.') ? 'request' : 'low_stock'];

const parseJson = (v, def) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || ''); } catch (_) { return def; }
};

async function getAllRules() {
  return db.query('SELECT * FROM automation_rules ORDER BY created_at DESC');
}

async function createRule(payload) {
  return db.insert(
    'INSERT INTO automation_rules (name, event_trigger, conditions, actions, is_active) VALUES ($1,$2,$3,$4,$5)',
    [payload.name || 'New Rule', payload.event_trigger || '', JSON.stringify(payload.conditions || []),
      JSON.stringify(payload.actions || []), payload.is_active ? true : false]);
}

async function deleteRule(id) {
  await db.run('DELETE FROM automation_rules WHERE id = $1', [id]);
  return true;
}

async function toggleRule(id) {
  await db.run('UPDATE automation_rules SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  return true;
}

async function recentLogs(limit = 25) {
  return db.query(
    `SELECT l.*, r.name AS rule_name, r.event_trigger FROM automation_logs l
       LEFT JOIN automation_rules r ON r.id = l.automation_rule_id
      ORDER BY l.created_at DESC, l.id DESC LIMIT $1`, [limit]);
}

function evaluateConditions(conditionsJson, payload) {
  const conditions = parseJson(conditionsJson, null);
  if (conditions === null) return true;
  if (!Array.isArray(conditions) || !conditions.length) return true;
  for (const c of conditions) {
    if (!(c.field in payload)) return false;
    const actual = payload[c.field];
    switch (c.operator || '=') {
      case '=': if (String(actual).toLowerCase() !== String(c.value).toLowerCase()) return false; break;
      case '!=': if (String(actual).toLowerCase() === String(c.value).toLowerCase()) return false; break;
      case '>': if (!(Number(actual) > Number(c.value))) return false; break;
      case '<': if (!(Number(actual) < Number(c.value))) return false; break;
      case 'contains': if (!String(actual).toLowerCase().includes(String(c.value).toLowerCase())) return false; break;
      default: return false;
    }
  }
  return true;
}

// "{{asset_tag}} went to {{status}}" -> values from the payload.
const fill = (tpl, payload) => String(tpl || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (payload[k] ?? '').toString());

// Payload fields worth showing in a message, in a stable order.
function shownFields(payload) {
  const order = [...new Set([...fieldsFor(payload.event || ''), ...Object.keys(payload)])];
  return order.filter(k => !['event', 'asset_id', 'user_id', 'request_id', 'previous_holder_id'].includes(k)
    && payload[k] !== null && payload[k] !== undefined && payload[k] !== '');
}
const label = k => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

function defaultSubject(payload) {
  const what = payload.asset_tag || payload.name || payload.title || payload.location || '';
  return `IT-HAMS: ${EVENTS[payload.event] || payload.event}${what ? ' — ' + what : ''}`;
}

async function executeActions(ruleId, actionsJson, payload) {
  // Required lazily: these services are only needed when a rule actually runs.
  const mailService = require('./mailService');
  const teams = require('./teamsService');
  const notifications = require('./notificationService');
  const actions = parseJson(actionsJson, []);
  for (const action of Array.isArray(actions) ? actions : []) {
    let status = 'success', message = '';
    try {
      const cfg = action.config || {};
      const subject = fill(cfg.subject || cfg.title, payload) || defaultSubject(payload);
      const extra = fill(cfg.message, payload);
      const fields = shownFields(payload);
      if (action.type === 'webhook') {
        if (!cfg.url) throw new Error('Webhook action missing url');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(cfg.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
        message = `Webhook delivered (HTTP ${res.status})`;
      } else if (action.type === 'log') {
        logger.info(`[Automation] ${fill(cfg.message, payload) || JSON.stringify(payload)}`);
        message = 'Logged';
      } else if (action.type === 'email') {
        const list = String(cfg.to || '').split(/[,;\s]+/).filter(Boolean);
        if (!list.length) throw new Error('Email action missing recipient');
        const text = [extra, ...fields.map(k => `${label(k)}: ${payload[k]}`)].filter(Boolean).join('\n');
        const html = `${extra ? `<p>${e(extra)}</p>` : ''}<table cellpadding="6" style="border-collapse:collapse;font:14px Arial,sans-serif">` +
          fields.map(k => `<tr><td style="color:#64748b;border-bottom:1px solid #e2e8f0">${e(label(k))}</td><td style="border-bottom:1px solid #e2e8f0"><b>${e(payload[k])}</b></td></tr>`).join('') +
          '</table><p style="color:#94a3b8;font:12px Arial,sans-serif">Sent by an IT-HAMS automation rule.</p>';
        const r = await mailService.send({ type: 'automation', to: list[0], cc: list.slice(1), subject, text, html,
          relatedType: 'automation_rule', relatedId: ruleId });
        if (r.status !== 'sent') throw new Error(`Email ${r.status}: ${r.error}`);
        message = `Email sent to ${list.join(', ')}`;
      } else if (action.type === 'teams') {
        const r = await teams.post(cfg.url, { title: subject, text: extra, facts: fields.map(k => [label(k), payload[k]]) });
        if (!r.ok) throw new Error(r.error);
        message = 'Teams message posted';
      } else if (action.type === 'notify') {
        const n = await notifications.sendToAdmins('automation', subject.slice(0, 250),
          [extra, ...fields.map(k => `${label(k)}: ${payload[k]}`)].filter(Boolean).join('\n'));
        message = `In-app notification sent to ${n} admin(s)`;
      } else {
        throw new Error(`Unknown action type: ${action.type}`);
      }
    } catch (err) {
      status = 'failed';
      message = String(err.message).slice(0, 65000);
    }
    await db.run(
      'INSERT INTO automation_logs (automation_rule_id, trigger_payload, status, message) VALUES ($1,$2,$3,$4)',
      [ruleId, JSON.stringify(payload), status, message]);
  }
}

async function activeRules(event) {
  return db.query('SELECT * FROM automation_rules WHERE is_active = TRUE AND event_trigger = $1', [event]);
}

async function dispatch(event, payload) {
  const rules = await activeRules(event);
  let matched = 0;
  for (const rule of rules) {
    if (evaluateConditions(rule.conditions, { event, ...payload })) {
      matched++;
      await executeActions(rule.id, rule.actions, { event, ...payload });
    }
  }
  return matched;
}

// In-process listeners (the AI layer, src/ai/events.js) also hear every event, without a rule.
// publish() alone is for events only listeners use (they are not rule triggers in EVENTS).
// Listeners get { event, meta, payload() }; payload() builds the full payload once, on demand.
const bus = new EventEmitter();
bus.setMaxListeners(50);

function publish(event, meta = {}, build = null) {
  if (!bus.listenerCount(event) && !bus.listenerCount('*')) return;
  let memo = null;
  const payload = () => (memo = memo || Promise.resolve(typeof build === 'function' ? build() : (build || meta)));
  setImmediate(() => {
    try {
      bus.emit(event, { event, meta, payload });
      bus.emit('*', { event, meta, payload });
    } catch (err) {
      logger.error(`[Automation] listener for ${event} failed: ${err.message}`);
    }
  });
}

// Fire an event in the background. `build` is a payload object or an async function
// returning one; it is only evaluated when at least one active rule (or listener) needs it.
function fire(event, build, meta = null) {
  publish(event, meta || (typeof build === 'function' ? {} : build || {}), build);
  setImmediate(async () => {
    try {
      const rules = await activeRules(event);
      if (!rules.length) return;
      const payload = typeof build === 'function' ? await build() : build;
      if (!payload) return;
      for (const rule of rules) {
        if (evaluateConditions(rule.conditions, { event, ...payload })) await executeActions(rule.id, rule.actions, { event, ...payload });
      }
    } catch (err) {
      logger.error(`[Automation] ${event} failed: ${err.message}`);
    }
  });
}

// Standard payload for an asset event (works for soft-deleted assets too).
async function assetPayload(id, extra = {}) {
  const a = await db.get(
    `SELECT a.id, a.asset_tag, a.name, a.serial_number, a.model_number, a.status, a.purchase_cost, a.warranty_expiry,
            COALESCE(c.name, a.category) AS category, m.name AS manufacturer, l.name AS location,
            sl.name AS status_label, u.name AS assigned_to, u.email AS assigned_to_email
       FROM assets a
       LEFT JOIN asset_categories c ON c.id = a.category_id
       LEFT JOIN manufacturers m ON m.id = a.manufacturer_id
       LEFT JOIN locations l ON l.id = a.location_id
       LEFT JOIN status_labels sl ON sl.id = a.status_label_id
       LEFT JOIN users u ON u.id = a.assigned_to
      WHERE a.id = $1`, [id]);
  if (!a) return null;
  const out = {
    asset_id: a.id, asset_tag: a.asset_tag, name: a.name, serial_number: a.serial_number, model: a.model_number,
    category: a.category, manufacturer: a.manufacturer, location: a.location, status: a.status_label || a.status,
    assigned_to: a.assigned_to, assigned_to_email: a.assigned_to_email,
    purchase_cost: a.purchase_cost === null ? null : Number(a.purchase_cost),
    warranty_expiry: a.warranty_expiry ? new Date(a.warranty_expiry).toISOString().slice(0, 10) : null,
    ...extra
  };
  if (extra.previous_holder_id) {
    const h = await db.get('SELECT name FROM users WHERE id = $1', [extra.previous_holder_id]);
    out.previous_holder = h ? h.name : null;
  }
  return out;
}

function assetEvent(event, id, extra = {}) {
  fire(event, () => assetPayload(id, extra), { asset_id: id, ...extra });
}

module.exports = {
  EVENTS, FIELDS, fieldsFor, getAllRules, createRule, deleteRule, toggleRule, recentLogs,
  dispatch, fire, publish, bus, assetEvent, assetPayload, evaluateConditions
};
