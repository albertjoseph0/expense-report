const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const { parseReceiptFromText, stripHtml } = require('./parser');
const { insertReceipt } = require('./db');
const { analyzeReceiptImage } = require('./mistral-ocr');
const { matchReceipt } = require('./matcher');
const crypto = require('crypto');

const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_USER = process.env.IMAP_USER || '';
const IMAP_PASSWORD = process.env.IMAP_PASSWORD || '';
const POLL_INTERVAL = parseInt(process.env.IMAP_POLL_INTERVAL || '60000', 10);
const ALLOWED_SENDERS = (process.env.ALLOWED_SENDERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function saveAttachment(attachment) {
  const ext = path.extname(attachment.filename || '.png') || '.png';
  const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
  const filePath = path.join('uploads', uniqueName);
  fs.writeFileSync(filePath, attachment.content);
  return '/uploads/' + uniqueName;
}

function isReceiptImage(attachment) {
  if (!attachment.contentType || !attachment.contentType.startsWith('image/')) return false;
  if (attachment.size && attachment.size < 10240) return false;
  return true;
}

function senderAddress(from) {
  if (!from || !from.value || !from.value.length) return '';
  return (from.value[0].address || '').toLowerCase();
}

function senderString(from) {
  if (!from || !from.value || !from.value.length) return '';
  const entry = from.value[0];
  if (entry.name) return `"${entry.name}" <${entry.address}>`;
  return entry.address || '';
}

function buildGmailLink(messageId) {
  if (!messageId) return '';
  const clean = messageId.replace(/^<|>$/g, '');
  return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(clean)}`;
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

function insertAndMatch(vendor, date, total, imagePath, emailLink, imageSha256) {
  let info;
  try {
    info = insertReceipt.run({
      transaction_id: null,
      vendor,
      receipt_date: parseDateToISO(date),
      total_cents: parseCents(total),
      total_text: total,
      image_path: imagePath,
      image_sha256: imageSha256 || null,
      source: 'email',
      email_link: emailLink,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      console.log('[email-poller] Duplicate image skipped');
      return;
    }
    throw err;
  }
  matchReceipt(info.lastInsertRowid);
}

async function processEmail(parsed) {
  const addr = senderAddress(parsed.from);
  const fromStr = senderString(parsed.from);

  console.log(`[email-poller] Received: subject="${parsed.subject}" from=${addr}`);

  if (ALLOWED_SENDERS.length > 0 && !ALLOWED_SENDERS.includes(addr)) {
    console.log(`[email-poller] Skipping unauthorized sender: ${addr}`);
    return;
  }

  const imageAttachments = (parsed.attachments || []).filter(isReceiptImage);
  const emailLink = buildGmailLink(parsed.messageId);

  if (imageAttachments.length > 0) {
    for (const attachment of imageAttachments) {
      if (!process.env.MISTRAL_API_KEY) continue;
      try {
        const result = await analyzeReceiptImage(attachment.content);
        const imagePath = saveAttachment(attachment);
        const hash = crypto.createHash('sha256').update(attachment.content).digest('hex');
        insertAndMatch(result.vendor, result.date, result.total, imagePath, emailLink, hash);
        console.log(`[email-poller] Added receipt (image): ${result.vendor} | ${result.date} | ${result.total}`);
      } catch (err) {
        console.error('[email-poller] OCR error:', err.message);
      }
    }
  } else {
    const rawText = parsed.text || (parsed.html ? stripHtml(parsed.html) : '');
    if (!rawText.trim()) return;

    const result = parseReceiptFromText(rawText, fromStr);
    insertAndMatch(result.vendor, result.date, result.total, '', emailLink, null);
    console.log(`[email-poller] Added receipt (text): ${result.vendor} | ${result.date} | ${result.total}`);
  }
}

async function pollInbox() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
  });

  client.on('error', (err) => {
    console.error('[email-poller] IMAP error:', err.message);
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const messages = client.fetch({ seen: false }, { uid: true, source: true });
      for await (const msg of messages) {
        try {
          const p = await simpleParser(msg.source);
          await processEmail(p);
          await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
        } catch (err) {
          console.error('[email-poller] Error processing message:', err.message);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error('[email-poller] IMAP error:', err.message);
  }
}

let intervalId = null;

function start() {
  if (!IMAP_USER || !IMAP_PASSWORD) {
    console.log('[email-poller] IMAP credentials not configured, email polling disabled');
    return;
  }
  console.log(`[email-poller] Starting — polling ${IMAP_USER} every ${POLL_INTERVAL / 1000}s`);
  pollInbox();
  intervalId = setInterval(pollInbox, POLL_INTERVAL);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { start, stop };
