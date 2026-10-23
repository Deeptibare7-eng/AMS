// Asset routes (port of AssetController + Dashboard + scan/label APIs + Procurement + Timeline + Catalog API).
const express = require('express');
const multer = require('multer');
const db = require('../core/db');
const authz = require('../services/authorizationService');
const assetService = require('../services/assetService');
const customFieldService = require('../services/customFieldService');
const platformService = require('../services/platformService');
const procurementService = require('../services/procurementService');
const timelineService = require('../services/timelineService');
const catalogService = require('../services/catalogService');
const stockSite = require('../services/stockSiteService');
const locationStock = require('../services/locationStockService');
const aiSearch = require('../ai/search/service');
const aiAsk = require('../ai/agents/assistant');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const { hamsUrl, sanitizeBody, intOr, listIds, appendFilters } = require('../core/helpers');
const { sendWorkbook } = require('../core/excelExport');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Dashboard ───
async function dashboardPage(req, res, next) {
  try {
    res.renderPage('home', { dashboard: await platformService.dashboard(), exportUrl: hamsUrl('/dashboard/export') });
  } catch (err) { next(err); }
}
router.get('/', authRequired, perm('dashboard.view'), dashboardPage);
router.get('/dashboard', authRequired, perm('dashboard.view'), dashboardPage);

// ─── Assets ───
// Hardware list filters from the query string (also used by the Excel export).
function assetFilters(req) {
  const search = String(req.query.search || '');
  const pick = (k, ok) => (ok(String(req.query[k] || '')) ? String(req.query[k]) : null);
  // Multi-select filters: ?model=A&model=B (one value is fine too).
  const multi = k => [...new Set([].concat(req.query[k] || []).map(String).filter(v => v && v.length <= 120))].slice(0, 500);
  return {
    search,
    category_id: multi('category_id'),
    status_label_id: multi('status_label_id'),
    location_id: multi('location_id'),
    manufacturer_id: multi('manufacturer_id'),
    model: multi('model'),
    site: multi('site'),
    // Dashboard drill-downs
    assigned: pick('assigned', v => v === '0' || v === '1'),
    active: pick('active', v => v === '1'),
    warranty: pick('warranty', v => v === 'expiring'),
    repair: pick('repair', v => v === '1'),
    status_label: pick('status_label', v => v === 'none'),
    label_type: pick('label_type', v => ['deployable', 'deployed', 'pending', 'undeployable', 'archived'].includes(v)),
    created_month: pick('created_month', v => /^\d{4}-\d{2}$/.test(v)),
    category_name: pick('category_name', v => v.length > 0 && v.length <= 100),
    department: pick('department', v => v === 'none' || /^\d+$/.test(v)),
    // From questions in plain language (kept only while that AI capability is on; see aiAsk.gate).
    ...nlFilters(req, pick, multi)
  };
}

const NL_KEYS = ['near_site', 'near_location', 'holder', 'warranty_from', 'warranty_to', 'bought_from', 'bought_to', 'ram_min', 'ram_max', 'os', 'ai', 'dq', 'sort', 'asked'];
function nlFilters(req, pick, multi) {
  const date = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const small = v => /^\d{1,4}$/.test(v);
  return {
    near_site: multi('near_site').filter(v => v.length <= 60),
    near_location: multi('near_location').filter(v => /^\d+$/.test(v)),
    holder: pick('holder', v => /^\d{1,9}$/.test(v)),
    warranty_from: pick('warranty_from', date), warranty_to: pick('warranty_to', date),
    bought_from: pick('bought_from', date), bought_to: pick('bought_to', date),
    ram_min: pick('ram_min', small), ram_max: pick('ram_max', small),
    os: pick('os', v => ['windows11', 'windows10', 'windows_legacy', 'eol', 'macos', 'linux'].includes(v)),
    ai: pick('ai', v => ['refresh_high', 'unusual'].includes(v)),
    dq: pick('dq', v => /^[a-z_]{3,40}$/.test(v)),
    sort: pick('sort', v => ['oldest', 'newest', 'cost_high', 'cost_low', 'risk'].includes(v)),
    asked: pick('asked', v => v.length > 0 && v.length <= 200)
  };
}

