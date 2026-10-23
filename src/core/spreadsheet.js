// Read the first sheet of an uploaded .xlsx (via exceljs) or .csv into
// { headers: [...], rows: [{ header: text }] }. Cell values become strings; Excel
// dates become 'YYYY-MM-DD'. Old binary .xls is rejected with a clear message.
const ExcelJS = require('exceljs');
const { HttpError } = require('./helpers');

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if ('result' in v) return cellText(v.result);   // formula
    if ('text' in v) return cellText(v.text);       // hyperlink
    if ('error' in v) return '';
    return String(v);
  }
  return String(v);
}

function sheetToTable(sheet) {
  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col - 1] = cellText(cell.value).trim(); });
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const raw = { __row: n };
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const t = cellText(row.getCell(i + 1).value).trim();
      if (t) any = true;
      raw[h] = t;
    });
    if (any) rows.push(raw);
  });
  return { name: sheet.name, headers: headers.filter(Boolean), rows };
}

async function loadXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (_) {
    throw new HttpError('Could not read this Excel file. Save it as .xlsx (Excel Workbook) or .csv and try again.', 422);
  }
  if (!wb.worksheets.length) throw new HttpError('The workbook has no sheets.', 422);
  return wb;
}

async function readXlsx(buffer) {
  return sheetToTable((await loadXlsx(buffer)).worksheets[0]);
}

function readCsv(text) {
  // RFC-style: quoted fields may contain commas, quotes ("") and newlines.
  const records = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); records.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); records.push(row); }
  const headers = (records.shift() || []).map(h => h.replace(/^﻿/, '').trim());
  const rows = [];
  records.forEach((r, idx) => {
    if (!r.some(v => v.trim())) return;
    const raw = { __row: idx + 2 };
    headers.forEach((h, i) => { if (h) raw[h] = (r[i] || '').trim(); });
    rows.push(raw);
  });
  return { headers: headers.filter(Boolean), rows };
}

async function readTable(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'xls') {
    throw new HttpError('Old .xls (Excel 97-2003) files are not supported. Save the file as .xlsx or .csv and upload again.', 422);
  }
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const table = ext === 'xlsx' || (ext !== 'csv' && isZip) ? await readXlsx(buffer) : readCsv(buffer.toString('utf8'));
  if (!table.rows.length) throw new HttpError('The file has a header row but no data rows.', 422);
  return table;
}

// Map raw headers to canonical keys using alias lists (case/punctuation-insensitive).
function normalizeHeader(h) {
  return String(h || '').replace(/\([^)]*\)/g, '').toLowerCase().replace(/[_\s./#*-]+/g, ' ').trim();
}
function mapRows(rows, aliases) {
  const lookup = {};
  for (const [key, list] of Object.entries(aliases)) for (const a of list) lookup[normalizeHeader(a)] = key;
  return rows.map(raw => {
    const out = { __row: raw.__row };
    for (const [h, v] of Object.entries(raw)) {
      const key = lookup[normalizeHeader(h)];
      if (key && out[key] === undefined) out[key] = v;
    }
    return out;
  });
}

// All sheets of an .xlsx (hidden sheets skipped), or a single-sheet table for .csv.
async function readWorkbook(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'xls') {
    throw new HttpError('Old .xls (Excel 97-2003) files are not supported. Save the file as .xlsx or .csv and upload again.', 422);
  }
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (ext === 'xlsx' || (ext !== 'csv' && isZip)) {
    const wb = await loadXlsx(buffer);
    return wb.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden').map(sheetToTable);
  }
  return [{ name: 'CSV', ...readCsv(buffer.toString('utf8')) }];
}

module.exports = { readWorkbook, readTable, mapRows, normalizeHeader, cellText };
