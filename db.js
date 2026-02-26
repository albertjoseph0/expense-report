const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database(path.join(__dirname, 'expense-report.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema Migration for Auth (Detect if schema needs to be reset/updated)
const userTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();

if (!userTableExists) {
  console.log("Migrating database to multi-tenant auth system... (Recreating tables)");
  try {
    db.exec(`DROP TABLE IF EXISTS receipts;`);
    db.exec(`DROP TABLE IF EXISTS transactions;`);
    db.exec(`DROP TABLE IF EXISTS statements;`);
  } catch (e) {
    console.error("Migration error:", e);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, file_sha256)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  posted_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  member_name TEXT,
  status TEXT,
  receipt_required INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 0,
  raw_row_text TEXT NOT NULL,
  raw_row_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(statement_id, row_number),
  UNIQUE(statement_id, raw_row_hash)
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  vendor TEXT,
  receipt_date TEXT,
  total_cents INTEGER,
  total_text TEXT,
  image_path TEXT NOT NULL,
  image_sha256 TEXT,                      -- SHA-256 of image bytes for dedup (scoped by user handled in code/constraint?)
  source TEXT NOT NULL DEFAULT 'upload',
  email_link TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, image_sha256)
);

CREATE INDEX IF NOT EXISTS receipts_transaction_id_idx ON receipts(transaction_id);
CREATE INDEX IF NOT EXISTS receipts_total_cents_idx ON receipts(total_cents);
CREATE INDEX IF NOT EXISTS receipts_user_id_idx ON receipts(user_id);
CREATE INDEX IF NOT EXISTS statements_user_id_idx ON statements(user_id);
`);

// User Management
const createUser = db.prepare(`
  INSERT INTO users (username, password_hash) VALUES (@username, @password_hash)
`);

const getUserByUsername = db.prepare(`
  SELECT * FROM users WHERE username = ?
`);

const getUserById = db.prepare(`
  SELECT * FROM users WHERE id = ?
`);

const insertStatement = db.prepare(
  `INSERT INTO statements (user_id, filename, file_sha256) VALUES (@user_id, @filename, @file_sha256)`
);

const findStatementByHash = db.prepare(
  `SELECT * FROM statements WHERE user_id = ? AND file_sha256 = ?`
);

const insertTransaction = db.prepare(`
  INSERT OR IGNORE INTO transactions
    (statement_id, row_number, posted_date, description, amount_cents, member_name, status, raw_row_text, raw_row_hash)
  VALUES
    (@statement_id, @row_number, @posted_date, @description, @amount_cents, @member_name, @status, @raw_row_text, @raw_row_hash)
`);

const insertReceipt = db.prepare(`
  INSERT INTO receipts
    (user_id, transaction_id, vendor, receipt_date, total_cents, total_text, image_path, image_sha256, source, email_link)
  VALUES
    (@user_id, @transaction_id, @vendor, @receipt_date, @total_cents, @total_text, @image_path, @image_sha256, @source, @email_link)
`);

const linkReceipt = db.prepare(
  `UPDATE receipts SET transaction_id = @transaction_id WHERE id = @receipt_id`
);

const unlinkReceipt = db.prepare(
  `UPDATE receipts SET transaction_id = NULL WHERE id = ?`
);

const deleteReceipt = db.prepare(
  `DELETE FROM receipts WHERE id = ?`
);

const setReceiptRequired = db.prepare(
  `UPDATE transactions SET receipt_required = @value WHERE id = @transaction_id`
);

const setVerified = db.prepare(
  `UPDATE transactions SET verified = @value WHERE id = @transaction_id`
);

function getTransactions(userId, { search, dateFrom, dateTo, missingOnly } = {}) {
  // Join with statements to filter by user_id
  let sql = `SELECT t.* FROM transactions t JOIN statements s ON t.statement_id = s.id WHERE s.user_id = @userId`;
  const conditions = [];
  const params = { userId };

  if (missingOnly) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id) AND t.receipt_required = 1`);
  }
  if (search) {
    conditions.push(`t.description LIKE @search`);
    params.search = `%${search}%`;
  }
  if (dateFrom) {
    conditions.push(`t.posted_date >= @dateFrom`);
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    conditions.push(`t.posted_date <= @dateTo`);
    params.dateTo = dateTo;
  }

  if (conditions.length) {
    sql += ` AND ` + conditions.join(' AND ');
  }
  sql += ` ORDER BY t.posted_date DESC, t.id DESC`;

  const transactions = db.prepare(sql).all(params);
  return attachReceipts(transactions);
}

