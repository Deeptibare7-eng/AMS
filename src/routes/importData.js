// "Import Data": upload the Asset Data register, preview what it changes, then apply.
// Admin-only (it updates hardware, accessories, allocations and employee accounts).
const express = require('express');
const multer = require('multer');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const sync = require('../services/assetRegisterSync');
const { hamsUrl } = require('../core/helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const guard = [authRequired, perm('settings.manage'), mod('assets')];

router.get('/import-data', ...guard, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const history = (await sync.history(10)).map(h => {
      let info = null; try { info = h.errors && h.errors.trim().startsWith('{') ? JSON.parse(h.errors) : null; } catch (_) {}
      return { ...h, info };
    });
    res.renderPage('import-data/index', {
      jobId: String(req.query.job || ''), job: req.query.job ? sync.getJob(String(req.query.job), user.id) : null, history
    });
  } catch (err) { next(err); }
});

// Upload -> background analysis (read-only), then the page polls for the preview.
router.post('/import-data/analyze', authRequired, upload.single('file'), csrfProtect, perm('settings.manage'), mod('assets'), async (req, res, next) => {
  try {
    if (!req.file) { req.flash('error', 'Choose the Asset Data Excel file (.xlsx) to import.'); return res.redirect(hamsUrl('/import-data')); }
    if (!/\.xlsx$/i.test(req.file.originalname)) { req.flash('error', 'Upload the Asset Data workbook as .xlsx.'); return res.redirect(hamsUrl('/import-data')); }
    try {
      const id = sync.startAnalysis(req.file.buffer, req.file.originalname, await currentUser(req));
      return res.redirect(hamsUrl('/import-data?job=' + id));
    } catch (err) { req.flash('error', err.message); return res.redirect(hamsUrl('/import-data')); }
  } catch (err) { next(err); }
});

router.get('/import-data/jobs/:id', ...guard, async (req, res) => {
  const job = sync.getJob(String(req.params.id), (await currentUser(req)).id);
  if (!job) return res.status(404).json({ ok: false, message: 'Import not found (the server may have restarted). Upload the file again.' });
  res.json({ ok: true, job });
});

router.post('/import-data/jobs/:id/apply', authRequired, csrfProtect, perm('settings.manage'), mod('assets'), async (req, res, next) => {
  try {
    try { sync.startApply(String(req.params.id), await currentUser(req)); } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/import-data?job=' + encodeURIComponent(req.params.id)));
  } catch (err) { next(err); }
});

module.exports = router;
