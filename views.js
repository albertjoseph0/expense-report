function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSummary(stats) {
  return `<div id="summary" hx-swap-oob="true">${stats.total} transactions · ${stats.withReceipts} receipts · ${stats.missing} missing · ${stats.exempt} exempt · ${stats.verified} verified</div>`;
}

function renderRow(txn) {
  const receipts = txn.receipts || [];
  let receiptCell;

  if (receipts.length > 0) {
    const receiptLinks = receipts.map((r, i) =>
      `<span class="receipt-entry">` +
      `<a href="#" onclick="openViewer('${esc(r.image_path)}'); return false;">#${i + 1}</a>` +
      `<button hx-delete="/receipts/${r.id}" hx-target="#row-${txn.id}" hx-swap="outerHTML" class="unlink-btn" title="Unlink">✕</button>` +
      `</span>`
    ).join(' ');
    receiptCell = `<span class="receipt-status has-receipt">
      ${receiptLinks}
    </span>`;
  } else {
    receiptCell = `<span class="receipt-status missing">❌</span>`;
  }

  const checked = txn.verified ? 'checked' : '';

  return `<tr id="row-${txn.id}" class="${txn.verified ? 'verified' : ''}">
  <td class="verified-cell"><input type="checkbox" ${checked} hx-patch="/transactions/${txn.id}/verified" hx-target="#row-${txn.id}" hx-swap="outerHTML"></td>
  <td>${esc(txn.posted_date)}</td>
  <td>${esc(txn.description)}</td>
  <td>$${(txn.amount_cents / 100).toFixed(2)}</td>
  <td>${receiptCell}</td>
</tr>`;
}

function renderTableBody(transactions) {
  return transactions.map(renderRow).join('\n');
}

function renderOrphanCard(r, transactionsOrOptions) {
  let options = '';
  if (typeof transactionsOrOptions === 'string') {
    options = transactionsOrOptions;
  } else if (Array.isArray(transactionsOrOptions)) {
    options = transactionsOrOptions.map(t =>
      `<option value="${t.id}">${esc(t.posted_date)} — ${esc(t.description)} — $${(t.amount_cents / 100).toFixed(2)}</option>`
    ).join('');
  }

  return `<div class="orphan-card" id="orphan-${r.id}">
  <a href="#" onclick="openViewer('${esc(r.image_path)}'); return false;">
    <img src="${esc(r.image_path)}" class="orphan-thumb" alt="Receipt">
  </a>
  <div class="orphan-info">
    <strong>${esc(r.vendor) || 'Unknown'}</strong>
    <span>${esc(r.receipt_date) || 'No date'} · ${esc(r.total_text) || '?'}</span>
    <form class="assign-form" hx-post="/receipts/${r.id}/assign" hx-target="#table-body" hx-swap="innerHTML">
      <select name="transaction_id" required><option value="">Assign to…</option>${options}</select>
      <button type="submit" class="assign-btn" title="Assign">✓</button>
    </form>
    <button hx-get="/receipts/${r.id}/edit" hx-target="#orphan-${r.id}" hx-swap="outerHTML" class="edit-btn" title="Edit">✎</button>
  </div>
  <button hx-delete="/receipts/${r.id}" hx-target="#orphan-list" hx-swap="innerHTML" class="delete-btn" title="Delete">🗑</button>
</div>`;
}

function renderOrphanEditForm(r) {
  const total = r.total_cents != null ? (r.total_cents / 100).toFixed(2) : '';
  const date = r.receipt_date || '';

  return `<div class="orphan-card editing" id="orphan-${r.id}">
  <a href="#" onclick="openViewer('${esc(r.image_path)}'); return false;">
    <img src="${esc(r.image_path)}" class="orphan-thumb" alt="Receipt">
  </a>
  <form class="orphan-info edit-form" hx-patch="/receipts/${r.id}" hx-target="#orphan-${r.id}" hx-swap="outerHTML">
    <input type="text" name="vendor" value="${esc(r.vendor)}" placeholder="Vendor" aria-label="Vendor" class="edit-input">
    <input type="date" name="date" value="${esc(date)}" aria-label="Date" class="edit-input">
    <input type="number" name="total" value="${total}" step="0.01" placeholder="0.00" aria-label="Total" class="edit-input">
    <div class="edit-actions">
      <button type="submit" class="save-btn" title="Save">✓</button>
      <button type="button" class="cancel-btn" hx-get="/receipts/${r.id}/card" hx-target="#orphan-${r.id}" hx-swap="outerHTML" title="Cancel">✕</button>
    </div>
  </form>
</div>`;
}

