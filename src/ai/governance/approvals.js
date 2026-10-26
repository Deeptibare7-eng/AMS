// AI Approvals: agents propose, people decide.
// - propose() stores a recommendation (title, plain-language why, confidence, the change it
//   proposes). One open recommendation per dedupe_key.
// - Accepting runs the handler registered for the recommendation's type. A handler makes the
//   change through the EXISTING service (assetService.updateAsset, ...), so location scope,
//   validation, stock ledger, audit log and events all apply exactly as for a manual change.
// - Every decision is written to the audit log (activity_logs) and kept as a training label
//   (ai_feedback). Nothing is ever applied without a person accepting it.
const db = require('../../core/db');
const audit = require('../../services/auditService');
const authz = require('../../services/authorizationService');
const flags = require('../flags');
const { HttpError } = require('../../core/helpers');

// type -> { label, capability, permission, apply(rec, user) -> result object }
// permission: what the same change needs when done by hand (e.g. 'assets.edit'); services don't
// check permissions themselves (routes do), so decide() checks it before applying.
const HANDLERS = new Map();

function registerHandler(type, { label, capability, permission = null, apply }) {
  if (typeof apply !== 'function') throw new Error(`Handler for ${type} needs apply()`);
  HANDLERS.set(type, { label: label || type, capability, permission, apply });
}
const handlerFor = type => HANDLERS.get(type) || null;

function cleanWhy(why) {
  return [].concat(why || []).map(w => (typeof w === 'string' ? { text: w } : w))
    .filter(w => w && w.text).slice(0, 8)
    .map(w => ({ text: String(w.text).slice(0, 300), ...(w.factor ? { factor: String(w.factor).slice(0, 60) } : {}) }));
}

// needs_review (agents disagree or are unsure) exists once ai_m7.sql is applied.
const reviewColumn = () => flags.hasTable('ai_runs');

// The proposed change without what varies from run to run (scores, which agents backed it), as
// canonical JSON: two recommendations that would make the same change compare equal.
const VOLATILE = new Set(['score', 'confidence', 'share', '_agents']);
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter(k => !VOLATILE.has(k)).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
let suppressed = 0;

// Returns the new id, or null when the capability is off or the same recommendation is already open.
async function propose(rec) {
  const h = handlerFor(rec.type);
  if (!h) throw new Error(`No handler registered for recommendation type "${rec.type}"`);
  if (!(await flags.isOn(h.capability))) return null;
  const confidence = Number(rec.confidence);
  if (!(confidence >= 0 && confidence <= 1)) throw new Error('confidence must be between 0 and 1');
  const why = cleanWhy(rec.why);
  if (!why.length) throw new Error('A recommendation needs at least one plain-language reason (why).');
  // Rejecting teaches: the same change is not proposed again. If it has changed since (e.g. more
  // assets in the group, another value), it is, and says so.
  if (rec.dedupe_key) {
    const prev = await db.get(
      `SELECT id, proposed, decided_at FROM ai_recommendations WHERE dedupe_key = $1 AND status = 'rejected'
        ORDER BY decided_at DESC NULLS LAST, id DESC LIMIT 1`, [rec.dedupe_key]);
    if (prev) {
      if (stableJson(prev.proposed) === stableJson(rec.proposed || {})) { suppressed++; return null; }
      why.splice(Math.min(why.length, 7), 0, { text: `A similar recommendation (#${prev.id}) was rejected${prev.decided_at ? ' on ' + new Date(prev.decided_at).toISOString().slice(0, 10) : ''}; it has changed since, so it is shown again.` });
    }
  }
  const review = !!rec.needs_review && await reviewColumn();
  const row = await db.get(
    `INSERT INTO ai_recommendations (type, agent, target_type, target_id, location_id, site, title, why, proposed,
       confidence, model_name, model_version, dedupe_key, run_id, expires_at${review ? ', needs_review' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${review ? ', TRUE' : ''})
     ON CONFLICT (dedupe_key) WHERE status IN ('pending', 'applying') DO NOTHING
     RETURNING id`,
    [rec.type, rec.agent || 'system', rec.target_type, rec.target_id || null, rec.location_id || null, rec.site || null,
      String(rec.title || '').slice(0, 255), JSON.stringify(why), JSON.stringify(rec.proposed || {}),
      Math.round(confidence * 1000) / 1000, rec.model_name || null, rec.model_version || null,
      rec.dedupe_key || null, rec.run_id || null, rec.expires_at || null]);
  return row ? row.id : null;
}

// Who sees and decides what: super admins everything; staff with assets.view their role's location
// scope (all locations when none is set); Location SPOCs without assets.view only their own sites
// (the same rule as the Location Workspace).
async function scopeFor(user) {
  if (!user) return { none: true };
  if (await authz.isSuperAdmin(user)) return { all: true };
  if (await authz.can('assets.view', user)) {
    const s = await authz.locationScopeFor(user);
    return s.global ? { all: true } : { location_ids: s.location_ids };
  }
  const sites = (await db.query('SELECT site FROM site_spocs WHERE user_id = $1', [user.id])).map(r => r.site);
  return { sites };
}

