// Port of StockMovementService: movement ledger UI operations.
const db = require('../core/db');
const Paginator = require('../core/paginator');
const audit = require('./auditService');
const ledger = require('./movementLedgerService');
const { nullableId, HttpError, trimStr, intOr, listParam } = require('../core/helpers');

const MODULES = {
  assets: { label: 'Hardware Asset', table: 'assets', stock: null },
  accessories: { label: 'Accessory', table: 'accessories', stock: 'available_qty' },
  consumables: { label: 'Consumable', table: 'consumables', stock: 'remaining_qty' },
  components: { label: 'Component', table: 'components', stock: 'available_qty' }
};

const EXPORT_LABELS = { ...Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, v.label])), licenses: 'License' };
const EXPORT_TABLES = { ...Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, v.table])), licenses: 'licenses' };

async function itemName(moduleKey, itemId) {
  const table = EXPORT_TABLES[moduleKey];
  if (!table || !itemId) return `#${itemId}`;
  const row = await db.get(`SELECT name FROM ${table} WHERE id = $1`, [itemId]);
  return row ? row.name : `#${itemId}`;
}

// One page of the ledger. Item names / asset serial+tag come from LEFT JOINs in the
// same query (previously 1-2 extra queries per row, up to ~500 per page view).
async function movements(filters = {}, { page = 1, perPage = 50 } = {}) {
  const where = [];
  const params = [];
  let i = 1;
  // One module or a list (multi-select); unknown keys are ignored, none = all modules.
  const moduleKeys = listParam(filters.module_key || filters.module).filter(k => MODULES[k]);
  if (moduleKeys.length) { where.push(`sm.module_key = ANY($${i++}::text[])`); params.push(moduleKeys); }
  if (filters.item_id) { where.push(`sm.item_id = $${i++}`); params.push(parseInt(filters.item_id, 10)); }
  if (filters.search) {
    where.push(`(sm.reason ILIKE $${i} OR sm.reference ILIKE $${i} OR sm.notes ILIKE $${i} OR sm.module_key ILIKE $${i} OR sm.movement_type ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i += 1;
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await db.get(`SELECT COUNT(*)::int AS c FROM stock_movements sm ${whereSql}`, params)).c;
  const paginator = new Paginator(total, perPage, page);
  // Pick the page's ids first (index-only on created_at,id), then join just those rows,
  // so deep pages don't join every skipped row.
  const rows = await db.query(
    `WITH pg AS (
       SELECT sm.id FROM stock_movements sm ${whereSql}
       ORDER BY sm.created_at DESC, sm.id DESC LIMIT ${paginator.perPage} OFFSET ${paginator.offset})
     SELECT sm.*, u.name AS created_by_name,
            COALESCE(a.name, ac.name, cs.name, cp.name, li.name, '#' || sm.item_id) AS item_name,
            COALESCE(a.serial_number, '') AS serial_number, COALESCE(a.asset_tag, '') AS asset_tag
     FROM pg JOIN stock_movements sm ON sm.id = pg.id
     LEFT JOIN users u ON u.id = sm.created_by
     LEFT JOIN assets a ON sm.module_key = 'assets' AND a.id = sm.item_id
     LEFT JOIN accessories ac ON sm.module_key = 'accessories' AND ac.id = sm.item_id
     LEFT JOIN consumables cs ON sm.module_key = 'consumables' AND cs.id = sm.item_id
     LEFT JOIN components cp ON sm.module_key = 'components' AND cp.id = sm.item_id
     LEFT JOIN licenses li ON sm.module_key = 'licenses' AND li.id = sm.item_id
     ORDER BY sm.created_at DESC, sm.id DESC`,
    params);
  for (const r of rows) r.module_label = EXPORT_LABELS[r.module_key] || r.module_key;
  return { rows, paginator, total };
}

async function pageData(filters = {}, pageNum = 1) {
  const items = []; // items are picked via /api/pick/stock-items (type-to-search)
  const [locations, users, suppliers, currentAssets] = await Promise.all([
    db.query('SELECT id, name FROM locations ORDER BY name ASC'),
    Promise.resolve([]), // holder is picked via /api/pick/users (type-to-search)
    db.query('SELECT id, name FROM suppliers ORDER BY name ASC'),
    db.query(
      `SELECT a.id, a.name, a.asset_tag, a.serial_number, a.status, a.assigned_to,
              sl.name AS status_label_name, sl.color AS status_label_color,
              u.name AS assigned_to_name, l.name AS location_name
       FROM assets a
       LEFT JOIN status_labels sl ON a.status_label_id = sl.id
       LEFT JOIN users u ON a.assigned_to = u.id
       LEFT JOIN locations l ON a.location_id = l.id
       WHERE a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 50`) // the page shows 50
  ]);
  return {
    modules: MODULES,
    items,
    locations, users, suppliers,
    current_assets: currentAssets,
    ...(await (async () => {
      const m = await movements(filters, { page: pageNum });
      return { movements: m.rows, paginator: m.paginator, total: m.total };
    })()),
    filters: {
      module_key: listParam(filters.module_key || filters.module).filter(k => MODULES[k]),
      item_id: filters.item_id || '',
      search: filters.search || ''
    }
  };
}

function resolveItem(data) {
  if (data.item_ref && String(data.item_ref).includes(':')) {
    const [mk, id] = String(data.item_ref).split(':');
    return [mk, parseInt(id, 10) || 0];
  }
  return [data.module_key || 'assets', intOr(data.item_id, 0)];
}

async function applyQuantityChange(t, moduleKey, itemId, direction, qty) {
  const mod = MODULES[moduleKey];
  if (!mod || !mod.stock) return;
  if (direction === 'in') {
    await t.run(`UPDATE ${mod.table} SET ${mod.stock} = ${mod.stock} + $1, total_qty = total_qty + $1 WHERE id = $2`, [qty, itemId]);
  } else {
    const row = await t.get(`SELECT ${mod.stock} AS avail FROM ${mod.table} WHERE id = $1 FOR UPDATE`, [itemId]);
    if (!row || intOr(row.avail) < qty) throw new HttpError('Not enough stock available for this movement.', 422);
    await t.run(`UPDATE ${mod.table} SET ${mod.stock} = ${mod.stock} - $1 WHERE id = $2`, [qty, itemId]);
  }
}

async function create(data, userId) {
  const [moduleKey, itemId] = resolveItem(data);
  const direction = data.direction === 'out' ? 'out' : 'in';
  const quantity = Math.max(1, intOr(data.quantity, 1));
  const mod = MODULES[moduleKey];
  if (!mod) throw new HttpError('Invalid stock module selected.', 422);
  if (!itemId || !(await db.get(`SELECT id FROM ${mod.table} WHERE id = $1`, [itemId]))) {
    throw new HttpError('Selected stock item was not found.', 404);
  }
  await db.tx(async t => {
    await ledger.record({
      module_key: moduleKey, item_id: itemId,
      movement_type: data.movement_type || (direction === 'in' ? 'stock_in' : 'stock_out'),
      direction, quantity,
      from_location_id: nullableId(data.from_location_id),
      to_location_id: nullableId(data.to_location_id),
      holder_user_id: nullableId(data.holder_user_id),
      vendor_id: nullableId(data.vendor_id),
      effective_status: data.effective_status || null,
      reason: trimStr(data.reason), reference: trimStr(data.reference), notes: trimStr(data.notes),
      created_by: userId
    }, t);
    await applyQuantityChange(t, moduleKey, itemId, direction, quantity);
  });
  const name = await itemName(moduleKey, itemId);
  await audit.log(userId, 'STOCK_MOVEMENT',
    `${direction} movement recorded for ${moduleKey}: ${name}. Quantity: ${quantity}. Reason: ${trimStr(data.reason) || 'None'}`);
  return true;
}

async function update(id, data, userId) {
  const existing = await db.get('SELECT * FROM stock_movements WHERE id = $1', [id]);
  if (!existing) throw new HttpError('Stock movement not found.', 404);
  await db.run('UPDATE stock_movements SET reason=$1, reference=$2, notes=$3 WHERE id=$4',
    [trimStr(data.reason, existing.reason), trimStr(data.reference, existing.reference), trimStr(data.notes, existing.notes), id]);
  const name = await itemName(existing.module_key, existing.item_id);
  await audit.log(userId, 'STOCK_MOVEMENT_UPDATE',
    `Updated metadata for stock movement #${id} (${existing.module_key}: ${name})`);
  return true;
}

async function reverseQuantityChange(t, movement) {
  const mod = MODULES[movement.module_key];
  if (!mod || !mod.stock) return;
  const qty = intOr(movement.quantity, 1);
  if (movement.direction === 'in') {
    await t.run(
      `UPDATE ${mod.table} SET ${mod.stock} = GREATEST(0, ${mod.stock} - $1), total_qty = GREATEST(0, total_qty - $1) WHERE id = $2`,
      [qty, movement.item_id]);
  } else {
    await t.run(`UPDATE ${mod.table} SET ${mod.stock} = ${mod.stock} + $1 WHERE id = $2`, [qty, movement.item_id]);
  }
}

// Movements written by an assignment/issue can't be rolled back here: the
// assignment would stay open and the later return would add the stock twice.
const ASSIGNMENT_LINKED = `(related_assignment_id IS NOT NULL OR movement_type IN ('assigned', 'issued'))`;

async function rollback(id, userId) {
  const movement = await db.tx(async t => {
    // DELETE ... RETURNING inside the transaction: two concurrent rollbacks can't
    // both reverse the same movement.
    const row = await t.get('SELECT * FROM stock_movements WHERE id = $1 FOR UPDATE', [id]);
    if (!row) throw new HttpError('Stock movement not found.', 404);
    if (row.related_assignment_id || ['assigned', 'issued'].includes(row.movement_type)) {
      throw new HttpError('This movement belongs to an assignment. Check the item in instead of rolling it back.', 422);
    }
    const del = await t.get('DELETE FROM stock_movements WHERE id = $1 RETURNING *', [id]);
    if (del) await reverseQuantityChange(t, del);
    return del;
  });
  const name = await itemName(movement.module_key, movement.item_id);
  await audit.log(userId, 'STOCK_ROLLBACK',
    `Rolled back stock movement #${id} for ${movement.module_key}: ${name}. Quantity: ${movement.quantity}. Direction: ${movement.direction}`);
  return true;
}

async function bulkRollback(ids, userId) {
  ids = [...new Set(ids.map(Number).filter(Boolean))];
  if (!ids.length) return false;
  const rows = await db.tx(async t => {
    const deleted = await t.query(
      `DELETE FROM stock_movements WHERE id = ANY($1::int[]) AND NOT ${ASSIGNMENT_LINKED} RETURNING *`, [ids]);
    // Same reversal as a single rollback (keeps total_qty in step, never negative).
    for (const m of deleted) await reverseQuantityChange(t, m);
    return deleted;
  });
  if (!rows.length) return false;
  for (const m of rows) {
    const name = await itemName(m.module_key, m.item_id);
    await audit.log(userId, 'STOCK_ROLLBACK',
      `Rolled back stock movement #${m.id} (Bulk) for ${m.module_key}: ${name}. Quantity: ${m.quantity}. Direction: ${m.direction}`);
  }
  return true;
}

async function exportRows(ids) {
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length) return [];
  const rows = await db.query(
    `SELECT sm.*, u.name AS created_by_name,
            COALESCE(a.name, ac.name, cs.name, cp.name, li.name, '#' || sm.item_id) AS item_name
     FROM stock_movements sm
     LEFT JOIN users u ON u.id = sm.created_by
     LEFT JOIN assets a ON sm.module_key = 'assets' AND a.id = sm.item_id
     LEFT JOIN accessories ac ON sm.module_key = 'accessories' AND ac.id = sm.item_id
     LEFT JOIN consumables cs ON sm.module_key = 'consumables' AND cs.id = sm.item_id
     LEFT JOIN components cp ON sm.module_key = 'components' AND cp.id = sm.item_id
     LEFT JOIN licenses li ON sm.module_key = 'licenses' AND li.id = sm.item_id
     WHERE sm.id = ANY($1::int[]) ORDER BY sm.created_at DESC, sm.id DESC`, [ids]);
  for (const r of rows) r.module_label = EXPORT_LABELS[r.module_key] || r.module_key;
  return rows;
}

module.exports = { MODULES, pageData, movements, create, update, rollback, bulkRollback, exportRows };
