// Port of AssetRepository (~890 lines) + AssetService (~335 lines).
const crypto = require('crypto');
const db = require('../core/db');
const cache = require('../core/cache');
const audit = require('./auditService');
const authz = require('./authorizationService');
const ledger = require('./movementLedgerService');
const automation = require('./automationService');
const Paginator = require('../core/paginator');
const { nullableId, HttpError, extractCustomFields } = require('../core/helpers');

const BASE_JOINS = `
  FROM assets a
  LEFT JOIN users u ON a.assigned_to = u.id
  LEFT JOIN asset_categories ac ON a.category_id = ac.id
  LEFT JOIN asset_models am ON a.asset_model_id = am.id
  LEFT JOIN manufacturers m ON a.manufacturer_id = m.id
  LEFT JOIN suppliers s ON a.supplier_id = s.id
  LEFT JOIN locations l ON a.location_id = l.id
  LEFT JOIN status_labels sl ON a.status_label_id = sl.id`;

const BASE_SELECT = `
  SELECT a.*,
    u.name AS assigned_to_name,
    ac.name AS category_name,
    am.name AS model_name,
    m.name AS manufacturer_name,
    s.name AS supplier_name,
    l.name AS location_name,
    sl.name AS status_label_name,
    sl.color AS status_label_color`;

// Filter values may be one value or a list (multi-select): ?location_id=1&location_id=2.
const listOf = v => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v])
  .map(String).filter(x => x && x.length <= 120).slice(0, 500);
const idsOf = v => listOf(v).map(n => parseInt(n, 10)).filter(Number.isFinite);

// Multi-select filter dimensions: id columns, Model Number and the stock site from Machine Name.
const FACETS = {
  category_id: { col: 'category_id', type: 'int' },
  status_label_id: { col: 'status_label_id', type: 'int' },
  location_id: { col: 'location_id', type: 'int' },
  manufacturer_id: { col: 'manufacturer_id', type: 'int' },
  model: { col: 'model_number', type: 'text' },
  site: { col: 'stock_site', type: 'text' }
};
const facetValues = (k, v) => (FACETS[k].type === 'int' ? idsOf(v) : listOf(v));

function buildFilters(filters, params, startIdx = 1) {
  const where = [];
  let i = startIdx;
  if (filters.search && Array.isArray(filters.search_ids)) {
    // Smart search (src/ai/search, while its switch is on) already matched the text, name / tag /
    // serial included, and passes the matching ids best first.
    where.push(`a.id = ANY($${i++}::int[])`);
    params.push(filters.search_ids);
  } else if (filters.search) {
    where.push(`(a.name ILIKE $${i} OR a.asset_tag ILIKE $${i + 1} OR a.serial_number ILIKE $${i + 2})`);
    const term = `%${filters.search}%`;
    params.push(term, term, term);
    i += 3;
  }
  for (const [k, f] of Object.entries(FACETS)) {
    const vals = facetValues(k, filters[k]);
    if (vals.length) { where.push(`a.${f.col} = ANY($${i++}::${f.type}[])`); params.push(vals); }
  }
  if (Array.isArray(filters.location_ids) && filters.location_ids.length) {
    const ph = filters.location_ids.map(() => `$${i++}`);
    where.push(`a.location_id IN (${ph.join(', ')})`);
    params.push(...filters.location_ids.map(Number));
  }
  // Dashboard drill-down filters (values are validated in the route).
  if (filters.assigned === '1') where.push('a.assigned_to IS NOT NULL');
  if (filters.assigned === '0') where.push('a.assigned_to IS NULL');
  if (filters.active === '1') where.push(`a.status <> 'archived'`);
  if (filters.warranty === 'expiring') where.push(`a.warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'`);
  if (filters.repair === '1') where.push(`(a.status = 'repair' OR a.status_label_id IN (SELECT id FROM status_labels WHERE name = 'In Repair'))`);
  if (filters.status_label === 'none') where.push('a.status_label_id IS NULL');
  if (['deployable', 'deployed', 'pending', 'undeployable', 'archived'].includes(filters.label_type)) { where.push(`a.status_label_id IN (SELECT id FROM status_labels WHERE type = $${i++})`); params.push(filters.label_type); }
  if (/^\d{4}-\d{2}$/.test(String(filters.created_month || ''))) { where.push(`TO_CHAR(a.created_at, 'YYYY-MM') = $${i++}`); params.push(filters.created_month); }
  if (filters.category_name && String(filters.category_name).length <= 100) {
    where.push(`a.category_id IS NULL AND COALESCE(a.category, 'Uncategorized') = $${i++}`);
    params.push(filters.category_name);
  }
  if (filters.department === 'none') {
    where.push('NOT EXISTS (SELECT 1 FROM users du WHERE du.id = a.assigned_to AND du.department_id IS NOT NULL)');
  } else if (/^\d+$/.test(String(filters.department || ''))) {
    where.push(`EXISTS (SELECT 1 FROM users du WHERE du.id = a.assigned_to AND du.department_id = $${i++})`);
    params.push(parseInt(filters.department, 10));
  }
  // Filters behind questions in plain language (src/ai/nl, while its switch is on; the route checks
  // the values). Fixed SQL, values as parameters.
  const nearSites = listOf(filters.near_site), nearLocs = idsOf(filters.near_location);
  if (nearSites.length || nearLocs.length) {
    where.push(`(a.stock_site = ANY($${i}::text[]) OR a.location_id = ANY($${i + 1}::int[]))`);
    params.push(nearSites, nearLocs);
    i += 2;
  }
  if (/^\d+$/.test(String(filters.holder || ''))) { where.push(`a.assigned_to = $${i++}`); params.push(parseInt(filters.holder, 10)); }
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  for (const [k, col, op] of [['warranty_from', 'warranty_expiry', '>='], ['warranty_to', 'warranty_expiry', '<='], ['bought_from', 'purchase_date', '>='], ['bought_to', 'purchase_date', '<=']]) {
    if (isDate(filters[k])) { where.push(`a.${col} ${op} $${i++}::date`); params.push(filters[k]); }
  }
  const RAM = `substring(a.custom_fields_data->>'RAM Size (GB)' from '^\\s*(\\d{1,4})')::int`;
  if (/^\d{1,4}$/.test(String(filters.ram_min || ''))) { where.push(`${RAM} >= $${i++}`); params.push(parseInt(filters.ram_min, 10)); }
  if (/^\d{1,4}$/.test(String(filters.ram_max || ''))) { where.push(`${RAM} <= $${i++}`); params.push(parseInt(filters.ram_max, 10)); }
  if (OS_SQL[filters.os]) where.push(`lower(a.custom_fields_data->>'OEM OS') ~ '${OS_SQL[filters.os]}'`);
  if (AI_SETS[filters.ai]) where.push(AI_SETS[filters.ai]);
  if (/^[a-z_]{3,40}$/.test(String(filters.dq || ''))) { where.push(`a.id IN (SELECT asset_id FROM ai_dq_issues WHERE code = $${i++})`); params.push(filters.dq); }
  where.push('a.deleted_at IS NULL');
  return where.join(' AND ');
}

