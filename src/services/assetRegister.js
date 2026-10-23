// Reads the "Asset Data" register workbook and normalizes each row into the shape the
// tool stores. Only IMPORTED_TYPES rows are imported (Computing -> Hardware); other Asset
// Types (Accessories, Servers) and Intune columns are left out. Values come from the file
// as written; nothing is inferred:
//   Allocated + CTID -> employee holder;  Allocated + Type of Allocation "Hardware" -> Deployed, no holder
//   In Repository -> In Stock;  Allocated -> Deployed;  "Retired - ..." -> a status with that exact name
//   any other status -> row not imported (counted in unknownStatus for the preview)
const ExcelJS = require('exceljs');
const { HttpError } = require('../core/helpers');

const IMPORTED_TYPES = ['Computing'];

const t = v => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
// Placeholders that mean "no value" for the linked fields (location, manufacturer, model,
// category, vendor, invoice). Detail fields keep the file's text as written.
const JUNK = new Set(['', 'na', 'n/a', '#n/a', 'nil', 'none', 'pending', '-', '0', 'tbd', 'null']);
const clean = v => (JUNK.has(t(v).toLowerCase()) ? '' : t(v));
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    return '';
  }
  return String(v);
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(v) {
  const s = t(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return +m[1] >= 1990 && +m[1] <= 2045 ? s : null;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = +m[3]; if (y < 100) y += y >= 70 ? 1900 : 2000;
    return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  return null;
}
function parseAmount(v) {
  const s = t(v).replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return n > 0 && n < 1e9 ? n : null;
}
const isRealPo = v => /^(CTIN|CTINPO|CTUS|PO)[-_ ]?\w*\d{3,}/i.test(t(v)) || /^\d{6,}$/.test(t(v));
const looksLikeTag = v => /^\d{6,12}$/.test(t(v));
const looksLikeHostname = v => /^[A-Za-z][A-Za-z0-9\-_.]{2,30}$/.test(t(v)) && !/stock|return|client|store|scrap|repair|handover/i.test(t(v));

// In Repository / Allocated map to the tool's working statuses (check-out and stock counts
// rely on those names). Every "Retired - ..." status keeps its exact name. Anything else
// returns null so the row is reported instead of guessed.
function statusFor(raw) {
  const s = t(raw);
  const l = s.toLowerCase();
  if (l === 'allocated') return { kind: 'allocated', status: 'assigned', label: 'Deployed' };
  if (l === 'in repository') return { kind: 'stock', status: 'available', label: 'In Stock' };
  if (/^retired\s*-\s*\S/.test(l)) return { kind: 'retired', status: 'archived', label: s.slice(0, 100) };
  return null;
}

const REQUIRED = ['Sr.', 'Asset Type', 'Friendly Name', 'Service Tag #', 'Asset Status', 'CTID', 'Asset Location',
  'Manufacturer Name', 'Model Number'];

// Reads the first sheet and returns { headers, rows: [normalized], skipped, excluded,
// unknownStatus, total }. skipped = rows without an Asset Type; excluded = rows per Asset
// Type not in IMPORTED_TYPES; unknownStatus = rows per status text statusFor() doesn't know.
async function readRegister(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (_) {
    throw new HttpError('Could not read this Excel file. Upload the Asset Data workbook saved as .xlsx.', 422);
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError('The workbook has no sheets.', 422);
  const H = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { H[i - 1] = t(cellText(c.value)); });
  const missing = REQUIRED.filter(h => !H.includes(h));
  if (missing.length) {
    throw new HttpError(`This doesn't look like the Asset Data file — missing column(s): ${missing.join(', ')}.`, 422);
  }
  const ix = name => H.indexOf(name);
  const C = {
    sr: ix('Sr.'), type: ix('Asset Type'), friendly: ix('Friendly Name'), tag: ix('Service Tag #'), po: ix('PO #'),
    fams: ix('FAMS No. / Barcode'), purchase: ix('Purchase Date'), amount: ix('Amount'), status: ix('Asset Status'),
    allocType: ix('Type of Allocation'), ctid: ix('CTID'), clientProv: ix('Client Provided Asset'), duty: ix('Duty Exempted'),
    loc: ix('Asset Location'), employer: ix('CTID Employer Name'), parent: ix('Parent Asset Type'), mfr: ix('Manufacturer Name'),
    machine: ix('Machine Name'), model: ix('Model Number'), os: ix('OEM OS'), hddType: ix('Harddisk Type'), hddSize: ix('Harddisk Size'),
    hddCount: ix('No of Harddisks'), cpu: ix('Processor'), cores: ix('No of Cores Processors'), ram: ix('RAM Size'),
    wStart: ix('Warranty Start Date'), wEnd: ix('Warranty End Date'), vendor: ix('Vendor Name'), invoice: ix('Invoice No.'),
    order: ix('Order No.'), baseline: ix('Baseline Date'), keyboard: ix('Keyboard'), monitor: ix('Monitor'), client: ix('Client'),
    group: ix('Group'), project: ix('Project'), remarks: ix('Remarks'), fixedId: ix('Fixed Asset ID'), grn: ix('GRN No.'),
    insured: ix('Insured')
  };
  const raw = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const a = [];
    for (let i = 1; i <= H.length; i++) a.push(t(cellText(row.getCell(i).value)));
    if (a.some(Boolean)) raw.push({ n, a });
  });
  const g = (a, k) => (C[k] >= 0 ? a[C[k]] || '' : '');

  const rows = [];
  let skipped = 0;
  const excluded = {}, unknownStatus = {};
  const occurrences = new Map(); // service tag (upper) -> count, for duplicate tags
  const imported = new Set(IMPORTED_TYPES.map(x => x.toLowerCase()));
  for (const { n, a } of raw) {
    const type = g(a, 'type');
    if (!type) { skipped++; continue; }
    if (!imported.has(type.toLowerCase())) { excluded[type] = (excluded[type] || 0) + 1; continue; }
    const st = statusFor(g(a, 'status'));
    if (!st) { const s = g(a, 'status') || '(blank)'; unknownStatus[s] = (unknownStatus[s] || 0) + 1; continue; }
    const isAcc = /^accessories$/i.test(type);
    const serialRaw = g(a, 'tag');
    const key = serialRaw.toUpperCase();
    const occ = key ? (occurrences.get(key) || 0) + 1 : 1;
    if (key) occurrences.set(key, occ);
    const ctid = clean(g(a, 'ctid'));

    const cf = {};
    // Detail fields: the file's text as written (only blank cells are left out).
    const put = (k, v) => { const s = t(v); if (s) cf[k] = s.slice(0, 500); };
    put('Sr. (source row)', g(a, 'sr')); put('Asset Type', g(a, 'type')); put('Parent Asset Type', g(a, 'parent'));
    put('Asset Status (source)', g(a, 'status')); put('Type of Allocation', g(a, 'allocType')); put('CTID', g(a, 'ctid'));
    put('CTID Employer Name', g(a, 'employer')); put('PO #', g(a, 'po')); put('FAMS No. / Barcode', g(a, 'fams'));
    put('Machine Name', g(a, 'machine')); put('OEM OS', g(a, 'os')); put('Processor', g(a, 'cpu'));
    // Counts and sizes: 0 means "not recorded" in the register, so only positive numbers are kept.
    if (/^[1-9]\d*$/.test(g(a, 'cores'))) cf['No of Cores'] = g(a, 'cores');
    if (/^[1-9]\d*$/.test(g(a, 'ram'))) cf['RAM Size (GB)'] = g(a, 'ram');
    put('Harddisk Type', g(a, 'hddType'));
    if (/^[1-9]\d*$/.test(g(a, 'hddSize'))) cf['Harddisk Size'] = g(a, 'hddSize');
    if (/^[1-9]\d*$/.test(g(a, 'hddCount'))) cf['No of Harddisks'] = g(a, 'hddCount');
    if (g(a, 'wStart')) cf['Warranty Start Date'] = parseDate(g(a, 'wStart')) || g(a, 'wStart');
    put('Vendor Name', g(a, 'vendor')); put('Invoice No.', g(a, 'invoice')); put('Order No.', g(a, 'order'));
    put('GRN No.', g(a, 'grn')); put('Fixed Asset ID', g(a, 'fixedId')); put('Client', g(a, 'client')); put('Group', g(a, 'group'));
    put('Project', g(a, 'project')); put('Client Provided Asset', g(a, 'clientProv')); put('Duty Exempted', g(a, 'duty'));
    put('Insured', g(a, 'insured')); put('Baseline Date', g(a, 'baseline')); put('Keyboard', g(a, 'keyboard')); put('Monitor', g(a, 'monitor'));

    const mf = clean(g(a, 'mfr')) || null;
    const md = clean(g(a, 'model')) || null;
    const cat = clean(g(a, 'friendly')) || null;
    // Name: the Machine Name when it is a real host name, else "Manufacturer Model" (the
    // register has no asset-name column; Machine Name often holds notes like "IT STOCK ...").
    const machine = g(a, 'machine');
    rows.push({
      line: n, isAcc, key, occ, serialRaw: serialRaw || null, ctid: ctid || null,
      statusKind: st.kind, status: st.status, label: st.label, statusRaw: g(a, 'status'),
      category: cat, manufacturer: mf, model: md, location: clean(g(a, 'loc')) || null,
      vendor: (v => (v && !/client provided/i.test(v) ? v : null))(clean(g(a, 'vendor'))),
      po: isRealPo(g(a, 'po')) ? g(a, 'po') : null, invoice: clean(g(a, 'invoice')) || null,
      purchase: parseDate(g(a, 'purchase')), amount: parseAmount(g(a, 'amount')), warrantyEnd: parseDate(g(a, 'wEnd')),
      notes: g(a, 'remarks') || null, fams: g(a, 'fams'), sr: g(a, 'sr'),
      name: isAcc ? (md || [mf, cat].filter(Boolean).join(' ') || 'Accessory').slice(0, 255)
        : (looksLikeHostname(machine) ? machine : [mf, md].filter(Boolean).join(' ') || cat || `Asset ${serialRaw}`).slice(0, 255),
      cf
    });
  }
  // A FAMS barcode can become the asset tag only if no other imported row carries it.
  const famsCount = new Map();
  for (const r of rows) if (r.fams) famsCount.set(r.fams, (famsCount.get(r.fams) || 0) + 1);
  for (const r of rows) r.famsUnique = famsCount.get(r.fams) === 1;
  return { headers: H, rows, skipped, excluded, unknownStatus, total: raw.length };
}

module.exports = { IMPORTED_TYPES, readRegister, statusFor, looksLikeTag };
