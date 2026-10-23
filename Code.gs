/**
 * drive-invoice-to-sheet: invoices & receipts dropped in a Google Drive folder -> AI reads them -> rows in Google Sheets.
 * https://github.com/bubucilo/drive-invoice-to-sheet  (MIT)
 *
 * Every TRIGGER_MINUTES, for each new file (PDF, JPG, JPEG, PNG, WEBP) in FOLDER_ID:
 *   1. Read it. Images go to the model as they are. PDFs (the models take no PDFs) are split into pages with pdf-lib,
 *      each page is rendered by Drive (thumbnail, ~1024 px wide) and all page images go to the model together.
 *      Drive OCR is deliberately NOT used: on 2-page bilingual invoices it silently dropped the page with the totals.
 *   2. The model (Ollama Cloud by default) returns the fields as JSON. It only READS; it never decides.
 *   3. Code checks everything: written total copied (not computed), line items vs totals, Subtotal - Discount + Tax
 *      = Total, dates (future / suspiciously old), handwriting, non-final documents (carts, quotes, pending orders),
 *      category list, currency. Anything off -> Status "Needs review" + the reason in Notes (the row is still written).
 *   4. Same file content (MD5) already imported -> not written, moves to "Needs Review".
 *      Same Vendor + Doc No. + Total already in the sheet -> written and flagged "possible duplicate of row N"
 *      (never silently skipped: a wrong Doc No. can make two different invoices look identical).
 *   5. Row written -> file moves to "Archived" (the link in the File column keeps working).
 *      AI / page-render failure -> file stays, retried next run; after MAX_TRIES -> "Needs Review".
 *      Ollama rate-limited or down (HTTP 429/5xx, network) -> optional fallback to DeepSeek's own API, ONLY if a
 *      DeepSeek key is set (second provider; DeepSeek stores data in China). Rows read by it say so in Notes.
 *      No fallback key, or both down -> RETRY next run (does not use up a try).
 *      To retry a file from "Needs Review", move it back to the main folder: it gets fresh tries.
 *   6. Every file is logged in the "Import Log" tab.
 *   FX Rate + "Total <HOME_CURRENCY>" are in-sheet GOOGLEFINANCE formulas (rate on the document date).
 *
 * Setup: see README. In short: set FOLDER_ID + COMPANY_NAME below, Services (+) > Drive API > Add,
 *        run invoiceImportSetup(), menu Invoice Import > Set Ollama API key > Test AI on newest file.
 */