// Operating-system families (on the register's OEM OS) and AI result sets, for the filters above.
const OS_SQL = {
  windows11: 'win(dows)? ?11', windows10: 'win(dows)? ?10', windows_legacy: '\\mxp\\M|vista|win(dows)? ?(7|8)\\M',
  eol: '\\mxp\\M|vista|win(dows)? ?(7|8|10)\\M', macos: '\\mmac|os ?x\\M', linux: 'linux|ubuntu|cent ?os|red ?hat|debian'
};
const AI_SETS = {
  refresh_high: `a.id IN (SELECT asset_id FROM ai_predictions WHERE capability = 'lifecycle' AND label = 'high')`,
  unusual: `a.id IN (SELECT asset_id FROM ai_predictions WHERE capability = 'anomaly' AND label = 'unusual')`
};
const SORTS = {
  oldest: 'a.purchase_date ASC NULLS LAST, a.id', newest: 'a.purchase_date DESC NULLS LAST, a.id DESC',
  cost_high: 'a.purchase_cost DESC NULLS LAST, a.id', cost_low: 'a.purchase_cost ASC NULLS LAST, a.id',
  risk: `(SELECT p.score FROM ai_predictions p WHERE p.asset_id = a.id AND p.capability = 'lifecycle') DESC NULLS LAST, a.id`
};

async function count(filters = {}) {
  const params = [];
  const where = buildFilters(filters, params);
  const row = await db.get(`SELECT COUNT(*)::int AS c FROM assets a WHERE ${where}`, params);
  return row.c;
}

// Hardware count cards for the current filters, same rules as Asset Models (catalogService):
// in stock = "deployable" status and unassigned (returned_to_client = of those, Machine Name says
// "Returned to client"); allocated = assigned or a "deployed" status; retired = archived, unassigned.
async function summary(filters = {}, user = null) {
  const scoped = await authz.applyLocationScope(filters, user);
  const params = [];
  const where = buildFilters(scoped, params);
  return db.get(
    `SELECT COUNT(*)::int AS matched,
            COUNT(*) FILTER (WHERE sl.type = 'deployable' AND a.assigned_to IS NULL)::int AS in_stock,
            COUNT(*) FILTER (WHERE sl.type = 'deployable' AND a.assigned_to IS NULL AND a.stock_site = '_returned')::int AS returned_to_client,
            COUNT(*) FILTER (WHERE a.assigned_to IS NOT NULL OR sl.type = 'deployed')::int AS allocated,
            COUNT(*) FILTER (WHERE a.assigned_to IS NULL AND (sl.type = 'archived' OR a.status = 'archived'))::int AS retired
       FROM assets a LEFT JOIN status_labels sl ON sl.id = a.status_label_id WHERE ${where}`, params);
}

// Option counts for the Hardware filters: { dimension: Map(value -> count) }. Each dimension is
// counted with every OTHER filter applied, so picking a stock site shows how many of each model
// are there (and picking a model shows how many are at each site).
async function facetCounts(filters = {}, user = null) {
  const scoped = await authz.applyLocationScope(filters, user);
  const params = [];
  const rest = { ...scoped };
  for (const k of Object.keys(FACETS)) delete rest[k];
  const where = buildFilters(rest, params);
  const conds = {};
  for (const [k, f] of Object.entries(FACETS)) {
    const vals = facetValues(k, scoped[k]);
    if (vals.length) { params.push(vals); conds[k] = `${f.col} = ANY($${params.length}::${f.type}[])`; }
  }
  const parts = Object.entries(FACETS).map(([k, f]) => {
    const w = Object.entries(conds).filter(([other]) => other !== k).map(([, c]) => c);
    return `SELECT '${k}' AS f, ${f.col}::text AS v, COUNT(*)::int AS n FROM base${w.length ? ` WHERE ${w.join(' AND ')}` : ''} GROUP BY 2`;
  });
  const rows = await db.query(
    `WITH base AS MATERIALIZED (
       SELECT a.category_id, a.status_label_id, a.location_id, a.manufacturer_id, a.model_number, a.stock_site
         FROM assets a WHERE ${where})
     ${parts.join(' UNION ALL ')}`, params);
  const out = Object.fromEntries(Object.keys(FACETS).map(k => [k, new Map()]));
  for (const r of rows) if (r.v !== null) out[r.f].set(r.v, r.n);
  return out;
}

