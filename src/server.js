const app = require('./app');
const config = require('./config');
const logger = require('./core/logger');

// Refuse to run in production with missing or weak secrets.
if (config.appEnv === 'production') {
  const problems = [];
  if (!config.sessionSecretFromEnv || String(process.env.SESSION_SECRET).length < 32) problems.push('SESSION_SECRET must be set (32+ characters)');
  if (!config.db.password || ['hams', 'password', 'postgres'].includes(config.db.password) || config.db.password.length < 12) problems.push('DB_PASS must be set to a strong password (12+ characters)');
  if (!config.appUrl.startsWith('https://')) problems.push('APP_URL must use https:// in production');
  if (problems.length) {
    console.error(['Refusing to start in production:', ...problems.map(p => ' - ' + p)].join('\n'));
    process.exit(1);
  }
} else if (!config.sessionSecretFromEnv) {
  console.warn('SESSION_SECRET is not set: using a random secret for this run (sessions reset on restart).');
}

// assets.stock_site (Hardware "Stock site" filter) must exist and match the current site rules.
require('./services/stockSiteService').ensureStockSiteColumn(require('./core/db'))
  .then(rebuilt => { if (rebuilt) console.log('Stock site column (re)built from the Machine Name site rules'); })
  .catch(err => { console.error('Could not prepare assets.stock_site:', err.message); process.exit(1); })
  .then(() => app.listen(config.port, () => {
  console.log(`IT-HAMS running at ${config.appUrl} (env: ${config.appEnv})`);
  logger.info(`Server started on port ${config.port}`);
  if (require('./services/schedulerService').start()) {
    console.log('Automation scheduler running (Settings > Automations; SCHEDULER_ENABLED=0 to switch off)');
  }
  // In-house AI: registers listeners and jobs only; each capability stays off until switched on (Settings > AI).
  require('./ai').start();
  if (config.heartbeat.enabled) {
    const { HeartbeatAgent } = require('./services/heartbeat/heartbeatAgent');
    new HeartbeatAgent().start();
    console.log(`Heartbeat agent enabled (interval ${config.heartbeat.intervalSec}s)`);
  }
}));
