const { db } = require('./db');

function tokenOverlap(receiptVendor, txnDescription) {
  if (!receiptVendor || !txnDescription) return 0;
  const vendorTokens = receiptVendor.toLowerCase().split(/\s+/);
  const descTokens = new Set(txnDescription.toLowerCase().split(/\s+/));
  let count = 0;
  for (const token of vendorTokens) {
    if (descTokens.has(token)) count++;
  }
  return count;
}

function findBestMatch(receipt, candidates) {
  const amountMatches = candidates.filter(t => t.amount_cents === receipt.total_cents);
  if (amountMatches.length === 0) return null;

  const receiptDate = new Date(receipt.receipt_date + 'T00:00:00');
  const dateMatches = amountMatches.filter(t => {
    const txnDate = new Date(t.posted_date + 'T00:00:00');
    const diffDays = Math.abs((txnDate - receiptDate) / (1000 * 60 * 60 * 24));
    return diffDays <= 2;
  });
  if (dateMatches.length === 0) return null;

  const scored = dateMatches.map(t => {
    const overlap = tokenOverlap(receipt.vendor, t.description);
    const txnDate = new Date(t.posted_date + 'T00:00:00');
    const dateDiff = Math.abs((txnDate - receiptDate) / (1000 * 60 * 60 * 24));
    return { txn: t, overlap, dateDiff };
  });

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return a.dateDiff - b.dateDiff;
  });

  const best = scored[0];
  if (scored.length > 1 && scored[1].overlap === best.overlap && scored[1].dateDiff === best.dateDiff) {
    return null;
  }

  return best.txn;
}

function matchReceipt(receiptId) {
  const receipt = db.prepare(`SELECT * FROM receipts WHERE id = ?`).get(receiptId);
  if (!receipt || receipt.total_cents == null || !receipt.receipt_date) return null;

  // Tier 1: prefer transactions with no receipts linked
  const unlinked = db.prepare(`
    SELECT t.* FROM transactions t
    WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
      AND t.receipt_required = 1
  `).all();

  let best = findBestMatch(receipt, unlinked);
  if (!best) {
    // Tier 2: fallback to transactions that already have receipts
    const linked = db.prepare(`
      SELECT t.* FROM transactions t
      WHERE EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
        AND t.receipt_required = 1
    `).all();
    best = findBestMatch(receipt, linked);
  }

  if (!best) return null;

  db.prepare(`UPDATE receipts SET transaction_id = ? WHERE id = ?`).run(best.id, receiptId);
  return best;
}

function matchOrphanReceipts() {
  const orphans = db.prepare(`SELECT id FROM receipts WHERE transaction_id IS NULL`).all();
  let matched = 0;
  for (const orphan of orphans) {
    const result = matchReceipt(orphan.id);
    if (result) matched++;
  }
  return matched;
}

module.exports = { matchReceipt, matchOrphanReceipts, tokenOverlap, findBestMatch };
