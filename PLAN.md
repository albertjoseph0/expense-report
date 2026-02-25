# Expense Report — Implementation Plan

Following the [Hello Interview Delivery Framework](https://www.hellointerview.com/learn/system-design/in-a-hurry/delivery).

---

## 1. Requirements

### Functional Requirements

1. **User should be able to import a bank statement CSV** — each row becomes a transaction record (the source of truth).
2. **User should be able to attach a receipt to a bank transaction** — via image upload or email forwarding, matched to a specific transaction row.
3. **User should be able to see which transactions are missing receipts** — the primary view is the statement, highlighting gaps.

### Non-Functional Requirements

1. **Data integrity** — Bank statement rows must never be lost or silently duplicated. Every imported row is preserved exactly as the bank provided it.
2. **Single-user local tool** — No need for auth, horizontal scaling, or multi-tenancy. SQLite is sufficient.
3. **Idempotent imports** — Re-importing the same CSV should not create duplicate transactions.

---

## 2. Core Entities

| Entity | Key Fields |
|---|---|
| **Statement** | `id`, `filename`, `file_sha256`, `imported_at` |
| **Transaction** | `id`, `statement_id` (FK), `row_number`, `date`, `description`, `amount_cents`, `member_name`, `status`, `receipt_required`, `raw_row_text`, `raw_row_hash` |
| **Receipt** | `id`, `transaction_id` (FK → Transaction, nullable), `vendor`, `date`, `total_cents`, `total_text`, `image_path`, `image_sha256`, `source`, `email_link`, `created_at` |

**Key inversion from the old tool:** `Transaction` is the parent. `Receipt` belongs to a transaction (nullable FK). A transaction without a receipt is an unresolved gap. A receipt without a transaction is an orphan to be matched. **Multiple receipts can belong to a single transaction** (e.g., customer copy + merchant copy, multi-page receipts).

**Design decisions from review:**
- **Money as integer cents** — avoids float rounding bugs in matching (`amount_cents INTEGER`, not `REAL`).
- **Statement table** — ties every transaction to its import file; idempotency at the file level via `file_sha256`.
- **Raw row preservation** — `raw_row_text` stores the exact CSV line the bank provided.
- **`receipt_required` flag** — lets user exempt transfers, ATM, interest, refunds from the "missing receipt" view.
- **`image_sha256` on receipts** — prevents the same image file from being uploaded twice (see §5e).

---

## 3. Data Flow

```
1. User uploads bank statement CSV
2. Parse CSV → insert/upsert Transaction rows (deduplicate by csv_row_hash)
3. Auto-match: scan orphan receipts against new transactions
4. User uploads receipt image (or email-poller ingests one)
5. SHA-256 hash the image → reject if identical image already exists (see §5e)
6. Mistral OCR extracts vendor, date, total
7. Content-duplicate check: warn if (total_cents, receipt_date) matches an existing receipt
8. Auto-match: find Transaction by amount ± date proximity (prefer unlinked transactions, deprioritize already-linked)
9. If match found → link receipt to transaction (set transaction_id); multiple receipts per transaction allowed
10. If no match → receipt stays orphaned, user can manually link
11. Dashboard shows all Transactions, highlights those missing receipts
```

---

## 4. High-Level Design

### Architecture: htmx + Server-Rendered HTML

Instead of a JSON API + client-side SPA, the server returns **HTML fragments** that htmx swaps into the page. This eliminates all client-side rendering, state management, and fetch logic.

```
┌──────────────────────────────────────────────────────┐
│              Browser (htmx, ~zero JS)                │
│                                                      │
│  hx-get, hx-post, hx-put, hx-delete                 │
│  Server returns HTML fragments → htmx swaps DOM      │
└──────────────┬───────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│                   Express Server                     │
│                                                      │
│  Routes return HTML (via template engine)             │
│                                                      │
│  GET  /                         ← full page          │
│  POST /statements               ← CSV upload,        │
│                                   returns #table-body │
│  GET  /transactions              ← filtered table     │
│                                   rows (HTML partial) │
│  POST /transactions/:id/receipt  ← image upload +     │
│                                   OCR, returns row    │
│  PUT  /transactions/:id/receipt/:rid ← manual link,   │
│                                       returns row     │
│  DELETE /receipts/:id            ← unlink, returns    │
│                                   updated row         │
│  GET  /transactions/export.csv   ← CSV download       │
└──────────────┬──────────────────────┬────────────────┘
               │                      │
               ▼                      ▼
        ┌────────────┐        ┌──────────────┐
        │  SQLite DB │        │  Mistral OCR │
        │            │        │  (API)       │
        │ transactions│       └──────────────┘
        │ receipts    │
        └────────────┘
```

### Why htmx

| Concern | SPA (old tool) | htmx (new tool) |
|---|---|---|
| Rendering | Client-side DOM manipulation | Server returns HTML fragments |
| State | Client tracks filters, edits, popovers | Server is the only source of state |
| JS needed | ~500+ lines | ~10 lines (image viewer only) |
| Data format | JSON API + client parsing | HTML partials, no parsing |

### Route → HTML Fragment Mapping

| Route | Trigger | Returns | htmx Target |
|---|---|---|---|
| `GET /` | Page load | Full page with transaction table | — |
| `POST /statements` | CSV file input `hx-post` | Updated `<tbody>` + summary bar | `#table-body`, `#summary` (OOB) |
| `GET /transactions` | Filter change `hx-get` | `<tbody>` rows + summary | `#table-body`, `#summary` (OOB) |
| `POST /transactions/:id/receipt` | Drop image on row `hx-post` | Single `<tr>` for that transaction | `#row-{id}` (outerHTML swap) |
| `PUT /transactions/:id/receipt/:rid` | Manual link button | Single `<tr>` | `#row-{id}` |
| `DELETE /receipts/:id` | Delete button `hx-delete` | Single `<tr>` (updated, no receipt) | `#row-{id}` |
| `GET /transactions/export.csv` | Regular `<a href>` | CSV file download | — |

### Schema

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,       -- idempotent: reject duplicate file imports
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,            -- 1-based position in CSV (excl. header)
  posted_date TEXT NOT NULL,              -- normalized YYYY-MM-DD
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,          -- always positive (debits only for now)
  member_name TEXT,
  status TEXT,                            -- 'Cleared', 'Pending', etc.
  receipt_required INTEGER NOT NULL DEFAULT 1,  -- 0 = exempt (transfers, ATM, etc.)
  raw_row_text TEXT NOT NULL,             -- exact CSV line for audit
  raw_row_hash TEXT NOT NULL,             -- SHA-256 of raw_row_text
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(statement_id, row_number),
  UNIQUE(statement_id, raw_row_hash)
);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  vendor TEXT,
  receipt_date TEXT,                       -- normalized YYYY-MM-DD
  total_cents INTEGER,                    -- parsed from OCR
  total_text TEXT,                        -- original OCR string e.g. "$12.34"
  image_path TEXT NOT NULL,               -- relative path, e.g. 'uploads/123.jpg'
  image_sha256 TEXT,                      -- SHA-256 of image bytes for dedup
  source TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'email'
  email_link TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX receipts_image_sha256_uq ON receipts(image_sha256) WHERE image_sha256 IS NOT NULL;