// Hardware filter dropdowns (multi-select, as on Asset Models). Model and Location values come
// from the assets themselves, the rest from the catalog; a value already chosen is always listed.
function filterSelects(filters, references, all) {
  const refs = list => (list || []).map(o => ({ v: String(o.id), l: o.name }));
  const models = [...new Set([...all.model.keys(), ...filters.model])].sort((a, b) => a.localeCompare(b)).map(v => ({ v, l: v }));
  return [
    { key: 'category_id', any: 'All categories', noun: 'categories', options: refs(references.categories) },
    { key: 'status_label_id', any: 'All statuses', noun: 'statuses', options: refs(references.status_labels) },
    { key: 'site', any: 'All locations', noun: 'locations', title: 'Where the device sits, read from Machine Name', options: stockSite.siteOptions([...all.site.keys(), ...filters.site]) },
    { key: 'location_id', any: 'All asset locations', noun: 'asset locations', title: 'The register\'s Asset Location (purchase location)', options: refs(references.locations) },
    { key: 'manufacturer_id', any: 'All manufacturers', noun: 'manufacturers', options: refs(references.manufacturers) },
    { key: 'model', any: 'All models', noun: 'models', options: models }
  ];
}

// The result in words, e.g. "There are 20 Laptops with status In Stock at the Mindspace location,
// model 5400". Returns null when nothing is filtered.
function describeResult(filters, selects, n, extras) {
  const label = (key, v) => (selects.find(s => s.key === key).options.find(o => o.v === v) || { l: v }).l;
  const names = key => filters[key].map(v => label(key, v));
  const or = a => {
    if (a.length > 4) a = [...a.slice(0, 3), `${a.length - 3} more`];
    return a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`;
  };
  const cats = names('category_id').map(c => (n === 1 ? c : c + 's'));
  const parts = [], tail = [];
  if (filters.status_label_id.length) parts.push(`with status ${or(names('status_label_id'))}`);
  if (filters.site.length) {
    const sites = filters.site.filter(v => !stockSite.SITE_KEY_LABELS[v]);
    const sp = [];
    if (sites.length) sp.push(`at the ${or(sites)} location${sites.length > 1 ? 's' : ''}`);
    if (filters.site.includes('_returned')) sp.push('marked Returned to client');
    if (filters.site.includes('_unknown')) sp.push('in stock under an unknown site code');
    if (filters.site.includes('_none')) sp.push('with no location in Machine Name');
    parts.push(sp.join(' or '));
  }
  if (filters.location_id.length) parts.push(`with Asset Location ${or(names('location_id'))}`);
  if (filters.manufacturer_id.length) parts.push(`made by ${or(names('manufacturer_id'))}`);
  if (filters.model.length) tail.push(`model ${or(names('model'))}`);
  if (filters.search) tail.push(`matching "${filters.search}"`);
  if (extras.length) tail.push(`(${extras.join(', ')})`);
  if (!parts.length && !tail.length && !cats.length) return null;
  return {
    lead: n === 1 ? 'There is' : 'There are',
    rest: `${cats.length ? or(cats) : (n === 1 ? 'asset' : 'assets')}${parts.length ? ' ' + parts.join(' ') : ''}${tail.length ? ', ' + tail.join(', ') : ''}`
  };
}

router.get('/assets', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const page = intOr(req.query.page, 1);
    // A question in plain language (?ask=, AI while on): shown as the filters it was understood as.
    if (req.query.ask) return res.redirect(hamsUrl(await aiAsk.redirectFor(String(req.query.ask), user)));
    const filters = await aiAsk.gate(assetFilters(req));
    const fromDashboard = req.query.from === 'dashboard';
    // Smart search (AI, while its switch is on): ranked matches over every field. Otherwise, or
    // while its index is still being built, the name / tag / serial match as before.
    const { filters: listFilters, smart } = await aiSearch.forFilters(filters);
    if (!smart) aiSearch.warm();
    const [result, references, cards, all, inventoryTotal] = await Promise.all([
      assetService.page(page, 15, listFilters, user),
      assetService.getReferenceData(user),
      assetService.summary(listFilters, user),
      assetService.facetCounts({}, user), // every Model / Location value, for the dropdowns
      authz.applyLocationScope({}, user).then(s => assetService.count(s))
    ]);
    // Keep every active filter on pagination links, not just the search text.
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (Array.isArray(v)) v.forEach(x => qs.append(k, x)); else if (v) qs.set(k, v);
    }
    if (fromDashboard) qs.set('from', 'dashboard');
    const baseUrl = hamsUrl('/assets') + (qs.toString() ? '?' + qs.toString() : '');

    // Dashboard drill-down filters that have no dropdown: kept as they are, and described.
    const extraParams = {};
    for (const k of ['assigned', 'active', 'warranty', 'repair', 'status_label', 'label_type', 'created_month', 'category_name', 'department', ...NL_KEYS]) {
      if (Array.isArray(filters[k]) ? filters[k].length : filters[k]) extraParams[k] = filters[k];
    }
    if (fromDashboard) extraParams.from = 'dashboard';
    const shown = [];
    if (filters.status_label) shown.push('Status: not set');
    if (filters.category_name) shown.push(`Category: ${filters.category_name}`);
    if (filters.assigned === '1') shown.push('Assigned to an employee');
    if (filters.assigned === '0') shown.push('Not assigned');
    if (filters.label_type === 'deployable') shown.push('In stock (deployable)');
    else if (filters.label_type) shown.push(`State: ${filters.label_type}`);
    if (filters.warranty) shown.push('Warranty expiring in 90 days');
    if (filters.repair) shown.push('In repair');
    if (filters.created_month) shown.push(`Added in ${filters.created_month}`);
    if (filters.department === 'none') shown.push('Department: unassigned');
    else if (filters.department) shown.push(`Department #${filters.department}`);
    if (filters.active) shown.push('Active (not retired)');
    const selects = filterSelects(filters, references, all);
    // A question in plain language: the filters it became, each removable (null: no question). Its own
    // filters (place, holder, dates, RAM, ...) also go into the sentence above the list.
    const askChips = filters.asked || NL_KEYS.some(k => (Array.isArray(filters[k]) ? filters[k].length : filters[k] && k !== 'asked'))
      ? await aiAsk.chipsFromQuery(qs.toString(), filters) : null;
    const askShown = (askChips || []).filter(c => c.keys.some(k => NL_KEYS.includes(k))).map(c => c.label);
    res.renderPage('assets/index', {
      assets: result.items, paginator: result.paginator, total: result.total, inventoryTotal, cards,
      filters, selects, statement: describeResult(filters, selects, result.total, [...shown, ...askShown]), extraParams,
      siteLabel: stockSite.siteKeyLabel, references, baseUrl, fromDashboard, shownFilters: shown,
      // What smart search understood, and why each listed asset matched (null: old search).
      smartSearch: smart ? { banner: aiSearch.banner(smart), why: aiSearch.explain(smart, result.items.map(a => a.id)) } : null,
      askBanner: askChips ? { question: filters.asked, chips: askChips } : null,
      // Header Excel icon: every asset matching the current filters, not just this page.
      exportUrl: hamsUrl('/assets/export') + (qs.toString() ? '?' + qs.toString() : ''),
      canAssign: await authz.can('assets.checkout', user),
      // Same rule as checkoutAsset and the in-stock picker.
      inStockCount: (await db.get(`SELECT COUNT(*)::int AS c FROM assets a LEFT JOIN status_labels sl ON a.status_label_id = sl.id
        WHERE a.deleted_at IS NULL AND a.assigned_to IS NULL
          AND LOWER(COALESCE(sl.name, a.status, '')) IN ('available', 'in stock', 'ready to deploy', 'ready')`)).c
    });
  } catch (err) { next(err); }
});

