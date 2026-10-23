// CSV/Excel bulk import for the Software tab (License Management). Parses a
// flexible-header file into software_assets rows, validates them (including
// the Qty 0-15 policy — see softwareService for the data-wide normalization
// this mirrors), computes renewal_date the same way the original loader did,
// and inserts in a single transaction with per-row error collection.
const ExcelJS = require('exceljs'); // replaces 'xlsx' (unpatched high-severity advisory)
const db = require('../core/db');
const { HttpError, trimStr, intOr } = require('../core/helpers');

const QTY_MIN = 0, QTY_MAX = 10;
const RENEWAL_CYCLES = ['Annual', '6 Months', 'Perpetual'];

// Canonical column -> accepted header aliases (case/space/underscore-insensitive).
const COLUMN_ALIASES = {
  sr_no: ['sr no', 'srno', 'sr_no', 's no', 'sl no', 'sr'],
  sw_name: ['sw name', 'software name', 'name', 'application', 'software'],
  edition_version: ['edition version', 'edition', 'version', 'ed ver'],
  po_number: ['po number', 'po no', 'purchase order', 'po'],
  fams_no: ['fams no', 'fams number', 'fams', 'fams no barcode', 'barcode'],
  license_type: ['license type', 'licensetype', 'type'],
  qty: ['qty', 'quantity'],
  purchase_date: ['purchase date', 'purchased on', 'date of purchase'],
  renewal_name: ['renewal name', 'renewal cycle', 'cycle', 'renewal'],
  amount: ['amount', 'cost', 'price', 'value'],
  subscription_start_date: ['subscription start date', 'sub start date', 'start date'],
  subscription_end_date: ['subscription end date', 'sub end date', 'end date'],
  client_provided: ['client provided', 'client_provided', 'client provided asset'],
  duty_exempted: ['duty exempted', 'duty_exempted'],
  asset_location: ['asset location', 'location'],
  manufacturer_name: ['manufacturer name', 'manufacturer', 'oem'],
  remaining_warranty_days: ['remaining warranty days', 'warranty days', 'remaining warranty in days'],
  vendor_name: ['vendor name', 'vendor', 'supplier'],
  invoice_no: ['invoice no', 'invoice number', 'invoice'],
  client: ['client'],
  group_name: ['group name', 'group'],
  project: ['project'],
  license_key: ['license key', 'licensekey', 'key'],
  remarks: ['remarks', 'notes', 'comment', 'comments'],
  market_name: ['market name', 'market'],
  client_name: ['client name'],
  allocated_user_name: ['user name', 'allocated user', 'allocated to']
};

function normalizeHeader(h) {
  // Drop parenthesised hints like "Qty (0-10)" so template headers match aliases,
  // and treat punctuation as separators: "Sr.", "Ed/Ver", "PO #", "FAMS No. / Barcode".
  return String(h || '').replace(/\([^)]*\)/g, '').toLowerCase().replace(/[_\s./#-]+/g, ' ').trim();
}

function buildHeaderMap(headers) {
  const lookup = {};
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) lookup[alias] = canonical;
  }
  const map = {}; // raw header -> canonical key
  for (const h of headers) {
    const norm = normalizeHeader(h);
    if (lookup[norm]) map[h] = lookup[norm];
  }
  return map;
}

function remapRow(rawRow, headerMap) {
  const row = {};
  for (const [rawKey, val] of Object.entries(rawRow)) {
    const canonical = headerMap[rawKey];
    if (canonical) row[canonical] = val instanceof Date ? val : trimStr(val);
  }
  return row;
}

// ---- File parsing (CSV or Excel) ----
function parseCsvText(text) {
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new HttpError('File must include a header row and at least one data row.', 422);
  const splitLine = line => {
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = splitLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const raw = {};
    headers.forEach((h, idx) => { raw[h] = (cols[idx] || '').trim(); });
    rows.push(raw);
  }
  return { headers, rows };
}

// Cell value -> string, matching the old sheet_to_json(raw:false, dateNF:'yyyy-mm-dd') output.
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if ('result' in v) return cellText(v.result);            // formula
    if ('text' in v) return cellText(v.text);                // hyperlink
    if ('error' in v) return '';
    return String(v);
  }
  return String(v);
}