function scopeSql(scope, params) {
  if (scope.all) return 'TRUE';
  if (scope.location_ids) { params.push(scope.location_ids); return `r.location_id = ANY($${params.length}::int[])`; }
  if (scope.sites && scope.sites.length) { params.push(scope.sites); return `r.site = ANY($${params.length}::text[])`; }
  return 'FALSE';
}

function inScope(scope, rec) {
  if (scope.all) return true;
  if (scope.location_ids) return rec.location_id !== null && scope.location_ids.includes(rec.location_id);
  if (scope.sites) return rec.site !== null && scope.sites.includes(rec.site);
  return false;
}

const OPEN_SQL = `r.status = 'pending' AND (r.expires_at IS NULL OR r.expires_at > CURRENT_TIMESTAMP)`;
const SORTS = { confidence: 'r.confidence DESC, r.created_at DESC', newest: 'r.created_at DESC', oldest: 'r.created_at ASC', least_sure: 'r.confidence ASC, r.created_at DESC' };

// filters (all optional, checked by the route): agent, type, review ('1': agents disagree or are
// unsure), min (confidence 0-1), location_id, q (text in the title), sort.
// Returns the page plus facets (agents and types with counts) for the filter menus.
async function list(user, { view = 'pending', page = 1, perPage = 25, filters = {} } = {}) {
  const scope = await scopeFor(user);
  const params = [];
  const base = [scopeSql(scope, params), view === 'decided' ? `r.status NOT IN ('pending', 'applying')` : OPEN_SQL];
  const facetWhere = base.join(' AND ');
  const facetParams = params.slice();
  const where = base.slice();
  // Each ? in sql is the one value (no JSONB ? operator is used here).
  const add = (sql, v) => { params.push(v); where.push(sql.split('?').join(`$${params.length}`)); };
  // An agent's own recommendations, and the orchestrator's that it backed.
  if (filters.agent) add(`(r.agent = ? OR r.proposed->'_agents' @> to_jsonb(?::text))`, filters.agent);
  if (filters.type) add('r.type = ?', filters.type);
  if (filters.min !== undefined && filters.min !== null && filters.min !== '') add('r.confidence >= ?', Number(filters.min));
  if (filters.location_id) add('r.location_id = ?', Number(filters.location_id));
  if (filters.q) add('r.title ILIKE ?', `%${String(filters.q).replace(/[\\%_]/g, '\\$&')}%`);
  const review = await reviewColumn();
  if (filters.review === '1' && review) where.push('r.needs_review');
  const sqlWhere = where.join(' AND ');
  const total = (await db.get(`SELECT COUNT(*)::int AS n FROM ai_recommendations r WHERE ${sqlWhere}`, params)).n;
  const offset = (Math.max(1, page) - 1) * perPage;
  const order = view === 'decided' ? 'r.decided_at DESC NULLS LAST' : (SORTS[filters.sort] || SORTS.confidence);
  const rows = await db.query(
    `SELECT r.*, u.name AS decided_by_name, l.name AS location_name FROM ai_recommendations r
       LEFT JOIN users u ON u.id = r.decided_by LEFT JOIN locations l ON l.id = r.location_id
      WHERE ${sqlWhere}
      ORDER BY ${order}, r.id DESC
      LIMIT ${perPage} OFFSET ${offset}`, params);
  const facet = col => db.query(`SELECT ${col} AS value, COUNT(*)::int AS n FROM ai_recommendations r WHERE ${facetWhere} GROUP BY 1 ORDER BY 2 DESC`, facetParams);
  const facets = {
    agents: await facet('r.agent'), types: (await facet('r.type')).map(t => ({ ...t, label: (handlerFor(t.value) || {}).label || t.value })),
    review: review ? (await db.get(`SELECT COUNT(*)::int AS n FROM ai_recommendations r WHERE ${facetWhere} AND r.needs_review`, facetParams)).n : 0,
    locations: await db.query(`SELECT l.id AS value, l.name AS label, COUNT(*)::int AS n FROM ai_recommendations r JOIN locations l ON l.id = r.location_id WHERE ${facetWhere} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50`, facetParams)
  };
  return { total, page: Math.max(1, page), perPage, facets, rows: rows.map(r => ({ ...r, handler_label: (handlerFor(r.type) || {}).label || r.type })) };
}

async function pendingCount(user) {
  const scope = await scopeFor(user);
  const params = [];
  return (await db.get(`SELECT COUNT(*)::int AS n FROM ai_recommendations r WHERE ${scopeSql(scope, params)} AND ${OPEN_SQL}`, params)).n;
}