const ASSET_EXPORT_COLUMNS = [
  { header: 'Asset tag', key: 'asset_tag', width: 16 },
  { header: 'Name', key: 'name', width: 28 },
  { header: 'Serial number', key: 'serial_number', width: 18 },
  { header: 'Category', key: 'category_name', width: 16 },
  { header: 'Model', key: 'model_name', width: 24 },
  { header: 'Model number', key: 'model_number', width: 18 },
  { header: 'Manufacturer', key: 'manufacturer_name', width: 16 },
  { header: 'Status', key: 'status_label_name', width: 16 },
  { header: 'Asset Location', key: 'location_name', width: 18 },
  { header: 'Location (from Machine Name)', key: 'stock_site', width: 24 },
  { header: 'Assigned to', key: 'assigned_to_name', width: 26 },
  { header: 'Supplier', key: 'supplier_name', width: 18 },
  { header: 'Purchase date', key: 'purchase_date', width: 14, numFmt: 'dd-mmm-yyyy' },
  { header: 'Purchase cost', key: 'purchase_cost', width: 14 },
  { header: 'Warranty expiry', key: 'warranty_expiry', width: 14, numFmt: 'dd-mmm-yyyy' },
  { header: 'Added on', key: 'created_at', width: 16, numFmt: 'dd-mmm-yyyy' }
];

