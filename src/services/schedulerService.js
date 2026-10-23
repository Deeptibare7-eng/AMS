// Built-in job scheduler: runs recurring jobs inside the web process, so no cron /
// Task Scheduler setup is needed. Ticks once a minute; each job runs once per
// "slot" (an interval bucket, a day or a week in the configured time zone).
//
// - On/off switches and times live in settings group 'automation' (Settings → Automations).
// - The last run of each job is kept in settings group 'scheduler_state'.
// - A Postgres advisory lock makes a job run once even if several app instances
//   share the database. Set SCHEDULER_ENABLED=0 to switch the scheduler off.
// - A job seen for the first time records the current slot instead of running, so
//   enabling the scheduler never fires everything at once; use "Run now" to test.
const db = require('../core/db');
const logger = require('../core/logger');
const settings = require('./settingsService');

const LOCK_NS = 70412;
const DEFAULT_TZ = 'Asia/Kolkata';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const JOBS = [
  { key: 'folder_imports', label: 'Daily folder import', group: 'imports', defaultEnabled: true,
    description: 'Checks the import folder for a new Asset Data register and imports it. It is applied automatically only within the safety limits; otherwise it is held for review.',
    schedule: { type: 'interval', minutes: 30 },
    run: ctx => require('./folderImportService').run(ctx) },
  { key: 'daily_alerts', label: 'Daily IT alerts', group: 'alerts', defaultEnabled: true,
    description: 'Warranties reaching 90/60/30 days, leavers still holding devices and low spare stock per site. Sends one digest (email, Teams, in-app) only when something needs attention.',
    schedule: { type: 'daily', timeKey: 'daily_time', time: '08:00' },
    run: ctx => require('./alertDigestService').runDaily(ctx) },
  { key: 'weekly_summary', label: 'Weekly summary', group: 'alerts', defaultEnabled: true,
    description: 'Fleet totals, the week\'s activity, warranty exposure, leavers and low stock, sent to the summary recipients.',
    schedule: { type: 'weekly', dayKey: 'weekly_day', day: 1, timeKey: 'weekly_time', time: '09:00' },
    run: () => require('./alertDigestService').runWeekly() },
  { key: 'report_schedules', label: 'Scheduled reports', group: 'existing', defaultEnabled: true,
    description: 'Generates the report files set up under Report Schedules when they are due (saved on the server in storage/reports).',
    schedule: { type: 'interval', minutes: 15 },
    run: async () => `${await require('./reportScheduleService').runDue()} report(s) generated` },
  { key: 'backup_schedules', label: 'Scheduled backups', group: 'existing', defaultEnabled: true,
    description: 'Runs the backup schedules set up under Backup & Restore when they are due (only if automatic backups are switched on there).',
    schedule: { type: 'interval', minutes: 15 },
    run: async () => `${await require('./backupService').runDueSchedules(null)} backup(s) run` },
  { key: 'joinee_recommendations', label: 'New-joinee kit suggestions', group: 'existing', defaultEnabled: true,
    description: 'Suggests a laptop and headset for newly imported joiners. A coordinator still reviews and approves each one.',
    schedule: { type: 'interval', minutes: 60 },
    run: async () => `${await require('./newJoineeService').ensureDrafts()} joiner(s) given a suggested kit` },
  { key: 'token_prune', label: 'Remove expired API tokens', group: 'cleanup', defaultEnabled: false,
    description: 'Deletes API tokens that have already expired.',
    schedule: { type: 'daily', time: '02:00' },
    run: async () => `${await require('./apiTokenService').pruneExpired()} expired token(s) removed` },
  { key: 'log_cleanup', label: 'Log retention clean-up', group: 'cleanup', defaultEnabled: false,
    description: 'Trims application log files to the retention set in the Log Viewer.',
    schedule: { type: 'daily', time: '02:15' },
    run: async () => `${await require('./logService').enforceRetention()} log file(s) processed` },
  { key: 'archive_purge', label: 'Purge expired archive', group: 'cleanup', defaultEnabled: false, destructive: true,
    description: 'PERMANENTLY deletes archived (soft-deleted) assets, accessories, licences etc. older than the archive retention period. Cannot be undone.',
    schedule: { type: 'daily', time: '02:30' },
    run: async () => `${await require('./archiveService').purgeExpired()} archived record(s) permanently deleted` }
];
const BY_KEY = new Map(JOBS.map(j => [j.key, j]));

// Add-on jobs (the AI layer). A job may bring its own enabled() switch instead of the
// Automations-page setting; jobs in other groups are not listed on the Automations page.
function register(job) {
  if (BY_KEY.has(job.key)) return false;
  JOBS.push(job);
  BY_KEY.set(job.key, job);
  return true;
}

// ───────────────────────────── time & slots ─────────────────────────────

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}
async function timeZone() {
  const tz = await settings.get('automation', 'timezone', DEFAULT_TZ);
  return validTz(tz) ? tz : DEFAULT_TZ;
}
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const toMinutes = t => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3), 10);

// Wall-clock parts in a time zone: { date: 'YYYY-MM-DD', minutes, weekday 0-6 }.
function partsIn(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(at).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  };
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function jobTime(job) {
  const t = job.schedule.timeKey ? await settings.get('automation', job.schedule.timeKey, job.schedule.time) : job.schedule.time;
  return validTime(t) ? t : job.schedule.time;
}
async function jobDay(job) {
  const d = parseInt(job.schedule.dayKey ? await settings.get('automation', job.schedule.dayKey, String(job.schedule.day)) : job.schedule.day, 10);
  return d >= 0 && d <= 6 ? d : job.schedule.day;
}

