// Training rows for the intake classifier, read from the existing tables (read-only).
// Plain values only (ISO dates, string label ids) so rows can be sent to a worker thread.

async function loadRows(q) {
  const rows = await q.query(
    `SELECT a.id, a.name, a.model_number, a.serial_number, a.category_id, a.manufacturer_id, a.asset_model_id,
            to_char(a.purchase_date, 'YYYY-MM-DD') AS purchase_date
       FROM assets a
      WHERE a.deleted_at IS NULL AND COALESCE(a.name, '') <> ''`);
  return rows.map(r => ({
    id: r.id, name: r.name || '', model_number: r.model_number || '', serial_number: r.serial_number || '',
    category_id: r.category_id === null ? null : String(r.category_id),
    manufacturer_id: r.manufacturer_id === null ? null : String(r.manufacturer_id),
    asset_model_id: r.asset_model_id === null ? null : String(r.asset_model_id),
    purchase_date: r.purchase_date
  }));
}

// The Asset Models catalog, for model matching.
async function loadCatalog(q) {
  const rows = await q.query(`SELECT id, name, model_number, manufacturer_id, category_id FROM asset_models WHERE deleted_at IS NULL`);
  return rows.map(r => ({
    id: String(r.id), name: r.name || '', model_number: r.model_number || '',
    manufacturer_id: r.manufacturer_id === null ? null : String(r.manufacturer_id),
    category_id: r.category_id === null ? null : String(r.category_id)
  }));
}

// id -> name for the three targets (for messages and the evaluation report).
async function labelNames(q) {
  // One after another: q may be a single transaction client.
  const c = await q.query('SELECT id, name FROM asset_categories');
  const m = await q.query('SELECT id, name FROM manufacturers');
  const am = await q.query('SELECT id, name FROM asset_models');
  const map = rows => Object.fromEntries(rows.map(r => [String(r.id), r.name]));
  return { category: map(c), manufacturer: map(m), model: map(am) };
}

module.exports = { loadRows, loadCatalog, labelNames };