function attachReceipts(transactions) {
  if (transactions.length === 0) return transactions;
  const ids = transactions.map(t => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const receipts = db.prepare(
    `SELECT * FROM receipts WHERE transaction_id IN (${placeholders}) ORDER BY created_at`
  ).all(...ids);

  const byTxn = {};
  for (const r of receipts) {
    if (!byTxn[r.transaction_id]) byTxn[r.transaction_id] = [];
    byTxn[r.transaction_id].push(r);
  }
  for (const t of transactions) {
    t.receipts = byTxn[t.id] || [];
  }
  return transactions;
}

function getTransactionById(id, userId) {
  // Ensure transaction belongs to user
  const txn = db.prepare(`
    SELECT t.* FROM transactions t
    JOIN statements s ON t.statement_id = s.id
    WHERE t.id = ? AND s.user_id = ?
  `).get(id, userId);

  if (!txn) return null;
  txn.receipts = db.prepare(`SELECT * FROM receipts WHERE transaction_id = ? ORDER BY created_at`).all(id);
  return txn;
}

const getOrphanReceipts = db.prepare(
  `SELECT * FROM receipts WHERE user_id = ? AND transaction_id IS NULL ORDER BY created_at DESC`
);

const getUnlinkedTransactions = db.prepare(`
  SELECT t.* FROM transactions t
  JOIN statements s ON t.statement_id = s.id
  WHERE s.user_id = ?
    AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
    AND t.receipt_required = 1
  ORDER BY t.posted_date DESC
`);

function getStats(userId) {
  // Scoped by user
  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM transactions t
    JOIN statements s ON t.statement_id = s.id
    WHERE s.user_id = ?
  `).get(userId).count;

  const withReceipts = db.prepare(
    `SELECT COUNT(*) AS count FROM transactions t
     JOIN statements s ON t.statement_id = s.id
     WHERE s.user_id = ? AND EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)`
  ).get(userId).count;

  const exempt = db.prepare(
    `SELECT COUNT(*) AS count FROM transactions t
     JOIN statements s ON t.statement_id = s.id
     WHERE s.user_id = ? AND receipt_required = 0`
  ).get(userId).count;

  const verified = db.prepare(
    `SELECT COUNT(*) AS count FROM transactions t
     JOIN statements s ON t.statement_id = s.id
     WHERE s.user_id = ? AND verified = 1`
  ).get(userId).count;

  const missing = total - withReceipts - exempt;
  return { total, withReceipts, missing, exempt, verified };
}

function findContentDuplicates(userId, receiptDate, totalCents) {
  if (!receiptDate || totalCents == null) return [];
  return db.prepare(
    `SELECT * FROM receipts WHERE user_id = ? AND receipt_date = ? AND total_cents = ?`
  ).all(userId, receiptDate, totalCents);
}

// Receipt Image duplicate check helper (scoped by user)
const findReceiptByHash = db.prepare(
  `SELECT * FROM receipts WHERE user_id = ? AND image_sha256 = ?`
);

module.exports = {
  db,
  createUser,
  getUserByUsername,
  getUserById,
  insertStatement,
  findStatementByHash,
  insertTransaction,
  insertReceipt,
  linkReceipt,
  unlinkReceipt,
  deleteReceipt,
  getTransactions,
  getTransactionById,
  getOrphanReceipts,
  getUnlinkedTransactions,
  getStats,
  findContentDuplicates,
  findReceiptByHash,
  setReceiptRequired,
  setVerified,
};