async function feedback(rec, label, user, actual = null) {
  const h = handlerFor(rec.type);
  await db.run(
    `INSERT INTO ai_feedback (recommendation_id, capability, model_name, model_version, target_type, target_id, label, predicted, actual, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [rec.id, h ? h.capability : 'unknown', rec.model_name, rec.model_version, rec.target_type, rec.target_id, label,
      JSON.stringify(rec.proposed || {}), actual === null ? null : JSON.stringify(actual), user ? user.id : null]);
}

// decision: 'accept' | 'reject'. choice: for a recommendation with alternatives (agents that
// disagree), the option the person picked; a choice other than the proposed value is recorded as
// "edited". Returns the updated recommendation.
async function decide(id, decision, user, note = '', { choice = null } = {}) {
  if (!['accept', 'reject'].includes(decision)) throw new HttpError('Choose accept or reject.', 422);
  if (!user || !(await authz.can('ai.approve', user))) throw new HttpError('You do not have permission to decide AI recommendations.', 403);
  const rec = await db.get('SELECT * FROM ai_recommendations WHERE id = $1', [id]);
  if (!rec) throw new HttpError('Recommendation not found.', 404);
  if (!inScope(await scopeFor(user), rec)) throw new HttpError('This recommendation is outside your locations.', 403);
  const text = String(note || '').trim().slice(0, 1000) || null;

  if (decision === 'reject') {
    const done = await db.get(
      `UPDATE ai_recommendations SET status = 'rejected', decided_by = $2, decided_at = CURRENT_TIMESTAMP, decision_note = $3
        WHERE id = $1 AND status = 'pending' RETURNING *`, [id, user.id, text]);
    if (!done) throw new HttpError('This recommendation has already been decided.', 409);
    await feedback(done, 'rejected', user);
    await audit.log(user.id, 'AI_RECOMMENDATION_REJECTED', `AI recommendation #${id} (${rec.type}) rejected: ${rec.title}`);
    return done;
  }

  const h = handlerFor(rec.type);
  if (!h) throw new HttpError('This kind of recommendation can no longer be applied.', 422);
  if (!(await flags.isOn(h.capability))) throw new HttpError('This AI capability is switched off, so its recommendations cannot be applied.', 422);
  if (h.permission && !(await authz.can(h.permission, user))) {
    throw new HttpError(`Applying this needs the "${h.permission}" permission, the same as making the change by hand.`, 403);
  }
  // Claim it first so two people can't apply the same recommendation.
  const claimed = await db.get(
    `UPDATE ai_recommendations SET status = 'applying', decided_by = $2, decided_at = CURRENT_TIMESTAMP, decision_note = $3
      WHERE id = $1 AND status = 'pending' RETURNING *`, [id, user.id, text]);
  if (!claimed) throw new HttpError('This recommendation has already been decided.', 409);
  const edited = choice !== null && choice !== undefined && choice !== '' && String(choice) !== String((rec.proposed || {})._to_id);
  let result;
  try {
    result = await h.apply(claimed, user, { choice: edited ? choice : null });
  } catch (err) {
    await db.run(`UPDATE ai_recommendations SET status = 'failed', applied_result = $2 WHERE id = $1`,
      [id, JSON.stringify({ error: String(err.message).slice(0, 1000) })]);
    await audit.log(user.id, 'AI_RECOMMENDATION_FAILED', `AI recommendation #${id} (${rec.type}) could not be applied: ${err.message}`);
    throw new HttpError(`Could not apply the recommendation: ${err.message}`, err.status && err.status < 500 ? err.status : 422);
  }
  const status = edited ? 'edited' : 'accepted';
  const done = await db.get(
    `UPDATE ai_recommendations SET status = $3, applied_result = $2 WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(result || {}), status]);
  await feedback(done, status, user, result || null);
  await audit.log(user.id, edited ? 'AI_RECOMMENDATION_EDITED' : 'AI_RECOMMENDATION_ACCEPTED',
    `AI recommendation #${id} (${rec.type}) ${edited ? 'accepted with a different option' : 'accepted and applied'}: ${rec.title}${result && result.summary ? ` (${result.summary})` : ''}`);
  if (edited || rec.agent === 'Orchestrator') require('../orchestrator/weights').invalidate();
  return done;
}

// Several at once (bulk accept / reject in the inbox): each goes through decide() on its own, so
// permission, scope and "already decided" are checked per recommendation. Returns one result each.
async function decideMany(ids, decision, user, note = '') {
  const out = [];
  for (const id of [...new Set(ids)].slice(0, 100)) {
    try {
      const done = await decide(id, decision, user, note);
      out.push({ id, ok: true, status: done.status, summary: done.applied_result && done.applied_result.summary });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      out.push({ id, ok: false, error: err.message });
    }
  }
  return out;
}

module.exports = { registerHandler, handlerFor, propose, list, pendingCount, decide, decideMany, scopeFor, stableJson, suppressedCount: () => suppressed };
