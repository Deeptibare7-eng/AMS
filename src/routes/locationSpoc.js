// Location Workspace (SPOCs: their own sites; Hardware viewers: any site, plus "All sites") and
// the Location SPOCs admin page. Every action re-checks that the site is one the user may open.
const express = require('express');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm } = require('../middleware/permission');
const spoc = require('../services/locationSpocService');
const stock = require('../services/stockSiteService');
const assetService = require('../services/assetService');
const newJoineeService = require('../services/newJoineeService');
const { hamsUrl, intOr } = require('../core/helpers');

const router = express.Router();
const TABS = ['overview', 'stock', 'allocate', 'joiners'];
const back = (site, tab) => hamsUrl(`/location-workspace?site=${encodeURIComponent(site)}&tab=${tab}`);

router.get('/location-workspace', authRequired, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const access = await spoc.sitesFor(user);
    if (!access.sites.length) {
      return res.status(403).renderPage('_error', { statusCode: 403, message: 'The Location Workspace is for Location SPOCs. Ask an admin to add you as SPOC for your site.' });
    }
    // Admins (and SPOCs with several sites) start on "All sites".
    const wanted = String(req.query.site || '');
    const site = wanted === 'all' || (!wanted && (access.all || access.sites.length > 1)) ? 'all'
      : access.sites.includes(wanted) ? wanted : access.sites[0];
    const tab = TABS.includes(req.query.tab) ? req.query.tab : 'overview';
    const data = site === 'all'
      ? { network: await spoc.network(access.all ? null : access.sites) }
      : { ws: await spoc.siteWorkspace(site) };
    if (data.ws && tab === 'overview') {
      // Transfer suggestions that involve this site (other sites' spares are shown read-only).
      data.transfers = (await spoc.network()).transfers.filter(t => t.from === site || t.to === site);
    }
    if (data.ws && tab === 'joiners') {
      data.joinees = (await newJoineeService.listJoinees()).filter(j => j.site === site);
      data.options = await newJoineeService.allocationOptions(data.joinees.map(j => j.location_id));
    }
    res.renderPage('location/workspace', {
      access, site, tab, ...data, grades: stock.GRADES, today: new Date().toISOString().slice(0, 10),
      selectedAsset: String(req.query.asset || '') // "Allocate" link on Stock by model pre-selects the laptop
    });
  } catch (err) { next(err); }
});

// Person search for the Allocate form (SPOCs can't use the directory pickers).
router.get('/location-workspace/people', authRequired, async (req, res, next) => {
  try {
    const access = await spoc.sitesFor(await currentUser(req));
    if (!access.sites.length) return res.status(403).json({ ok: false, results: [] });
    const rows = await spoc.searchPeople(req.query.q);
    res.json({ ok: true, results: rows.map(u => ({ id: u.id, label: u.employee_id && u.employee_id !== u.name ? `${u.name} (${u.employee_id})` : u.name })) });
  } catch (err) { next(err); }
});

router.post('/location-workspace/allocate', authRequired, csrfProtect, async (req, res, next) => {
  const site = String(req.body.site || '');
  try {
    const user = await currentUser(req);
    await spoc.assertSite(user, site);
    const assetId = intOr(req.body.asset_id, 0);
    const holderId = intOr(req.body.user_id, 0);
    if (!holderId) throw Object.assign(new Error('Pick the employee to allocate to.'), { status: 422 });
    const laptop = await spoc.assertAllocatable(site, assetId);
    const notes = String(req.body.notes || '').trim().slice(0, 500);
    await assetService.checkoutAsset(assetId, { user_id: holderId, checkout_notes: `Allocated from ${site} stock (Location Workspace)${notes ? ': ' + notes : ''}` }, user);
    req.flash('success', `${laptop.model} ${laptop.asset_tag} allocated.`);
  } catch (err) {
    if (!err.status) return next(err);
    req.flash('error', err.message);
  }
  res.redirect(back(site, 'allocate'));
});

router.post('/location-workspace/checkin', authRequired, csrfProtect, async (req, res, next) => {
  const site = String(req.body.site || '');
  try {
    const user = await currentUser(req);
    await spoc.assertSite(user, site);
    const assetId = intOr(req.body.asset_id, 0);
    await spoc.assertOutAtSite(site, assetId);
    const condition = ['good', 'repair', 'damaged'].includes(req.body.condition) ? req.body.condition : 'good';
    await assetService.checkinAsset(assetId, { checkin_condition: condition, checkin_notes: `Checked in at ${site} (Location Workspace)${req.body.notes ? ': ' + String(req.body.notes).slice(0, 500) : ''}` }, user);
    req.flash('success', 'Device checked in.');
  } catch (err) {
    if (!err.status) return next(err);
    req.flash('error', err.message);
  }
  res.redirect(back(site, 'allocate'));
});

