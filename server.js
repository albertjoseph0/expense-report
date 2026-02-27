require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const {
  db, insertReceipt, unlinkReceipt, deleteReceipt,
  getTransactions, getOrphanReceipts, getStats, setReceiptRequired, linkReceipt,
  getTransactionById, setVerified, updateReceipt,
  createUser, findUserByUsername,
} = require('./db');
const { importStatement } = require('./csv-import');
const { matchReceipt } = require('./matcher');
const { analyzeReceiptImage } = require('./mistral-ocr');
const { renderPage, renderSummary, renderTableBody, renderRow, renderOrphanList, renderToast, renderOrphanCard, renderOrphanEditForm } = require('./views');
const { hashPassword, verifyPassword, generateToken, requireAuth } = require('./auth');
const { renderLoginPage, renderRegisterPage } = require('./auth-views');

const app = express();
const PORT = process.env.PORT || 3000;

const imageStorage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const unique = crypto.randomUUID();
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
app.use(cookieParser());

// ── Public auth routes (no login required) ──────────────────────────

app.get('/login', (req, res) => {
  res.send(renderLoginPage());
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.send(renderLoginPage('Username and password are required'));
  }

  const user = findUserByUsername.get(username);
  if (!user) {
    return res.send(renderLoginPage('Invalid username or password'));
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return res.send(renderLoginPage('Invalid username or password'));
  }

  const token = generateToken(user);
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
  res.redirect('/');
});

app.get('/register', (req, res) => {
  res.send(renderRegisterPage());
});

app.post('/register', async (req, res) => {
  const { username, password, confirmPassword } = req.body;
  if (!username || !password) {
    return res.send(renderRegisterPage('Username and password are required'));
  }
  if (username.length < 3 || username.length > 32) {
    return res.send(renderRegisterPage('Username must be 3–32 characters'));
  }
  if (password.length < 8) {
    return res.send(renderRegisterPage('Password must be at least 8 characters'));
  }
  if (password !== confirmPassword) {
    return res.send(renderRegisterPage('Passwords do not match'));
  }

  const existing = findUserByUsername.get(username);
  if (existing) {
    return res.send(renderRegisterPage('Username already taken'));
  }

  const hash = await hashPassword(password);
  const info = createUser.run({ username, password_hash: hash });
  const token = generateToken({ id: info.lastInsertRowid, username });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
});

// ── All routes below require authentication ─────────────────────────

app.use(requireAuth);

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
  const userId = req.user.id;
  const filters = parseFilters(req.query);
  const transactions = getTransactions({ ...filters, userId });
  const stats = getStats(userId);
  const orphans = getOrphanReceipts(userId);
  res.send(renderPage(transactions, stats, orphans, filters, req.user));
});

// Filtered transaction rows (htmx partial)
app.get('/transactions', (req, res) => {
  const userId = req.user.id;
  const filters = parseFilters(req.query);
  const transactions = getTransactions({ ...filters, userId });
  const stats = getStats(userId);
  res.send(renderTableBody(transactions) + `<template>${renderSummary(stats)}</template>`);
});