async function parseWorkbookBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (_) {
    throw new HttpError('Could not read this Excel file. Save it as .xlsx (Excel Workbook) or .csv and try again.', 422);
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw new HttpError('The workbook has no sheets.', 422);
  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => { headers[col - 1] = cellText(cell.value).trim(); });
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const raw = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const t = cellText(row.getCell(i + 1).value);
      if (t !== '') any = true;
      raw[h] = t;
    });
    if (any) rows.push(raw);
  });
  if (!rows.length) throw new HttpError('The first sheet has no data rows.', 422);
  return { headers: headers.filter(Boolean), rows };
}

// Detects format from filename/mimetype; falls back to sniffing the buffer.
async function parseUpload(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  let parsed;
  if (ext === 'xls') {
    throw new HttpError('Old .xls (Excel 97-2003) files are not supported. Save the file as .xlsx or .csv and upload again.', 422);
  } else if (ext === 'xlsx') {
    parsed = await parseWorkbookBuffer(buffer);
  } else if (ext === 'csv' || ext === 'txt') {
    parsed = parseCsvText(buffer.toString('utf8'));
  } else {
    // Unknown extension: sniff for the XLSX zip signature (PK\x03\x04), else CSV.
    parsed = (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b)
      ? await parseWorkbookBuffer(buffer)
      : parseCsvText(buffer.toString('utf8'));
  }
  const headerMap = buildHeaderMap(parsed.headers);
  if (!Object.values(headerMap).includes('sw_name')) {
    throw new HttpError('Could not find a Software Name column. Expected a header like "SW Name" or "Software Name".', 422);
  }
  const rows = parsed.rows.map(r => remapRow(r, headerMap));
  return { headers: parsed.headers, mappedColumns: [...new Set(Object.values(headerMap))], rows, total: rows.length };
}

// ---- Validation ----
// Returns 'YYYY-MM-DD'. Strings like "19-Apr-22" parse as *local* midnight, so they
// must be formatted with local date parts — toISOString() (UTC) shifted them a day
// early in IST.
function parseDateVal(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  if (v instanceof Date) return d.toISOString().slice(0, 10);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function boolVal(v) {
  const s = trimStr(v).toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(s);
}

function computeRenewalDate(row, subEnd, purchase) {
  if (subEnd) return subEnd;
  if (!purchase) return null;
  if (row.renewal_name === 'Annual') {
    const d = new Date(purchase); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10);
  }
  if (row.renewal_name === '6 Months') {
    const d = new Date(purchase); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0, 10);
  }
  return null; // Perpetual (or unspecified) with no subscription window
}