// The slot the job should most recently have run in. Daily/weekly slots are dates.
async function currentSlot(job, tz, now = new Date()) {
  const s = job.schedule;
  if (s.type === 'interval') return 'i' + Math.floor(now.getTime() / (s.minutes * 60000));
  const p = partsIn(tz, now);
  const t = toMinutes(await jobTime(job));
  if (s.type === 'daily') return p.minutes >= t ? p.date : addDays(p.date, -1);
  const day = await jobDay(job);
  let back = (p.weekday - day + 7) % 7;
  if (back === 0 && p.minutes < t) back = 7;
  return addDays(p.date, -back);
}

async function describe(job, tz) {
  const s = job.schedule;
  if (s.type === 'interval') return s.minutes >= 60 ? `Every ${s.minutes / 60} hour${s.minutes === 60 ? '' : 's'}` : `Every ${s.minutes} minutes`;
  const t = await jobTime(job);
  return s.type === 'daily' ? `Daily at ${t}` : `${DAYS[await jobDay(job)]}s at ${t}`;
}

async function isEnabled(job) {
  if (job.enabled) return !!(await job.enabled());
  return (await settings.get('automation', `job_${job.key}_enabled`, job.defaultEnabled ? '1' : '0')) === '1';
}

// ───────────────────────────── state ─────────────────────────────

async function readState(q, key) {
  const row = await q.get(`SELECT setting_value FROM settings WHERE group_key = 'scheduler_state' AND setting_key = $1`, [key]);
  if (!row) return null;
  try { return JSON.parse(row.setting_value); } catch (_) { return null; }
}
async function writeState(q, key, state) {
  await q.run(
    `INSERT INTO settings (group_key, setting_key, setting_value) VALUES ('scheduler_state', $1, $2)
     ON CONFLICT (group_key, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
    [key, JSON.stringify(state)]);
}

// ───────────────────────────── running ─────────────────────────────

// Runs one job under an advisory lock. Scheduled runs advance the slot; manual runs don't
// (so the next scheduled run still happens and covers its full window).
async function execute(job, { manual = false, user = null } = {}) {
  const tz = await timeZone();
  const slot = await currentSlot(job, tz);
  return db.tx(async t => {
    const lock = await t.get('SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS ok', [LOCK_NS, job.key]);
    if (!lock.ok) return { status: 'skipped', summary: 'Already running elsewhere.' };
    const state = await readState(t, job.key) || {};
    if (!manual && state.last_slot === slot) return { status: 'skipped', summary: 'Already ran for this slot.' };

    // Daily windows: (previous slot, this slot]. Manual runs cover just today.
    const today = partsIn(tz).date;
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const until = manual || !isDate(slot) ? today : slot;
    const since = !manual && isDate(state.last_slot) && state.last_slot < until ? state.last_slot : addDays(until, -1);

    const t0 = Date.now();
    let status = 'ok', summary = '', error = null;
    try {
      summary = String(await job.run({ manual, user, since, until }) ?? '');
    } catch (err) {
      status = 'error';
      error = String(err && err.message || err).slice(0, 1000);
      logger.error(`[Scheduler] ${job.key} failed: ${error}`);
    }
    const next = {
      last_slot: manual ? (state.last_slot || slot) : slot,
      last_run_at: new Date().toISOString(), status, summary: summary.slice(0, 2000), error,
      duration_ms: Date.now() - t0, manual, by: user ? user.name : null
    };
    await writeState(t, job.key, next);
    if (!manual) logger.info(`[Scheduler] ${job.key} ${status} in ${next.duration_ms}ms: ${summary || error}`);
    return next;
  });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const tz = await timeZone();
    for (const job of JOBS) {
      try {
        if (!(await isEnabled(job))) continue;
        const slot = await currentSlot(job, tz);
        const state = await readState(db, job.key);
        if (!state) { await writeState(db, job.key, { last_slot: slot, baseline: true }); continue; }
        if (state.last_slot === slot) continue;
        await execute(job);
      } catch (err) {
        logger.error(`[Scheduler] ${job.key}: ${err.message}`);
      }
    }
  } finally {
    ticking = false;
  }
}

let timer = null;
function start() {
  if (process.env.SCHEDULER_ENABLED === '0' || timer) return false;
  setTimeout(() => tick().catch(() => {}), 20000);
  timer = setInterval(() => tick().catch(() => {}), 60000);
  return true;
}

async function runNow(key, user) {
  const job = BY_KEY.get(key);
  if (!job) throw new Error('Unknown job');
  return execute(job, { manual: true, user });
}

// For the Automations page.
async function status() {
  const tz = await timeZone();
  const rows = await db.query(`SELECT setting_key, setting_value FROM settings WHERE group_key = 'scheduler_state'`);
  const states = Object.fromEntries(rows.map(r => { try { return [r.setting_key, JSON.parse(r.setting_value)]; } catch (_) { return [r.setting_key, null]; } }));
  const out = [];
  for (const job of JOBS) {
    out.push({
      key: job.key, label: job.label, description: job.description, group: job.group, destructive: !!job.destructive,
      enabled: await isEnabled(job), schedule: await describe(job, tz), state: states[job.key] || null
    });
  }
  return { tz, running: !!timer, jobs: out };
}

module.exports = { JOBS, DAYS, DEFAULT_TZ, start, tick, runNow, status, register, validTz, validTime, partsIn, currentSlot, addDays };
