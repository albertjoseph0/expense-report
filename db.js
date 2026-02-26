const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database(path.join(__dirname, 'expense-report.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  raw_row_text TEXT NOT NULL,
  raw_row_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(statement_id, row_number),
  UNIQUE(statement_id, raw_row_hash)
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  vendor TEXT,
  receipt_date TEXT,
  total_cents INTEGER,
  total_text TEXT,
  image_path TEXT NOT NULL,
  image_sha256 TEXT,                      -- SHA-256 of image bytes for dedup
  source TEXT NOT NULL DEFAULT 'upload',
  email_link TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS receipts_transaction_id_idx ON receipts(transaction_id);
CREATE INDEX IF NOT EXISTS receipts_total_cents_idx ON receipts(total_cents);
`);

// Migration: add verified column to transactions if it doesn't exist
try {
  db.exec(`ALTER TABLE transactions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Column already exists
}

// Migration: add image_sha256 column to receipts if it doesn't exist
try {
  db.exec(`ALTER TABLE receipts ADD COLUMN image_sha256 TEXT`);
} catch (e) {
  // Column already exists
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS receipts_image_sha256_uq ON receipts(image_sha256) WHERE image_sha256 IS NOT NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS receipts_date_total_idx ON receipts(receipt_date, total_cents)`);

const insertStatement = db.prepare(
  `INSERT INTO statements (filename, file_sha256) VALUES (@filename, @file_sha256)`
);

const findStatementByHash = db.prepare(
  `SELECT * FROM statements WHERE file_sha256 = ?`
);

const insertTransaction = db.prepare(`
  INSERT OR IGNORE INTO transactions
    (statement_id, row_number, posted_date, description, amount_cents, member_name, status, raw_row_text, raw_row_hash)
  VALUES
    (@statement_id, @row_number, @posted_date, @description, @amount_cents, @member_name, @status, @raw_row_text, @raw_row_hash)
`);

const insertReceipt = db.prepare(`
  INSERT INTO receipts
    (transaction_id, vendor, receipt_date, total_cents, total_text, image_path, image_sha256, source, email_link)
  VALUES
    (@transaction_id, @vendor, @receipt_date, @total_cents, @total_text, @image_path, @image_sha256, @source, @email_link)
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

const updateReceipt = db.prepare(
  `UPDATE receipts
   SET vendor = @vendor,
       receipt_date = @receipt_date,
       total_cents = @total_cents,
       total_text = @total_text
   WHERE id = @id`
);

function getTransactions({ search, dateFrom, dateTo, missingOnly } = {}) {
  let sql = `SELECT t.* FROM transactions t`;
  const conditions = [];
  const params = {};

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
    sql += ` WHERE ` + conditions.join(' AND ');
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

function getTransactionById(id) {
  const txn = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id);
  if (!txn) return null;
  txn.receipts = db.prepare(`SELECT * FROM receipts WHERE transaction_id = ? ORDER BY created_at`).all(id);
  return txn;
}

const getOrphanReceipts = db.prepare(
  `SELECT * FROM receipts WHERE transaction_id IS NULL ORDER BY created_at DESC`
);

const getUnlinkedTransactions = db.prepare(`
  SELECT t.* FROM transactions t
  WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
    AND t.receipt_required = 1
  ORDER BY t.posted_date DESC
`);

function getStats() {
  const total = db.prepare(`SELECT COUNT(*) AS count FROM transactions`).get().count;
  const withReceipts = db.prepare(
    `SELECT COUNT(*) AS count FROM transactions t WHERE EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)`
  ).get().count;
  const exempt = db.prepare(
    `SELECT COUNT(*) AS count FROM transactions WHERE receipt_required = 0`
  ).get().count;
  const verified = db.prepare(
    `SELECT COUNT(*) AS count FROM transactions WHERE verified = 1`
  ).get().count;
  const missing = total - withReceipts - exempt;
  return { total, withReceipts, missing, exempt, verified };
}

function findContentDuplicates(receiptDate, totalCents) {
  if (!receiptDate || totalCents == null) return [];
  return db.prepare(
    `SELECT * FROM receipts WHERE receipt_date = ? AND total_cents = ?`
  ).all(receiptDate, totalCents);
}

module.exports = {
  db,
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
  setReceiptRequired,
  setVerified,
  updateReceipt,
};
