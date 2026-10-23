// Licence compliance (capability 'compliance'): rules over the existing licence and software tables,
// run when asked (they are quick). With no licence or software records the engine is dormant and says
// so; it starts checking as soon as data arrives (Licences module or the software import).
// Findings are facts, not predictions: each says which rule, what was found and why it matters.
// Read-only.
const db = require('../../core/db');
const authz = require('../../services/authorizationService');

const RULES = [
  { code: 'over_allocated', severity: 'high', label: 'More seats in use than bought', about: 'Active assignments exceed the licence seats.' },
  { code: 'expired_in_use', severity: 'high', label: 'Expired licence still assigned', about: 'The licence has expired or been terminated but seats are still assigned.' },
  { code: 'subscription_ended_allocated', severity: 'high', label: 'Ended subscription still allocated', about: 'A software subscription ended but is still allocated to someone.' },
  { code: 'expiring_in_use', severity: 'medium', label: 'Licence in use expires within 60 days', about: 'Renew or plan the switch before it lapses.' },
  { code: 'renewal_due', severity: 'medium', label: 'Software renewal due within 30 days', about: 'Subscription end or renewal date is near.' },
  { code: 'held_by_leavers', severity: 'medium', label: 'Seats held by deactivated users or retired assets', about: 'These seats can be reclaimed.' },
  { code: 'duplicate_key', severity: 'medium', label: 'Same licence key on several licences', about: 'One key recorded more than once: a copy-paste error or an over-used key.' },
  { code: 'software_leaver', severity: 'medium', label: 'Software allocated to a deactivated user', about: 'The allocation can be reclaimed.' },
  { code: 'unused_seats', severity: 'low', label: 'Many seats never used', about: 'At least 5 seats (and a fifth of the licence) unused 90+ days after purchase.' },
  { code: 'seat_count_mismatch', severity: 'low', label: 'Available seats don\'t add up', about: 'Available seats differ from seats minus active assignments.' }
];
const BY_CODE = new Map(RULES.map(r => [r.code, r]));

async function scopeOf(user) { return user ? authz.locationScopeFor(user) : { global: true, location_ids: [] }; }

// Counts of the data the rules look at.
async function dataSize() {
  return db.get(
    `SELECT (SELECT COUNT(*) FROM licenses WHERE deleted_at IS NULL)::int AS licenses,
            (SELECT COUNT(*) FROM license_assignments WHERE revoked_at IS NULL)::int AS assignments,
            (SELECT COUNT(*) FROM software_assets)::int AS software`);
}

