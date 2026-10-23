// Asset documents for the search index, read from the existing tables (read-only).
// One document per asset: the text of each searchable field, plus name / tag / serial as typed
// (for the literal "contains" match the search box has always done).

// Register columns kept in custom fields (All PGS import). Missing keys are simply empty.
const CF = {
  machine: 'Machine Name', fams: 'FAMS No. / Barcode', processor: 'Processor', ram: 'RAM Size (GB)', os: 'OEM OS',
  vendor: 'Vendor Name', client: 'Client', project: 'Project', source_status: 'Asset Status (source)',
  order_no: 'Order No.', invoice_no: 'Invoice No.', po_no: 'PO #', ctid: 'CTID'
};
const CF_KEYS = Object.keys(CF);

// Barcode placeholders that identify nothing.
const PLACEHOLDER = /^(na|n\/a|nil|none|null|pending|tbd|0|-+|\.+)$/i;

const SITE_TEXT = { _returned: 'returned to client', _unknown: '', _none: '' };

function sql(where) {
  return `SELECT a.id, a.name, a.asset_tag, a.serial_number, a.model_number, a.notes, a.stock_site,
                 a.category AS category_text, a.status AS status_text, a.deleted_at IS NOT NULL AS deleted,
                 EXTRACT(EPOCH FROM a.created_at)::float8 AS created,
                 am.name AS model_name, m.name AS maker, ac.name AS category, sl.name AS status_label,
                 l.name AS location, sub.name AS sub_location, s.name AS supplier,
                 u.name AS holder, u.employee_id AS holder_code, u.email AS holder_email,
                 ${CF_KEYS.map((k, i) => `a.custom_fields_data->>$${i + 1} AS cf_${k}`).join(', ')}
            FROM assets a
            LEFT JOIN asset_models am ON am.id = a.asset_model_id
            LEFT JOIN manufacturers m ON m.id = a.manufacturer_id
            LEFT JOIN asset_categories ac ON ac.id = a.category_id
            LEFT JOIN status_labels sl ON sl.id = a.status_label_id
            LEFT JOIN locations l ON l.id = a.location_id
            LEFT JOIN sub_locations sub ON sub.id = a.sub_location_id
            LEFT JOIN suppliers s ON s.id = a.supplier_id
            LEFT JOIN users u ON u.id = a.assigned_to
           WHERE ${where}`;
}

const join = (...xs) => [...new Set(xs.filter(x => x !== null && x !== undefined && String(x).trim() !== '').map(x => String(x).trim()))].join(' | ');

// Words the register implies but doesn't spell: "Windows 11" -> win11, RAM "16" -> "16gb ram".
function specText(r) {
  const ram = r.cf_ram && /^\d+(\.\d+)?$/.test(String(r.cf_ram).trim()) ? `${String(r.cf_ram).trim()}gb ram` : r.cf_ram;
  const os = r.cf_os || '';
  const m = String(os).match(/windows\s*(\d+|xp)/i);
  return join(r.cf_processor, ram, os, m ? 'win' + m[1].toLowerCase() : null);
}

function toDoc(r) {
  const fams = r.cf_fams && !PLACEHOLDER.test(String(r.cf_fams).trim()) ? r.cf_fams : null;
  const site = r.stock_site in SITE_TEXT ? SITE_TEXT[r.stock_site] : r.stock_site;
  return {
    id: r.id,
    created: Number(r.created) || 0,
    fields: {
      tag: r.asset_tag,
      serial: r.serial_number,
      fams,
      name: r.name,
      holder: join(r.holder, r.holder_code, r.holder_email ? String(r.holder_email).split('@')[0] : null, r.cf_ctid),
      model: join(r.model_name, r.model_number),
      category: r.category || r.category_text,
      maker: r.maker,
      status: join(r.status_label || r.status_text, r.cf_source_status),
      place: join(r.location, r.sub_location, site),
      machine: r.cf_machine,
      spec: specText(r),
      supplier: join(r.supplier, r.cf_vendor),
      project: join(r.cf_client, r.cf_project),
      notes: join(r.notes, r.cf_order_no, r.cf_invoice_no, r.cf_po_no)
    },
    literal: [r.name, r.asset_tag, r.serial_number].map(v => String(v || '').toLowerCase()).join('\u0001')
  };
}

// Change mark: the newest updated_at of assets and users (holder names), as exact text.
async function watermark(q) {
  const r = await q.get(`SELECT to_char(GREATEST((SELECT MAX(updated_at) FROM assets), (SELECT MAX(updated_at) FROM users)),
                                 'YYYY-MM-DD HH24:MI:SS.US') AS w`);
  return r && r.w ? r.w : null;
}

// Every asset that isn't deleted. Read the watermark first, so changes during the read show up next time.
async function loadAll(q) {
  const mark = await watermark(q);
  const rows = await q.query(sql('a.deleted_at IS NULL'), CF_KEYS.map(k => CF[k]));
  return { mark, docs: rows.map(toDoc) };
}

// Assets (also deleted ones) changed since `since`, or whose holder's record changed. updated_at is
// the time a transaction started, so a long one can commit rows older than the last mark: the
// 2-minute overlap catches those (re-reading an unchanged asset costs nothing, see upsert).
async function loadChanged(q, since, limit = 5001) {
  const mark = await watermark(q);
  const n = CF_KEYS.length;
  const after = `$${n + 1}::timestamp - INTERVAL '2 minutes'`;
  const rows = await q.query(
    sql(`a.updated_at > ${after} OR u.updated_at > ${after}`) + ` LIMIT ${Number(limit) | 0}`,
    [...CF_KEYS.map(k => CF[k]), since]);
  return { mark, rows: rows.map(r => ({ deleted: r.deleted, doc: toDoc(r) })) };
}

module.exports = { loadAll, loadChanged, toDoc, watermark, CF };
