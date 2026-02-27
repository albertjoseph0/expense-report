const crypto = require('crypto');
const {
  db,
  insertStatement,
  findStatementByHash,
  insertTransaction,
} = require('./db');
const { matchOrphanReceipts } = require('./matcher');

function parseCSVRow(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseDate(mmddyyyy) {
  const [mm, dd, yyyy] = mmddyyyy.split('/');
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function parseCents(amountStr) {
  const cleaned = amountStr.replace(/[$,]/g, '');
  return Math.round(parseFloat(cleaned) * 100);
}

function importStatement(csvBuffer, filename, userId) {
  const fileSha = crypto.createHash('sha256').update(csvBuffer).digest('hex');

  const existing = findStatementByHash.get(fileSha, userId);
  if (existing) {
    return { imported: false, reason: 'duplicate', statementId: existing.id };
  }

  const text = csvBuffer.toString('utf-8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

  if (lines.length < 2) {
    return { imported: false, reason: 'empty' };
  }

  const importAll = db.transaction(() => {
    const { lastInsertRowid: statementId } = insertStatement.run({
      filename,
      file_sha256: fileSha,
      user_id: userId,
    });

    let rowsImported = 0;
    let rowsSkipped = 0;

    // Skip header (line 0)
    for (let i = 1; i < lines.length; i++) {
      const rawLine = lines[i];
      const fields = parseCSVRow(rawLine);

      // CSV format: Status,Date,Description,Debit,Credit,Member Name
      const status = fields[0] || '';
      const dateStr = fields[1] || '';
      const description = fields[2] || '';
      const debit = fields[3] || '';
      const memberName = fields[5] || '';

      if (!debit) {
        rowsSkipped++;
        continue;
      }

      const postedDate = parseDate(dateStr);
      const amountCents = parseCents(debit);
      const rawRowHash = crypto.createHash('sha256').update(rawLine).digest('hex');

      const result = insertTransaction.run({
        statement_id: statementId,
        row_number: i,
        posted_date: postedDate,
        description,
        amount_cents: amountCents,
        member_name: memberName || null,
        status: status || null,
        raw_row_text: rawLine,
        raw_row_hash: rawRowHash,
      });

      if (result.changes > 0) {
        rowsImported++;
      } else {
        rowsSkipped++;
      }
    }

    return { imported: true, statementId, rowsImported, rowsSkipped };
  });

  const result = importAll();

  matchOrphanReceipts(userId);

  return result;
}

module.exports = { importStatement, parseCSVRow };
