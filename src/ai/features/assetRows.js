// Asset rows for refresh risk and anomalies (read-only): the M1 feature columns plus the names and
// register fields those models explain themselves with. Plain values only (ISO dates), so the rows
// can be sent to a worker thread.
const { featureSql } = require('./assetFeatures');

// where: extra condition on assets "a" (e.g. 'a.id = $1'); params for it.
async function load(q, where = 'a.deleted_at IS NULL', params = []) {
  const rows = await q.query(
    `WITH f AS (${featureSql(where)})
     SELECT f.asset_id AS id, f.category_id, ac.name AS category, f.asset_model_id, am.name AS model,
            f.manufacturer_id, m.name AS maker, f.location_id, l.name AS location, f.stock_site,
            sl.name AS status, f.label_type, f.is_retired, f.retired_reason, f.holder_user_id, u.name AS holder,
            to_char(f.purchase_date, 'YYYY-MM-DD') AS purchase_date, to_char(f.warranty_expiry, 'YYYY-MM-DD') AS warranty_expiry,
            f.purchase_cost::float8 AS cost, f.ram_gb, f.os_family, f.os_eol, f.feature_hash, f.deleted,
            a.asset_tag, a.name, a.custom_fields_data->>'Processor' AS cpu,
            lower(btrim(COALESCE(a.custom_fields_data->>'Client Provided Asset', ''))) = 'yes' AS client_provided
       FROM f
       JOIN assets a ON a.id = f.asset_id
       LEFT JOIN asset_categories ac ON ac.id = f.category_id
       LEFT JOIN asset_models am ON am.id = f.asset_model_id
       LEFT JOIN manufacturers m ON m.id = f.manufacturer_id
       LEFT JOIN locations l ON l.id = f.location_id
       LEFT JOIN status_labels sl ON sl.id = f.status_label_id
       LEFT JOIN users u ON u.id = f.holder_user_id`, params);
  return rows.map(r => ({ ...r, cost: r.cost === null ? null : Number(r.cost) }));
}

// Age in years on a date (default today).
function ageYears(purchaseDate, now = Date.now()) {
  if (!purchaseDate) return null;
  return (now - Date.parse(purchaseDate + 'T00:00:00Z')) / (365.25 * 864e5);
}

module.exports = { load, ageYears };
