// Per-asset AI features, computed in SQL from the existing tables (read-only).
// One definition shared by the snapshot job and, later, the models, so both see the same values.
// Only an asset's own attributes are stored. Derived values (age, devices per holder) are
// computed as of a date when needed, so one asset's change never rewrites other assets' rows.

// Feature columns, in ai_feature_snapshots order (also the order hashed into feature_hash).
const COLUMNS = [
  'category_id', 'asset_model_id', 'manufacturer_id', 'supplier_id', 'location_id', 'stock_site',
  'status', 'status_label_id', 'label_type', 'is_retired', 'retired_reason', 'holder_user_id',
  'purchase_date', 'purchase_cost', 'warranty_expiry', 'ram_gb', 'os_family', 'os_eol', 'deleted'
];

// OEM OS text -> family. Order matters: macOS and Linux before servers, servers before desktop Windows.
const OS_UNKNOWN = `os IS NULL OR btrim(os) ~ '^(|na|n/a|-|none|nil|unknown)$'`;
const OS_FAMILY = `CASE
    WHEN ${OS_UNKNOWN} THEN NULL
    WHEN os ~ '\\mmac|macos|os ?x\\M|leopard|lion|mavericks|yosemite|el capitan|sierra|mojave|catalina|big ?sur|monterey|ventura|sonoma|sequoia|tahoe' THEN 'macos'
    WHEN os ~ 'linux|ubuntu|cent ?os|red ?hat|rhel|debian|suse|fedora' THEN 'linux'
    WHEN os ~ 'server|win(dows)? ?(2003|2008|2012|2016|2019|2022|2025)\\M' THEN 'windows_server'
    WHEN os ~ 'win(dows)? ?11' THEN 'windows11'
    WHEN os ~ 'win(dows)? ?10' THEN 'windows10'
    WHEN os ~ '\\mxp\\M|vista|win(dows)? ?(7|8)\\M' THEN 'windows_legacy'
    WHEN os ~ 'chrome' THEN 'chromeos'
    ELSE 'other' END`;
// The vendor no longer ships security updates (paid extended support ignored), as of 2026-10:
// Windows XP/Vista/7/8/10 (10 ended 2025-10-14), Windows Server 2003/2008/2012, macOS 13 Ventura
// and older, CentOS, Ubuntu before 22.04. Review this list as products reach end of support.
const OS_EOL = `CASE
    WHEN ${OS_UNKNOWN} THEN NULL
    ELSE os ~ '(\\mxp\\M|vista|win(dows)? ?(7|8|10)\\M|(server|win(dows)?) ?(2003|2008|2012)\\M|leopard|lion|mavericks|yosemite|el capitan|sierra|mojave|catalina|big ?sur|monterey|ventura|cent ?os|ubuntu ?(1\\d|20|21)\\.)' END`;

// SELECT returning one row per asset: asset_id, the COLUMNS and feature_hash.
// whereSql (optional) filters assets, e.g. 'a.id = ANY($1::int[])'. Soft-deleted assets are
// included with deleted = TRUE so a deletion is recorded.
function featureSql(whereSql = '') {
  return `
    WITH base AS (
      SELECT a.id AS asset_id, a.category_id, a.asset_model_id, a.manufacturer_id, a.supplier_id, a.location_id,
             a.stock_site::varchar(60) AS stock_site, a.status::varchar(30) AS status, a.status_label_id,
             sl.type::varchar(20) AS label_type,
             (COALESCE(sl.type = 'archived', FALSE) OR a.status = 'archived') AS is_retired,
             (CASE WHEN sl.type = 'archived' THEN sl.name END)::varchar(100) AS retired_reason,
             a.assigned_to AS holder_user_id,
             a.purchase_date, a.purchase_cost, a.warranty_expiry,
             substring(a.custom_fields_data->>'RAM Size (GB)' from '^\\s*(\\d{1,4})')::int AS ram_gb,
             lower(a.custom_fields_data->>'OEM OS') AS os,
             (a.deleted_at IS NOT NULL) AS deleted
        FROM assets a
        LEFT JOIN status_labels sl ON sl.id = a.status_label_id
       ${whereSql ? 'WHERE ' + whereSql : ''}
    ), feat AS (
      SELECT asset_id, category_id, asset_model_id, manufacturer_id, supplier_id, location_id, stock_site,
             status, status_label_id, label_type, is_retired, retired_reason, holder_user_id,
             purchase_date, purchase_cost, warranty_expiry, ram_gb,
             (${OS_FAMILY})::varchar(20) AS os_family, (${OS_EOL}) AS os_eol, deleted
        FROM base
    )
    SELECT feat.*, md5(ROW(${COLUMNS.join(', ')})::text) AS feature_hash FROM feat`;
}

module.exports = { COLUMNS, featureSql };