CREATE INDEX receipts_transaction_id_idx ON receipts(transaction_id);
CREATE INDEX receipts_total_cents_idx ON receipts(total_cents);
CREATE INDEX receipts_date_total_idx ON receipts(receipt_date, total_cents);
```

---

## 5. Deep Dives

### 5a. Auto-Matching Algorithm

When a receipt is ingested, match it to a transaction. Multiple receipts can link to the same transaction, but **unlinked transactions are strongly preferred**.

1. **Candidate pool** — all transactions where `receipt_required = 1`. Split into two tiers:
   - **Tier 1 (preferred):** transactions with no receipts linked (`NOT EXISTS (SELECT 1 FROM receipts WHERE transaction_id = t.id)`).
   - **Tier 2 (fallback):** transactions that already have receipt(s) linked.
2. **Exact amount match** — `receipt.total_cents === transaction.amount_cents`.
3. **Date proximity** — receipt date within ±2 days of transaction date (bank posting delay).
4. **Vendor/description overlap** — case-insensitive token overlap between receipt vendor and transaction description (e.g. "CHIPOTLE" appears in both). Cheap tiebreaker that avoids false matches on common amounts like $6.39.
5. **Tiebreaker** — if multiple candidates remain, prefer closest date. If still tied, leave unmatched for manual resolution.
6. **Tier precedence** — only consider Tier 2 candidates if zero Tier 1 candidates matched. This prevents a new receipt from silently attaching to an already-receipted transaction when there's a viable unlinked one.
7. **Reverse direction** — when a statement is imported, also scan orphan receipts and auto-link any matches.

### 5b. Idempotent CSV Import

Two-level dedup:
1. **File level** — SHA-256 the entire uploaded file → `statements.file_sha256 UNIQUE`. Re-uploading the same file is a no-op.
2. **Row level** — within a statement, `UNIQUE(statement_id, raw_row_hash)` prevents partial re-imports from creating duplicates.

### 5b-ii. Unlink vs Delete

- **Unlink** (`PUT /transactions/:id/receipt` with no receipt) — sets `receipt.transaction_id = NULL`, receipt becomes orphan again. No data destroyed.
- **Delete** (`DELETE /receipts/:id`) — removes receipt record and image file. Explicit destructive action.

### 5c. UI — Transaction-Centric View (htmx)

The page structure is a single HTML page with htmx attributes:

```
┌─────────────────────────────────────────────────┐
│  Expense Report                                 │
│                                                 │
│  [Import Statement CSV]     [Upload Receipt]    │
│                                                 │
│  Filters: [Search___] [From__] [To__]           │
│           [x] Missing receipts only             │
│           ← all filters use hx-get="/transactions" │
│                                                 │
│  Summary: 32 transactions · 28 receipts · 4 missing · 2 exempt │
│                                                 │
│  ┌─────────────────────────────────────────────┐│
│  │ Date  │ Description        │ Amount │Receipt││
│  │───────│────────────────────│────────│───────││
│  │ 02/19 │ SITAR INDIAN GR... │ $78.47 │ ✅ (2) 🔍││ ← multiple receipts shown with count
│  │ 02/19 │ CHIPOTLE MEX GR... │ $44.04 │ ❌      ││ ← drop zone per row
│  │ 02/18 │ DUNKIN #344563...  │  $6.39 │ ❌      ││
│  └─────────────────────────────────────────────┘│
│                                                 │
│  Orphan Receipts (3 unmatched)                  │
│  ┌─────────────────────────────────────────────┐│
│  │ Vendor      │ Date  │ Total  │ [Link]       ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

