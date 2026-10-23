// Provides req.flash(), res.renderPage() (layout-wrapped) and res.renderBare()
// (standalone auth pages), plus locals the layout needs (brand, nav gates, user).
const path = require('path');
const ejs = require('ejs');
const db = require('../core/db');
const settings = require('../services/settingsService');
const authz = require('../services/authorizationService');
const moduleService = require('../services/moduleService');
const aiFlags = require('../ai/flags');
const { currentUser } = require('./auth');
const { csrfToken } = require('./csrf');
const helpers = require('../core/helpers');

const viewsDir = path.join(__dirname, '..', 'views');

function renderFile(view, locals) {
  return ejs.renderFile(path.join(viewsDir, view + '.ejs'), locals, { async: true });
}

module.exports = function viewLocals(req, res, next) {
  // Persist session before redirecting so the next request never reads stale state
  const origRedirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (req.session && req.session.save) {
      req.session.save(() => origRedirect(...args));
    } else {
      origRedirect(...args);
    }
  };

  // Flash: set now, read on next request (read-once)
  req.flash = (key, msg) => {
    req.session.flash = req.session.flash || {};
    req.session.flash[key] = msg;
  };
  const flashes = req.session.flash || {};
  delete req.session.flash;
  res.locals.flash = flashes;

  res.renderPage = (view, params = {}) => {
    (async () => {
      const user = await currentUser(req);
      const [brandName, brandTagline, brandLogo] = await Promise.all([
        settings.get('branding', 'app_name', 'HAMS'),
        settings.get('branding', 'app_tagline', 'Enterprise'),
        settings.get('branding', 'app_logo', '')
      ]);
      const permCache = {};
      // Load the user's role/permissions once for the whole sidebar instead of
      // two queries per nav item.
      const navSuper = user ? await authz.isSuperAdmin(user) : false;
      const navPerms = user && !navSuper ? await authz.permissionsFor(user) : [];
      const canNav = async (permission, module = null) => {
        const cacheKey = permission + '|' + module;
        if (permCache[cacheKey] === undefined) {
          const okPerm = user ? (navSuper || authz.hasPermission(navPerms, permission)) : false;
          const okMod = module === null ? true : await moduleService.isEnabled(module);
          permCache[cacheKey] = okPerm && okMod;
        }
        return permCache[cacheKey];
      };
      const isSuperAdmin = navSuper;
      // Location SPOCs get the Location Workspace in the sidebar.
      const isSpoc = user ? !!(await db.get('SELECT 1 AS x FROM site_spocs WHERE user_id = $1 LIMIT 1', [user.id])) : false;
      // AI capabilities that are switched on (empty set while AI is off), for optional AI cards.
      const aiOn = user ? await aiFlags.enabledSet() : new Set();

      const locals = {
        ...helpers,
        hams_url: helpers.hamsUrl,
        csrf_token: csrfToken(req),
        csrf_field: `<input type="hidden" name="_csrf" value="${helpers.e(csrfToken(req))}">`,
        flash: flashes,
        currentPath: req.path,
        // Pages opened from a dashboard tile/chart show a way back (Hardware has its own banner).
        dashboardBack: req.query.from === 'dashboard' && req.path !== '/assets',
        currentUser: user,
        brandName, brandTagline, brandLogo,
        canNav,
        isSuperAdmin,
        isSpoc,
        aiOn,
        ...params
      };
      const content = await renderFile(view, locals);
      const html = await renderFile('layouts/main', { ...locals, content });
      res.status(params.statusCode || 200).send(html);
    })().catch(next);
  };

  res.renderBare = (view, params = {}) => {
    (async () => {
      const [brandName, brandTagline] = await Promise.all([
        settings.get('branding', 'app_name', 'HAMS'),
        settings.get('branding', 'app_tagline', 'Enterprise')
      ]);
      const locals = {
        ...helpers,
        hams_url: helpers.hamsUrl,
        csrf_token: csrfToken(req),
        csrf_field: `<input type="hidden" name="_csrf" value="${helpers.e(csrfToken(req))}">`,
        flash: flashes,
        brandName, brandTagline,
        ...params
      };
      const html = await renderFile(view, locals);
      res.status(params.statusCode || 200).send(html);
    })().catch(next);
  };

  next();
};