var INVOICE_IMPORT = (function () {
  var CFG = {
    // ---- set these ----
    FOLDER_ID: 'PASTE_YOUR_DRIVE_FOLDER_ID',   // the folder people drop invoices into (the ID in its URL)
    COMPANY_NAME: 'Your Company',              // the buyer: a document "from" this name is flagged
    HOME_CURRENCY: 'IDR',                      // currency of the "Total <HOME_CURRENCY>" column; also assumed when none is shown
    LOCALE_HINT: 'Documents are mostly Indonesian or English. Numeric dates on Indonesian documents are day-month-year.',
    TIMEZONE: 'Asia/Jakarta',
    CATEGORIES: ['Transport & Courier', 'Travel & Accommodation', 'Software & Subscriptions', 'Marketing & Ads',
      'Office & Operations', 'Meals', 'Utilities', 'Professional Services', 'Insurance', 'Fees & Bank Charges', 'Tax', 'Other'],
    // ---- usually fine as is ----
    ARCHIVE_FOLDER: 'Archived',
    REVIEW_FOLDER: 'Needs Review',
    TAB: 'Expenses',
    LOG_TAB: 'Import Log',
    OLLAMA_URL: 'https://ollama.com/api/chat',
    MODEL: 'deepseek-v4.1-flash',             // scored 58/58 fields vs minimax-m3.1-flash 56/58 on our 10-file test set (2026-10)
    THINK: 'low',                              // sent as "think"; '' = model default
    KEY_PROP: 'OLLAMA_API_KEY',
    // Optional fallback, only on Ollama 429/5xx/unreachable (never on bad answers). Off until a DeepSeek key is set.
    FALLBACK_URL: 'https://api.deepseek.com/chat/completions',
    FALLBACK_MODEL: 'deepseek-flash',          // = DeepSeek-V4.1-Flash per api-docs.deepseek.com (2026-10)
    FALLBACK_KEY_PROP: 'DEEPSEEK_API_KEY',
    FALLBACK_EXTRA: { thinking: { type: 'enabled' } },   // merged into the request body
    MAX_TRIES: 3,
    MAX_FILE_MB: 15,
    MAX_PDF_PAGES: 6,                          // more pages -> first 6 read + Needs review
    PAGE_PX: 2400,                             // requested thumbnail size; Drive caps it at ~1024 px wide
    THUMB_WAIT_S: 60,                          // how long to wait for Drive to render a split-off page
    TMP_FOLDER: '_tmp_pages',                  // subfolder for split pages, trashed right after each file
    // pdf-lib pinned + checked: the downloaded code must match this SHA-256 or it is not run.
    PDF_LIB_URL: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
    PDF_LIB_SHA256: '0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f',
    TRIGGER_MINUTES: 10,                       // Apps Script allows 1, 5, 10, 15 or 30
    MAX_RUN_MS: 4.5 * 60 * 1000,               // stop before Apps Script's 6-min limit; next run continues
    MAX_DOC_AGE_DAYS: 60,                      // doc date older than this before upload -> Needs review (catches misread years)
    // Currencies pegged to USD: rate = USD->HOME / peg. In Oct 2026 Google's own SAR->IDR history ran ~3% below
    // USD->IDR / 3.75 (a pegged currency can't do that). SAR 3.75 = Saudi Central Bank official rate.
    FX_PEGS: { SAR: 3.75 },
    CURRENCY_ALIASES: { RP: 'IDR', SR: 'SAR', RM: 'MYR' },
  };

  var TOTAL_HOME = 'Total ' + CFG.HOME_CURRENCY;
  var HEAD = ['Processed At', 'File', 'Type', 'Vendor', 'Doc No.', 'Doc Date', 'Due Date', 'Items', 'Subtotal',
    'Discount', 'Tax', 'Total', 'Currency', 'FX Rate', TOTAL_HOME, 'Payment Method', 'Category', 'Status', 'Notes'];
  var LOG_HEAD = ['File ID', 'File Name', 'MD5', 'Logged At', 'Result', 'Row', 'Detail'];
  var KINDS = { 'application/pdf': 'pdf', 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image' };
  var EXT_KINDS = { pdf: 'pdf', jpg: 'image', jpeg: 'image', png: 'image', webp: 'image' };

  // ---------------- main ----------------

  // async because pdf-lib is promise-based
  async function run() {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) { Logger.log('Another Invoice Import is running; skipped.'); return; }
    try { await runLocked_(); } finally { lock.releaseLock(); }
  }

  async function runLocked_() {
    var t0 = Date.now();
    var ss = SpreadsheetApp.getActive();
    checkConfig_();
    var sh = ss.getSheetByName(CFG.TAB);
    if (!sh) throw new Error('Tab not found: ' + CFG.TAB + '. Run invoiceImportSetup first.');
    var log = logSheet_(ss);
    var cols = columns_(sh);
    var hist = logHistory(log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, LOG_HEAD.length).getValues() : []);
    var keys = existingKeys_(sh, cols);
    var folder = DriveApp.getFolderById(CFG.FOLDER_ID);
    var archived = subfolder_(folder, CFG.ARCHIVE_FOLDER), review = subfolder_(folder, CFG.REVIEW_FOLDER);

    var files = [], it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.getMimeType().indexOf('application/vnd.google-apps') === 0) continue;   // the sheet itself, docs
      files.push(f);
    }
    files.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });

    var n = 0, left = 0, stopped = '';
    for (var i = 0; i < files.length; i++) {
      if (stopped || Date.now() - t0 > CFG.MAX_RUN_MS) { left++; continue; }
      var f = files[i], id = f.getId();
      var entry = [id, f.getName(), '', new Date(), '', '', ''];
      var dest = null;
      try {
        var kind = fileKind(f.getMimeType(), f.getName());
        if (!kind) {
          entry[4] = 'SKIPPED'; entry[6] = 'Unsupported file type (' + f.getMimeType() + '). Use PDF, JPG, PNG or WEBP'; dest = review;
        } else if (f.getSize() > CFG.MAX_FILE_MB * 1024 * 1024) {
          entry[4] = 'SKIPPED'; entry[6] = 'File larger than ' + CFG.MAX_FILE_MB + ' MB'; dest = review;
        } else {
          var blob = f.getBlob(), md5 = md5Hex_(blob.getBytes());
          entry[2] = md5;
          if (hist.okMd5[md5]) {
            entry[4] = 'DUPLICATE'; entry[6] = 'Same file already imported (row ' + hist.okMd5[md5] + ')'; dest = review;
          } else {
            var got = await extract_(f, kind, blob);
            var rec = validate(got.raw, { fileName: f.getName(), created: fmtDate_(f.getDateCreated()), today: fmtDate_(new Date()),
              pageCount: got.pageCount, pagesRead: got.pagesRead });
            var key = dupKey(rec.vendor, rec.docNo, rec.total);
            if (got.provider === 'deepseek') markProvider(rec, got.why);
            if (key && keys[key]) markPossibleDuplicate(rec, keys[key]);
            var row = writeRow_(sh, cols, rec, f);
            if (key && !keys[key]) keys[key] = row;
            hist.okMd5[md5] = row;
            entry[4] = rec.status === 'OK' ? 'OK' : 'OK (needs review)'; entry[5] = row; entry[6] = rec.notes; dest = archived;
          }
        }
      } catch (e) {
        if (e.transient) {
          entry[4] = 'RETRY'; entry[6] = e.message; stopped = e.message;
        } else {
          var tries = (hist.errors[id] || 0) + 1;
          hist.errors[id] = tries;
          entry[4] = tries >= CFG.MAX_TRIES ? 'GAVE UP' : 'ERROR';
          entry[6] = String(e.message).substring(0, 400) + ' (try ' + tries + '/' + CFG.MAX_TRIES + ')';
          if (tries >= CFG.MAX_TRIES) dest = review;
        }
      }
      if (dest) {
        var err = moveFile_(f, dest);
        if (err) entry[6] = (entry[6] ? entry[6] + '; ' : '') + 'not moved: ' + err;
      }
      log.appendRow(entry);
      n++;
    }
    var msg = 'Processed ' + n + ' file(s)' + (left ? ', ' + left + ' left for next run' : '') +
      (stopped ? ' (stopped early: ' + stopped.substring(0, 80) + ')' : '') + '. See "' + CFG.LOG_TAB + '".';
    try { ss.toast(msg, 'Invoice Import'); } catch (e) { /* trigger run: no UI */ }
    Logger.log(msg);
  }

  // ---------------- read + AI ----------------

  /** -> { raw: AI JSON, provider, why, pageCount, pagesRead } */
  async function extract_(f, kind, blob) {
    if (kind === 'pdf') {
      var pages = await pdfPageImages_(f, blob);
      var m = callModel_(buildPrompt(f.getName(), { read: pages.images.length, count: pages.pageCount }), pages.images);
      return { raw: m.raw, provider: m.provider, why: m.why, pageCount: pages.pageCount, pagesRead: pages.images.length };
    }
    var one = callModel_(buildPrompt(f.getName(), null), [Utilities.base64Encode(blob.getBytes())]);
    return { raw: one.raw, provider: one.provider, why: one.why, pageCount: 1, pagesRead: 1 };
  }

  /**
   * PDF -> one PNG per page (first MAX_PDF_PAGES). Page 1 = the file's own Drive thumbnail; pages 2+ are split off with
   * pdf-lib into temp PDFs so Drive renders them too. Temp files are trashed in finally. Needs the Drive advanced service.
   */
  async function pdfPageImages_(f, blob) {
    if (typeof Drive === 'undefined') throw new Error('Drive advanced service missing: Services (+) > Drive API > Add');
    var PDFLib = pdfLib_();
    var src = await PDFLib.PDFDocument.load(new Uint8Array(blob.getBytes()), { updateMetadata: false });
    var count = src.getPageCount(), n = Math.min(count, CFG.MAX_PDF_PAGES), ids = [f.getId()], tmp = [];
    try {
      if (n > 1) {
        var folder = subfolder_(DriveApp.getFolderById(CFG.FOLDER_ID), CFG.TMP_FOLDER);
        for (var i = 1; i < n; i++) {
          var one = await PDFLib.PDFDocument.create();
          one.addPage((await one.copyPages(src, [i]))[0]);
          var bytes = toSignedBytes(await one.save());
          var tf = folder.createFile(Utilities.newBlob(bytes, 'application/pdf', '_page' + (i + 1) + '_' + f.getName()));
          tmp.push(tf); ids.push(tf.getId());
        }
      }
      return { images: ids.map(function (id) { return Utilities.base64Encode(pageImage_(id)); }), pageCount: count };
    } finally {
      tmp.forEach(function (t) { try { t.setTrashed(true); } catch (e) { Logger.log('Temp page not trashed: ' + t.getId()); } });
    }
  }

  /** Drive thumbnail of a file as PNG bytes; waits up to THUMB_WAIT_S for Drive to render a new upload. */
  function pageImage_(id) {
    var link = '', t0 = Date.now();
    while (!link) {
      link = Drive.Files.get(id, { fields: 'thumbnailLink' }).thumbnailLink || '';
      if (link) break;
      if (Date.now() - t0 > CFG.THUMB_WAIT_S * 1000) throw new Error('Drive did not render the PDF page within ' + CFG.THUMB_WAIT_S + ' s');
      Utilities.sleep(3000);
    }
    var res = UrlFetchApp.fetch(link.replace(/=s\d+$/, '') + '=s' + CFG.PAGE_PX, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Page image download HTTP ' + res.getResponseCode());
    return res.getContent();
  }

  var pdfLibLoaded = null;
  /** pdf-lib from cdnjs, run only if it matches the pinned SHA-256. */
  function pdfLib_() {
    if (pdfLibLoaded) return pdfLibLoaded;
    var res;
    try { res = UrlFetchApp.fetch(CFG.PDF_LIB_URL, { muteHttpExceptions: true }); } catch (e) { throw transientError_('pdf-lib download failed: ' + e.message); }
    if (res.getResponseCode() !== 200) throw transientError_('pdf-lib download HTTP ' + res.getResponseCode());
    var hex = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, res.getContent())
      .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    if (hex !== CFG.PDF_LIB_SHA256) throw new Error('pdf-lib download does not match the pinned SHA-256; not run (' + hex.substring(0, 12) + ')');
    if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = function (fn) { fn(); return 0; };  // Apps Script has none
    (0, eval)(res.getContentText());
    pdfLibLoaded = globalThis.PDFLib;
    if (!pdfLibLoaded) throw new Error('pdf-lib did not load');
    return pdfLibLoaded;
  }

  var ollamaDown = '';   // set on the first Ollama capacity failure; the rest of this run goes to DeepSeek
  /** -> { raw, provider: 'ollama' | 'deepseek', why } */
  function callModel_(prompt, images) {
    if (!ollamaDown) {
      try {
        return { raw: callOllama_(prompt, images), provider: 'ollama', why: '' };
      } catch (e) {
        if (!e.transient || !PropertiesService.getScriptProperties().getProperty(CFG.FALLBACK_KEY_PROP)) throw e;
        ollamaDown = String(e.message).substring(0, 80);
      }
    }
    return { raw: callDeepSeek_(prompt, images), provider: 'deepseek', why: ollamaDown };
  }

  function callOllama_(prompt, images) {
    var key = PropertiesService.getScriptProperties().getProperty(CFG.KEY_PROP);
    if (!key) throw new Error('No Ollama API key. Menu Invoice Import > Set Ollama API key');
    var res;
    try {
      res = UrlFetchApp.fetch(CFG.OLLAMA_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        muteHttpExceptions: true,
        payload: JSON.stringify(requestBody(prompt, images))
      });
    } catch (e) {
      throw transientError_('Ollama unreachable: ' + e.message);
    }
    var code = res.getResponseCode(), body = res.getContentText();
    if (code === 429 || code >= 500) throw transientError_('Ollama HTTP ' + code + ' ' + body.substring(0, 200));
    if (code !== 200) throw new Error('Ollama HTTP ' + code + ' ' + body.substring(0, 300));
    var msg = JSON.parse(body).message || {};
    return parseJson(msg.content || '');
  }

  function callDeepSeek_(prompt, images) {
    var key = PropertiesService.getScriptProperties().getProperty(CFG.FALLBACK_KEY_PROP);
    var res;
    try {
      res = UrlFetchApp.fetch(CFG.FALLBACK_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        muteHttpExceptions: true,
        payload: JSON.stringify(deepseekBody(prompt, images))
      });
    } catch (e) {
      throw transientError_('Ollama down and DeepSeek unreachable: ' + e.message);
    }
    var code = res.getResponseCode(), body = res.getContentText();
    if (code === 429 || code >= 500) throw transientError_('Ollama down and DeepSeek HTTP ' + code + ' ' + body.substring(0, 200));
    if (code !== 200) throw new Error('DeepSeek HTTP ' + code + ' ' + body.substring(0, 300));
    return parseJson(deepseekContent(body));
  }

  function transientError_(text) { var e = new Error(text); e.transient = true; return e; }

  // ---------------- sheet ----------------

  /** Header name -> 1-based column, from row 1. Missing headers stop the run (nothing written in the wrong place). */
  function columns_(sh) {
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var row = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    var cols = { width: lastCol };
    HEAD.forEach(function (h) {
      var i = row.indexOf(h);
      if (i < 0) throw new Error('Header "' + h + '" not found in row 1 of ' + CFG.TAB + '. Run invoiceImportSetup.');
      cols[h] = i + 1;
    });
    return cols;
  }

  function existingKeys_(sh, cols) {
    var keys = {}, last = sh.getLastRow();
    if (last < 2) return keys;
    var data = sh.getRange(2, 1, last - 1, cols.width).getValues();
    data.forEach(function (r, i) {
      var k = dupKey(r[cols['Vendor'] - 1], r[cols['Doc No.'] - 1], parseAmount(r[cols['Total'] - 1]));
      if (k && !keys[k]) keys[k] = i + 2;
    });
    return keys;
  }

  function writeRow_(sh, cols, rec, f) {
    var row = sh.getLastRow() + 1;
    var out = [];
    for (var i = 0; i < cols.width; i++) out.push('');
    var put = function (h, v) { out[cols[h] - 1] = v === null || v === undefined ? '' : v; };
    put('Processed At', new Date());
    put('File', '=HYPERLINK("' + f.getUrl() + '","' + f.getName().replace(/"/g, '""') + '")');
    put('Type', rec.type);
    put('Vendor', safeText(rec.vendor));
    put('Doc No.', rec.docNo ? "'" + rec.docNo : '');      // keep as text (leading zeros, long IDs)
    put('Doc Date', rec.docDate);                            // YYYY-MM-DD string -> Sheets stores a date
    put('Due Date', rec.dueDate);
    put('Items', safeText(rec.items));
    put('Subtotal', rec.subtotal);
    put('Discount', rec.discount);
    put('Tax', rec.tax);
    put('Total', rec.total);
    put('Currency', rec.currency);
    put('Payment Method', safeText(rec.paymentMethod));
    put('Category', rec.category);
    put('Status', rec.status);
    put('Notes', safeText(rec.notes));
    sh.getRange(row, 1, 1, cols.width).setValues([out]);
    setFxFormulas_(sh, cols, row, 1);
    return row;
  }

  /**
   * FX Rate + Total <HOME_CURRENCY> as in-sheet formulas (Google blocks historical GOOGLEFINANCE data from Apps Script, so the
   * script never reads the rate). Rate = last close in the 7 days up to Doc Date (weekends/holidays fall back).
   */
  function setFxFormulas_(sh, cols, firstRow, n) {
    var fx = [], idr = [];
    for (var i = 0; i < n; i++) {
      fx.push([fxFormulaR1C1(cols['FX Rate'], cols['Currency'], cols['Doc Date'])]);
      idr.push([totalHomeFormulaR1C1(cols[TOTAL_HOME], cols['Total'], cols['FX Rate'])]);
    }
    sh.getRange(firstRow, cols['FX Rate'], n, 1).setFormulasR1C1(fx);
    sh.getRange(firstRow, cols[TOTAL_HOME], n, 1).setFormulasR1C1(idr);
  }

  function checkConfig_() {
    if (!CFG.FOLDER_ID || /^PASTE_/.test(CFG.FOLDER_ID)) throw new Error('Set CFG.FOLDER_ID at the top of the script to your Drive folder ID first.');
  }

  function logSheet_(ss) {
    var log = ss.getSheetByName(CFG.LOG_TAB);
    if (!log) {
      log = ss.insertSheet(CFG.LOG_TAB);
      log.getRange(1, 1, 1, LOG_HEAD.length).setValues([LOG_HEAD]).setFontWeight('bold');
      log.setFrozenRows(1);
    }
    return log;
  }

  function subfolder_(folder, name) {
    var it = folder.getFoldersByName(name);
    return it.hasNext() ? it.next() : folder.createFolder(name);
  }

  /** Moves a file; returns '' on success or the error text. */
  function moveFile_(f, dest) {
    try { f.moveTo(dest); return ''; } catch (e) { return String(e.message).substring(0, 100); }
  }

  function md5Hex_(bytes) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
      .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  }

  function fmtDate_(d) { return Utilities.formatDate(d, CFG.TIMEZONE, 'yyyy-MM-dd'); }

  // ---------------- pure functions (tested in test_invoice.js) ----------------

  var SYSTEM_PROMPT = [
    'You read ' + CFG.COMPANY_NAME + ' expense documents: vendor invoices, receipts, payment screenshots. ' + CFG.LOCALE_HINT,
    CFG.COMPANY_NAME + ' is the buyer, never the vendor. Copy values exactly as printed. Never guess: use null when a value is not on the document.',
    'Fields:',
    '- type: "Invoice" = a bill asking for payment (due date, "remit to"); "Receipt" = proof of a payment already made (struk, e-receipt, transfer proof, ride/delivery app order); "Other" = neither.',
    '- vendor: the business that issued the document or was paid. For ride-hailing and delivery apps (Grab, Gojek, Uber, Lalamove...) use the app and service, e.g. "Grab Express".',
    '- doc_number: invoice no., receipt no., order ID or transaction ID, exactly as printed. Never a VAT, tax or company registration number (VAT Number, NPWP, CR).',
    '- doc_date, due_date: YYYY-MM-DD. Use the date printed on the document, not the file name.',
    '- items: one line, max 200 characters, what was bought, with quantities (e.g. "Travel insurance, 39 people in 2 groups").',
    '- lines: every purchased item row as printed: description, qty, unit_price, amount. Read each number on its own; do not fix them to make the sums work. Leave out discount, tax, fee-total and total rows. [] when the document has no item rows.',
    '- total: COPY the final amount exactly as written on the document (Total, Jumlah, Tertagih, Amount Due, Invoice Total). Never calculate it from the lines. null if no total is written.',
    '- subtotal: only when a subtotal is written on the document (Subtotal, Applicable Fees), else null. discount: a positive number, null if none. tax: tax added (0 when the document shows 0%), null if not shown.',
    '- handwritten: true when any amount, date or quantity is handwritten.',
    '- Amounts are plain numbers without thousand separators: "Rp53.500" -> 53500, "2,028,000" -> 2028000.',
    '- currency: ISO code (IDR, USD, SAR, EUR...).',
    '- payment_method: as shown, e.g. "VISA card", "Bank transfer BCA", "Cash", "GoPay". A "remit to" bank account on an invoice is not a payment method: use null.',
    '- category: exactly one of: ' + CFG.CATEGORIES.join(' | ') + '.',
    '- is_final: false when the document is not a final bill or receipt: an order still in progress (driver on the way, "Cancel Booking" button), a quotation, a proforma, a draft, a shopping cart or order summary, an insurance policy or certificate. Otherwise true.',
    '- confidence: "high", "medium" or "low" (low when the image is blurry, cropped or key numbers are hard to read).',
    '- notes: short, only what a finance reviewer must know; "" when nothing.',
    'Answer with the JSON object only.'
  ].join('\n');

  var NUM = { type: ['number', 'null'] }, STR = { type: ['string', 'null'] };
  var SCHEMA = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['Invoice', 'Receipt', 'Other'] },
      vendor: STR, doc_number: STR, doc_date: STR, due_date: STR, items: STR,
      lines: {
        type: 'array',
        items: { type: 'object', properties: { description: STR, qty: NUM, unit_price: NUM, amount: NUM },
          required: ['description', 'qty', 'unit_price', 'amount'] }
      },
      subtotal: NUM, discount: NUM, tax: NUM, total: NUM, currency: STR, payment_method: STR,
      category: { type: 'string', enum: CFG.CATEGORIES },
      is_final: { type: 'boolean' },
      handwritten: { type: 'boolean' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string' }
    },
    required: ['type', 'vendor', 'doc_number', 'doc_date', 'due_date', 'items', 'lines', 'subtotal', 'discount', 'tax', 'total',
      'currency', 'payment_method', 'category', 'is_final', 'handwritten', 'confidence', 'notes']
  };

  /** pdf null = the document is the attached image; pdf = { read, count } pages. */
  function buildPrompt(fileName, pdf) {
    if (!pdf) return 'File name: ' + fileName + '\n\nThe document is the attached image.';
    return 'File name: ' + fileName + '\n\nThe document is a PDF. Its pages are attached as images, in order (' + pdf.read +
      ' of ' + pdf.count + ' page' + (pdf.count > 1 ? 's' : '') + '). Read the totals from whichever page shows them.';
  }

  /** pdf-lib Uint8Array -> Apps Script byte[] (signed). */
  function toSignedBytes(u8) {
    var out = new Array(u8.length);
    for (var i = 0; i < u8.length; i++) out[i] = u8[i] > 127 ? u8[i] - 256 : u8[i];
    return out;
  }

  /** Rows read by the fallback say so in Notes (status unchanged: the same checks ran). */
  function markProvider(rec, why) {
    rec.notes = 'read by DeepSeek API (Ollama: ' + why + ')' + (rec.notes ? '; ' + rec.notes : '');
    return rec;
  }

  /** Same Vendor + Doc No. + Total as an earlier row: still written, but flagged so a person decides. */
  function markPossibleDuplicate(rec, row) {
    rec.status = 'Needs review';
    rec.notes = 'possible duplicate of row ' + row + ' (same Vendor + Doc No. + Total)' + (rec.notes ? '; ' + rec.notes : '');
    return rec;
  }

  function requestBody(prompt, images) {
    var user = { role: 'user', content: prompt };
    if (images && images.length) user.images = images;
    var body = {
      model: CFG.MODEL,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, user]
    };
    if (CFG.THINK !== '') body.think = CFG.THINK;
    return body;
  }

  /** DeepSeek API (OpenAI format): no JSON schema option, so the schema goes in the system prompt; json_object mode. */
  function deepseekBody(prompt, images) {
    var content = [{ type: 'text', text: prompt }];
    (images || []).forEach(function (b64) {
      content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } });   // format detected from content
    });
    var body = {
      model: CFG.FALLBACK_MODEL,
      stream: false,
      temperature: 0,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + '\nReturn json only: one object matching this JSON schema:\n' + JSON.stringify(SCHEMA) },
        { role: 'user', content: content }
      ]
    };
    Object.keys(CFG.FALLBACK_EXTRA).forEach(function (k) { body[k] = CFG.FALLBACK_EXTRA[k]; });
    return body;
  }

  /** Answer text from a DeepSeek response; DeepSeek documents occasional empty content, which is an error, never a blank row. */
  function deepseekContent(body) {
    var c = (((JSON.parse(body).choices || [])[0] || {}).message || {}).content || '';
    if (!String(c).trim()) throw new Error('DeepSeek returned empty content');
    return c;
  }

  function parseJson(text) {
    var s = String(text), a = s.indexOf('{'), b = s.lastIndexOf('}');   // also strips ```json fences and stray text
    if (a < 0 || b < a) throw new Error('AI answer has no JSON: ' + String(text).substring(0, 200));
    return JSON.parse(s.substring(a, b + 1));
  }

  /**
   * "Rp53.500" -> 53500, "2,028,000" -> 2028000, "1.234.567,89" -> 1234567.89, "-Rp8.500" -> -8500, 507000 -> 507000.
   * One separator followed by exactly 3 digits is a thousands separator ("12.500" -> 12500). Fine for IDR/JPY-style
   * amounts; for currencies with cents, documents almost always show 2 decimals, so this rarely bites.
   */
  function parseAmount(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim(), neg = /^-|^\(.*\)$/.test(s);
    s = s.replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) return null;
    var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      var dec = lastDot > lastComma ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('');
      s = s.replace(dec, '.');
    } else {
      var sep = lastDot >= 0 ? '.' : (lastComma >= 0 ? ',' : '');
      if (sep) {
        var parts = s.split(sep);
        s = (parts.length > 2 || parts[parts.length - 1].length === 3) ? parts.join('') : parts.join('.');
      }
    }
    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  /** '' when the numbers add up, else the reason. Accepts a subtotal printed before or after the discount. */
  function mathCheck(sub, disc, tax, total) {
    if (total === null) return 'no total found';
    if (sub === null) return '';
    var d = disc || 0, t = tax || 0;
    if (Math.abs(sub - d + t - total) <= 1 || Math.abs(sub + t - total) <= 1) return '';
    return 'Subtotal - Discount + Tax (' + (sub - d + t) + ') does not match Total (' + total + ')';
  }

  /**
   * Item rows vs the written totals: each qty x unit price = amount, and the amounts add up to the subtotal
   * (or to Total + Discount - Tax). Returns the reasons, [] when fine or when there are no item rows.
   * Catches a misread digit that the model "fixed" by computing its own total (e.g. a handwritten 24.000 read as 29.000).
   * Line amounts may include tax (e.g. Saudi invoices: 162 + 15% VAT = 186.30 per line); accepted when the document's own
   * Tax / Subtotal rate explains the difference.
   */
  function linesCheck(lines, sub, disc, tax, total) {
    var out = [], sum = 0, all = true;
    var rate = sub && tax ? tax / sub : 0;
    (lines || []).forEach(function (l, i) {
      var q = parseAmount(l && l.qty), u = parseAmount(l && l.unit_price), a = parseAmount(l && l.amount);
      if (q !== null && u !== null && a !== null && Math.abs(q * u - a) > 1 && !(rate && Math.abs(q * u * (1 + rate) - a) <= 1)) {
        out.push('line ' + (i + 1) + ': ' + q + ' x ' + u + ' is not ' + a);
      }
      if (a === null) all = false; else sum += a;
    });
    if (!lines || !lines.length || !all) return out;
    var d = disc || 0, t = tax || 0;
    var okSub = sub !== null && Math.abs(sum - sub) <= 1;
    var okTotal = total !== null && (Math.abs(sum - d + t - total) <= 1 || Math.abs(sum - d - total) <= 1);   // lines excl. or incl. tax
    if (!okSub && !okTotal) out.push('item lines add up to ' + sum + ', not to the written ' + (sub !== null ? 'Subtotal ' + sub : 'Total ' + total));
    return out;
  }

  /** Whole days from date a to date b (YYYY-MM-DD strings). */
  function daysBetween(a, b) {
    var p = function (s) { var m = s.split('-'); return Date.UTC(+m[0], +m[1] - 1, +m[2]); };
    return Math.round((p(b) - p(a)) / 86400000);
  }

  function validDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2020 || y > 2100) return '';
    return m[0];
  }

  /** "WhatsApp Image 2026-10-22 at 13.49.55.jpeg" -> "2026-10-22"; "" when the name has no date. */
  function dateFromName(name) {
    var m = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(String(name));
    return m ? validDate(m[1] + '-' + m[2] + '-' + m[3]) : '';
  }

  function fileKind(mime, name) {
    if (KINDS[mime]) return KINDS[mime];
    var ext = (/\.([a-z0-9]+)$/i.exec(String(name)) || [])[1];
    return ext ? (EXT_KINDS[ext.toLowerCase()] || '') : '';
  }

  /** Same vendor + doc number + total = same document. '' when doc number or total is missing (no dedupe then). */
  function dupKey(vendor, docNo, total) {
    var v = String(vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    var d = String(docNo || '').toLowerCase().replace(/^'/, '').replace(/[^a-z0-9]/g, '');
    if (!v || !d || total === null || total === undefined || total === '') return '';
    return v + '|' + d + '|' + Math.round(Number(total));
  }

  /** Cell text that Sheets would read as a formula gets a leading apostrophe. */
  function safeText(s) {
    s = s === null || s === undefined ? '' : String(s).trim();
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }

  /** Relative R1C1 reference from column `from` to column `to` on the same row (survives sorting). */
  function rc(from, to) { return 'R[0]C[' + (to - from) + ']'; }

  /** FX Rate cell: 1 for the home currency, USD->home / peg for pegged currencies, else Google's direct rate; text when it can't. */
  function fxFormulaR1C1(fxCol, curCol, dateCol) {
    var cur = rc(fxCol, curCol), d = rc(fxCol, dateCol);
    var close = function (pair) {
      return 'LET(t,GOOGLEFINANCE("CURRENCY:"&' + pair + ',"price",' + d + '-7,' + d + '+1),INDEX(t,ROWS(t),2))';
    };
    var home = CFG.HOME_CURRENCY, rate = close(cur + '&"' + home + '"');
    Object.keys(CFG.FX_PEGS).forEach(function (code) {
      var usdToHome = home === 'USD' ? '1' : close('"USD' + home + '"');
      rate = 'IF(' + cur + '="' + code + '",' + usdToHome + '/' + CFG.FX_PEGS[code] + ',' + rate + ')';
    });
    return '=IF(' + cur + '="","",IF(' + cur + '="' + home + '",1,IF(' + d + '="","no date",IFERROR(' + rate + ',"no rate"))))';
  }

  function totalHomeFormulaR1C1(homeCol, totalCol, fxCol) {
    var t = rc(homeCol, totalCol), fx = rc(homeCol, fxCol);
    return '=IF(AND(ISNUMBER(' + t + '),ISNUMBER(' + fx + ')),ROUND(' + t + '*' + fx + ',2),"")';
  }

  /**
   * AI JSON -> record for the sheet. ctx = { fileName, created: 'YYYY-MM-DD', today: 'YYYY-MM-DD' }.
   * problems -> Status "Needs review"; info -> Notes only.
   */
  function validate(raw, ctx) {
    raw = raw || {};
    var problems = [], info = [];
    var str = function (v, max) { v = v === null || v === undefined ? '' : String(v).trim(); return max ? v.substring(0, max) : v; };
    var rec = {};

    rec.type = ['Invoice', 'Receipt', 'Other'].indexOf(raw.type) >= 0 ? raw.type : 'Other';
    if (rec.type === 'Other') problems.push('not recognised as an invoice or receipt');
    rec.vendor = str(raw.vendor, 120);
    if (!rec.vendor) problems.push('no vendor');
    else if (rec.vendor.toLowerCase().indexOf(String(CFG.COMPANY_NAME).toLowerCase()) >= 0) problems.push('vendor reads as ' + CFG.COMPANY_NAME + ' (we are the buyer)');
    rec.docNo = str(raw.doc_number, 80);
    rec.items = str(raw.items, 200);

    rec.subtotal = parseAmount(raw.subtotal);
    rec.discount = parseAmount(raw.discount);
    if (rec.discount !== null) rec.discount = Math.abs(rec.discount);
    rec.tax = parseAmount(raw.tax);
    rec.total = parseAmount(raw.total);
    var math = mathCheck(rec.subtotal, rec.discount, rec.tax, rec.total);
    if (math) problems.push(math);
    problems = problems.concat(linesCheck(raw.lines, rec.subtotal, rec.discount, rec.tax, rec.total));
    if (rec.total !== null && rec.total <= 0) problems.push('total is not positive');

    var cur = str(raw.currency).toUpperCase().replace(/[^A-Z]/g, '');
    cur = CFG.CURRENCY_ALIASES[cur] || cur;
    rec.currency = /^[A-Z]{3}$/.test(cur) ? cur : CFG.HOME_CURRENCY;
    if (!cur) problems.push('currency not shown; assumed ' + CFG.HOME_CURRENCY);
    else if (cur !== rec.currency) problems.push('currency "' + str(raw.currency) + '" not recognised; assumed ' + CFG.HOME_CURRENCY);
    rec.paymentMethod = str(raw.payment_method, 80);

    rec.category = CFG.CATEGORIES.indexOf(raw.category) >= 0 ? raw.category : 'Other';
    if (CFG.CATEGORIES.indexOf(raw.category) < 0) problems.push('category "' + str(raw.category) + '" not in list');

    rec.docDate = validDate(raw.doc_date);
    if (raw.doc_date && !rec.docDate) problems.push('unreadable doc date "' + str(raw.doc_date) + '"');
    if (rec.docDate && ctx.today && rec.docDate > ctx.today) problems.push('doc date ' + rec.docDate + ' is in the future');
    if (rec.docDate && ctx.created && daysBetween(rec.docDate, ctx.created) > CFG.MAX_DOC_AGE_DAYS) {
      problems.push('doc date ' + rec.docDate + ' is ' + daysBetween(rec.docDate, ctx.created) + ' days before upload (misread year?)');
    }
    if (!rec.docDate) {
      var fromName = dateFromName(ctx.fileName);
      rec.docDate = fromName || ctx.created || '';
      if (rec.docDate) info.push('no date on document; Doc Date from ' + (fromName ? 'file name' : 'upload date'));
    }
    rec.dueDate = validDate(raw.due_date);

    if (raw.is_final === false) problems.push('not a final receipt (order in progress, quote or draft)');
    if (raw.handwritten === true) problems.push('handwritten: check amounts and date against the image');
    if (ctx.pageCount && ctx.pagesRead && ctx.pagesRead < ctx.pageCount) problems.push('only the first ' + ctx.pagesRead + ' of ' + ctx.pageCount + ' PDF pages were read');
    if (raw.confidence === 'low') problems.push('AI confidence low');
    var aiNote = str(raw.notes, 300);

    rec.status = problems.length ? 'Needs review' : 'OK';
    rec.notes = problems.concat(info).concat(aiNote ? ['AI: ' + aiNote] : []).join('; ');
    return rec;
  }

  /** Log rows -> { okMd5: md5 -> sheet row, errors: fileId -> failed tries since its last GAVE UP }. */
  function logHistory(rows) {
    var okMd5 = {}, errors = {};
    rows.forEach(function (r) {
      var id = r[0], md5 = r[2], result = String(r[4]);
      if (result.indexOf('OK') === 0 && md5) okMd5[md5] = r[5];
      if (result === 'ERROR') errors[id] = (errors[id] || 0) + 1;
      if (result === 'GAVE UP') errors[id] = 0;     // moved back by hand from Needs Review -> fresh tries
    });
    return { okMd5: okMd5, errors: errors };
  }

  // ---------------- setup / tools ----------------

  function setup() {
    checkConfig_();
    var ss = SpreadsheetApp.getActive();
    ss.setSpreadsheetTimeZone(CFG.TIMEZONE);
    var sh = ss.getSheetByName(CFG.TAB);
    if (!sh) {
      var first = ss.getSheets()[0];
      sh = first.getLastRow() === 0 && first.getName() !== CFG.LOG_TAB ? first.setName(CFG.TAB) : ss.insertSheet(CFG.TAB, 0);
    }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#0b5d4b').setFontColor('#ffffff');
      sh.setFrozenRows(1);
      var col = function (h) { return HEAD.indexOf(h) + 1; };
      sh.getRange(2, col('Processed At'), sh.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy hh:mm');
      ['Doc Date', 'Due Date'].forEach(function (h) { sh.getRange(2, col(h), sh.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy'); });
      ['Subtotal', 'Discount', 'Tax', 'Total'].forEach(function (h) { sh.getRange(2, col(h), sh.getMaxRows() - 1, 1).setNumberFormat('#,##0.00'); });   // cents for USD/SAR
      sh.getRange(2, col(TOTAL_HOME), sh.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
      sh.getRange(2, col('FX Rate'), sh.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
      sh.setColumnWidth(col('File'), 220);
      sh.setColumnWidth(col('Items'), 280);
      sh.setColumnWidth(col('Notes'), 320);
    }
    var added = addMissingColumns_(sh);
    var cols = columns_(sh);                        // throws if headers were changed
    if (added.length && sh.getLastRow() > 1) setFxFormulas_(sh, cols, 2, sh.getLastRow() - 1);   // backfill old rows
    logSheet_(ss);
    var folder = DriveApp.getFolderById(CFG.FOLDER_ID);
    subfolder_(folder, CFG.ARCHIVE_FOLDER);
    subfolder_(folder, CFG.REVIEW_FOLDER);

    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (/^invoiceImport/.test(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('invoiceImportMenu').forSpreadsheet(ss).onOpen().create();
    ScriptApp.newTrigger('invoiceImportRun').timeBased().everyMinutes(CFG.TRIGGER_MINUTES).create();
    menu();
    var warn = typeof Drive === 'undefined' ? '\n\nPDFs need the Drive advanced service: Services (+) > Drive API > Add.' : '';
    SpreadsheetApp.getUi().alert('Invoice Import installed: tab "' + CFG.TAB + '", log "' + CFG.LOG_TAB + '", folders "' +
      CFG.ARCHIVE_FOLDER + '" + "' + CFG.REVIEW_FOLDER + '", import every ' + CFG.TRIGGER_MINUTES + ' min.' +
      (added.length ? '\n\nAdded columns: ' + added.join(', ') + ' (filled for existing rows).' : '') + warn);
  }

  /** Existing sheet from an older version: insert any new HEAD column right after its HEAD neighbour. */
  function addMissingColumns_(sh) {
    var added = [];
    var headers = function () { return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); }); };
    HEAD.forEach(function (h, i) {
      var row = headers();
      if (row.indexOf(h) >= 0) return;
      var after = i > 0 ? row.indexOf(HEAD[i - 1]) + 1 : 0;
      if (after > 0) sh.insertColumnAfter(after); else sh.insertColumnBefore(1);
      var c = after + 1;
      sh.getRange(1, c).setValue(h);
      if (h === 'FX Rate') sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
      if (h === TOTAL_HOME) sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
      added.push(h);
    });
    return added;
  }

  function menu() {
    SpreadsheetApp.getUi().createMenu('Invoice Import')
      .addItem('Import new files now', 'invoiceImportRun')
      .addItem('Test AI on newest file (no write, no move)', 'invoiceImportTestAi')
      .addItem('Test AI on newest PDF (no write, no move)', 'invoiceImportTestAiPdf')
      .addItem('Set Ollama API key', 'invoiceImportSetKey')
      .addItem('Set DeepSeek API key (fallback)', 'invoiceImportSetFallbackKey')
      .addToUi();
  }

  function setKey(fallback) {
    var ui = SpreadsheetApp.getUi();
    var r = fallback
      ? ui.prompt('DeepSeek API key (fallback)', 'From platform.deepseek.com > API keys. Used only when Ollama is rate-limited or down. Leave empty + OK to switch the fallback off.', ui.ButtonSet.OK_CANCEL)
      : ui.prompt('Ollama API key', 'From ollama.com > Settings > API keys. Stored in Script Properties, not in the sheet.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var prop = fallback ? CFG.FALLBACK_KEY_PROP : CFG.KEY_PROP, v = r.getResponseText().trim(), props = PropertiesService.getScriptProperties();
    if (v) props.setProperty(prop, v); else props.deleteProperty(prop);
    ui.alert(v ? 'Saved.' : 'Removed.');
  }

  /** Newest file in the main folder (else in Archived): AI + checks, shown in a popup. Never writes or moves. */
  async function testAi(pdfOnly) {
    var folder = DriveApp.getFolderById(CFG.FOLDER_ID), newest = null, where = 'main folder';
    var pick = function (it) {
      while (it.hasNext()) {
        var f = it.next();
        var k = fileKind(f.getMimeType(), f.getName());
        if (!k || (pdfOnly && k !== 'pdf')) continue;
        if (!newest || f.getDateCreated() > newest.getDateCreated()) newest = f;
      }
    };
    pick(folder.getFiles());
    if (!newest) { pick(subfolder_(folder, CFG.ARCHIVE_FOLDER).getFiles()); where = CFG.ARCHIVE_FOLDER; }
    if (!newest) throw new Error('No PDF/image files in the folder or in ' + CFG.ARCHIVE_FOLDER);
    var t0 = Date.now(), blob = newest.getBlob();
    var got = await extract_(newest, fileKind(newest.getMimeType(), newest.getName()), blob);
    var raw = got.raw;
    var rec = validate(raw, { fileName: newest.getName(), created: fmtDate_(newest.getDateCreated()), today: fmtDate_(new Date()),
      pageCount: got.pageCount, pagesRead: got.pagesRead });
    if (got.provider === 'deepseek') markProvider(rec, got.why);
    var out = 'File: ' + newest.getName() + '  [' + where + ']  ' + Math.round((Date.now() - t0) / 1000) + ' s  via ' + got.provider +
      '\n\nAI raw: ' + JSON.stringify(raw, null, 1) + '\n\nWould write: ' + JSON.stringify(rec, null, 1);
    Logger.log(out);
    SpreadsheetApp.getUi().alert(out.substring(0, 3000));
  }

  return {
    run: run, setup: setup, menu: menu, setKey: setKey, testAi: testAi,
    // exposed for local tests
    _: { CFG: CFG, HEAD: HEAD, SCHEMA: SCHEMA, SYSTEM_PROMPT: SYSTEM_PROMPT, buildPrompt: buildPrompt, requestBody: requestBody,
      fxFormulaR1C1: fxFormulaR1C1, toSignedBytes: toSignedBytes, markPossibleDuplicate: markPossibleDuplicate, deepseekBody: deepseekBody, deepseekContent: deepseekContent,
      markProvider: markProvider, callModel: callModel_, totalHomeFormulaR1C1: totalHomeFormulaR1C1, parseJson: parseJson, parseAmount: parseAmount, mathCheck: mathCheck, linesCheck: linesCheck, daysBetween: daysBetween, validDate: validDate, dateFromName: dateFromName,
      fileKind: fileKind, dupKey: dupKey, safeText: safeText, validate: validate, logHistory: logHistory }
  };
})();

function invoiceImportRun() { return INVOICE_IMPORT.run(); }
function invoiceImportSetup() { INVOICE_IMPORT.setup(); }
function invoiceImportMenu() { INVOICE_IMPORT.menu(); }
function invoiceImportSetKey() { INVOICE_IMPORT.setKey(false); }
function invoiceImportSetFallbackKey() { INVOICE_IMPORT.setKey(true); }
function invoiceImportTestAi() { return INVOICE_IMPORT.testAi(false); }
function invoiceImportTestAiPdf() { return INVOICE_IMPORT.testAi(true); }
function invoiceImportRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (/^invoiceImport/.test(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
}