// Newest first, or in smart-search rank order, read from the ranked id list itself (page 1 of
// 15,000 ids: ~25 ms instead of ~140 ms). Reuses the id list buildFilters already sent.
function listOrder(filters, params) {
  // An explicit order (from a question: "oldest", "most expensive", "highest risk") comes first.
  if (SORTS[filters.sort]) return { joins: BASE_JOINS, order: SORTS[filters.sort] };
  const at = filters.search && Array.isArray(filters.search_ids) ? params.indexOf(filters.search_ids) + 1 : 0;
  if (!at) return { joins: BASE_JOINS, order: 'a.created_at DESC' };
  return {
    joins: BASE_JOINS.replace('FROM assets a', `FROM unnest($${at}::int[]) WITH ORDINALITY AS sr(id, ord) JOIN assets a ON a.id = sr.id`),
    order: 'sr.ord'
  };
}

async function fetch(limit, offset, filters = {}) {
  const params = [];
  const where = buildFilters(filters, params);
  const { joins, order } = listOrder(filters, params);
  params.push(limit, offset);
  return db.query(
    `${BASE_SELECT} ${joins} WHERE ${where}
     ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}

async function all() { return fetch(1000, 0, {}); }

// Excel export: only the exported columns. a.* carries ~20 MB of custom-field JSON,
// which made a full export take ~10 s instead of ~1 s.
async function exportRows(filters = {}) {
  const params = [];
  const where = buildFilters(filters, params);
  const { joins, order } = listOrder(filters, params);
  return db.query(
    `SELECT a.asset_tag, a.name, a.serial_number, a.model_number, a.status, a.category,
       a.purchase_date, a.purchase_cost, a.warranty_expiry, a.created_at,
       u.name AS assigned_to_name, ac.name AS category_name, am.name AS model_name, m.name AS manufacturer_name,
       s.name AS supplier_name, l.name AS location_name, sl.name AS status_label_name, a.stock_site
     ${joins} WHERE ${where} ORDER BY ${order}`,
    params
  );
}

async function find(id) {
  return db.get(
    `${BASE_SELECT}, am.default_warranty_months ${BASE_JOINS}
     LEFT JOIN procurement_records pr ON a.procurement_id = pr.id
     WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [parseInt(id, 10)]
  );
}

async function findByLabelToken(token) {
  const row = await db.get('SELECT id FROM assets WHERE label_token = $1 LIMIT 1', [token]);
  return row ? find(row.id) : null;
}

async function findByBarcodeOrTag(code) {
  return db.get(
    `${BASE_SELECT}, sub.name AS sub_location_name ${BASE_JOINS}
     LEFT JOIN sub_locations sub ON a.sub_location_id = sub.id
     WHERE a.deleted_at IS NULL AND (a.asset_tag = $1 OR a.serial_number = $1) LIMIT 1`,
    [code]
  );
}

async function serialNumberExists(serial, excludeId = null) {
  const params = [serial];
  let sql = 'SELECT id FROM assets WHERE serial_number = $1'; // UNIQUE includes archived rows
  if (excludeId) { sql += ' AND id != $2'; params.push(excludeId); }
  const row = await db.get(sql + ' LIMIT 1', params);
  return !!row;
}

async function findMany(ids) {
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  return db.query(
    `SELECT a.*, ac.name AS category_name, am.name AS model_name, m.name AS manufacturer_name, l.name AS location_name
     FROM assets a
     LEFT JOIN asset_categories ac ON a.category_id = ac.id
     LEFT JOIN asset_models am ON a.asset_model_id = am.id
     LEFT JOIN manufacturers m ON a.manufacturer_id = m.id
     LEFT JOIN locations l ON a.location_id = l.id
     WHERE a.id IN (${ph}) AND a.deleted_at IS NULL
     ORDER BY a.asset_tag ASC, a.name ASC`,
    ids
  );
}

async function referenceData() {
  const [categories, models, manufacturers, suppliers, locations, statusLabels, users, procurement] = await Promise.all([
    db.query('SELECT * FROM asset_categories ORDER BY name ASC'),
    db.query('SELECT * FROM asset_models ORDER BY name ASC'),
    db.query('SELECT * FROM manufacturers ORDER BY name ASC'),
    db.query('SELECT * FROM suppliers ORDER BY name ASC'),
    db.query('SELECT * FROM locations ORDER BY name ASC'),
    db.query('SELECT * FROM status_labels ORDER BY name ASC'),
    Promise.resolve([]), // users are picked via /api/pick/users (type-to-search)
    db.query('SELECT id, po_number, invoice_number FROM procurement_records WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100')
  ]);
  return { categories, models, manufacturers, suppliers, locations, status_labels: statusLabels, users, procurement };
}