Key interactions — all server-round-tripped, zero client state:

- **Filter changes** → `hx-get="/transactions?missing=1&search=dunkin"` → server returns `<tbody>` rows
- **CSV import** → `hx-post="/statements" hx-encoding="multipart/form-data"` → server returns new `<tbody>`
- **Receipt upload onto a row** → small JS drag handler calls `hx-post="/transactions/5/receipt"` → server returns updated `<tr>`
- **View receipt image** → clicking the receipt link loads the image into a viewer panel (reuse zoom/pan JS from old tool)
- **Manual link** → orphan receipt row has a dropdown of unlinked transactions, `hx-put` links them

### 5e. Duplicate Receipt Detection

Two layers of dedup, handled at different points in the upload flow:

#### Case 1: Identical image file uploaded twice

- **When:** Before saving to disk or calling OCR.
- **How:** SHA-256 hash the uploaded image buffer. Insert the receipt row with `image_sha256`. If the insert fails with `SQLITE_CONSTRAINT` (unique violation on the partial index), delete the uploaded file from disk and return an error: _"This image has already been uploaded (receipt #N)."_
- **Why atomic:** Don't pre-check then insert (TOCTOU). Just insert and catch the constraint violation.
- **Scope:** Global dedup — the same image cannot be attached to different transactions. If that becomes a requirement, move to a many-to-many model.

#### Case 2: Different photos, same receipt content (e.g., customer copy + merchant copy)

- **When:** After OCR extracts vendor/date/total.
- **How:** Query `SELECT * FROM receipts WHERE total_cents = ? AND receipt_date = ?`. If a match exists, still save the receipt, but return a transient warning in the HTML response: _"This looks similar to an existing receipt (Chipotle, $44.04, 02/19)."_
- **Why warn-only:** Legitimate duplicates exist (two coffee runs same day, same amount). The user makes the final call.
- **Index:** `receipts_date_total_idx ON receipts(receipt_date, total_cents)` keeps the check cheap.