// Export transactions as CSV
app.get('/export', (req, res) => {
  const userId = req.user.id;
  const transactions = getTransactions({ userId });
  const headers = ['Date', 'Description', 'Amount', 'Member Name', 'Verified', 'Photo Source'];

  const csvRows = [headers.join(',')];

  for (const txn of transactions) {
    const date = txn.posted_date;
    const description = `"${(txn.description || '').replace(/"/g, '""')}"`;
    const amount = (txn.amount_cents / 100).toFixed(2);
    const memberName = `"${(txn.member_name || '').replace(/"/g, '""')}"`;
    const verified = txn.verified ? 'Yes' : 'No';

    let photoSource = '';
    if (txn.receipts && txn.receipts.length > 0) {
      const urls = txn.receipts.map(r => `${req.protocol}://${req.get('host')}${r.image_path}`);
      if (urls.length === 1) {
        photoSource = `=HYPERLINK("${urls[0]}", "View Receipt")`;
      } else {
        photoSource = urls.join(', ');
      }

      photoSource = `"${photoSource.replace(/"/g, '""')}"`;
    }

    csvRows.push([date, description, amount, memberName, verified, photoSource].join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send(csvRows.join('\n'));
});

// Import bank statement CSV
app.post('/statements', csvUpload.single('statement'), (req, res) => {
  if (!req.file) return res.status(400).send('<tr><td colspan="5">No CSV file uploaded</td></tr>');

  const userId = req.user.id;
  const result = importStatement(req.file.buffer, req.file.originalname, userId);
  const filters = parseFilters(req.query);
  const transactions = getTransactions({ ...filters, userId });
  const allTxns = getTransactions({ userId });
  const stats = getStats(userId);
  const orphans = getOrphanReceipts(userId);

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
  const userId = req.user.id;
  if (!req.file) {
    const filters = parseFilters(req.query);
    const transactions = getTransactions({ ...filters, userId });
    const stats = getStats(userId);
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
      user_id: userId,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      try { fs.unlinkSync(req.file.path); } catch (e) { }
      const filters = parseFilters(req.query);
      const transactions = getTransactions({ ...filters, userId });
      const allTxns = getTransactions({ userId });
      const orphans = getOrphanReceipts(userId);
      const stats = getStats(userId);
      return res.status(409).send(
        renderTableBody(transactions) +
        `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${renderToast(`⚠️ Duplicate image skipped`, 'warning')}</template>`
      );
    }
    throw err;
  }

  const matched = matchReceipt(info.lastInsertRowid, userId);
  const toast = matched
    ? renderToast('✅ Receipt uploaded and matched', 'success')
    : renderToast('✅ Receipt uploaded — unmatched', 'success');

  const filters = parseFilters(req.query);
  const transactions = getTransactions({ ...filters, userId });
  const allTxns = getTransactions({ userId });
  const orphans = getOrphanReceipts(userId);
  const stats = getStats(userId);
  res.send(
    renderTableBody(transactions) +
    `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${toast}</template>`
  );
});

// Get edit form for receipt
app.get('/receipts/:id/edit', (req, res) => {
  const receiptId = parseInt(req.params.id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND user_id = ?').get(receiptId, req.user.id);
  if (!receipt) return res.status(404).send(renderToast('❌ Receipt not found', 'error'));
  res.send(renderOrphanEditForm(receipt));
});

// Get display card for receipt (cancel edit)
app.get('/receipts/:id/card', (req, res) => {
  const receiptId = parseInt(req.params.id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND user_id = ?').get(receiptId, req.user.id);
  if (!receipt) return res.status(404).send(renderToast('❌ Receipt not found', 'error'));

  const transactions = getTransactions({ userId: req.user.id });
  res.send(renderOrphanCard(receipt, transactions));
});

// Update receipt details
app.patch('/receipts/:id', (req, res) => {
  const receiptId = parseInt(req.params.id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND user_id = ?').get(receiptId, req.user.id);
  if (!receipt) return res.status(404).send(renderToast('❌ Receipt not found', 'error'));

  const { vendor, date, total } = req.body;
  const totalCents = parseCents(total);
  const totalText = totalCents != null ? (totalCents / 100).toFixed(2) : total;

  try {
    updateReceipt.run({
      id: receiptId,
      vendor: vendor || null,
      receipt_date: date || null,
      total_cents: totalCents,
      total_text: totalText,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).send(renderToast('❌ Update failed', 'error'));
  }

  const updatedReceipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  const transactions = getTransactions({ userId: req.user.id });
  res.send(renderOrphanCard(updatedReceipt, transactions));
});

// Manually assign an orphan receipt to a transaction
app.post('/receipts/:id/assign', (req, res) => {
  const userId = req.user.id;
  const receiptId = parseInt(req.params.id);
  const txnId = parseInt(req.body.transaction_id);
  if (!txnId) return res.status(400).send(renderToast('❌ No transaction selected', 'error'));

  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND user_id = ?').get(receiptId, userId);
  if (!receipt) return res.status(404).send(renderToast('❌ Receipt not found', 'error'));

  linkReceipt.run({ receipt_id: receiptId, transaction_id: txnId });

  const filters = parseFilters(req.query);
  const transactions = getTransactions({ ...filters, userId });
  const allTxns = getTransactions({ userId });
  const orphans = getOrphanReceipts(userId);
  const stats = getStats(userId);
  const txn = getTransactionById(txnId, userId);
  const txnLabel = txn ? `${txn.description}` : `#${txnId}`;
  res.send(
    renderTableBody(transactions) +
    `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${renderToast(`✅ Receipt assigned to ${txnLabel}`, 'success')}</template>`
  );
});

// Toggle verified status
app.patch('/transactions/:id/verified', (req, res) => {
  const userId = req.user.id;
  const txnId = parseInt(req.params.id);
  const txn = getTransactionById(txnId, userId);
  if (!txn) return res.status(404).send(renderToast('❌ Transaction not found', 'error'));

  const newValue = txn.verified ? 0 : 1;
  setVerified.run({ value: newValue, transaction_id: txnId });

  const updated = getTransactionById(txnId, userId);
  const stats = getStats(userId);
  res.send(renderRow(updated) + `<template>${renderSummary(stats)}</template>`);
});

// Unlink receipt from transaction (DELETE /receipts/:id just unlinks, keeps orphan)
app.delete('/receipts/:id', (req, res) => {
  const userId = req.user.id;
  const receiptId = parseInt(req.params.id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND user_id = ?').get(receiptId, userId);
  if (!receipt) return res.status(404).send('Receipt not found');

  const txnId = receipt.transaction_id;
  unlinkReceipt.run(receiptId);
  const allTxns = getTransactions({ userId });

  if (txnId) {
    const txn = getTransactionById(txnId, userId);
    const stats = getStats(userId);
    const orphans = getOrphanReceipts(userId);
    res.send(renderRow(txn) + `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div></template>`);
  } else {
    // Deleting from orphan list — actually delete
    deleteReceipt.run(receiptId);
    if (receipt.image_path) {
      const filePath = path.join(__dirname, receipt.image_path);
      try { fs.unlinkSync(filePath); } catch (e) { }
    }
    const orphans = getOrphanReceipts(userId);
    res.send(renderOrphanList(orphans, allTxns));
  }
});

app.listen(PORT, () => {
  console.log(`Expense Report running at http://localhost:${PORT}`);
});
