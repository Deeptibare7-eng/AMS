// Port of ProcurementService.
const path = require('path');
const fs = require('fs');
const db = require('../core/db');
const Paginator = require('../core/paginator');
const audit = require('./auditService');
const config = require('../config');
const { nullableId } = require('../core/helpers');

function storeUpload(file, subDir) {
  if (!file) return null;
  const dir = path.join(config.publicDir, 'uploads', 'procurement', subDir);
  fs.mkdirSync(dir, { recursive: true });
  // Files land under public/, so refuse types a browser would execute same-origin.
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.html', '.htm', '.xhtml', '.shtml', '.svg', '.xml', '.js', '.mjs'].includes(ext)) {
    throw new Error('This file type is not allowed for procurement documents.');
  }
  const filename = Date.now().toString(36) + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  return `uploads/procurement/${subDir}/${filename}`;
}

// One page of the ledger (paged in SQL), optionally filtered by PO/invoice/vendor.
async function getRecordsPage(page = 1, perPage = 25, search = '') {
  const params = [];
  let where = 'p.deleted_at IS NULL';
  if (search) { params.push(`%${search}%`); where += ' AND (p.po_number ILIKE $1 OR p.invoice_number ILIKE $1 OR v.name ILIKE $1)'; }
  const from = `FROM procurement_records p LEFT JOIN suppliers v ON p.vendor_id = v.id
     LEFT JOIN users u ON p.created_by = u.id WHERE ${where}`;
  const total = (await db.get(`SELECT COUNT(*)::int AS c ${from}`, params)).c;
  const paginator = new Paginator(total, perPage, page);
  const records = await db.query(
    `SELECT p.*, v.name AS vendor_name, u.name AS created_by_name ${from}
     ORDER BY p.purchase_date DESC NULLS LAST, p.id DESC LIMIT ${paginator.perPage} OFFSET ${paginator.offset}`, params);
  return { records, paginator, total };
}

async function getAllRecords() {
  return db.query(
    `SELECT p.*, v.name AS vendor_name, u.name AS created_by_name
     FROM procurement_records p
     LEFT JOIN suppliers v ON p.vendor_id = v.id
     LEFT JOIN users u ON p.created_by = u.id
     WHERE p.deleted_at IS NULL ORDER BY p.purchase_date DESC NULLS LAST`);
}

async function getRecord(id) {
  return db.get(
    `SELECT p.*, v.name AS vendor_name FROM procurement_records p
     LEFT JOIN suppliers v ON p.vendor_id = v.id
     WHERE p.id = $1 AND p.deleted_at IS NULL`, [id]);
}

// Assets on a PO, one page at a time (a single PO can hold 1,700+ assets).
async function getLinkedAssets(id, { page = 1, perPage = 50 } = {}) {
  const total = (await db.get('SELECT COUNT(*)::int AS c FROM assets WHERE procurement_id = $1 AND deleted_at IS NULL', [id])).c;
  const paginator = new Paginator(total, perPage, page);
  const rows = await db.query(
    `SELECT a.id, a.name, a.asset_tag, a.serial_number, sl.name AS status_name, sl.color AS status_color
     FROM assets a LEFT JOIN status_labels sl ON a.status_label_id = sl.id
     WHERE a.procurement_id = $1 AND a.deleted_at IS NULL
     ORDER BY a.id LIMIT ${paginator.perPage} OFFSET ${paginator.offset}`, [id]);
  rows.paginator = paginator;
  rows.total = total;
  return rows;
}

async function createRecord(data, files, user) {
  const invoicePath = storeUpload(files && files.invoice ? files.invoice[0] : null, 'invoices');
  const poPath = storeUpload(files && files.po ? files.po[0] : null, 'pos');
  const id = await db.insert(
    `INSERT INTO procurement_records (po_number, invoice_number, vendor_id, purchase_date, total_amount,
       currency, invoice_file_path, po_file_path, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [data.po_number || null, data.invoice_number || null, nullableId(data.vendor_id),
      data.purchase_date || null,
      data.total_amount !== '' && data.total_amount != null ? data.total_amount : null,
      data.currency || 'USD', invoicePath, poPath, data.notes || null, user ? user.id : null]);
  if (id) {
    await audit.log(user ? user.id : null, 'PROCUREMENT_CREATED',
      `New procurement record created (PO: ${data.po_number || 'N/A'})`);
  }
  return id;
}

async function updateRecord(id, data, files, user) {
  const record = await getRecord(id);
  if (!record) return false;
  const invoicePath = storeUpload(files && files.invoice ? files.invoice[0] : null, 'invoices') || record.invoice_file_path;
  const poPath = storeUpload(files && files.po ? files.po[0] : null, 'pos') || record.po_file_path;
  await db.run(
    `UPDATE procurement_records SET po_number=$1, invoice_number=$2, vendor_id=$3, purchase_date=$4,
       total_amount=$5, currency=$6, invoice_file_path=$7, po_file_path=$8, notes=$9 WHERE id=$10`,
    [data.po_number || null, data.invoice_number || null, nullableId(data.vendor_id),
      data.purchase_date || null,
      data.total_amount !== '' && data.total_amount != null ? data.total_amount : null,
      data.currency || 'USD', invoicePath, poPath, data.notes || null, id]);
  await audit.log(user ? user.id : null, 'PROCUREMENT_UPDATED', `Procurement record #${id} updated.`);
  return true;
}

module.exports = { getRecordsPage, getAllRecords, getRecord, getLinkedAssets, createRecord, updateRecord };
