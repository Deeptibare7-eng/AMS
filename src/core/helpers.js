const config = require('../config');

// Mirrors PHP hams_url(): prefix APP_URL
function hamsUrl(p = '') {
  const path = '/' + String(p).replace(/^\/+/, '');
  return config.appUrl + (path === '/' ? '' : path);
}

// Mirrors PHP e() htmlspecialchars ENT_QUOTES
function e(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ''/null/undefined -> null else int
function nullableId(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function intOr(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

// Multi-select filters: a query value may be "x=1", "x[]=1&x[]=2" or "x=1,2". Returns the
// non-empty values; `allowed` keeps only known values. listIds() keeps positive integers.
function listParam(v, allowed = null) {
  const raw = v === undefined || v === null ? [] : Array.isArray(v) ? v : String(v).split(',');
  const out = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
  return allowed ? out.filter(x => allowed.includes(x)) : out;
}
function listIds(v) {
  return listParam(v).map(Number).filter(n => Number.isInteger(n) && n > 0);
}
// Appends filters to URLSearchParams: arrays as key[]=v (one per value), scalars as key=v.
function appendFilters(params, filters) {
  for (const [k, v] of Object.entries(filters)) {
    if (Array.isArray(v)) v.forEach(x => params.append(`${k}[]`, x));
    else if (v !== null && v !== undefined && v !== '') params.set(k, v);
  }
  return params;
}

function trimStr(v, def = '') {
  if (v === null || v === undefined) return def;
  return String(v).trim();
}

// Trim all string values of a body object (mirrors Request::getBody sanitize)
function sanitizeBody(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (typeof v === 'string') out[k] = v.trim();
    else if (Array.isArray(v)) out[k] = v.map(x => (typeof x === 'string' ? x.trim() : x));
    else out[k] = v;
  }
  return out;
}

// Extract cf_-prefixed custom fields (mirrors PHP extractCustomFields)
function extractCustomFields(data) {
  const cf = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k.startsWith('cf_')) cf[k.substring(3)] = v;
  }
  return cf;
}

// HttpError with status code (mirrors PHP \Exception($msg, $code))
class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function formatDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

function formatDateTime(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// CSV encode a row of values (RFC-ish, like fputcsv)
function csvRow(values) {
  return values.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

function timestampSlug() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// JSON for embedding inside <script>: escapes '<' (and JS line separators) so
// stored data can't close the script tag.
function safeJson(v) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  return JSON.stringify(v === undefined ? null : v)
    .replace(/</g, '\\u003c')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}

// Initials avatar as an inline SVG data URI. Replaces ui-avatars.com, which
// received every person's name on each page view (and cost a request per row).
function avatarUrl(name, bg = '#3b82f6') {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${e(bg)}"/>` +
    `<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#fff" font-family="Inter,Arial,sans-serif" font-size="26" font-weight="600">${e(initials)}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// QR code as a PNG data URI, generated in-process. Replaces api.qrserver.com,
// which received every encoded value (label links, 2FA secrets).
function qrDataUrl(text, size = 160) {
  return require('qrcode').toDataURL(String(text), { width: size, margin: 1, errorCorrectionLevel: 'M' });
}

// Passwords that shipped as defaults (seed, bulk user import). Signing in with one
// forces a password change; they can't be chosen as a new password.
const DEFAULT_PASSWORDS = new Set(['password', 'changeme123']);
function isDefaultPassword(pw) { return DEFAULT_PASSWORDS.has(String(pw || '').trim().toLowerCase()); }

module.exports = {
  isDefaultPassword,
  qrDataUrl,
  hamsUrl, e, nullableId, intOr, listParam, listIds, appendFilters, trimStr, sanitizeBody, extractCustomFields,
  HttpError, formatDate, formatDateTime, csvRow, timestampSlug, safeJson, avatarUrl
};
