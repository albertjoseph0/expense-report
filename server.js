require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  db, insertReceipt, unlinkReceipt, deleteReceipt,
  getTransactions, getOrphanReceipts, getStats, setReceiptRequired, linkReceipt,
  getTransactionById, findContentDuplicates, setVerified,
  createUser, getUserByUsername
} = require('./db');
const { hashPassword, comparePassword, generateToken, authenticateToken } = require('./auth');
const { importStatement } = require('./csv-import');
const { matchReceipt } = require('./matcher');
const { analyzeReceiptImage } = require('./mistral-ocr');
const { renderPage, renderSummary, renderTableBody, renderRow, renderOrphanList, renderToast, renderLoginPage, renderRegisterPage } = require('./views');

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

// Auth Routes
app.get('/login', (req, res) => {
  res.send(renderLoginPage());
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send(renderLoginPage('All fields required'));

  const user = getUserByUsername.get(username);

  if (!user || !(await comparePassword(password, user.password_hash))) {
    return res.status(401).send(renderLoginPage('Invalid username or password'));
  }

  const token = generateToken(user);
  res.cookie('auth_token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }); // 1 week
  res.redirect('/');
});

app.get('/register', (req, res) => {
  res.send(renderRegisterPage());
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send(renderRegisterPage('All fields required'));

  try {
    const passwordHash = await hashPassword(password);
    createUser.run({ username, password_hash: passwordHash });
    res.redirect('/login');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).send(renderRegisterPage('Username already taken'));
    }
    throw err;
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/login');
});

// Middleware to protect routes
app.use(authenticateToken);

// Full page
app.get('/', (req, res) => {
  const filters = parseFilters(req.query);
  const transactions = getTransactions(req.user.userId, filters);
  const stats = getStats(req.user.userId);
  const orphans = getOrphanReceipts.all(req.user.userId);
  res.send(renderPage(req.user, transactions, stats, orphans, filters));
});

// Filtered transaction rows (htmx partial)
app.get('/transactions', (req, res) => {
  const filters = parseFilters(req.query);
  const transactions = getTransactions(req.user.userId, filters);
  const stats = getStats(req.user.userId);
  res.send(renderTableBody(transactions) + `<template>${renderSummary(stats)}</template>`);
});

// Import bank statement CSV
app.post('/statements', csvUpload.single('statement'), (req, res) => {
  if (!req.file) return res.status(400).send('<tr><td colspan="5">No CSV file uploaded</td></tr>');

  const result = importStatement(req.user.userId, req.file.buffer, req.file.originalname);
  const filters = parseFilters(req.query);
  const transactions = getTransactions(req.user.userId, filters);
  const allTxns = getTransactions(req.user.userId, {});
  const stats = getStats(req.user.userId);
  const orphans = getOrphanReceipts.all(req.user.userId);

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
    const transactions = getTransactions(req.user.userId, filters);
    const stats = getStats(req.user.userId);
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
      user_id: req.user.userId,
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
      // Check for existing receipt for this user
      // Note: db.js handles constraints, but we need to check if it's THIS user's duplicate
      const existing = db.prepare(`SELECT * FROM receipts WHERE user_id = ? AND image_sha256 = ?`).get(req.user.userId, hash);

      const filters = parseFilters(req.query);
      const transactions = getTransactions(req.user.userId, filters);
      const allTxns = getTransactions(req.user.userId, {});
      const orphans = getOrphanReceipts.all(req.user.userId);
      const stats = getStats(req.user.userId);

      if (existing) {
         return res.status(409).send(
          renderTableBody(transactions) +
          `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${renderToast(`⚠️ Duplicate image skipped`, 'warning')}</template>`
        );
      } else {
        // If it's unique to the user but failed constraint, something is wrong with my assumption about constraints?
        // Ah, UNIQUE(user_id, image_sha256). So if it fails, it MUST be this user.
        return res.status(409).send(
          renderTableBody(transactions) +
          `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${renderToast(`⚠️ Duplicate image skipped`, 'warning')}</template>`
        );
      }
    }
    throw err;
  }

  const matched = matchReceipt(info.lastInsertRowid);
  const toast = matched
    ? renderToast('✅ Receipt uploaded and matched', 'success')
    : renderToast('✅ Receipt uploaded — unmatched', 'success');

  const filters = parseFilters(req.query);
  const transactions = getTransactions(req.user.userId, filters);
  const allTxns = getTransactions(req.user.userId, {});
  const orphans = getOrphanReceipts.all(req.user.userId);
  const stats = getStats(req.user.userId);
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

  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND user_id = ?').get(receiptId, req.user.userId);
  if (!receipt) return res.status(404).send(renderToast('❌ Receipt not found', 'error'));

  // Verify transaction belongs to user
  const txn = getTransactionById(txnId, req.user.userId);
  if (!txn) return res.status(404).send(renderToast('❌ Transaction not found', 'error'));

  linkReceipt.run({ receipt_id: receiptId, transaction_id: txnId });

  const filters = parseFilters(req.query);
  const transactions = getTransactions(req.user.userId, filters);
  const allTxns = getTransactions(req.user.userId, {});
  const orphans = getOrphanReceipts.all(req.user.userId);
  const stats = getStats(req.user.userId);
  const txnLabel = `${txn.description}`;
  res.send(
    renderTableBody(transactions) +
    `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div>${renderToast(`✅ Receipt assigned to ${txnLabel}`, 'success')}</template>`
  );
});

// Toggle verified status
app.patch('/transactions/:id/verified', (req, res) => {
  const txnId = parseInt(req.params.id);
  const txn = getTransactionById(txnId, req.user.userId);
  if (!txn) return res.status(404).send(renderToast('❌ Transaction not found', 'error'));

  const newValue = txn.verified ? 0 : 1;
  setVerified.run({ value: newValue, transaction_id: txnId });

  const updated = getTransactionById(txnId, req.user.userId);
  const stats = getStats(req.user.userId);
  res.send(renderRow(updated) + `<template>${renderSummary(stats)}</template>`);
});

// Unlink receipt from transaction (DELETE /receipts/:id just unlinks, keeps orphan)
app.delete('/receipts/:id', (req, res) => {
  const receiptId = parseInt(req.params.id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND user_id = ?').get(receiptId, req.user.userId);
  if (!receipt) return res.status(404).send('Receipt not found');

  const txnId = receipt.transaction_id;
  unlinkReceipt.run(receiptId);
  const allTxns = getTransactions(req.user.userId, {});

  if (txnId) {
    const txn = getTransactionById(txnId, req.user.userId);
    const stats = getStats(req.user.userId);
    const orphans = getOrphanReceipts.all(req.user.userId);
    res.send(renderRow(txn) + `<template>${renderSummary(stats)}<div id="orphan-list" hx-swap-oob="innerHTML">${renderOrphanList(orphans, allTxns)}</div></template>`);
  } else {
    // Deleting from orphan list — actually delete
    deleteReceipt.run(receiptId);
    if (receipt.image_path) {
      const filePath = path.join(__dirname, receipt.image_path);
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    const orphans = getOrphanReceipts.all(req.user.userId);
    res.send(renderOrphanList(orphans, allTxns));
  }
});

app.listen(PORT, () => {
  console.log(`Expense Report running at http://localhost:${PORT}`);
});
