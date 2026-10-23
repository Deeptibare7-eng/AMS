// Port of AuthMiddleware: session guard + employee redirect to portal.
const db = require('../core/db');
const authz = require('../services/authorizationService');
const { hamsUrl } = require('../core/helpers');

const ALWAYS_ALLOWED_PREFIXES = ['/portal', '/logout', '/profile', '/api/'];

async function currentUser(req) {
  if (!req.session || !req.session.user_id) return null;
  if (req._cachedUser !== undefined) return req._cachedUser;
  const user = await db.get(
    'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
    [req.session.user_id]
  );
  req._cachedUser = user;
  return user;
}

// While must_change_password is set, only the Profile page (to change it) and logout work.
const PASSWORD_CHANGE_ALLOWED = ['/profile', '/logout'];

function authRequired(req, res, next) {
  (async () => {
    if (!req.session.user_id) {
      return res.redirect(hamsUrl('/login'));
    }
    const path = req.path;
    const user = await currentUser(req);
    if (user && user.must_change_password && !PASSWORD_CHANGE_ALLOWED.some(p => path === p || path.startsWith(p + '/'))) {
      if (path.startsWith('/api/') || req.xhr) {
        return res.status(403).json({ ok: false, message: 'Password change required.' });
      }
      req.flash('error', 'Please set a new password before continuing.');
      return res.redirect(hamsUrl('/profile'));
    }
    if (ALWAYS_ALLOWED_PREFIXES.some(p => path.startsWith(p))) return next();
    if (!user || !(await authz.can('dashboard.view', user))) {
      return res.redirect(hamsUrl('/portal/dashboard'));
    }
    next();
  })().catch(next);
}

module.exports = { authRequired, currentUser };