async function nextAssetTag() {
  const row = await db.get('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM assets');
  let next = parseInt(row.next, 10);
  for (;;) {
    const tag = 'HAMS-' + String(next).padStart(6, '0');
    const exists = await db.get('SELECT id FROM assets WHERE asset_tag = $1', [tag]);
    if (!exists) return tag;
    next += 1;
  }
}

async function statusLabelId(name, t = null) {
  const runner = t || db;
  const row = await runner.get('SELECT id FROM status_labels WHERE name = $1 LIMIT 1', [name]);
  return row ? row.id : null;
}

async function statusLabelIdAny(names, t = null) {
  for (const n of names) {
    const id = await statusLabelId(n, t);
    if (id) return id;
  }
  return null;
}

function normalizeAssetData(data) {
  for (const k of ['name', 'asset_tag', 'serial_number', 'model_number', 'category']) {
    data[k] = String(data[k] ?? '').trim();
  }
  data.status = String(data.status ?? 'available').trim() || 'available';
  if (data.name === '') throw new HttpError('Asset name is required', 422);
  data.custom_fields_data = extractCustomFields(data);
  return data;
}

async function assertLocationAllowed(locationId, user) {
  if (!(await authz.canAccessLocation(locationId, user))) {
    throw new HttpError('You do not have access to manage records in this location.', 403);
  }
}

// Location scope must be checked against where an asset IS, not only where an
// edit would move it; otherwise a scoped user can act on other sites' assets.
async function assertAssetsInScope(ids, user) {
  ids = [].concat(ids).map(Number).filter(Boolean);
  if (!ids.length) return;
  const rows = await db.query('SELECT DISTINCT location_id FROM assets WHERE id = ANY($1::int[])', [ids]);
  for (const r of rows) await assertLocationAllowed(r.location_id, user);
}

async function assertSubLocationBelongsToLocation(subLocationId, locationId) {
  const sub = nullableId(subLocationId), loc = nullableId(locationId);
  if (!sub || !loc) return;
  const row = await db.get(
    'SELECT id FROM sub_locations WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL',
    [sub, loc]
  );
  if (!row) throw new HttpError('The selected sub-location does not belong to the selected location.', 422);
}

async function createAsset(data) {
  // "In Stock" label wins on create (mirrors original short-circuit)
  const stockLabel = await statusLabelId('In Stock');
  const labelId = stockLabel || nullableId(data.status_label_id) || await statusLabelId('Ready to Deploy');
  const assetTag = data.asset_tag || await nextAssetTag();
  const labelToken = crypto.randomBytes(16).toString('hex');
  const locationId = nullableId(data.location_id);
  const procurementId = nullableId(data.procurement_id);

  const id = await db.insert(
    `INSERT INTO assets (asset_tag, label_token, name, asset_model_id, category_id, manufacturer_id,
       supplier_id, location_id, sub_location_id, serial_number, model_number, status, status_label_id,
       purchase_date, purchase_cost, warranty_expiry, notes, custom_fields_data, procurement_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      assetTag, labelToken, data.name,
      nullableId(data.asset_model_id), nullableId(data.category_id), nullableId(data.manufacturer_id),
      nullableId(data.supplier_id), locationId, nullableId(data.sub_location_id),
      data.serial_number || null, data.model_number || null,
      'available', labelId,
      data.purchase_date || null,
      data.purchase_cost !== '' && data.purchase_cost !== undefined && data.purchase_cost !== null ? data.purchase_cost : null,
      data.warranty_expiry || null,
      data.notes || null,
      JSON.stringify(data.custom_fields_data || {}),
      procurementId
    ]
  );
  if (id) {
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: 'stock_in', direction: 'in', quantity: 1,
      to_location_id: locationId, effective_status: 'available', reason: 'Asset registration',
      reference: procurementId ? `Procurement #${procurementId}` : null,
      notes: 'Asset entered inventory and is ready for allocation.'
    });
  }
  return id;
}

async function registerAsset(data, user) {
  normalizeAssetData(data);
  await assertLocationAllowed(data.location_id, user);
  await assertSubLocationBelongsToLocation(data.sub_location_id, data.location_id);
  const serial = String(data.serial_number || '').trim();
  if (serial && await serialNumberExists(serial)) {
    throw new HttpError(`Serial number '${serial}' is already in use by another asset.`, 422);
  }
  const id = await createAsset(data);
  if (id) {
    await audit.log(user ? user.id : null, 'ASSET_CREATED',
      `Asset ${data.name || 'Unknown asset'} (SN: ${serial || 'N/A'}) registered.`);
    cache.del('hams_dashboard_metrics');
    automation.assetEvent('asset.created', id, { actor: user ? user.name : null });
  }
  return id;
}

// --- Status/maintenance lifecycle automation ---
function isRepairState(labelName, status) {
  const label = String(labelName || '').toLowerCase();
  const st = String(status || '').toLowerCase();
  if (['ready to deploy', 'in stock', 'available'].includes(label)) return false;
  return ['in repair', 'under repair', 'repair'].includes(label) || ['repair', 'under_repair'].includes(st);
}

function isAvailableState(labelName, status) {
  const label = String(labelName || '').toLowerCase();
  const st = String(status || '').toLowerCase();
  return ['ready to deploy', 'in stock', 'available'].includes(label) || ['available', 'in_stock'].includes(st);
}