### 5f. Multiple Receipts Per Transaction — Changes Needed

The schema already supports multiple receipts per transaction (receipts FK → transactions). The following modules assume 1:1 and need updates:

| Module | What to change |
|---|---|
| **`db.js` — `getTransactions()`** | Replace `LEFT JOIN receipts` (produces duplicate rows) with a two-query approach: query transactions first, then query receipts for those transaction IDs, group in JS. Each transaction gets a `receipts: [...]` array. |
| **`db.js` — add `getTransactionById(id)`** | New helper that returns `{...txn, receipts: [...]}` for single-row re-renders. Replaces the inefficient `getTransactions({}).find(t => t.id === txnId)` pattern used in multiple routes. |
| **`db.js` — `getUnlinkedTransactions`** | Change `LEFT JOIN ... WHERE r.id IS NULL` to `WHERE NOT EXISTS (SELECT 1 FROM receipts WHERE transaction_id = t.id)`. |
| **`db.js` — `getStats()`** | Use `NOT EXISTS` for the "missing" count to be correct with multiple receipts. |
| **`db.js` — `getTransactions({missingOnly})`** | Same `NOT EXISTS` fix for the missing-only filter. |
| **`views.js` — `renderRow()`** | Display multiple receipt thumbnails/links per row. Show a count badge when 2+. Per-receipt unlink/delete buttons. |
| **`matcher.js` — `matchReceipt()`** | Two-tier candidate pool (see §5a). Include `receipt_count` or `has_receipt` boolean in scoring. |
| **`server.js` — single-row routes** | `POST /transactions/:id/receipt`, `PUT /transactions/:id/exempt`, `DELETE /receipts/:id` — use new `getTransactionById()` instead of `getTransactions({}).find(...)`. |
| **`server.js` — `image_path` storage** | Store relative paths (`uploads/123.jpg`) not absolute-looking paths (`/uploads/123.jpg`). Fix `path.join(__dirname, receipt.image_path)` which breaks with leading `/`. |
| **`server.js` — export CSV** | Add `receipt_count` column. Join multiple vendor names with `; `. |

### 5d. What to Reuse from the Old Tool

| Module | Reuse? | Notes |
|---|---|---|
| `mistral-ocr.js` | ✅ Copy as-is | OCR extraction logic is unchanged |
| `parser.js` | ✅ Copy as-is | Text-based receipt parsing for emails |
| `email-poller.js` | ✅ Adapt | Insert as orphan receipt, then call matcher |
| `reconcile.js` | ❌ Replace | Old logic inverted — replaced by `matcher.js` |
| `db.js` | ❌ Rewrite | New schema, two tables |
| `server.js` | ❌ Rewrite | Returns HTML fragments, not JSON |
| `public/index.html` | ❌ Rewrite | htmx-driven; reuse image viewer zoom/pan JS (~90 lines) |

---

## 6. File Structure

```
expense-report/
├── server.js              # Express app, routes return HTML
├── db.js                  # SQLite schema + prepared statements
├── matcher.js             # Auto-match receipts ↔ transactions
├── csv-import.js          # Parse bank CSV, upsert transactions
├── views.js               # HTML template functions (partials)
├── mistral-ocr.js         # (copied from receipt tool)
├── parser.js              # (copied from receipt tool)
├── email-poller.js        # (adapted from receipt tool)
├── public/
│   └── style.css          # Minimal stylesheet
├── uploads/               # Receipt images
├── .env
├── .env.example
└── package.json
```

---

## 7. Build Order

| Step | Module | Depends On | What to Verify |
|---|---|---|---|
| 1 | `db.js` | — | Tables created, FKs enforced, prepared statements work |
| 2 | `csv-import.js` | db.js | Import test-statement.csv → 37 rows; re-import same file → 0 new |
| 3 | `mistral-ocr.js` + `parser.js` | — | Copy from old tool, smoke test |
| 4 | `matcher.js` | db.js | Link receipt to transaction by amount+date+vendor overlap |
| 5 | `views.js` | — | Template functions return valid HTML fragments |
| 6 | `server.js` | all above | Full page loads, CSV import works, receipt upload + auto-match works |
| 7 | `email-poller.js` | db.js, matcher.js | Adapted to create orphan receipts |
