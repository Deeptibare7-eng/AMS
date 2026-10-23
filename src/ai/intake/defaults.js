// Smart defaults for Register Asset, from assets of the same catalog model (nearest neighbours by
// model, and by model + location for the supplier): the usual warranty term, the usual supplier
// and the typical cost. Each comes with how many assets it is based on and how consistent they are.
const MIN_PEERS = 3;
const inr = n => '₹' + Math.round(Number(n)).toLocaleString('en-IN');

async function warranty(q, modelId) {
  const rows = await q.query(`
    SELECT ROUND((a.warranty_expiry - COALESCE(
             CASE WHEN a.custom_fields_data->>'Warranty Start Date' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (a.custom_fields_data->>'Warranty Start Date')::date END,
             a.purchase_date)) / 30.4375)::int AS months, COUNT(*)::int AS n
      FROM assets a
     WHERE a.asset_model_id = $1 AND a.deleted_at IS NULL AND a.warranty_expiry IS NOT NULL
     GROUP BY 1 HAVING ROUND((a.warranty_expiry - COALESCE(
             CASE WHEN a.custom_fields_data->>'Warranty Start Date' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (a.custom_fields_data->>'Warranty Start Date')::date END,
             a.purchase_date)) / 30.4375)::int > 0
     ORDER BY 2 DESC`, [modelId]);
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (total < MIN_PEERS) return null;
  const top = rows[0];
  return { months: top.months, confidence: top.n / total, n: total, why: `${top.months} months on ${top.n} of ${total} assets of this model` };
}

async function supplier(q, modelId, locationId) {
  const pick = async (sameLocation) => q.query(`
    SELECT a.supplier_id, s.name, COUNT(*)::int AS n FROM assets a JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.asset_model_id = $1 AND a.deleted_at IS NULL ${sameLocation ? 'AND a.location_id = $2' : ''}
     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5`, sameLocation ? [modelId, locationId] : [modelId]);
  let rows = locationId ? await pick(true) : [];
  let scope = 'at this location';
  if (rows.reduce((s, r) => s + r.n, 0) < MIN_PEERS) { rows = await pick(false); scope = 'everywhere'; }
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (total < MIN_PEERS) return null;
  return { id: String(rows[0].supplier_id), name: rows[0].name, confidence: rows[0].n / total, n: total, why: `supplied ${rows[0].n} of ${total} assets of this model ${scope}` };
}

// Typical cost: purchases of the last 3 years when there are enough (prices change), else all years.
async function cost(q, modelId) {
  const stats = recent => q.get(`
    SELECT COUNT(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY purchase_cost)::float8 AS median,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY purchase_cost)::float8 AS p25,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY purchase_cost)::float8 AS p75,
           MIN(EXTRACT(YEAR FROM purchase_date))::int AS since
      FROM assets WHERE asset_model_id = $1 AND deleted_at IS NULL AND purchase_cost > 0
       ${recent ? `AND purchase_date >= CURRENT_DATE - INTERVAL '3 years'` : ''}`, [modelId]);
  let row = await stats(true);
  let when = 'bought in the last 3 years';
  if (!row || row.n < MIN_PEERS) { row = await stats(false); when = row && row.since ? `bought since ${row.since} (none recently)` : 'bought'; }
  if (!row || row.n < MIN_PEERS) return null;
  const spread = row.median ? (row.p75 - row.p25) / row.median : 1;
  return {
    value: Math.round(row.median), n: row.n, confidence: Math.max(0, Math.min(1, 1 - spread)),
    why: `median of ${row.n} ${when} (middle half ${inr(row.p25)}–${inr(row.p75)})`
  };
}

async function forModel(q, modelId, locationId = null) {
  if (!modelId) return {};
  const [w, s, c] = [await warranty(q, modelId), await supplier(q, modelId, locationId), await cost(q, modelId)];
  return { warranty: w, supplier: s, cost: c };
}

module.exports = { forModel, warranty, supplier, cost };