async function lifecycleSnapshot(id, t) {
  return t.get(
    `SELECT a.*, sl.name AS status_label_name FROM assets a
     LEFT JOIN status_labels sl ON a.status_label_id = sl.id
     WHERE a.id = $1 FOR UPDATE OF a`,
    [id]
  );
}

async function syncMaintenanceFromStatusChange(id, before, data, t, actorId = null) {
  const after = await lifecycleSnapshot(id, t);
  if (!after) return;
  const wasRepair = isRepairState(before.status_label_name, before.status);
  const inRepair = isRepairState(after.status_label_name, after.status);
  const nowAvailable = isAvailableState(after.status_label_name, after.status);

  if (inRepair) {
    let maint = await t.get(
      `SELECT id FROM asset_maintenance WHERE asset_id = $1 AND maintenance_type = 'repair'
       AND status IN ('open', 'in_progress') ORDER BY id DESC LIMIT 1`,
      [id]
    );
    let maintenanceId = maint ? maint.id : null;
    if (!maintenanceId) {
      maintenanceId = await t.insert(
        `INSERT INTO asset_maintenance (asset_id, vendor_id, title, maintenance_type, status, start_date, notes, created_by)
         VALUES ($1, $2, $3, 'repair', 'open', CURRENT_DATE, $4, $5)`,
        [
          id, nullableId(data.supplier_id),
          `Auto repair - ${after.asset_tag || ''} ${after.name || 'Asset'}`.trim(),
          'Automatically created because asset status changed to repair.\n' + (data.notes || ''),
          actorId
        ]
      );
    }
    // Auto-checkin if assigned
    if (after.assigned_to) {
      await t.run(
        `UPDATE assignments SET returned_at = CURRENT_TIMESTAMP, checkin_condition = 'repair',
           checkin_notes = $1
         WHERE id = (SELECT id FROM assignments WHERE asset_id = $2 AND returned_at IS NULL
                     ORDER BY assigned_at DESC, id DESC LIMIT 1)`,
        [`Auto checked-in because asset moved to repair via maintenance #${maintenanceId}`, id]
      );
    }
    const repairLabel = await statusLabelId('In Repair', t);
    await t.run(
      'UPDATE assets SET assigned_to = NULL, status = $1, status_label_id = COALESCE($2, status_label_id) WHERE id = $3',
      ['repair', repairLabel, id]
    );
    if (!wasRepair) {
      await ledger.record({
        module_key: 'assets', item_id: id, movement_type: 'repair_sent', direction: 'out', quantity: 1,
        from_location_id: after.location_id, vendor_id: nullableId(data.supplier_id),
        related_maintenance_id: maintenanceId, effective_status: 'repair',
        reason: 'Status changed to repair', reference: `Maintenance #${maintenanceId}`,
        created_by: actorId
      }, t);
    }
  } else if (wasRepair && nowAvailable) {
    const maint = await t.get(
      `SELECT id, completion_date FROM asset_maintenance WHERE asset_id = $1 AND maintenance_type = 'repair'
       AND status IN ('open', 'in_progress') ORDER BY id DESC LIMIT 1`,
      [id]
    );
    const maintenanceId = maint ? maint.id : null;
    if (maintenanceId) {
      await t.run(
        `UPDATE asset_maintenance SET status = 'completed', completion_date = COALESCE(completion_date, CURRENT_DATE),
           notes = COALESCE(notes, '') || E'\\n' || $1 WHERE id = $2`,
        ['Automatically completed because asset status changed to ready/stock.', maintenanceId]
      );
    }
    const readyLabel = await statusLabelIdAny(['Ready to Deploy', 'In Stock'], t);
    await t.run(
      'UPDATE assets SET assigned_to = NULL, status = $1, status_label_id = COALESCE($2, status_label_id) WHERE id = $3',
      ['available', readyLabel, id]
    );
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: 'repair_received', direction: 'in', quantity: 1,
      to_location_id: after.location_id, related_maintenance_id: maintenanceId, effective_status: 'available',
      reason: 'Status changed to ready/stock', reference: maintenanceId ? `Maintenance #${maintenanceId}` : null,
      created_by: actorId
    }, t);
  }
}

