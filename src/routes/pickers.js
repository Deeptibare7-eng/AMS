// Type-to-search endpoints behind components/picker.ejs. They replace <select>
// lists that rendered every user/asset (7,000+ / 16,000+ options) on each page,
// or silently cut off at the first 1,000 rows.
const express = require('express');
const db = require('../core/db');
const authz = require('../services/authorizationService');
const { authRequired, currentUser } = require('../middleware/auth');

const router = express.Router();
const LIMIT = 20;

// Staff-only: the caller needs at least one of these permissions.
function anyPerm(...perms) {
  return async (req, res, next) => {
    try {
      const user = await currentUser(req);
      for (const p of perms) if (await authz.can(p, user)) return next();
      res.status(403).json({ ok: false, message: 'Forbidden' });
    } catch (err) { next(err); }
  };
}

const term = req => `%${String(req.query.q || '').trim().slice(0, 100)}%`;

router.get('/api/pick/users', authRequired, anyPerm('assets.view', 'inventory.view', 'personnel.view'), async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT id, name, email, employee_id FROM users
        WHERE deleted_at IS NULL AND (name ILIKE $1 OR email ILIKE $1 OR employee_id ILIKE $1)
        ORDER BY name ASC LIMIT ${LIMIT}`, [term(req)]);
    // Email, else CTID, as the hint after the name (imported employees are named by CTID and have no email).
    res.json({ ok: true, results: rows.map(u => {
      const hint = [u.email, u.employee_id].find(x => x && x !== u.name);
      return { id: u.id, label: hint ? `${u.name} (${hint})` : u.name };
    }) });
  } catch (err) { next(err); }
});

router.get('/api/pick/assets', authRequired, anyPerm('assets.view', 'inventory.view'), async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT id, name, asset_tag FROM assets
        WHERE deleted_at IS NULL AND (name ILIKE $1 OR asset_tag ILIKE $1 OR serial_number ILIKE $1)
        ORDER BY name ASC LIMIT ${LIMIT}`, [term(req)]);
    res.json({ ok: true, results: rows.map(a => ({ id: a.id, label: `${a.name} (${a.asset_tag})` })) });
  } catch (err) { next(err); }
});

// Hardware "Quick assign": only assets that can actually be checked out —
// unassigned and in stock (same status rule as assetService.checkoutAsset).
router.get('/api/pick/instock-assets', authRequired, anyPerm('assets.checkout'), async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT a.id, a.name, a.asset_tag, a.serial_number, l.name AS location FROM assets a
        LEFT JOIN status_labels sl ON a.status_label_id = sl.id
        LEFT JOIN locations l ON l.id = a.location_id
        WHERE a.deleted_at IS NULL AND a.assigned_to IS NULL
          AND LOWER(COALESCE(sl.name, a.status, '')) IN ('available', 'in stock', 'ready to deploy', 'ready')
          AND (a.name ILIKE $1 OR a.asset_tag ILIKE $1 OR a.serial_number ILIKE $1 OR a.model_number ILIKE $1)
        ORDER BY a.name ASC, a.asset_tag ASC LIMIT ${LIMIT}`, [term(req)]);
    res.json({ ok: true, results: rows.map(a => ({ id: a.id, label: `${a.name} (${a.asset_tag}${a.serial_number ? ' · ' + a.serial_number : ''}${a.location ? ' · ' + a.location : ''})` })) });
  } catch (err) { next(err); }
});

// Maintenance: same rule as the old list — no lost, retired or disposed assets (including
// any archived status, e.g. the register's "Retired - ..." statuses).
router.get('/api/pick/maintainable-assets', authRequired, anyPerm('maintenance.view', 'assets.view'), async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT a.id, a.name, a.asset_tag FROM assets a
        LEFT JOIN status_labels sl ON a.status_label_id = sl.id
        WHERE a.deleted_at IS NULL
          AND LOWER(COALESCE(sl.name, a.status, '')) NOT IN ('lost', 'retired', 'disposed')
          AND COALESCE(sl.type, '') <> 'archived'
          AND (a.name ILIKE $1 OR a.asset_tag ILIKE $1 OR a.serial_number ILIKE $1)
        ORDER BY a.name ASC LIMIT ${LIMIT}`, [term(req)]);
    res.json({ ok: true, results: rows.map(a => ({ id: a.id, label: `${a.name} (${a.asset_tag})` })) });
  } catch (err) { next(err); }
});

// Employee self-service: only unassigned assets, and only name/tag (same data the old list showed).
router.get('/api/pick/requestable-assets', authRequired, anyPerm('requests.view', 'requests.create'), async (req, res, next) => {
  try {
    const rows = await db.query(
      `SELECT id, name, asset_tag FROM assets
        WHERE assigned_to IS NULL AND deleted_at IS NULL AND (name ILIKE $1 OR asset_tag ILIKE $1)
        ORDER BY name ASC LIMIT ${LIMIT}`, [term(req)]);
    res.json({ ok: true, results: rows.map(a => ({ id: a.id, label: `${a.name} (${a.asset_tag})` })) });
  } catch (err) { next(err); }
});

// Stock ledger item: value is "<module>:<id>" like the old <select>.
const STOCK_MODULES = {
  assets: ['Hardware Asset', 'assets', "COALESCE(asset_tag, '') || ' ' || COALESCE(serial_number, '')"],
  accessories: ['Accessory', 'accessories', "COALESCE(serial_number, '')"],
  consumables: ['Consumable', 'consumables', "''"],
  components: ['Component', 'components', "COALESCE(serial_number, '')"]
};
router.get('/api/pick/stock-items', authRequired, anyPerm('inventory.view', 'assets.view'), async (req, res, next) => {
  try {
    const results = [];
    for (const [key, [label, table, extra]] of Object.entries(STOCK_MODULES)) {
      const rows = await db.query(
        `SELECT id, name FROM ${table} WHERE deleted_at IS NULL AND (name ILIKE $1 OR ${extra} ILIKE $1)
          ORDER BY name ASC LIMIT 8`, [term(req)]);
      for (const r of rows) results.push({ id: `${key}:${r.id}`, label: `[${label}] ${r.name}` });
    }
    res.json({ ok: true, results });
  } catch (err) { next(err); }
});

module.exports = router;
