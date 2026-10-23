// Outbound email via SMTP (nodemailer), configured in Settings → Notifications.
// Every attempt is written to email_log as sent / failed / skipped, so a missing
// SMTP setup or a bad address never breaks the action that triggered the email.
// SMTP_PASSWORD (environment) takes precedence over the password stored in settings.
const nodemailer = require('nodemailer');
const db = require('../core/db');
const settings = require('./settingsService');

const isDeliverable = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')) && !/\.invalid$/i.test(String(e));

async function smtpConfig() {
  const get = (k, d = '') => settings.get('notifications', k, d);
  const [enabled, host, port, user, pass, enc, from] = await Promise.all([
    get('email_enabled', '0'), get('smtp_host'), get('smtp_port', '587'), get('smtp_username'),
    get('smtp_password'), get('smtp_encryption', 'tls'), get('mail_from')
  ]);
  return {
    enabled: enabled === '1' && !!host && !!from,
    reason: enabled !== '1' ? 'Email is disabled (Settings → Notifications)' : !host ? 'SMTP host is not configured' : !from ? 'From address is not configured' : null,
    transport: {
      host, port: parseInt(port, 10) || 587,
      secure: enc === 'ssl',                 // implicit TLS (465)
      requireTLS: enc === 'tls',             // STARTTLS (587)
      ignoreTLS: enc === 'none',
      auth: user ? { user, pass: process.env.SMTP_PASSWORD || pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
    },
    from
  };
}

async function logEmail(entry) {
  return db.insert(
    `INSERT INTO email_log (type, to_email, cc_emails, subject, body_text, status, error, related_type, related_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [entry.type, entry.to || null, (entry.cc || []).join(', ') || null, entry.subject, entry.text, entry.status,
      entry.error || null, entry.relatedType || null, entry.relatedId || null, entry.createdBy || null]);
}

// Returns { status: 'sent' | 'failed' | 'skipped', error?, to, cc }
async function send({ type, to, cc = [], subject, text, html, relatedType, relatedId, createdBy }) {
  cc = [...new Set(cc.filter(isDeliverable).map(e => e.toLowerCase()))].filter(e => e !== String(to || '').toLowerCase());
  const base = { type, to, cc, subject, text, relatedType, relatedId, createdBy };
  if (!isDeliverable(to)) {
    await logEmail({ ...base, status: 'skipped', error: 'Recipient has no deliverable email address' });
    return { status: 'skipped', error: 'Recipient has no deliverable email address', to, cc };
  }
  const cfg = await smtpConfig();
  if (!cfg.enabled) {
    await logEmail({ ...base, status: 'skipped', error: cfg.reason });
    return { status: 'skipped', error: cfg.reason, to, cc };
  }
  try {
    const transporter = nodemailer.createTransport(cfg.transport);
    await transporter.sendMail({ from: cfg.from, to, cc: cc.length ? cc : undefined, subject, text, html });
    await logEmail({ ...base, status: 'sent' });
    return { status: 'sent', to, cc };
  } catch (err) {
    const error = String(err && err.message || err).slice(0, 500);
    await logEmail({ ...base, status: 'failed', error });
    return { status: 'failed', error, to, cc };
  }
}

module.exports = { send, smtpConfig, isDeliverable };
