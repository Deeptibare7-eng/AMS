// Feature snapshots: the AI layer's record of how each asset looked over time (the register itself
// keeps only the current state).
// - The first run in a calendar month writes a 'full' row for every asset. Other runs write a
//   'change' row only for assets whose features differ from their latest row (feature_hash).
//   A second run on the same day updates that day's row.
// - A difference between an asset's latest row and now becomes an ai_asset_events row (retired,
//   assigned, site_changed, ...) with precision 'snapshot': it happened between window_start and
//   now. It is skipped when the same event was already captured live (precision 'exact').
// - The very first run is the baseline: rows for every asset, no events.
// - Reads existing tables only; writes only ai_feature_snapshots and ai_asset_events, in one
//   transaction, one run at a time (advisory lock).
const db = require('../../core/db');
const { COLUMNS, featureSql } = require('./assetFeatures');

const LOCK_KEY = 70413;

// [event_type, condition on c (now) / p (latest row), from_value, to_value]
const CHANGES = [
  ['retired', 'c.is_retired AND NOT p.is_retired', 'p.status', 'c.retired_reason'],
  ['unretired', 'NOT c.is_retired AND p.is_retired', 'p.retired_reason', 'c.status'],
  ['assigned', 'c.holder_user_id IS NOT NULL AND c.holder_user_id IS DISTINCT FROM p.holder_user_id', 'p.holder_user_id::text', 'c.holder_user_id::text'],
  ['unassigned', 'c.holder_user_id IS NULL AND p.holder_user_id IS NOT NULL', 'p.holder_user_id::text', 'NULL'],
  ['status_changed', 'c.status_label_id IS DISTINCT FROM p.status_label_id',
    '(SELECT name FROM status_labels WHERE id = p.status_label_id)', '(SELECT name FROM status_labels WHERE id = c.status_label_id)'],
  ['site_changed', 'c.stock_site IS DISTINCT FROM p.stock_site', 'p.stock_site', 'c.stock_site'],
  ['location_changed', 'c.location_id IS DISTINCT FROM p.location_id', 'p.location_id::text', 'c.location_id::text'],
  ['deleted', 'c.deleted AND NOT p.deleted', 'NULL', 'NULL']
];

async function run({ trigger = 'schedule', full = null } = {}) {
  const t0 = Date.now();
  return db.tx(async t => {
    const lock = await t.get('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_KEY]);
    if (!lock.ok) return { skipped: true, summary: 'Skipped: a snapshot is already running.' };

    await t.run(`CREATE TEMP TABLE ai_cur ON COMMIT DROP AS ${featureSql()}`);
    await t.run(`CREATE TEMP TABLE ai_prev ON COMMIT DROP AS
      SELECT DISTINCT ON (asset_id) * FROM ai_feature_snapshots ORDER BY asset_id, snapshot_date DESC`);
    await t.run('CREATE UNIQUE INDEX ON ai_cur (asset_id)');
    await t.run('CREATE UNIQUE INDEX ON ai_prev (asset_id)');
    // Temp tables have no statistics until analysed; without them the joins below get poor plans.
    await t.run('ANALYZE ai_cur');
    await t.run('ANALYZE ai_prev');

    const isFull = full !== null ? !!full : !(await t.get(
      `SELECT 1 AS x FROM ai_feature_snapshots WHERE kind = 'full' AND snapshot_date >= date_trunc('month', CURRENT_DATE) LIMIT 1`));

    const events = await t.query(`
      INSERT INTO ai_asset_events (asset_id, event_type, occurred_at, window_start, precision, from_value, to_value, source)
      SELECT x.asset_id, x.event_type, CURRENT_TIMESTAMP, x.window_start, 'snapshot', x.from_value, x.to_value, 'snapshot'
        FROM (${CHANGES.map(([type, cond, from, to]) => `
          SELECT c.asset_id, '${type}'::varchar AS event_type, p.snapshot_date AS window_start, p.recorded_at AS since,
                 LEFT(${from}, 120) AS from_value, LEFT(${to}, 120) AS to_value
            FROM ai_cur c JOIN ai_prev p ON p.asset_id = c.asset_id
           WHERE ${cond}`).join('\n          UNION ALL')}
        ) x
       WHERE NOT EXISTS (SELECT 1 FROM ai_asset_events e
                          WHERE e.asset_id = x.asset_id AND e.event_type = x.event_type
                            AND e.precision = 'exact' AND e.occurred_at >= x.since)
      RETURNING event_type`);

    const cols = COLUMNS.join(', ');
    const written = await t.run(`
      INSERT INTO ai_feature_snapshots (snapshot_date, kind, asset_id, ${cols}, feature_hash)
      SELECT CURRENT_DATE, $1, c.asset_id, ${COLUMNS.map(k => 'c.' + k).join(', ')}, c.feature_hash
        FROM ai_cur c LEFT JOIN ai_prev p ON p.asset_id = c.asset_id
       WHERE $2::boolean OR p.asset_id IS NULL OR p.feature_hash <> c.feature_hash
      ON CONFLICT (asset_id, snapshot_date) DO UPDATE SET
        kind = CASE WHEN EXCLUDED.kind = 'full' THEN 'full' ELSE ai_feature_snapshots.kind END,
        ${COLUMNS.map(k => `${k} = EXCLUDED.${k}`).join(', ')},
        feature_hash = EXCLUDED.feature_hash, recorded_at = CURRENT_TIMESTAMP`,
      [isFull ? 'full' : 'change', isFull]);

    const assets = (await t.get('SELECT COUNT(*)::int AS n FROM ai_cur')).n;
    const byType = {};
    for (const e of events) byType[e.event_type] = (byType[e.event_type] || 0) + 1;
    const eventText = Object.keys(byType).length
      ? Object.entries(byType).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')
      : 'no lifecycle events';
    const ms = Date.now() - t0;
    return {
      trigger, kind: isFull ? 'full' : 'change', assets, written: written.rowCount, events: byType, ms,
      summary: `${isFull ? 'Full' : 'Change'} snapshot (${trigger}): ${written.rowCount} of ${assets} asset(s) recorded; ${eventText}; ${ms} ms.`
    };
  });
}

// For Settings > AI.
async function stats() {
  const s = await db.get(`SELECT COUNT(*)::int AS rows, COUNT(DISTINCT snapshot_date)::int AS dates,
                                 MIN(snapshot_date) AS first_date, MAX(snapshot_date) AS last_date,
                                 COUNT(DISTINCT asset_id)::int AS assets
                            FROM ai_feature_snapshots`);
  const events = await db.query(`SELECT event_type, precision, COUNT(*)::int AS n FROM ai_asset_events GROUP BY 1, 2 ORDER BY 3 DESC`);
  return { ...s, events };
}

module.exports = { run, stats, CHANGES };
