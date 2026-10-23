const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const config = require('./config');
const { pool } = require('./core/db');
const logger = require('./core/logger');
const { HttpError, hamsUrl } = require('./core/helpers');
const securityHeaders = require('./middleware/security');
const viewLocals = require('./middleware/viewLocals');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
// Front-end libraries are served from node_modules (pinned in package.json)
// instead of unpkg/jsdelivr, so pages don't wait on the internet on every click.
const vendor = {
  'alpine.min.js': 'alpinejs/dist/cdn.min.js',
  'lucide.min.js': 'lucide/dist/umd/lucide.min.js',
  'apexcharts.min.js': 'apexcharts/dist/apexcharts.min.js'
};
for (const [name, file] of Object.entries(vendor)) {
  const full = require.resolve(file);
  app.get('/vendor/' + name, (req, res) => res.sendFile(full, { maxAge: '7d' }));
}
app.use('/css', express.static(path.join(config.publicDir, 'css'), { maxAge: '1h' }));
// Self-hosted fonts (replaces fonts.googleapis.com / fonts.gstatic.com).
for (const font of ['inter', 'outfit']) {
  app.use('/fonts/' + font, express.static(path.dirname(require.resolve(`@fontsource/${font}/package.json`)), { maxAge: '30d' }));
}
// Procurement documents (invoices/POs) are not public: they are served further
// down only to signed-in users with assets.view. Everything else in public/ stays static.
const publicStatic = express.static(config.publicDir);
app.use((req, res, next) => (req.path.startsWith('/uploads/procurement/') ? next() : publicStatic(req, res, next)));

const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'sessions' }),
  secret: config.sessionSecret,
  name: 'hams_session',
  resave: false,
  saveUninitialized: true,
  // Secure (HTTPS-only) whenever the app is served over https:// (APP_URL) or runs
  // with APP_ENV=production; 'trust proxy' above lets this work behind nginx/a load balancer.
  cookie: {
    httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8,
    secure: config.appUrl.startsWith('https://') || config.appEnv === 'production'
  }
});
// REST API v1 is header-authenticated (Bearer / agent tokens). Give it a
// throwaway per-request session so a token call never mints a browser session cookie.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/v1/')) { req.session = {}; return next(); }
  sessionMiddleware(req, res, next);
});

app.use(viewLocals);

{
  const { authRequired } = require('./middleware/auth');
  const { perm } = require('./middleware/permission');
  const INLINE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
  app.use('/uploads/procurement', authRequired, perm('assets.view'),
    express.static(path.join(config.publicDir, 'uploads', 'procurement'), {
      index: false, dotfiles: 'deny', fallthrough: true,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (!INLINE.has(path.extname(filePath).toLowerCase())) res.setHeader('Content-Disposition', 'attachment');
      }
    }));
}

// Before web: /users/export must not be taken as /users/:id.
app.use('/', require('./routes/exports'));
app.use('/', require('./routes/web'));
app.use('/', require('./routes/api'));
app.use('/', require('./routes/agent-api'));
app.use('/', require('./routes/heartbeat'));
app.use('/', require('./routes/heartbeat-ui'));
app.use('/', require('./routes/agents-ui'));
app.use('/', require('./routes/software'));
app.use('/', require('./routes/licenseAllocation'));
app.use('/', require('./routes/newJoinees'));
app.use('/', require('./routes/pickers'));
app.use('/', require('./routes/importData'));
app.use('/', require('./routes/locationSpoc'));
app.use('/', require('./routes/ai'));

// 404
app.use((req, res, next) => next(new HttpError('Route not found', 404)));

// Error handler (port of ExceptionHandler)
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 100 && err.status < 600 ? err.status : 500;
  logger.error(err.message, {
    file: err.stack ? err.stack.split('\n')[1] : '',
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    user_id: req.session ? req.session.user_id : null,
    trace: err.stack || ''
  });
  let message = err.message;
  if (status === 500 && config.appEnv !== 'local') {
    message = 'An unexpected error occurred. Please try again later.';
  }
  const wantsJson = req.path.startsWith('/api') || (req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    return res.status(status).json({ success: false, error: { code: status, message } });
  }
  if (res.renderPage) {
    return res.renderPage('_error', { message, statusCode: status });
  }
  res.status(status).send(message);
});

module.exports = app;