router.get('/assets/export', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    // Same matches (and order) as the list, smart search included.
    const scoped = await authz.applyLocationScope((await aiSearch.forFilters(await aiAsk.gate(assetFilters(req)))).filters, user);
    const rows = (await assetService.exportRows(scoped)).map(a => ({
      ...a,
      category_name: a.category_name || a.category,
      status_label_name: a.status_label_name || a.status,
      stock_site: a.stock_site === '_none' ? '' : stockSite.siteKeyLabel(a.stock_site),
      purchase_cost: a.purchase_cost === null || a.purchase_cost === undefined ? null : Number(a.purchase_cost)
    }));
    await sendWorkbook(res, 'Hardware_' + new Date().toISOString().slice(0, 10), [{ name: 'Hardware', columns: ASSET_EXPORT_COLUMNS, rows }]);
  } catch (err) { next(err); }
});

// Dashboard as a workbook: one sheet per tile/chart, same numbers as on screen.
router.get('/dashboard/export', authRequired, perm('dashboard.view'), async (req, res, next) => {
  try {
    const d = await platformService.dashboard();
    const kv = [{ header: 'Metric', key: 'k', width: 36 }, { header: 'Value', key: 'v', width: 16 }];
    const lt = [{ header: 'Name', key: 'label', width: 30 }, { header: 'Assets', key: 'total', width: 12 }];
    const sheets = [
      { name: 'Summary', columns: kv, rows: [
        { k: 'Total assets', v: d.assets }, { k: 'Active users', v: d.users }, { k: 'Assigned assets', v: d.assigned },
        { k: 'In stock (deployable)', v: d.in_stock }, { k: 'In repair', v: d.repair },
        { k: 'Warranties expiring (90 days)', v: d.warranty_expiring }, { k: 'Serviceability index (%)', v: d.health }
      ] },
      { name: 'Acquisition by month', columns: [{ header: 'Month', key: 'month', width: 14 }, { header: 'New assets', key: 'total', width: 12 }], rows: d.trend },
      { name: 'By category', columns: lt, rows: d.by_category },
      { name: 'By department', columns: lt, rows: d.by_department },
      { name: 'Lifecycle states', columns: lt, rows: d.by_status },
      { name: 'Inventory stock', columns: [{ header: 'Module', key: 'm', width: 16 }, { header: 'Available', key: 'a', width: 12 }, { header: 'Total', key: 't', width: 12 }],
        rows: Object.entries(d.inventory_stock).map(([m, x]) => ({ m, a: x.available, t: x.total })) }
    ];
    await sendWorkbook(res, 'Dashboard_' + new Date().toISOString().slice(0, 10), sheets);
  } catch (err) { next(err); }
});

router.get('/assets/create', authRequired, perm('assets.create'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('assets/create', {
      references: await assetService.getReferenceData(user),
      asset_tag: await assetService.nextAssetTag()
    });
  } catch (err) { next(err); }
});