async function updateAsset(id, data, user) {
  normalizeAssetData(data);
  await assertAssetsInScope(id, user);
  await assertLocationAllowed(data.location_id, user);
  await assertSubLocationBelongsToLocation(data.sub_location_id, data.location_id);
  const serial = String(data.serial_number || '').trim();
  if (serial && await serialNumberExists(serial, id)) {
    throw new HttpError(`Serial number '${serial}' is already in use by another asset.`, 422);
  }
  const before = await find(id);
  if (!before) throw new HttpError('Asset not found.', 404);
  // Keep the register fields (Machine Name, Processor, PO #, ...) the form doesn't send: the Edit
  // page and the REST API send none, which used to wipe them all (and the stock site with them).
  const kept = before.custom_fields_data && typeof before.custom_fields_data === 'object' ? before.custom_fields_data : {};
  data.custom_fields_data = { ...kept, ...data.custom_fields_data };

  await db.tx(async t => {
    await t.run(
      `UPDATE assets SET asset_tag = $1, name = $2, asset_model_id = $3, category_id = $4,
         manufacturer_id = $5, supplier_id = $6, location_id = $7, sub_location_id = $8,
         serial_number = $9, model_number = $10, status = $11, status_label_id = $12,
         purchase_date = $13, purchase_cost = $14, warranty_expiry = $15, notes = $16,
         custom_fields_data = $17, procurement_id = $18
       WHERE id = $19`,
      [
        data.asset_tag, data.name, nullableId(data.asset_model_id), nullableId(data.category_id),
        nullableId(data.manufacturer_id), nullableId(data.supplier_id), nullableId(data.location_id),
        nullableId(data.sub_location_id), serial || null, data.model_number || null,
        data.status || 'available', nullableId(data.status_label_id),
        data.purchase_date || null,
        data.purchase_cost !== '' && data.purchase_cost !== undefined && data.purchase_cost !== null ? data.purchase_cost : null,
        data.warranty_expiry || null, data.notes || null,
        JSON.stringify(data.custom_fields_data || {}), nullableId(data.procurement_id),
        id
      ]
    );
    await syncMaintenanceFromStatusChange(id, before, data, t, user ? user.id : null);
  });

  await audit.log(user ? user.id : null, 'ASSET_UPDATED', `Asset ${data.name} updated.`);
  cache.del('hams_dashboard_metrics');
  const actor = user ? user.name : null;
  automation.assetEvent('asset.updated', id, { actor });
  if (String(before.status_label_id ?? '') !== String(nullableId(data.status_label_id) ?? '') ||
      String(before.status || '') !== String(data.status || 'available')) {
    automation.assetEvent('asset.status_changed', id, { actor, previous_status: before.status_label_name || before.status });
  }
  return true;
}

async function deleteAsset(id, user) {
  await assertAssetsInScope(id, user);
  const asset = await find(id);
  const res = await db.run('UPDATE assets SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  if (res.rowCount > 0) {
    await audit.log(user ? user.id : null, 'ASSET_DELETED', `Asset ${asset ? asset.name : `Asset #${id}`} deleted.`);
    cache.del('hams_dashboard_metrics');
    automation.assetEvent('asset.deleted', id, { actor: user ? user.name : null });
    return true;
  }
  return false;
}

async function checkoutAsset(id, data, user) {
  if (!data.user_id) throw new HttpError('Checkout user is required', 422);
  await assertAssetsInScope(id, user);
  const actorId = user ? user.id : null;
  await db.tx(async t => {
    const current = await t.get(
      `SELECT a.*, sl.name AS status_label_name FROM assets a
       LEFT JOIN status_labels sl ON a.status_label_id = sl.id
       WHERE a.id = $1 AND a.deleted_at IS NULL FOR UPDATE OF a`,
      [id]
    );
    if (!current) throw new HttpError('Asset not found.', 404);
    if (current.assigned_to) throw new HttpError('Asset is already assigned.', 422);
    const currentStatus = String(current.status_label_name || current.status || '').toLowerCase();
    if (!['available', 'in stock', 'ready to deploy', 'ready'].includes(currentStatus)) {
      throw new HttpError('Only available assets can be checked out.', 422);
    }
    const userId = parseInt(data.user_id, 10);
    const deployedStatus = await statusLabelId('Deployed', t);
    const assignmentId = await t.insert(
      `INSERT INTO assignments (asset_id, user_id, checked_out_by, expected_return_at, checkout_condition, checkout_notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, actorId, data.expected_return_at || null, data.checkout_condition || null, data.checkout_notes || null]
    );
    await t.run(
      "UPDATE assets SET assigned_to = $1, status = 'assigned', status_label_id = $2 WHERE id = $3",
      [userId, deployedStatus, id]
    );
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: 'assigned', direction: 'out', quantity: 1,
      from_location_id: current.location_id, holder_user_id: userId, related_assignment_id: assignmentId,
      effective_status: 'assigned', reason: 'Asset assignment', reference: `Assignment #${assignmentId}`,
      notes: data.checkout_notes || null, created_by: actorId
    }, t);
  });
  await audit.log(actorId, 'ASSET_CHECKED_OUT', `Asset #${id} checked out to user #${data.user_id}.`);
  cache.del('hams_dashboard_metrics');
  automation.assetEvent('asset.checked_out', id, { actor: user ? user.name : null });
  return true;
}

