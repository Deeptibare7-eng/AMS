// Live lifecycle capture: when an asset changes through the app (asset page, check-out/in,
// New Joinee allocation), record the event with its exact time. Bulk imports fire no per-asset
// events, so after an import a change-only snapshot catches those differences instead.
// Only while the 'snapshots' capability is on.
const db = require('../../core/db');
const logger = require('../../core/logger');
const events = require('../events');
const snapshots = require('./snapshots');

async function record(assetId, type, from = null, to = null) {
  await db.run(
    `INSERT INTO ai_asset_events (asset_id, event_type, occurred_at, precision, from_value, to_value, source)
     VALUES ($1, $2, CURRENT_TIMESTAMP, 'exact', LEFT($3, 120), LEFT($4, 120), 'event')`,
    [assetId, type, from === null ? null : String(from), to === null ? null : String(to)]);
}

async function current(assetId) {
  return db.get(
    `SELECT a.id, a.assigned_to, a.location_id, sl.name AS label, sl.type AS label_type
       FROM assets a LEFT JOIN status_labels sl ON sl.id = a.status_label_id WHERE a.id = $1`, [assetId]);
}

const IMPORT_DELAY_MS = 30000;
let importTimer = null;

function start() {
  events.on('asset.status_changed', 'snapshots', async ({ meta }) => {
    const a = meta && meta.asset_id ? await current(meta.asset_id) : null;
    if (!a) return;
    const prev = meta.previous_status
      ? await db.get('SELECT type FROM status_labels WHERE name = $1 LIMIT 1', [meta.previous_status]) : null;
    await record(a.id, 'status_changed', meta.previous_status || null, a.label);
    const wasRetired = prev && prev.type === 'archived';
    if (a.label_type === 'archived' && !wasRetired) await record(a.id, 'retired', meta.previous_status || null, a.label);
    if (a.label_type !== 'archived' && wasRetired) await record(a.id, 'unretired', meta.previous_status, a.label);
  });
  events.on('asset.checked_out', 'snapshots', async ({ meta }) => {
    const a = meta && meta.asset_id ? await current(meta.asset_id) : null;
    if (a && a.assigned_to) await record(a.id, 'assigned', null, a.assigned_to);
  });
  events.on('asset.checked_in', 'snapshots', async ({ meta }) => {
    if (meta && meta.asset_id) await record(meta.asset_id, 'unassigned', meta.previous_holder_id || null, null);
  });
  events.on('asset.deleted', 'snapshots', async ({ meta }) => {
    if (meta && meta.asset_id) await record(meta.asset_id, 'deleted');
  });
  // Several imports in a row (e.g. the folder import) give one snapshot shortly after the last.
  events.on('import.applied', 'snapshots', async () => {
    clearTimeout(importTimer);
    importTimer = setTimeout(() => {
      snapshots.run({ trigger: 'import' })
        .then(r => logger.info(`[AI] ${r.summary}`))
        .catch(err => logger.error(`[AI] snapshot after import failed: ${err.message}`));
    }, IMPORT_DELAY_MS);
    if (importTimer.unref) importTimer.unref();
  });
}

module.exports = { start, record };