router.get('/assets/labels', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    let rawIds = req.query.ids || [];
    if (!Array.isArray(rawIds)) rawIds = String(rawIds).split(',');
    res.renderPage('assets/labels', { assets: await assetService.getLabelAssets(rawIds, user) });
  } catch (err) { next(err); }
});

router.get('/assets/scan', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('assets/scan', { references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.get('/labels/assets/:token', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const asset = await assetService.findByLabelToken(req.params.token);
    if (!asset) return res.renderPage('_error', { message: 'Asset label not found', statusCode: 404 });
    res.redirect(hamsUrl('/assets/' + asset.id));
  } catch (err) { next(err); }
});

router.get('/api/scan/:token', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const asset = await assetService.findByLabelToken(req.params.token);
    if (!asset) return res.status(404).json({ ok: false, message: 'Asset not found' });
    const status = String(asset.status_label_name || asset.status || '').toLowerCase();
    const isAvailable = ['available', 'ready to deploy', 'ready', 'in stock'].includes(status);
    const isAssigned = ['assigned', 'deployed', 'in use'].includes(status);
    res.json({
      ok: true,
      asset: {
        id: asset.id, name: asset.name, asset_tag: asset.asset_tag,
        serial: asset.serial_number,
        status: asset.status_label_name || asset.status,
        category: asset.category_name || asset.category
      },
      actions: { can_checkout: isAvailable, can_checkin: isAssigned },
      links: {
        view: hamsUrl('/assets/' + asset.id),
        checkout: hamsUrl('/assets/' + asset.id + '/checkout'),
        checkin: hamsUrl('/assets/' + asset.id + '/checkin')
      }
    });
  } catch (err) { next(err); }
});

router.post('/assets', authRequired, csrfProtect, perm('assets.create'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const data = sanitizeBody(req.body);
    try {
      if (await assetService.registerAsset(data, user)) {
        req.flash('success', 'Asset registered in enterprise ledger');
        return res.redirect(hamsUrl('/assets'));
      }
      req.flash('error', 'Registration failed');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/create'));
  } catch (err) { next(err); }
});

router.get('/api/categories/:id/fields', authRequired, mod('assets'), async (req, res, next) => {
  try {
    res.json(await customFieldService.getFieldsByCategory(intOr(req.params.id)));
  } catch (err) { next(err); }
});

router.get('/api/locations/:id/sub-locations', authRequired, mod('assets'), async (req, res, next) => {
  try {
    const rows = await db.query(
      'SELECT id, name, code, floor, room FROM sub_locations WHERE location_id = $1 AND deleted_at IS NULL ORDER BY name ASC',
      [intOr(req.params.id)]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/assets/bulk-delete', authRequired, csrfProtect, perm('assets.delete'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(Number).filter(Boolean);
    if (!ids.length) {
      req.flash('error', 'No assets selected.');
      return res.redirect(hamsUrl('/assets'));
    }
    const deleted = await assetService.bulkDeleteAssets(ids, user);
    req.flash('success', `${deleted} asset(s) deleted.`);
    res.redirect(hamsUrl('/assets'));
  } catch (err) { next(err); }
});

router.post('/assets/bulk-update', authRequired, csrfProtect, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(Number).filter(Boolean);
    if (!ids.length) {
      req.flash('error', 'No assets selected.');
      return res.redirect(hamsUrl('/assets'));
    }
    const updateData = {};
    if (req.body.status_label_id) updateData.status_label_id = req.body.status_label_id;
    if (req.body.location_id) updateData.location_id = req.body.location_id;
    if (!Object.keys(updateData).length) {
      req.flash('error', 'No update fields provided.');
      return res.redirect(hamsUrl('/assets'));
    }
    try {
      const updated = await assetService.bulkUpdateAssets(ids, updateData, user);
      req.flash('success', `${updated} asset(s) updated successfully.`);
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets'));
  } catch (err) { next(err); }
});

