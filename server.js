require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  db, insertReceipt, unlinkReceipt, deleteReceipt,
  getTransactions, getOrphanReceipts, getStats, setReceiptRequired, linkReceipt,
  getTransactionById, findContentDuplicates, setVerified,
} = require('./db');
const { importStatement } = require('./csv-import');
const { matchReceipt } = require('./matcher');
const { analyzeReceiptImage } = require('./mistral-ocr');
const { renderPage, renderSummary, renderTableBody, renderRow, renderOrphanList, renderToast } = require('./views');

const app = express();
const PORT = process.env.PORT || 3000;

const imageStorage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const imageUpload = multer({
  storage: imageStorage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|bmp|webp|tiff/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseFilters(query) {
  return {
    search: query.search || '',
    dateFrom: query.dateFrom || '',
    dateTo: query.dateTo || '',
    missingOnly: query.missingOnly === '1',
  };
}

function parseDateToISO(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }
  return dateStr;
}

function parseCents(totalStr) {
  if (!totalStr) return null;
  const cleaned = totalStr.replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.round(num * 100);
}

function imageHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Full page
app.get('/', (req, res) => {
  const filters = parseFilters(req.query);
  const transactions = getTransactions(filters);
  const stats = getStats();
  const orphans = getOrphanReceipts.all();
  res.send(renderPage(transactions, stats, orphans, filters));
});

// Filtered transaction rows (htmx partial)
app.get('/transactions', (req, res) => {
  const filters = parseFilters(req.query);
  const transactions = getTransactions(filters);
  const stats = getStats();
  res.send(renderTableBody(transactions) + `<template>${renderSummary(stats)}</template>`);
});

// Import bank statement CSV
app.post('/statements', csvUpload.single('statement'), (req, res) => {
  if (!req.file) return res.status(400).send('<tr><td colspan="5">No CSV file uploaded</td></tr>');

  const result = importStatement(req.file.buffer, req.file.originalname);
  const filters = parseFilters(req.query);
  const transactions = getTransactions(filters);
  const allTxns = getTransactions({});
  const stats = getStats();
  const orphans = getOrphanReceipts.all();

  let toast;
  if (!result.imported && result.reason === 'duplicate') {
    toast = renderToast('⚠️ This statement has already been imported', 'warning');
  } else if (!result.imported && result.reason === 'empty') {
    toast = renderToast('❌ CSV file is empty or invalid', 'error');
  } else {
    toast = renderToast(`✅ Statement imported — ${result.rowsImported} transactions added${result.rowsSkipped ? ', ' + result.rowsSkipped + ' skipped' : ''}`, 'success');
  }

  res.send(
    renderTableBody(transactions) +
    `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${toast}</template>`
  );
});

// Upload a receipt (not attached to a transaction — goes to orphan list)
app.post('/receipts', imageUpload.single('receipt'), async (req, res) => {
  if (!req.file) {
    const filters = parseFilters(req.query);
    const transactions = getTransactions(filters);
    const stats = getStats();
    return res.status(400).send(renderTableBody(transactions) + `<template>${renderSummary(stats)}${renderToast('❌ No image selected', 'error')}</template>`);
  }

  const imageBuffer = fs.readFileSync(req.file.path);
  const hash = imageHash(imageBuffer);

  let vendor = null, receiptDate = null, totalCents = null, totalText = null;

  if (process.env.MISTRAL_API_KEY) {
    try {
      const parsed = await analyzeReceiptImage(imageBuffer);
      vendor = parsed.vendor;
      receiptDate = parseDateToISO(parsed.date);
      totalText = parsed.total;
      totalCents = parseCents(parsed.total);
    } catch (err) {
      console.error('OCR error:', err.message);
    }
  }

  const imagePath = '/uploads/' + req.file.filename;
  let info;
  try {
    info = insertReceipt.run({
      transaction_id: null,
      vendor,
      receipt_date: receiptDate,
      total_cents: totalCents,
      total_text: totalText,
      image_path: imagePath,
      image_sha256: hash,
      source: 'upload',
      email_link: '',
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      const existing = db.prepare(`SELECT * FROM receipts WHERE image_sha256 = ?`).get(hash);
      const filters = parseFilters(req.query);
      const transactions = getTransactions(filters);
      const allTxns = getTransactions({});
      const orphans = getOrphanReceipts.all();
      const stats = getStats();
      return res.status(409).send(
        renderTableBody(transactions) +
        `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${renderToast(`⚠️ Duplicate image skipped`, 'warning')}</template>`
      );
    }
    throw err;
  }

  const matched = matchReceipt(info.lastInsertRowid);
  const toast = matched
    ? renderToast('✅ Receipt uploaded and matched', 'success')
    : renderToast('✅ Receipt uploaded — unmatched', 'success');

  const filters = parseFilters(req.query);
  const transactions = getTransactions(filters);
  const allTxns = getTransactions({});
  const orphans = getOrphanReceipts.all();
  const stats = getStats();
  res.send(
    renderTableBody(transactions) +
    `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${toast}</template>`
  );
});

// Manually assign an orphan receipt to a transaction
app.post('/receipts/:id/assign', (req, res) => {
  const receiptId = parseInt(req.params.id);
  const txnId = parseInt(req.body.transaction_id);
  if (!txnId) return res.status(400).send(renderToast('❌ No transaction selected', 'error'));

  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!receipt) return res.status(404).send(renderToast('❌ Receipt not found', 'error'));

  linkReceipt.run({ receipt_id: receiptId, transaction_id: txnId });

  const filters = parseFilters(req.query);
  const transactions = getTransactions(filters);
  const allTxns = getTransactions({});
  const orphans = getOrphanReceipts.all();
  const stats = getStats();
  const txn = getTransactionById(txnId);
  const txnLabel = txn ? `${txn.description}` : `#${txnId}`;
  res.send(
    renderTableBody(transactions) +
    `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${renderToast(`✅ Receipt assigned to ${txnLabel}`, 'success')}</template>`
  );
});

// Toggle verified status
app.patch('/transactions/:id/verified', (req, res) => {
  const txnId = parseInt(req.params.id);
  const txn = getTransactionById(txnId);
  if (!txn) return res.status(404).send(renderToast('❌ Transaction not found', 'error'));

  const newValue = txn.verified ? 0 : 1;
  setVerified.run({ value: newValue, transaction_id: txnId });

  const updated = getTransactionById(txnId);
  const stats = getStats();
  res.send(renderRow(updated) + `<template>${renderSummary(stats)}</template>`);
});

// Unlink receipt from transaction (DELETE /receipts/:id just unlinks, keeps orphan)
app.delete('/receipts/:id', (req, res) => {
  const receiptId = parseInt(req.params.id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!receipt) return res.status(404).send('Receipt not found');

  const txnId = receipt.transaction_id;
  unlinkReceipt.run(receiptId);
  const allTxns = getTransactions({});

  if (txnId) {
    const txn = getTransactionById(txnId);
    const stats = getStats();
    const orphans = getOrphanReceipts.all();
    res.send(renderRow(txn) + `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div></template>`);
  } else {
    // Deleting from orphan list — actually delete
    deleteReceipt.run(receiptId);
    if (receipt.image_path) {
      const filePath = path.join(__dirname, receipt.image_path);
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    const orphans = getOrphanReceipts.all();
    res.send(renderOrphanList(orphans, allTxns));
  }
});

app.listen(PORT, () => {
  console.log(`Expense Report running at http://localhost:${PORT}`);
});
