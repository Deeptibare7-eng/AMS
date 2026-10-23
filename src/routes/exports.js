// Header "Download as Excel" icon. Pages with a full export pass exportUrl (see the
// layout); for every other page the browser sends the tables it is showing and gets
// them back as a workbook — only what the user can already see on screen.
const express = require('express');
const userService = require('../services/userService');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { sendWorkbook } = require('../core/excelExport');

const router = express.Router();
const MAX_TABLES = 20, MAX_COLS = 60, MAX_ROWS = 20000, MAX_CELL = 2000;

router.get('/users/export', authRequired, perm('personnel.view'), mod('personnel'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const dir = await userService.getDirectory(user, { page: 1, perPage: 200000, search: String(req.query.search || '') });
    await sendWorkbook(res, 'Users_' + new Date().toISOString().slice(0, 10), [{
      name: 'Users',
      columns: [
        { header: 'Name', key: 'name', width: 28 }, { header: 'Email', key: 'email', width: 36 },
        { header: 'Employee ID', key: 'employee_id', width: 14 }, { header: 'Department', key: 'department_name', width: 22 },
        { header: 'Location', key: 'location_name', width: 18 }, { header: 'Role', key: 'role_display_name', width: 18 },
        { header: 'Status', key: 'status', width: 12 }, { header: 'Source', key: 'auth_source', width: 12 },
        { header: 'Last login', key: 'last_login_at', width: 18, numFmt: 'dd-mmm-yyyy hh:mm' },
        { header: 'Created', key: 'created_at', width: 16, numFmt: 'dd-mmm-yyyy' }
      ],
      rows: dir.items.map(u => ({ ...u, role_display_name: u.role_display_name || u.role }))
    }]);
  } catch (err) { next(err); }
});

router.post('/export/view', authRequired, csrfProtect, async (req, res, next) => {
  try {
    const body = req.body || {};
    const tables = Array.isArray(body.tables) ? body.tables.slice(0, MAX_TABLES) : [];
    let budget = MAX_ROWS;
    const cell = v => String(v === null || v === undefined ? '' : v).slice(0, MAX_CELL);
    const sheets = tables.map((t, ti) => {
      const headers = (Array.isArray(t.headers) ? t.headers : []).slice(0, MAX_COLS).map((h, i) => cell(h).trim() || 'Column ' + (i + 1));
      const raw = (Array.isArray(t.rows) ? t.rows : []).slice(0, Math.max(0, budget));
      budget -= raw.length;
      const width = Math.max(headers.length, ...raw.map(r => (Array.isArray(r) ? Math.min(r.length, MAX_COLS) : 0)), 1);
      while (headers.length < width) headers.push('Column ' + (headers.length + 1));
      const columns = headers.map((h, i) => ({ header: h, key: 'c' + i }));
      const rows = raw.filter(Array.isArray).map(r => {
        const o = {};
        columns.forEach((c, i) => {
          const v = cell(r[i]).trim();
          // Keep plain numbers numeric so Excel can sum them.
          o[c.key] = /^-?\d{1,15}(\.\d+)?$/.test(v) && !/^0\d/.test(v) ? Number(v) : v;
        });
        return o;
      });
      return { name: cell(t.name).trim() || 'Table ' + (ti + 1), columns, rows };
    }).filter(s => s.rows.length || s.columns.length > 1);
    if (!sheets.length) return res.status(422).json({ ok: false, message: 'There is no table on this page to export.' });
    await sendWorkbook(res, cell(body.title).trim() || 'Export', sheets);
  } catch (err) { next(err); }
});

module.exports = router;