router.get('/assets/:id', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const asset = await assetService.getAsset(intOr(req.params.id), user);
    if (!asset) return res.renderPage('_error', { message: 'Asset not found', statusCode: 404 });
    res.renderPage('assets/show', {
      asset,
      references: await assetService.getReferenceData(user),
      assignments: await assetService.assignmentHistory(asset.id),
      stock_history: await assetService.stockHistory(asset.id),
      custom_fields: await customFieldService.getFieldsByCategory(asset.category_id || 0),
      book_value: assetService.calculateDepreciation(asset),
      insight: stockSite.assetInsight(asset),
      history: await locationStock.history(asset)
    });
  } catch (err) { next(err); }
});

router.get('/assets/:id/edit', authRequired, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const asset = await assetService.getAsset(intOr(req.params.id), user);
    if (!asset) return res.renderPage('_error', { message: 'Asset not found', statusCode: 404 });
    res.renderPage('assets/edit', { asset, references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.post('/assets/:id/update', authRequired, csrfProtect, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      if (await assetService.updateAsset(id, sanitizeBody(req.body), user)) {
        req.flash('success', 'Asset updated successfully');
        return res.redirect(hamsUrl('/assets/' + id));
      }
      req.flash('error', 'Asset update failed');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/' + id + '/edit'));
  } catch (err) { next(err); }
});

router.post('/assets/:id/delete', authRequired, csrfProtect, perm('assets.delete'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (await assetService.deleteAsset(intOr(req.params.id), user)) {
      req.flash('success', 'Asset deleted successfully');
    } else {
      req.flash('error', 'Asset delete failed');
    }
    res.redirect(hamsUrl('/assets'));
  } catch (err) { next(err); }
});

// Hardware page "Quick assign": pick an in-stock asset + a user. Same checkout
// logic as the asset page (availability re-checked, assignment, ledger, audit).
router.post('/assets/quick-assign', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const assetId = intOr(req.body.asset_id);
    const userId = intOr(req.body.user_id);
    try {
      if (!assetId) throw new Error('Choose an in-stock asset from the list.');
      if (!userId) throw new Error('Choose a user from the list.');
      const holder = await db.get('SELECT id, name, employee_id FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
      if (!holder) throw new Error('That user no longer exists.');
      await assetService.checkoutAsset(assetId, {
        user_id: userId,
        checkout_notes: String(req.body.checkout_notes || '').trim().slice(0, 500) || 'Assigned from Hardware (quick assign)'
      }, user);
      const a = await db.get('SELECT asset_tag, name FROM assets WHERE id = $1', [assetId]);
      req.flash('success', `${a.name} (${a.asset_tag}) assigned to ${holder.name}${holder.employee_id ? ' (' + holder.employee_id + ')' : ''}.`);
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets'));
  } catch (err) { next(err); }
});

router.post('/assets/:id/checkout', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      await assetService.checkoutAsset(id, sanitizeBody(req.body), user);
      req.flash('success', 'Asset checked out successfully');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/' + id));
  } catch (err) { next(err); }
});

router.post('/assets/:id/checkin', authRequired, csrfProtect, perm('assets.checkout'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const id = intOr(req.params.id);
    try {
      await assetService.checkinAsset(id, sanitizeBody(req.body), user);
      req.flash('success', 'Asset checked in successfully');
    } catch (err) {
      req.flash('error', err.message);
    }
    res.redirect(hamsUrl('/assets/' + id));
  } catch (err) { next(err); }
});

