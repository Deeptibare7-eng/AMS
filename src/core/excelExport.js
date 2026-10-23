// Stream an .xlsx download: sheets = [{ name, columns: [{ header, key, width }], rows: [{...}] }].
// Header row is bold on blue, frozen, with an autofilter, so the file is ready to filter in Excel.
const ExcelJS = require('exceljs');

function safeSheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) n = base.slice(0, 28) + ' ' + i++;
  used.add(n.toLowerCase());
  return n;
}

function safeFileName(name) {
  return String(name || 'export').replace(/[^A-Za-z0-9 _.-]+/g, '').replace(/\s+/g, '_').slice(0, 80) || 'export';
}

// Cells that start with = + - @ would run as formulas when opened in Excel.
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

async function sendWorkbook(res, fileName, sheets) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(fileName)}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  wb.creator = 'HAMS';
  wb.created = new Date();
  const used = new Set();
  for (const sheet of sheets) {
    const columns = sheet.columns && sheet.columns.length ? sheet.columns : [{ header: 'Info', key: 'info' }];
    const ws = wb.addWorksheet(safeSheetName(sheet.name, used), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || Math.min(45, Math.max(12, String(c.header).length + 4)) }));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    head.commit();
    for (const r of sheet.rows || []) {
      const out = {};
      for (const c of columns) out[c.key] = cellValue(r[c.key]);
      const row = ws.addRow(out);
      columns.forEach((c, i) => { if (c.numFmt) row.getCell(i + 1).numFmt = c.numFmt; });
      row.commit();
    }
    if (!(sheet.rows || []).length) ws.addRow({ [columns[0].key]: 'No records' }).commit();
    ws.commit();
  }
  await wb.commit();
}

module.exports = { sendWorkbook, safeFileName };
