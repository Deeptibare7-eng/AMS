// Port of TimelineService: aggregated events per module/record.
const db = require('../core/db');

async function auditEvents(module, id) {
  return db.query(
    `SELECT l.created_at, l.action AS title, l.description, COALESCE(u.name, 'System') AS actor
     FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.description ~ ('(^|[^0-9])' || $1 || '([^0-9]|$)') ORDER BY l.created_at DESC LIMIT 100`,
    [String(parseInt(id, 10) || 0)]); // whole-number match: id 1 must not match "#12"
}

async function assetAssignments(id) {
  return db.query(
    `SELECT a.assigned_at AS created_at, 'Asset Checkout' AS title,
            'Checked out to ' || COALESCE(u.name, 'Unknown') AS description,
            COALESCE(outu.name, 'System') AS actor
     FROM assignments a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN users outu ON outu.id = a.checked_out_by
     WHERE a.asset_id = $1`, [id]);
}

async function assetMaintenance(id) {
  return db.query(
    `SELECT created_at, 'Maintenance: ' || title AS title, notes AS description, status AS actor
     FROM asset_maintenance WHERE asset_id = $1`, [id]);
}

async function stockMovements(module, id) {
  return db.query(
    `SELECT sm.created_at, 'Stock ' || UPPER(sm.direction) AS title,
            'Quantity ' || sm.quantity || ': ' || COALESCE(sm.reason, 'No reason') AS description,
            COALESCE(u.name, 'System') AS actor
     FROM stock_movements sm LEFT JOIN users u ON u.id = sm.created_by
     WHERE sm.module_key = $1 AND sm.item_id = $2`, [module, id]);
}

async function get(module, id) {
  let events = await auditEvents(module, id);
  if (module === 'assets') {
    events = events.concat(await assetAssignments(id), await assetMaintenance(id), await stockMovements('assets', id));
  } else if (['accessories', 'consumables', 'components', 'licenses'].includes(module)) {
    events = events.concat(await stockMovements(module, id));
  }
  events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return events;
}

module.exports = { get };