// New joiners: change the drafted laptop, or approve (allocate + email) — joiners at the site only.
async function joineeAtSite(user, site, id) {
  await spoc.assertSite(user, site);
  const j = (await newJoineeService.listJoinees()).find(x => x.id === id);
  if (!j || j.site !== site) throw Object.assign(new Error('That joiner is not at this location.'), { status: 403 });
  return j;
}

router.post('/location-workspace/joinees/:id/laptop', authRequired, csrfProtect, async (req, res, next) => {
  const site = String(req.body.site || '');
  try {
    const user = await currentUser(req);
    const j = await joineeAtSite(user, site, intOr(req.params.id, 0));
    await newJoineeService.updateDraft(j.id, { laptop_asset_id: req.body.laptop_asset_id, headphone_accessory_id: j.draft_headphone_accessory_id || '' }, user);
    req.flash('success', `Laptop changed for ${j.name}.`);
  } catch (err) {
    if (!err.status) return next(err);
    req.flash('error', err.message);
  }
  res.redirect(back(site, 'joiners'));
});

router.post('/location-workspace/joinees/:id/approve', authRequired, csrfProtect, async (req, res, next) => {
  const site = String(req.body.site || '');
  try {
    const user = await currentUser(req);
    const j = await joineeAtSite(user, site, intOr(req.params.id, 0));
    const r = await newJoineeService.approveAllocation(j.id, user);
    req.flash('success', `Allocated to ${j.name}.` + (r.email && r.email.status === 'sent' ? ' Email sent.' : ` Email not sent (${(r.email && r.email.error) || 'email not set up'}).`));
  } catch (err) {
    if (!err.status) return next(err);
    req.flash('error', err.message);
  }
  res.redirect(back(site, 'joiners'));
});

// ───────────── Location SPOCs (admin) ─────────────
const adminGuard = [authRequired, perm('personnel.manage')];

// The page; `created` (a new account's temporary password) is rendered once, never stored.
async function spocsPage(res, created = null) {
  res.renderPage('location/spocs', { directory: await spoc.directory(), sites: await spoc.allSites(), created });
}

// After adding a SPOC or enabling sign-in: show a new account's password once, else flash.
function added(req, res, r) {
  if (r.password) return spocsPage(res, r);
  req.flash('success', r.contact
    ? `${r.name} added as SPOC contact for ${r.sites.join(', ')}. Add their email when you have it to let them sign in.`
    : `${r.email} is now SPOC for ${r.sites.join(', ')} (existing account, password unchanged).`);
  res.redirect(hamsUrl('/location-spocs'));
}

router.get('/location-spocs', ...adminGuard, async (req, res, next) => {
  try { await spocsPage(res); } catch (err) { next(err); }
});

router.post('/location-spocs', authRequired, csrfProtect, perm('personnel.manage'), async (req, res, next) => {
  try {
    try {
      return await added(req, res, await spoc.addSpoc(req.body, await currentUser(req)));
    } catch (err) {
      if (!err.status) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/location-spocs'));
  } catch (err) { next(err); }
});

router.post('/location-spocs/:id/enable-sign-in', authRequired, csrfProtect, perm('personnel.manage'), async (req, res, next) => {
  try {
    try {
      return await added(req, res, await spoc.enableSignIn(req.params.id, req.body, await currentUser(req)));
    } catch (err) {
      if (!err.status) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/location-spocs'));
  } catch (err) { next(err); }
});

router.post('/location-spocs/:id/edit', authRequired, csrfProtect, perm('personnel.manage'), async (req, res, next) => {
  try {
    try {
      const r = await spoc.editSpoc(req.params.id, req.body, await currentUser(req));
      req.flash('success', `Saved ${r.name} (${r.site}).`);
    } catch (err) {
      if (!err.status) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/location-spocs'));
  } catch (err) { next(err); }
});

router.post('/location-spocs/office', authRequired, csrfProtect, perm('personnel.manage'), async (req, res, next) => {
  try {
    try {
      await spoc.saveSiteOffice(String(req.body.site || ''), req.body, await currentUser(req));
      req.flash('success', `Office details saved for ${req.body.site}.`);
    } catch (err) {
      if (!err.status) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/location-spocs'));
  } catch (err) { next(err); }
});

router.post('/location-spocs/:id/remove', authRequired, csrfProtect, perm('personnel.manage'), async (req, res, next) => {
  try {
    try {
      const r = await spoc.removeSpoc(req.params.id, await currentUser(req));
      req.flash('success', `${r.name} removed as SPOC for ${r.site}.`);
    } catch (err) {
      if (!err.status) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/location-spocs'));
  } catch (err) { next(err); }
});

router.post('/location-spocs/users/:id/reset-password', authRequired, csrfProtect, perm('personnel.manage'), async (req, res, next) => {
  try {
    try {
      const r = await spoc.resetPassword(req.params.id, await currentUser(req));
      return spocsPage(res, { name: r.name, email: r.email, sites: [], password: r.password, reset: true });
    } catch (err) {
      if (!err.status) throw err;
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/location-spocs'));
  } catch (err) { next(err); }
});

module.exports = router;