// ─── Catalog API (inline creation) ───
router.get('/api/catalog/:type/search', authRequired, async (req, res) => {
  try {
    const results = await catalogService.search(req.params.type, String(req.query.q || '').trim());
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

router.post('/api/catalog/:type', authRequired, csrfProtect, perm('inventory.create'), async (req, res) => {
  try {
    const user = await currentUser(req);
    const data = sanitizeBody(req.body);
    const id = await catalogService.create(req.params.type, data, user);
    res.json({ ok: true, record: await catalogService.getCreatedRecord(req.params.type, id, data) });
  } catch (err) {
    res.status(422).json({ ok: false, message: err.message });
  }
});

// ─── Procurement ───
router.get('/procurement', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const result = await procurementService.getRecordsPage(intOr(req.query.page, 1), 25, search);
    res.renderPage('procurement/index', {
      records: result.records, paginator: result.paginator, total: result.total, search,
      baseUrl: hamsUrl('/procurement') + (search ? '?search=' + encodeURIComponent(search) : '')
    });
  } catch (err) { next(err); }
});

router.get('/procurement/create', authRequired, perm('assets.create'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.renderPage('procurement/create', { references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.post('/procurement', authRequired,
  upload.fields([{ name: 'invoice', maxCount: 1 }, { name: 'po', maxCount: 1 }]), csrfProtect,
  perm('assets.create'), mod('assets'), async (req, res, next) => {
    try {
      const user = await currentUser(req);
      try {
        const id = await procurementService.createRecord(sanitizeBody(req.body), req.files, user);
        if (id) {
          req.flash('success', 'Procurement record created successfully');
          return res.redirect(hamsUrl('/procurement'));
        }
      } catch (err) {
        req.flash('error', err.message);
      }
      res.redirect(hamsUrl('/procurement/create'));
    } catch (err) { next(err); }
  });

router.get('/procurement/:id', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const record = await procurementService.getRecord(intOr(req.params.id));
    if (!record) return res.renderPage('_error', { message: 'Record not found', statusCode: 404 });
    const assets = await procurementService.getLinkedAssets(record.id, { page: intOr(req.query.page, 1) });
    res.renderPage('procurement/show', {
      record, assets, paginator: assets.paginator, baseUrl: hamsUrl('/procurement/' + record.id)
    });
  } catch (err) { next(err); }
});

router.get('/procurement/:id/edit', authRequired, perm('assets.edit'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const record = await procurementService.getRecord(intOr(req.params.id));
    if (!record) return res.renderPage('_error', { message: 'Record not found', statusCode: 404 });
    res.renderPage('procurement/edit', { record, references: await assetService.getReferenceData(user) });
  } catch (err) { next(err); }
});

router.post('/procurement/:id/update', authRequired,
  upload.fields([{ name: 'invoice', maxCount: 1 }, { name: 'po', maxCount: 1 }]), csrfProtect,
  perm('assets.edit'), mod('assets'), async (req, res, next) => {
    try {
      const user = await currentUser(req);
      const id = intOr(req.params.id);
      try {
        if (await procurementService.updateRecord(id, sanitizeBody(req.body), req.files, user)) {
          req.flash('success', 'Procurement record updated successfully');
          return res.redirect(hamsUrl('/procurement/' + id));
        }
      } catch (err) {
        req.flash('error', err.message);
      }
      res.redirect(hamsUrl('/procurement/' + id + '/edit'));
    } catch (err) { next(err); }
  });

// ─── Internal APIs + Timeline ───
router.get('/api/dashboard', authRequired, perm('dashboard.view'), async (req, res, next) => {
  try { res.json(await platformService.dashboard()); } catch (err) { next(err); }
});

router.get('/api/assets', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  // Same JSON-array response as before, but paged (?page=, ?per_page= up to 200) and
  // location-scoped; it used to return the first 1,000 full rows to any assets.view user.
  try {
    const user = await currentUser(req);
    const perPage = Math.min(Math.max(intOr(req.query.per_page, 100), 1), 200);
    const result = await assetService.page(intOr(req.query.page, 1), perPage, { search: String(req.query.search || '') }, user);
    res.setHeader('X-Total-Count', result.total);
    res.setHeader('X-Page', result.paginator.currentPage);
    res.setHeader('X-Per-Page', perPage);
    res.json(result.items);
  } catch (err) { next(err); }
});

router.get('/timeline/:module/:id', authRequired, perm('assets.view'), async (req, res, next) => {
  try {
    res.renderPage('timeline/show', {
      module: req.params.module,
      id: req.params.id,
      events: await timelineService.get(req.params.module, intOr(req.params.id))
    });
  } catch (err) { next(err); }
});

module.exports = router;
