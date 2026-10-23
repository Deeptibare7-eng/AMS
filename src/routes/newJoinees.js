// New Joinees (Asset Management): onboarding asset allocation.
// The allocation agent drafts a laptop + headphones per designation from the
// joinee's own location; an engineer reviews/edits (location-scoped dropdowns)
// and approves. Guarded like the rest of Asset Management.
const express = require('express');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const newJoineeService = require('../services/newJoineeService');
const authz = require('../services/authorizationService');
const multer = require('multer');
const { hamsUrl, sanitizeBody, intOr } = require('../core/helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Excel template with the import headers and a "Valid values" sheet.
router.get('/new-joinees/import/template', authRequired, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const buf = await newJoineeService.importTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="new-joinees-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// Import joinees from .xlsx/.csv, then draft recommendations. Nothing is assigned
// until an engineer clicks Allocate.
router.post('/new-joinees/import', authRequired, upload.single('file'), csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Choose an Excel (.xlsx) or CSV file to import.');
      return res.redirect(hamsUrl('/new-joinees'));
    }
    try {
      const r = await newJoineeService.importJoinees(req.file.buffer, req.file.originalname, await currentUser(req));
      const spocMsg = r.spocs ? ` Location SPOCs: ${r.spocs.saved} saved for ${r.spocs.locations} location(s).` : '';
      req.flash('success', `Import complete: ${r.created} joinee(s) added, ${r.updated} updated` +
        (r.unchanged ? `, ${r.unchanged} unchanged` : '') +
        `. Laptop/headset recommendations drafted for ${r.recommended} joinee(s) — review and click Allocate.` + spocMsg);
      // One flash per type is shown, so combine all warnings into a single message.
      const warnings = [];
      if (r.skipped.length) {
        const shown = r.skipped.slice(0, 8).map(s => `row ${s.row}${s.employee_id ? ' (' + s.employee_id + ')' : ''}: ${s.reason}`);
        warnings.push(`${r.skipped.length} row(s) skipped — ${shown.join('; ')}${r.skipped.length > 8 ? '; …' : ''}.`);
      }
      if (r.noStock.length) {
        warnings.push(`No available laptops at: ${r.noStock.join(', ')} — those joinees have no laptop recommendation; use a stocked location (see the template's "Valid values" sheet).`);
      }
      if (r.defaultedDesignation) {
        warnings.push(`${r.defaultedDesignation} joinee(s) have a designation without a laptop rule; the standard Engineer laptop was recommended.`);
      }
      if (warnings.length) req.flash('error', warnings.join(' '));
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/new-joinees'));
  } catch (err) { next(err); }
});

router.get('/new-joinees', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    // Recommendation pass: only when some joinee needs a draft (read-only check first),
    // so ordinary page views don't open a write transaction. Never assigns —
    // SPOC review + approval is still required.
    if (await newJoineeService.needsRecommendations()) await newJoineeService.ensureDrafts();
    const newJoinees = await newJoineeService.listJoinees();
    res.renderPage('new-joinees/index', {
      newJoinees,
      canImport: await authz.can('assets.checkout', await currentUser(req)),
      // Only the joinees' locations are pickable, so don't ship every in-stock laptop.
      allocationOptions: await newJoineeService.allocationOptions(newJoinees.map(j => j.location_id))
    });
  } catch (err) { next(err); }
});

// Engineer edits the agent's draft allocation (location-validated).
router.post('/new-joinees/:id/allocation', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      await newJoineeService.updateDraft(intOr(req.params.id), sanitizeBody(req.body), actor);
      req.flash('success', 'Allocation draft updated.');
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/new-joinees'));
  } catch (err) { next(err); }
});

// Engineer approves — finalizes through the standard asset checkout +
// accessory assignment writers so Assets/Accessories tabs stay in sync.
router.post('/new-joinees/:id/allocate', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    try {
      const r = await newJoineeService.approveAllocation(intOr(req.params.id), actor);
      req.flash('success', (r.headphones
        ? 'Laptop and headphones allocated'
        : 'Laptop allocated (no headphones available at this location — issue them later)') +
        ' — now reflected in Hardware' + (r.headphones ? ' and Accessories' : '') + '.' +
        (r.email.status === 'sent' ? ` Allocation email sent to ${r.email.to}${r.email.cc.length ? ' (cc ' + r.email.cc.join(', ') + ')' : ''}.` : ''));
      if (r.email.status !== 'sent') {
        req.flash('error', `Allocation email not sent: ${r.email.error}. Use "Resend email" after fixing it.`);
      }
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/new-joinees'));
  } catch (err) { next(err); }
});

// Resend the allocation email (e.g. after SMTP setup or once the joinee has an email).
// Preview the allocation email (To / CC / subject / body) without sending it.
router.get('/new-joinees/:id/email/preview', authRequired, perm('assets.view'), mod('assets'), async (req, res) => {
  try {
    res.json({ ok: true, ...(await newJoineeService.previewAllocationEmail(intOr(req.params.id), await currentUser(req))) });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, message: err.message });
  }
});

// Remove a not-yet-allocated joinee (and their pending account) from the tool.
router.post('/new-joinees/:id/remove', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    try {
      const r = await newJoineeService.removeJoinee(intOr(req.params.id), await currentUser(req));
      req.flash('success', `${r.name} (${r.employee_id}) removed from New Joinees${r.accountRemoved ? ' — their pending account was deleted too' : ''}.`);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/new-joinees'));
  } catch (err) { next(err); }
});

router.post('/new-joinees/:id/email', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    try {
      const r = await newJoineeService.sendAllocationEmail(intOr(req.params.id), await currentUser(req));
      if (r.status === 'sent') req.flash('success', `Allocation email sent to ${r.to}${r.cc.length ? ' (cc ' + r.cc.join(', ') + ')' : ''}.`);
      else req.flash('error', `Allocation email not sent: ${r.error}.`);
    } catch (err) { req.flash('error', err.message); }
    res.redirect(hamsUrl('/new-joinees'));
  } catch (err) { next(err); }
});

module.exports = router;
