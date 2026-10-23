// Data-health rules for hardware assets. Each rule looks at one asset (plus fleet-wide context
// built once per scan) and returns null or an issue { detail, confidence?, data? } with a
// plain-language detail. Only active (not retired) assets are scored.
//
// Asset score = 100 - Σ weight(severity) × confidence, floored at 0.
const { famsNumber, hostname, PLACEHOLDER_FAMS } = require('./duplicates');
const { serialKey } = require('../models/text/tokenize');

const WEIGHT = { high: 30, medium: 15, low: 5 };
const inr = n => '₹' + Math.round(Number(n)).toLocaleString('en-IN');
const quote = s => `"${String(s).trim().slice(0, 60)}"`;
const others = (ids, self, tagOf, max = 2) => {
  const o = ids.filter(i => i !== self);
  const shown = o.slice(0, max).map(i => tagOf.get(i) || '#' + i).join(', ');
  return o.length > max ? `${shown} and ${o.length - max} more` : shown;
};

const RETURNED = /return(ed)?[\s_-]*to[\s_-]*client/i;
const VENDOR = /^vendor[_ -]/i;
const STOCK_CODE = /it[-\s_]*stock/i;
const NOTE = /\s|\//; // a host name has no spaces or slashes

const RULES = [
  // ── Status & location ──
  {
    code: 'returned_in_stock', label: 'In Stock but returned to client', severity: 'high', group: 'Status & location',
    check: r => (r.status === 'available' && RETURNED.test(r.machine_name || ''))
      ? { detail: `Shows as In Stock, but its Machine Name (${quote(r.machine_name)}) says it went back to the client, so it may not really be available.` } : null
  },
  {
    code: 'vendor_in_stock', label: 'In Stock but with a vendor', severity: 'medium', group: 'Status & location',
    check: r => (r.status === 'available' && VENDOR.test(r.machine_name || ''))
      ? { detail: `Shows as In Stock, but its Machine Name (${quote(r.machine_name)}) says a vendor has it.` } : null
  },
  {
    code: 'stock_code_on_deployed', label: 'Deployed but named as stock', severity: 'medium', group: 'Status & location',
    check: r => (r.status === 'assigned' && STOCK_CODE.test(r.machine_name || ''))
      ? { detail: `Deployed to an employee, but its Machine Name still reads as IT stock (${quote(r.machine_name)}).` } : null
  },
  {
    code: 'status_holder_mismatch', label: 'Status and holder disagree', severity: 'high', group: 'Status & location',
    check: r => {
      if (r.status === 'assigned' && !r.assigned_to) return { detail: 'Marked as deployed, but no employee holds it.' };
      if (r.assigned_to && r.status !== 'assigned') return { detail: `An employee holds it, but its status is "${r.label_name || r.status}", not Deployed.` };
      return null;
    }
  },
  {
    code: 'unknown_site', label: 'Stock site code not recognised', severity: 'medium', group: 'Status & location',
    check: r => (r.status === 'available' && r.stock_site === '_unknown')
      ? { detail: `In stock, but the site code in its Machine Name (${quote(r.machine_name)}) isn't one of the known sites, so it can't be counted in any site's stock.` } : null
  },
  {
    code: 'machine_name_note', label: 'Machine Name holds a note', severity: 'low', group: 'Identifiers',
    check: r => {
      const mn = String(r.machine_name || '').trim();
      if (!mn || STOCK_CODE.test(mn) || (r.status === 'available' && RETURNED.test(mn))) return null;
      return NOTE.test(mn) ? { detail: `Machine Name holds a note (${quote(mn)}) instead of a host name or stock code.` } : null;
    }
  },
  // ── Identifiers ──
  {
    code: 'serial_duplicate', label: 'Serial number on another asset', severity: 'high', group: 'Identifiers',
    check: (r, c) => {
      const ids = c.serialShared.get(serialKey(r.serial_number));
      return ids ? { detail: `Its serial number (${quote(r.serial_number)}) is also on ${others(ids, r.id, c.tagOf)}, written differently.`, data: { others: ids.filter(i => i !== r.id) } } : null;
    }
  },
  {
    code: 'fams_missing', label: 'No FAMS barcode', severity: 'medium', group: 'Identifiers',
    check: r => {
      const f = String(r.fams || '').trim();
      if (/^yes$/i.test(String(r.client_provided || '').trim()) || /^client provided$/i.test(f)) return null; // client-owned: no company barcode
      if (famsNumber(f)) return null;
      if (!f) return { detail: 'No FAMS barcode recorded.' };
      return { detail: PLACEHOLDER_FAMS.test(f) ? `No FAMS barcode: the register says ${quote(f)}.` : `The FAMS field holds ${quote(f)}, which isn't a barcode number.` };
    }
  },
  {
    code: 'fams_note', label: 'FAMS barcode has a note', severity: 'low', group: 'Identifiers',
    check: r => (/^\d{6,12}\s*\S/.test(String(r.fams || '').trim()) && /\D/.test(String(r.fams).trim().replace(/^\d{6,12}/, '')))
      ? { detail: `FAMS barcode has text after the number (${quote(r.fams)}); a scanner or search on the number may miss it.` } : null
  },
  {
    code: 'fams_duplicate', label: 'FAMS barcode on another asset', severity: 'medium', group: 'Identifiers',
    check: (r, c) => {
      const n = famsNumber(r.fams);
      const ids = n ? c.famsShared.get(n) : null;
      return ids ? { detail: `FAMS barcode ${n} is also on ${others(ids, r.id, c.tagOf)}.`, data: { fams: n, others: ids.filter(i => i !== r.id) } } : null;
    }
  },
  {
    code: 'hostname_duplicate', label: 'Host name on another asset', severity: 'medium', group: 'Identifiers',
    check: (r, c) => {
      const h = hostname(r.machine_name);
      const ids = h ? c.hostShared.get(h) : null;
      return ids ? { detail: `Host name ${quote(r.machine_name)} is also used by ${others(ids, r.id, c.tagOf)} (active).`, data: { others: ids.filter(i => i !== r.id) } } : null;
    }
  },
  // ── Category & catalog ──
  {
    code: 'category_mismatch', label: 'Category looks wrong', severity: 'medium', group: 'Category & catalog',
    check: (r, c) => {
      const m = c.modelMajority.get(r.asset_model_id);
      const ml = c.oof.get(r.id);
      if (!m || !r.category_id || m.category_id === r.category_id || !ml || ml.predicted !== m.category_id) return null;
      return {
        confidence: Math.min(m.share, ml.p),
        detail: `Filed as ${c.catName(r.category_id)}, but ${m.count} of ${m.total} "${r.model_name}" assets are ${c.catName(m.category_id)} and its name and model read like a ${c.catName(m.category_id)} (${ml.p >= 0.995 ? 'over 99%' : Math.round(ml.p * 100) + '%'} sure).`,
        data: { from: r.category_id, to: m.category_id }
      };
    }
  },
  {
    code: 'category_model_conflict', label: 'Category and model disagree', severity: 'low', group: 'Category & catalog',
    check: (r, c) => {
      const m = c.modelMajority.get(r.asset_model_id);
      if (!m || !r.category_id || m.category_id === r.category_id) return null;
      const ml = c.oof.get(r.id);
      if (ml && ml.predicted === m.category_id) return null; // reported as category_mismatch
      return { detail: `Filed as ${c.catName(r.category_id)}, but its model "${r.model_name}" is a ${c.catName(m.category_id)} model (${m.count} of ${m.total}). Either the category or the model is wrong.` };
    }
  },
  {
    code: 'model_variant', label: 'Catalog model has a spelling variant', severity: 'low', group: 'Category & catalog',
    check: (r, c) => {
      const v = c.variantOf.get(r.asset_model_id);
      return v ? { detail: `Its catalog model "${r.model_name}" looks like a duplicate of "${v}" in Asset Models.` } : null;
    }
  },
  // ── Purchase & warranty ──
  {
    code: 'missing_cost', label: 'No purchase cost', severity: 'medium', group: 'Purchase & warranty',
    check: (r, c) => {
      if (r.purchase_cost !== null && Number(r.purchase_cost) > 0) return null;
      const s = c.modelCost.get(r.asset_model_id);
      return { detail: 'No purchase cost recorded' + (s ? `; similar "${r.model_name}" assets cost about ${inr(s.median)} (${s.n} with a cost).` : '.') };
    }
  },
  {
    code: 'cost_outlier', label: 'Cost far from similar assets', severity: 'medium', group: 'Purchase & warranty',
    check: (r, c) => {
      const s = c.modelCost.get(r.asset_model_id);
      const v = Number(r.purchase_cost);
      if (!s || s.n < 10 || !(v > 0) || (v >= s.median * 0.25 && v <= s.median * 3)) return null;
      return { detail: `Cost ${inr(v)} is far from the usual ${inr(s.median)} for "${r.model_name}" (${s.n} assets, middle half ${inr(s.p25)}–${inr(s.p75)}). Possibly a typo or a bundle price.`, confidence: 0.8 };
    }
  },
  {
    code: 'missing_supplier', label: 'No supplier', severity: 'low', group: 'Purchase & warranty',
    check: r => (r.supplier_id ? null : { detail: 'No supplier recorded.' })
  },
  {
    code: 'missing_po', label: 'Not linked to a purchase order', severity: 'low', group: 'Purchase & warranty',
    check: r => {
      if (r.procurement_id) return null;
      const po = String(r.po_number || '').trim();
      return { detail: po && !/^(na|n\/a|-|0)$/i.test(po) ? `The register has PO ${quote(po)}, but the asset isn't linked to a Procurement record.` : 'Not linked to a purchase order.' };
    }
  },
  {
    code: 'warranty_not_recorded', label: 'No warranty term', severity: 'low', group: 'Purchase & warranty',
    check: r => (r.warranty_start && r.warranty_expiry && r.warranty_start === r.warranty_expiry)
      ? { detail: 'Warranty start and end are the same day, so no warranty term is recorded.' } : null
  },
  {
    code: 'warranty_before_purchase', label: 'Warranty ends before purchase', severity: 'medium', group: 'Purchase & warranty',
    check: r => (r.warranty_expiry && r.purchase_date && r.warranty_expiry < r.purchase_date)
      ? { detail: `Warranty ends (${r.warranty_expiry}) before the purchase date (${r.purchase_date}).` } : null
  }
];

const BY_CODE = new Map(RULES.map(r => [r.code, r]));

function evaluate(row, ctx) {
  const issues = [];
  for (const rule of RULES) {
    const hit = rule.check(row, ctx);
    if (hit) issues.push({ code: rule.code, severity: rule.severity, confidence: hit.confidence ?? 1, detail: hit.detail, data: hit.data || null });
  }
  const penalty = issues.reduce((s, i) => s + WEIGHT[i.severity] * i.confidence, 0);
  return { score: Math.max(0, Math.round(100 - penalty)), issues };
}

const grade = score => (score >= 90 ? 'Good' : score >= 70 ? 'Fair' : 'Poor');

module.exports = { RULES, BY_CODE, WEIGHT, evaluate, grade };