async function checkinAsset(id, data, user) {
  await assertAssetsInScope(id, user);
  const actorId = user ? user.id : null;
  let previousHolderId = null;
  await db.tx(async t => {
    const current = await t.get(
      `SELECT a.*, sl.name AS status_label_name FROM assets a
       LEFT JOIN status_labels sl ON a.status_label_id = sl.id
       WHERE a.id = $1 AND a.deleted_at IS NULL FOR UPDATE OF a`,
      [id]
    );
    if (!current) throw new HttpError('Asset not found.', 404);
    previousHolderId = current.assigned_to;
    const condition = String(data.checkin_condition || 'good').trim().toLowerCase();
    const needsRepair = ['repair', 'needs repair', 'under_repair'].includes(condition);
    const isDamaged = ['damaged', 'broken'].includes(condition);

    let status = 'available';
    let statusLabel = await statusLabelIdAny(['In Stock', 'Ready to Deploy'], t);
    let movementType = 'returned';
    let effectiveStatus = 'available';
    if (needsRepair) {
      status = 'repair';
      statusLabel = await statusLabelId('In Repair', t);
      movementType = 'repair_sent';
      effectiveStatus = 'repair';
    } else if (isDamaged) {
      status = 'damaged';
      statusLabel = await statusLabelIdAny(['Damaged', 'Broken'], t);
      movementType = 'damaged';
      effectiveStatus = 'damaged';
    }

    await t.run(
      `UPDATE assignments SET returned_at = CURRENT_TIMESTAMP, checked_in_by = $1,
         checkin_condition = $2, checkin_notes = $3
       WHERE id = (SELECT id FROM assignments WHERE asset_id = $4 AND returned_at IS NULL
                   ORDER BY assigned_at DESC, id DESC LIMIT 1)`,
      [actorId, data.checkin_condition || null, data.checkin_notes || null, id]
    );
    const latest = await t.get(
      'SELECT id FROM assignments WHERE asset_id = $1 ORDER BY assigned_at DESC, id DESC LIMIT 1', [id]
    );
    const assignmentId = latest ? latest.id : null;
    await t.run(
      'UPDATE assets SET assigned_to = NULL, status = $1, status_label_id = $2 WHERE id = $3',
      [status, statusLabel, id]
    );
    await ledger.record({
      module_key: 'assets', item_id: id, movement_type: movementType,
      direction: status === 'available' ? 'in' : 'out', quantity: 1,
      to_location_id: current.location_id, holder_user_id: current.assigned_to,
      related_assignment_id: assignmentId, effective_status: effectiveStatus,
      reason: status === 'available' ? 'Asset return' : 'Return requires non-available handling',
      reference: assignmentId ? `Assignment #${assignmentId}` : null,
      notes: data.checkin_notes || null, created_by: actorId
    }, t);
  });
  await audit.log(actorId, 'ASSET_CHECKED_IN', `Asset #${id} checked in.`);
  cache.del('hams_dashboard_metrics');
  automation.assetEvent('asset.checked_in', id, {
    actor: user ? user.name : null, previous_holder_id: previousHolderId, condition: data.checkin_condition || 'good'
  });
  return true;
}