function validateRows(rows) {
  const valid = [];
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 2;
    const rowErrors = [];

    const swName = trimStr(row.sw_name);
    if (!swName) rowErrors.push('Missing required field: sw_name (Software Name)');

    const qtyRaw = trimStr(row.qty);
    let qty = 1;
    if (qtyRaw !== '') {
      if (!/^-?\d+$/.test(qtyRaw)) rowErrors.push(`Invalid integer in Qty: ${qtyRaw}`);
      else {
        qty = parseInt(qtyRaw, 10);
        if (qty < QTY_MIN || qty > QTY_MAX) {
          rowErrors.push(`Qty must be between ${QTY_MIN} and ${QTY_MAX} (got ${qty})`);
        }
      }
    }

    const amountRaw = trimStr(row.amount);
    let amount = null;
    if (amountRaw !== '') {
      amount = Number(amountRaw.replace(/,/g, ''));
      if (Number.isNaN(amount)) rowErrors.push(`Invalid number in Amount: ${amountRaw}`);
    }

    const purchaseDate = parseDateVal(row.purchase_date);
    if (purchaseDate === undefined) rowErrors.push(`Invalid date in Purchase Date: ${row.purchase_date}`);
    const subStart = parseDateVal(row.subscription_start_date);
    if (subStart === undefined) rowErrors.push(`Invalid date in Subscription Start Date: ${row.subscription_start_date}`);
    const subEnd = parseDateVal(row.subscription_end_date);
    if (subEnd === undefined) rowErrors.push(`Invalid date in Subscription End Date: ${row.subscription_end_date}`);

    let licenseType = trimStr(row.license_type) || 'Perpetual';
    let renewalName = trimStr(row.renewal_name) || null;
    if (renewalName && !RENEWAL_CYCLES.includes(renewalName)) {
      rowErrors.push(`Renewal Name must be one of: ${RENEWAL_CYCLES.join(', ')} (got ${renewalName})`);
    }

    if (rowErrors.length) { errors.push({ line, data: row, errors: rowErrors }); continue; }

    const renewalDate = computeRenewalDate({ renewal_name: renewalName }, subEnd, purchaseDate);
    valid.push({
      sr_no: intOr(row.sr_no, null),
      sw_name: swName,
      edition_version: trimStr(row.edition_version) || null,
      po_number: trimStr(row.po_number) || null,
      fams_no: trimStr(row.fams_no) || null,
      license_type: licenseType,
      qty,
      purchase_date: purchaseDate,
      renewal_name: renewalName,
      amount,
      subscription_start_date: subStart,
      subscription_end_date: subEnd,
      renewal_date: renewalDate,
      client_provided: boolVal(row.client_provided),
      duty_exempted: boolVal(row.duty_exempted),
      asset_location: trimStr(row.asset_location) || null,
      manufacturer_name: trimStr(row.manufacturer_name) || null,
      remaining_warranty_days: row.remaining_warranty_days !== undefined && trimStr(row.remaining_warranty_days) !== ''
        ? intOr(row.remaining_warranty_days, null) : null,
      vendor_name: trimStr(row.vendor_name) || null,
      invoice_no: trimStr(row.invoice_no) || null,
      client: trimStr(row.client) || null,
      group_name: trimStr(row.group_name) || null,
      project: trimStr(row.project) || null,
      license_key: trimStr(row.license_key) || null,
      remarks: trimStr(row.remarks) || null,
      market_name: trimStr(row.market_name) || null,
      client_name: trimStr(row.client_name) || null,
      allocated_user_name: trimStr(row.allocated_user_name) || null
    });
  }
  return { valid, errors, valid_count: valid.length, error_count: errors.length };
}

// ---- Insert ----
async function executeImport(rows, userId) {
  let imported = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      await db.run(
        `INSERT INTO software_assets (
           sr_no, sw_name, edition_version, po_number, fams_no, license_type, qty, purchase_date,
           renewal_name, amount, subscription_start_date, subscription_end_date, renewal_date,
           client_provided, duty_exempted, asset_location, manufacturer_name, remaining_warranty_days,
           vendor_name, invoice_no, client, group_name, project, license_key, remarks,
           market_name, client_name, allocated_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
           (SELECT id FROM users WHERE $28::text IS NOT NULL AND LOWER(name) = LOWER($28::text) AND deleted_at IS NULL ORDER BY id LIMIT 1))`,
        [r.sr_no, r.sw_name, r.edition_version, r.po_number, r.fams_no, r.license_type, r.qty, r.purchase_date,
          r.renewal_name, r.amount, r.subscription_start_date, r.subscription_end_date, r.renewal_date,
          r.client_provided, r.duty_exempted, r.asset_location, r.manufacturer_name, r.remaining_warranty_days,
          r.vendor_name, r.invoice_no, r.client, r.group_name, r.project, r.license_key, r.remarks,
          r.market_name || null, r.client_name || null, r.allocated_user_name || null]);
      imported += 1;
    } catch (err) {
      errors.push(`Row for "${r.sw_name}": ${err.message}`);
    }
  }
  return { total: rows.length, imported, failed: rows.length - imported, errors };
}

function csvTemplate() {
  const header = ['SW Name', 'Edition Version', 'License Type', 'Qty (0-10)', 'Purchase Date',
    'Renewal Name', 'Amount', 'Subscription Start Date', 'Subscription End Date', 'Vendor Name',
    'Asset Location', 'License Key', 'Remarks'];
  const example = ['Adobe Photoshop', '2026', 'Subscription', '5', '2026-01-15',
    'Annual', '45000', '2026-01-15', '2027-01-14', 'Adobe Inc', 'CitiusTech Hyderabad', '', 'Design team'];
  return [header.join(','), example.join(',')].join('\n');
}

module.exports = { parseUpload, validateRows, executeImport, csvTemplate, QTY_MIN, QTY_MAX, RENEWAL_CYCLES };