function renderOrphanList(orphanReceipts, transactions) {
  if (!orphanReceipts || orphanReceipts.length === 0) {
    return '<p class="empty">No unmatched receipts</p>';
  }
  const txns = transactions || [];
  const options = txns.map(t =>
    `<option value="${t.id}">${esc(t.posted_date)} — ${esc(t.description)} — $${(t.amount_cents / 100).toFixed(2)}</option>`
  ).join('');
  return orphanReceipts.map(r => renderOrphanCard(r, options)).join('\n');
}

function renderPage(transactions, stats, orphanReceipts, filters) {
  const f = filters || {};
  const hxAttrs = `hx-get="/transactions" hx-target="#table-body" hx-swap="innerHTML" hx-trigger="input changed delay:300ms" hx-include=".filter-bar *"`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Expense Report</title>
  <link rel="stylesheet" href="/style.css">
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
</head>
<body>
  <div id="toast"></div>
  <div class="page-layout">
    <div class="main-panel">
      <h1>Expense Report</h1>

      <div class="actions-bar">
        <form hx-post="/statements" hx-target="#table-body" hx-swap="innerHTML" hx-encoding="multipart/form-data">
          <label class="btn">Import Statement <input type="file" name="statement" accept=".csv" onchange="this.form.requestSubmit()" hidden></label>
          <span class="htmx-indicator"><span class="spinner"></span> Importing…</span>
        </form>
        <label class="btn btn-secondary">Upload Receipts <input type="file" id="receipt-input" accept="image/*" multiple onchange="uploadReceipts(this.files)" hidden></label>
      </div>
      <div id="upload-progress"></div>

      <div class="filter-bar">
        <input type="search" name="search" placeholder="Search..." value="${esc(f.search)}" ${hxAttrs}>
        <input type="date" name="dateFrom" value="${esc(f.dateFrom)}" ${hxAttrs}>
        <input type="date" name="dateTo" value="${esc(f.dateTo)}" ${hxAttrs}>
        <label><input type="checkbox" name="missingOnly" value="1" ${f.missingOnly ? 'checked' : ''} ${hxAttrs.replace('input changed delay:300ms', 'change')}> Missing receipts only</label>
      </div>

      <table>
        <thead>
          <tr><th class="th-verified">Reconciled</th><th>Date</th><th>Description</th><th>Amount</th><th>Receipt</th></tr>
        </thead>
        <tbody id="table-body">${renderTableBody(transactions)}</tbody>
      </table>

      <div class="orphan-section">
        <h2>Unmatched Receipts</h2>
        <div id="orphan-list">${renderOrphanList(orphanReceipts, transactions)}</div>
      </div>
    </div>

    <div class="viewer-panel" id="viewer-panel">
      <div class="viewer-toolbar">
        <button id="zoomIn">+</button>
        <span id="zoomLabel">100%</span>
        <button id="zoomOut">−</button>
        <button id="zoomReset">Fit</button>
        <button id="viewerClose">✕</button>
      </div>
      <div class="viewer-body" id="viewerBody">
        <img id="viewerImg" src="" alt="Receipt">
      </div>
    </div>
  </div>
  <script>
    (function() {
      const viewerPanel = document.getElementById('viewer-panel');
      const viewerBody = document.getElementById('viewerBody');
      const viewerImg = document.getElementById('viewerImg');
      let scale = 1, panX = 0, panY = 0;
      let isDragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;

      window.openViewer = function(url) {
        viewerImg.src = url;
        viewerPanel.classList.add('active');
        viewerImg.onload = fitToView;
      };

      function fitToView() {
        const cW = viewerBody.clientWidth, cH = viewerBody.clientHeight;
        const iW = viewerImg.naturalWidth, iH = viewerImg.naturalHeight;
        scale = Math.min(cW / iW, cH / iH);
        panX = (cW - iW * scale) / 2;
        panY = (cH - iH * scale) / 2;
        applyTransform();
      }

      function applyTransform() {
        viewerImg.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
        document.getElementById('zoomLabel').textContent = Math.round(scale * 100) + '%';
      }

      function zoomBy(factor) {
        const cX = viewerBody.clientWidth / 2, cY = viewerBody.clientHeight / 2;
        const ns = Math.min(Math.max(scale * factor, 0.1), 10);
        const r = ns / scale;
        panX = cX - r * (cX - panX);
        panY = cY - r * (cY - panY);
        scale = ns;
        applyTransform();
      }

      document.getElementById('zoomIn').addEventListener('click', function() { zoomBy(1.25); });
      document.getElementById('zoomOut').addEventListener('click', function() { zoomBy(0.8); });
      document.getElementById('zoomReset').addEventListener('click', fitToView);
      document.getElementById('viewerClose').addEventListener('click', function() { viewerPanel.classList.remove('active'); });

      viewerBody.addEventListener('wheel', function(e) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const rect = viewerBody.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const ns = Math.min(Math.max(scale * factor, 0.1), 10);
        const r = ns / scale;
        panX = mx - r * (mx - panX);
        panY = my - r * (my - panY);
        scale = ns;
        applyTransform();
      }, { passive: false });

      viewerBody.addEventListener('mousedown', function(e) { isDragging = true; dragStartX = e.clientX; dragStartY = e.clientY; panStartX = panX; panStartY = panY; });
      window.addEventListener('mousemove', function(e) { if (!isDragging) return; panX = panStartX + (e.clientX - dragStartX); panY = panStartY + (e.clientY - dragStartY); applyTransform(); });
      window.addEventListener('mouseup', function() { isDragging = false; });
    })();
    window.uploadReceipts = async function(files) {
      if (!files.length) return;
      const progress = document.getElementById('upload-progress');
      const total = files.length;
      let done = 0;

      progress.innerHTML = '<div class="upload-status">Uploading 0 of ' + total + '…</div>';

      for (const file of files) {
        const fd = new FormData();
        fd.append('receipt', file);
        try {
          const resp = await fetch('/receipts', { method: 'POST', body: fd });
          const html = await resp.text();
          done++;
          // Use htmx to swap the response into table-body, which also processes OOB swaps
          var tbody = document.getElementById('table-body');
          htmx.swap(tbody, html, { swapStyle: 'innerHTML' });
        } catch (err) {
          done++;
        }
        progress.innerHTML = '<div class="upload-status">Uploaded ' + done + ' of ' + total + '…</div>';
      }

      progress.innerHTML = '<div class="upload-status done">✅ ' + done + ' receipt(s) uploaded</div>';
      setTimeout(function() { progress.innerHTML = ''; }, 4500);
      document.getElementById('receipt-input').value = '';
    };

    document.body.addEventListener('htmx:beforeSwap', function(e) {
      if (e.detail.xhr.status === 409 || e.detail.xhr.status === 400) {
        e.detail.shouldSwap = true;
        e.detail.isError = false;
      }
    });
    document.body.addEventListener('htmx:oobAfterSwap', function(e) {
      if (e.detail.target.id === 'toast') {
        setTimeout(function() { e.detail.target.innerHTML = ''; }, 4500);
      }
    });
  </script>
</body>
</html>`;
}

function renderToast(message, type) {
  return `<div id="toast" hx-swap-oob="innerHTML"><div class="toast-msg ${type}">${message}</div></div>`;
}

module.exports = { renderPage, renderSummary, renderTableBody, renderRow, renderOrphanList, renderOrphanCard, renderOrphanEditForm, renderToast };
