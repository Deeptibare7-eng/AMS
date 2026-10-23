// Duplicate detection on identifiers: serial number, FAMS barcode, host name (Machine Name).
//
// Exact matches after normalising (serials compared without case, spaces or dashes, so
// "ABC-123" and "abc123" are the same; the app's own check only refuses an identical serial).
//
// Near-duplicate serials (one character apart) are deliberately NOT flagged: on the real register
// 3,704 pairs are one edit apart and nearly all are siblings from one order (Dell service tags in a
// batch share most characters, e.g. 80C4271 / B0C4271 / G0C4271), so such warnings would be noise.
const { serialKey } = require('../models/text/tokenize');

const PLACEHOLDER_FAMS = /^(pending|client provided|0+|na|n\/a|-+|tbd|none|nil)$/i;

// FAMS: the barcode number (6-12 digits at the start), or null when it is a placeholder/blank.
function famsNumber(v) {
  const s = String(v ?? '').trim();
  if (!s || PLACEHOLDER_FAMS.test(s)) return null;
  const m = s.match(/^(\d{6,12})/);
  return m ? m[1] : null;
}

// Machine Name used as a host name: one token of letters, digits, dots, dashes or underscores.
// Stock codes ("BL IT Stock 12/01/26"), notes ("Returned to client on ...") and vendor labels are not.
const NOT_HOSTNAME = /it[-\s_]*stock|return(ed)?[\s_-]*to[\s_-]*client|updated[\s_-]*in[\s_-]*ims|fec[\s_-]*asset|^vendor[_ -]|faulty|not[\s_-]*working/i;
function hostname(v) {
  const s = String(v ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/i.test(s) || NOT_HOSTNAME.test(s)) return null;
  return s.toLowerCase();
}

// Values shared by more than one row: Map value -> [ids].
function sharedValues(rows, valueOf) {
  const m = new Map();
  for (const r of rows) {
    const v = valueOf(r);
    if (!v) continue;
    if (!m.has(v)) m.set(v, []);
    m.get(v).push(r.id);
  }
  for (const [k, ids] of m) if (ids.length < 2) m.delete(k);
  return m;
}

// Possible duplicates of one new/edited asset (Register Asset form), from the database.
// input: { serial_number, fams, machine_name, exclude_id }
async function checkCandidate(q, input) {
  const out = [];
  const exclude = parseInt(input.exclude_id, 10) || 0;
  const base = `SELECT a.id, a.asset_tag, a.name, a.serial_number, sl.name AS status
                  FROM assets a LEFT JOIN status_labels sl ON sl.id = a.status_label_id
                 WHERE a.deleted_at IS NULL AND a.id <> $1`;
  const sk = serialKey(input.serial_number);
  if (sk.length >= 4) {
    const rows = await q.query(`${base} AND regexp_replace(upper(a.serial_number), '[^A-Z0-9]', '', 'g') = $2 LIMIT 5`, [exclude, sk]);
    for (const r of rows) {
      const same = String(r.serial_number).trim() === String(input.serial_number).trim();
      out.push({ ...r, reason: same ? 'Same serial number (the save will be refused)' : `Same serial number written differently ("${r.serial_number}")`, confidence: 1 });
    }
  }
  const fams = famsNumber(input.fams);
  if (fams) {
    const rows = await q.query(`${base} AND substring(a.custom_fields_data->>'FAMS No. / Barcode' from '^\\s*(\\d{6,12})') = $2 LIMIT 5`, [exclude, fams]);
    for (const r of rows) out.push({ ...r, reason: `Same FAMS barcode (${fams})`, confidence: 1 });
  }
  const host = hostname(input.machine_name);
  if (host) {
    const rows = await q.query(`${base} AND lower(btrim(a.custom_fields_data->>'Machine Name')) = $2 AND a.status <> 'archived' LIMIT 5`, [exclude, host]);
    for (const r of rows) out.push({ ...r, reason: `Same host name (${String(input.machine_name).trim()})`, confidence: 0.9 });
  }
  return out.slice(0, 8);
}

module.exports = { famsNumber, hostname, sharedValues, checkCandidate, PLACEHOLDER_FAMS };