// All findings visible to the user: [{ code, severity, label, title, why, target, savings }].
async function check(user, { today = null } = {}) {
  const size = await dataSize();
  if (!size.licenses && !size.software) return { dormant: true, data: size, rules: RULES, findings: [], counts: {} };
  const scope = await scopeOf(user);
  const params = [today || new Date().toISOString().slice(0, 10)];
  let licScope = '';
  if (!scope.global) { params.push(scope.location_ids); licScope = ` AND l.location_id = ANY($2::int[])`; }
  const lic = await db.query(
    `SELECT l.id, l.name, l.seats, l.available_seats, l.license_key, l.purchase_cost::float8 AS cost,
            to_char(l.expiration_date, 'YYYY-MM-DD') AS expires, to_char(l.termination_date, 'YYYY-MM-DD') AS terminated,
            (COALESCE(l.purchase_date, l.created_at::date) <= $1::date - 90) AS settled,
            (SELECT COUNT(*) FROM license_assignments la WHERE la.license_id = l.id AND la.revoked_at IS NULL)::int AS active,
            (SELECT COUNT(*) FROM license_assignments la
               LEFT JOIN users u ON u.id = la.user_id LEFT JOIN assets a ON a.id = la.asset_id LEFT JOIN status_labels sl ON sl.id = a.status_label_id
              WHERE la.license_id = l.id AND la.revoked_at IS NULL
                AND ((la.user_id IS NOT NULL AND (u.id IS NULL OR u.deleted_at IS NOT NULL OR COALESCE(u.status, 'active') IN ('suspended', 'archived')))
                  OR (la.asset_id IS NOT NULL AND (a.id IS NULL OR a.deleted_at IS NOT NULL OR sl.type = 'archived' OR a.status = 'archived'))))::int AS leavers
       FROM licenses l WHERE l.deleted_at IS NULL${licScope}`, params);
  const findings = [];
  const add = (code, target, why, extra = {}) => {
    const r = BY_CODE.get(code);
    findings.push({ code, severity: r.severity, label: r.label, title: target.name, why, target, ...extra });
  };
  const todayStr = params[0];
  const inDays = (d, n) => d && d >= todayStr && d <= new Date(Date.parse(todayStr) + n * 864e5).toISOString().slice(0, 10);
  const keyCount = new Map();
  for (const l of lic) {
    const t = { type: 'license', id: l.id, name: l.name, url: `/inventory/licenses/${l.id}/history` };
    if (l.seats > 0 && l.active > l.seats) add('over_allocated', t, `${l.active} seats assigned, ${l.seats} bought`);
    const ended = [l.expires, l.terminated].filter(Boolean).filter(d => d < todayStr).sort()[0];
    if (ended && l.active > 0) add('expired_in_use', t, `Ended ${ended}; ${l.active} seat(s) still assigned`);
    if (!ended && inDays(l.expires, 60) && l.active > 0) add('expiring_in_use', t, `Expires ${l.expires}; ${l.active} seat(s) in use`);
    if (l.leavers > 0) add('held_by_leavers', t, `${l.leavers} seat(s) held by deactivated users or retired/deleted assets`);
    const unused = l.seats - l.active;
    if (l.settled && l.seats > 0 && unused >= 5 && unused >= l.seats / 5) {
      const savings = l.cost > 0 ? (l.cost / l.seats) * unused : null;
      add('unused_seats', t, `${unused} of ${l.seats} seats unused`, savings ? { savings } : {});
    }
    if (l.seats !== null && l.available_seats !== null && l.available_seats !== Math.max(0, l.seats - l.active)) {
      add('seat_count_mismatch', t, `Available ${l.available_seats}, but ${l.seats} seats − ${l.active} assigned = ${Math.max(0, l.seats - l.active)}`);
    }
    const key = String(l.license_key || '').trim().toLowerCase();
    if (key.length >= 5) { if (!keyCount.has(key)) keyCount.set(key, []); keyCount.get(key).push(l); }
  }
  for (const group of keyCount.values()) {
    if (group.length < 2) continue;
    const names = group.map(l => l.name).join(', ');
    for (const l of group) add('duplicate_key', { type: 'license', id: l.id, name: l.name, url: `/inventory/licenses/${l.id}/history` }, `The same key is on ${group.length} licences: ${names}`);
  }
  // Software subscriptions have no location id: only users who see every location get these.
  if (scope.global && size.software) {
    const sw = await db.query(
      `SELECT s.id, s.sw_name, s.edition_version, to_char(s.subscription_end_date, 'YYYY-MM-DD') AS ends, to_char(s.renewal_date, 'YYYY-MM-DD') AS renews,
              s.allocated_user_id, u.name AS user_name, (u.id IS NULL OR u.deleted_at IS NOT NULL OR COALESCE(u.status, 'active') IN ('suspended', 'archived')) AS user_gone
         FROM software_assets s LEFT JOIN users u ON u.id = s.allocated_user_id`);
    for (const s of sw) {
      const t = { type: 'software', id: s.id, name: [s.sw_name, s.edition_version].filter(Boolean).join(' '), url: '/software' };
      if (s.ends && s.ends < todayStr && s.allocated_user_id) add('subscription_ended_allocated', t, `Ended ${s.ends}; still allocated to ${s.user_name || 'a user'}`);
      const soon = [s.renews, s.ends].filter(d => inDays(d, 30)).sort()[0];
      if (soon && !(s.ends && s.ends < todayStr)) add('renewal_due', t, `Renewal or end on ${soon}`);
      if (s.allocated_user_id && s.user_gone) add('software_leaver', t, `Allocated to ${s.user_name || 'a removed user'}, who is no longer active`);
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.title.localeCompare(b.title));
  const counts = {};
  for (const f of findings) counts[f.code] = (counts[f.code] || 0) + 1;
  return { dormant: false, data: size, rules: RULES, findings, counts, savings: findings.reduce((s, f) => s + (f.savings || 0), 0) };
}

module.exports = { check, RULES, dataSize };