async function bulkUpdateAssets(ids, data, user) {
  ids = [...new Set(ids.map(Number).filter(Boolean))];
  if (!ids.length || !Object.keys(data).length) return 0;
  await assertAssetsInScope(ids, user);
  if ('location_id' in data) await assertLocationAllowed(data.location_id, user);

  const syncLifecycle = 'status_label_id' in data || 'status' in data;
  let updated = 0;
  await db.tx(async t => {
    let befores = [];
    if (syncLifecycle) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
      befores = await t.query(
        `SELECT a.*, sl.name AS status_label_name FROM assets a
         LEFT JOIN status_labels sl ON a.status_label_id = sl.id
         WHERE a.id IN (${ph}) AND a.deleted_at IS NULL`,
        ids
      );
    }
    const allowed = ['status_label_id', 'location_id', 'status'];
    const sets = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(data)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = $${i++}`);
      params.push(k.endsWith('_id') ? nullableId(v) : v);
    }
    if (!sets.length) return;
    const ph2 = ids.map(() => `$${i++}`).join(', ');
    const res = await t.run(
      `UPDATE assets SET ${sets.join(', ')} WHERE id IN (${ph2}) AND deleted_at IS NULL`,
      [...params, ...ids]
    );
    updated = res.rowCount;
    if (syncLifecycle) {
      for (const before of befores) {
        await syncMaintenanceFromStatusChange(before.id, before, data, t, user ? user.id : null);
      }
    }
  });
  if (updated > 0) {
    await audit.log(user ? user.id : null, 'ASSET_BULK_UPDATED', `${updated} asset(s) updated.`);
    cache.del('hams_dashboard_metrics');
  }
  return updated;
}

async function bulkDeleteAssets(ids, user) {
  ids = [...new Set(ids.map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  await assertAssetsInScope(ids, user);
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const res = await db.run(
    `UPDATE assets SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${ph}) AND deleted_at IS NULL`,
    ids
  );
  if (res.rowCount > 0) {
    await audit.log(user ? user.id : null, 'ASSET_BULK_DELETED', `${res.rowCount} asset(s) deleted.`);
    cache.del('hams_dashboard_metrics');
  }
  return res.rowCount;
}

async function assignmentHistory(assetId) {
  return db.query(
    `SELECT a.*, u.name AS user_name, ou.name AS checked_out_by_name, iu.name AS checked_in_by_name
     FROM assignments a
     LEFT JOIN users u ON a.user_id = u.id
     LEFT JOIN users ou ON a.checked_out_by = ou.id
     LEFT JOIN users iu ON a.checked_in_by = iu.id
     WHERE a.asset_id = $1 ORDER BY a.assigned_at DESC`,
    [assetId]
  );
}

async function stockHistory(assetId) {
  return db.query(
    `SELECT sm.*, cu.name AS created_by_name, hu.name AS holder_name, sv.name AS vendor_name,
            fl.name AS from_location_name, tl.name AS to_location_name
     FROM stock_movements sm
     LEFT JOIN users cu ON sm.created_by = cu.id
     LEFT JOIN users hu ON sm.holder_user_id = hu.id
     LEFT JOIN suppliers sv ON sm.vendor_id = sv.id
     LEFT JOIN locations fl ON sm.from_location_id = fl.id
     LEFT JOIN locations tl ON sm.to_location_id = tl.id
     WHERE sm.module_key = 'assets' AND sm.item_id = $1
     ORDER BY COALESCE(sm.occurred_at, sm.created_at) DESC, sm.id DESC`,
    [assetId]
  );
}

// Service-level wrappers with location scoping
async function page(pageNum = 1, perPage = 15, filters = {}, user = null) {
  const scoped = await authz.applyLocationScope(filters, user);
  const total = await count(scoped);
  const paginator = new Paginator(total, perPage, pageNum);
  const items = await fetch(perPage, paginator.offset, scoped);
  return { items, paginator, total };
}

async function getAsset(id, user) {
  const asset = await find(id);
  if (asset && !(await authz.canAccessLocation(asset.location_id, user))) return false;
  return asset;
}

async function getReferenceData(user) {
  const refs = await referenceData();
  const scope = await authz.locationScopeFor(user);
  if (!scope.global) {
    refs.locations = refs.locations.filter(l => scope.location_ids.includes(parseInt(l.id, 10)));
  }
  return refs;
}

async function getLabelAssets(ids, user) {
  const assets = await findMany(ids.map(Number).filter(Boolean));
  const out = [];
  for (const a of assets) {
    if (await authz.canAccessLocation(a.location_id, user)) out.push(a);
  }
  return out;
}

function calculateDepreciation(asset) {
  if (!asset.purchase_cost || !asset.purchase_date || !asset.depreciation_months) return null;
  const cost = parseFloat(asset.purchase_cost);
  const salvage = parseFloat(asset.salvage_value || 0);
  const months = parseInt(asset.depreciation_months, 10);
  const pd = new Date(asset.purchase_date);
  const now = new Date();
  let monthsOwned = (now.getFullYear() - pd.getFullYear()) * 12 + (now.getMonth() - pd.getMonth());
  if (now.getDate() < pd.getDate()) monthsOwned -= 1;
  monthsOwned = Math.max(0, monthsOwned);
  if (monthsOwned >= months) return salvage;
  const monthly = (cost - salvage) / months;
  return Math.max(salvage, cost - monthly * monthsOwned);
}

// Portal helpers
async function getAssignedToUser(userId) {
  return db.query(
    `SELECT a.*, ac.name AS category_name, m.name AS manufacturer_name, am.name AS model_name,
            sl.name AS status_name, sl.color AS status_color
     FROM assets a
     LEFT JOIN asset_categories ac ON a.category_id = ac.id
     LEFT JOIN manufacturers m ON a.manufacturer_id = m.id
     LEFT JOIN asset_models am ON a.asset_model_id = am.id
     LEFT JOIN status_labels sl ON a.status_label_id = sl.id
     WHERE a.assigned_to = $1 AND a.deleted_at IS NULL ORDER BY a.name ASC`,
    [userId]
  );
}

async function getAssignedAccessories(userId) {
  return db.query(
    `SELECT aa.id AS assignment_id, aa.qty, aa.assigned_at, aa.notes,
            acc.name, acc.model_number, ac.name AS category_name, m.name AS manufacturer_name
     FROM accessory_assignments aa
     JOIN accessories acc ON aa.accessory_id = acc.id
     LEFT JOIN asset_categories ac ON acc.category_id = ac.id
     LEFT JOIN manufacturers m ON acc.manufacturer_id = m.id
     WHERE aa.user_id = $1 AND aa.returned_at IS NULL ORDER BY acc.name ASC`,
    [userId]
  );
}

async function getAssignedLicenses(userId) {
  return db.query(
    `SELECT la.id AS assignment_id, la.assigned_at, la.notes,
            lic.name, lic.expiration_date, m.name AS manufacturer_name,
            a.name AS asset_name, a.asset_tag
     FROM license_assignments la
     JOIN licenses lic ON la.license_id = lic.id
     LEFT JOIN manufacturers m ON lic.manufacturer_id = m.id
     LEFT JOIN assets a ON la.asset_id = a.id
     WHERE (la.user_id = $1 OR la.asset_id IN (SELECT id FROM assets WHERE assigned_to = $1 AND deleted_at IS NULL))
       AND la.revoked_at IS NULL
     ORDER BY lic.name ASC`,
    [userId]
  );
}

async function getAssignedComponents(userId) {
  return db.query(
    `SELECT ca.id AS assignment_id, ca.qty, ca.assigned_at, ca.notes,
            comp.name, comp.serial_number, ac.name AS category_name, m.name AS manufacturer_name,
            a.name AS asset_name, a.asset_tag
     FROM component_assignments ca
     JOIN components comp ON ca.component_id = comp.id
     JOIN assets a ON ca.asset_id = a.id
     LEFT JOIN asset_categories ac ON comp.category_id = ac.id
     LEFT JOIN manufacturers m ON comp.manufacturer_id = m.id
     WHERE a.assigned_to = $1 AND a.deleted_at IS NULL AND ca.removed_at IS NULL
     ORDER BY comp.name ASC`,
    [userId]
  );
}

module.exports = {
  count, summary, facetCounts, FACETS, fetch, all, exportRows, find, findByLabelToken, findByBarcodeOrTag, findMany,
  referenceData, nextAssetTag, statusLabelId, statusLabelIdAny, serialNumberExists,
  registerAsset, createAsset, updateAsset, deleteAsset, checkoutAsset, checkinAsset,
  bulkUpdateAssets, bulkDeleteAssets, assignmentHistory, stockHistory,
  page, getAsset, getReferenceData, getLabelAssets, calculateDepreciation,
  getAssignedToUser, getAssignedAccessories, getAssignedLicenses, getAssignedComponents,
  syncMaintenanceFromStatusChange
};
