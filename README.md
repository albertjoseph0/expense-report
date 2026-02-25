# Expense Report

A local expense tracker that matches bank statement transactions to receipt images. Import a CSV bank statement, upload receipt photos (or ingest them via email), and see at a glance which transactions are missing documentation.

Built with Express, htmx, SQLite, and Mistral OCR.

![Stack](https://img.shields.io/badge/node.js-Express-green) ![DB](https://img.shields.io/badge/database-SQLite-blue) ![UI](https://img.shields.io/badge/frontend-htmx-orange)

## Features

- **CSV statement import** — drag-and-drop a bank statement CSV; rows become transactions. Idempotent (re-importing the same file is a no-op).
- **Receipt upload & OCR** — upload receipt images; Mistral OCR extracts vendor, date, and total automatically.
- **Auto-matching** — receipts are automatically linked to transactions by amount, date proximity, and vendor name overlap.
- **Manual reconciliation** — checkbox column to mark transactions as manually verified.
- **Email polling** — optionally ingest receipt images from an IMAP mailbox.
- **Duplicate detection** — identical images are rejected; same-content receipts trigger a warning.
- **Receipt viewer** — built-in pan/zoom image viewer for inspecting receipts.

## Getting Started

### Prerequisites

- Node.js 18+
- (Optional) A [Mistral API key](https://console.mistral.ai/) for receipt OCR

### Install

```bash
git clone https://github.com/albertjoseph0/expense-report.git
cd expense-report
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` and add your Mistral API key. Receipt upload works without it, but OCR extraction and auto-matching will be disabled.

### Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. **Import a statement** — click "Import Statement" and select a CSV file from your bank.
2. **Upload receipts** — click "Upload Receipts" to attach receipt photos. They'll be OCR'd and auto-matched to transactions when possible.
3. **Manual linking** — unmatched receipts appear in the "Unmatched Receipts" section with a dropdown to assign them to a transaction.
4. **Reconcile** — check the "Reconciled" checkbox on each row once you've verified it.

## Project Structure

```
├── server.js          # Express routes (returns HTML fragments for htmx)
├── db.js              # SQLite schema, migrations, queries
├── csv-import.js      # Bank CSV parser and importer
├── matcher.js         # Auto-match receipts ↔ transactions
├── mistral-ocr.js     # Mistral API receipt image analysis
├── parser.js          # Text-based receipt parsing
├── email-poller.js    # IMAP email receipt ingestion
├── views.js           # Server-side HTML template functions
├── public/
│   └── style.css
├── .env.example
└── package.json
```

## License

MIT
