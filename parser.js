/**
 * Parses receipt data from plain text (used for email-body receipts).
 * Image-based receipt parsing is handled by mistral-ocr.js.
 */

const DATE_PATTERNS = [
  /(\d{1,2}\/\d{1,2}\/\d{2,4})/,
  /(\d{1,2}-\d{1,2}-\d{2,4})/,
  /(\d{1,2}\.\d{1,2}\.\d{2,4})/,
  /(\d{4}\/\d{1,2}\/\d{1,2})/,
  /(\d{4}-\d{1,2}-\d{1,2})/,
  /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{2,4})/i,
];

const DATE_KEYWORDS = ['date', 'date:', 'dt:', 'dt'];

const TOTAL_KEYWORDS_PRIORITY = [
  'grand total',
  'total due',
  'amount due',
  'balance due',
  'total',
  'balance',
  'purchase',
];

const SKIP_KEYWORDS = ['subtotal', 'sub total', 'sub-total', 'tax', 'tip', 'discount', 'savings', 'change'];

const AMOUNT_PATTERN = /\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}/;

const VENDOR_SKIP_WORDS = [
  'welcome', 'to', 'thank', 'you', 'receipt', 'register', 'store',
  'cashier', 'terminal', 'transaction', 'order', 'invoice', 'tel',
  'phone', 'fax', 'www', 'http', 'com', 'org', 'net',
];

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildWordsFromText(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const words = [];
  for (let i = 0; i < lines.length; i++) {
    const lineKey = i * 15;
    const parts = lines[i].trim().split(/\s+/);
    for (const part of parts) {
      words.push({ text: part, confidence: 100, lineKey });
    }
  }
  return words;
}

function groupWordsIntoLines(words) {
  const lines = {};
  for (const word of words) {
    if (!lines[word.lineKey]) lines[word.lineKey] = [];
    lines[word.lineKey].push(word);
  }
  return Object.keys(lines)
    .sort((a, b) => Number(a) - Number(b))
    .map(key => lines[key]);
}

function getConfidenceForSubstring(words, substring) {
  const wordList = Array.isArray(words) ? words : [words];
  const subParts = substring.toLowerCase().split(/[\s,]+/);
  const matchedConfidences = [];

  for (const word of wordList) {
    const wordText = (word.text || '').toLowerCase();
    if (subParts.some(part => wordText.includes(part) || part.includes(wordText))) {
      matchedConfidences.push(word.confidence);
    }
  }

  if (matchedConfidences.length === 0) return 0;
  return Math.round(matchedConfidences.reduce((a, b) => a + b, 0) / matchedConfidences.length);
}

function extractDate(words) {
  const lines = groupWordsIntoLines(words);

  for (const line of lines) {
    const lineText = line.map(w => w.text).join(' ');
    const lowerLine = lineText.toLowerCase();
    const hasDateKeyword = DATE_KEYWORDS.some(kw => lowerLine.includes(kw));

    if (hasDateKeyword) {
      for (const pattern of DATE_PATTERNS) {
        const match = lineText.match(pattern);
        if (match) {
          const confidence = getConfidenceForSubstring(line, match[1]);
          return { value: match[1], confidence };
        }
      }
    }
  }

  const fullText = words.map(w => w.text).join(' ');
  for (const pattern of DATE_PATTERNS) {
    const match = fullText.match(pattern);
    if (match) {
      const confidence = getConfidenceForSubstring(words, match[1]);
      return { value: match[1], confidence };
    }
  }

  return { value: null, confidence: 0 };
}

function extractTotal(words) {
  const lines = groupWordsIntoLines(words);
  const reversedLines = [...lines].reverse();

  for (const keyword of TOTAL_KEYWORDS_PRIORITY) {
    for (const line of reversedLines) {
      const lineText = line.map(w => w.text).join(' ');
      const lowerLine = lineText.toLowerCase();

      if (SKIP_KEYWORDS.some(sk => lowerLine.includes(sk) && sk !== keyword)) continue;

      if (lowerLine.includes(keyword)) {
        const amountMatch = lineText.match(AMOUNT_PATTERN);
        if (amountMatch) {
          const amountStr = amountMatch[0].replace(/\s/g, '');
          const amountWords = line.filter(w => AMOUNT_PATTERN.test(w.text));
          const confidence = amountWords.length > 0
            ? amountWords.reduce((sum, w) => sum + w.confidence, 0) / amountWords.length
            : line.reduce((sum, w) => sum + w.confidence, 0) / line.length;
          return { value: amountStr, confidence: Math.round(confidence) };
        }
      }
    }
  }

  let largest = { value: null, confidence: 0, amount: 0 };
  for (const word of words) {
    const match = word.text.match(AMOUNT_PATTERN);
    if (match) {
      const num = parseFloat(match[0].replace(/[\$,\s]/g, ''));
      if (num > largest.amount) {
        largest = { value: match[0].replace(/\s/g, ''), confidence: Math.round(word.confidence), amount: num };
      }
    }
  }

  return { value: largest.value, confidence: largest.confidence };
}

function extractVendorFromEmail(rawText, emailFrom) {
  if (emailFrom) {
    const nameMatch = emailFrom.match(/^"?([^"<]+)"?\s*</);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      const lowerName = name.toLowerCase();
      const generic = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'info', 'support', 'orders', 'receipts', 'billing'];
      if (!generic.some(g => lowerName.includes(g)) && name.length > 1) {
        return name;
      }
    }
  }

  const lines = rawText.split('\n').filter(l => l.trim().length > 0);
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i].trim();
    if (/^\d+$/.test(line)) continue;
    if (/^\*+$/.test(line)) continue;
    if (DATE_PATTERNS.some(p => p.test(line))) continue;
    if (AMOUNT_PATTERN.test(line)) continue;
    if (line.length < 2) continue;
    const words = line.toLowerCase().split(/\s+/);
    if (words.every(w => VENDOR_SKIP_WORDS.includes(w))) continue;
    return line;
  }

  return null;
}

function parseReceiptFromText(rawText, emailFrom) {
  const text = rawText.includes('<') && rawText.includes('>') ? stripHtml(rawText) : rawText;
  const words = buildWordsFromText(text);
  const vendor = extractVendorFromEmail(text, emailFrom);
  const date = extractDate(words);
  const total = extractTotal(words);

  const scores = [date.confidence, total.confidence].filter(c => c > 0);
  const overallConfidence = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    vendor,
    vendorConfidence: vendor ? 100 : 0,
    date: date.value,
    dateConfidence: date.confidence,
    total: total.value,
    totalConfidence: total.confidence,
    overallConfidence,
  };
}

module.exports = { parseReceiptFromText, stripHtml };
