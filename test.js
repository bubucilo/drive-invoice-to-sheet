// Tests for Code.gs (no Google account needed): node test.js
// Every case below comes from a real failure or a real document shape; the data is made up.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), ctx);
const I = ctx.INVOICE_IMPORT._;

let fail = 0, n = 0;
const eq = (got, want, msg) => { n++; if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log('  FAIL:', msg, '| got', JSON.stringify(got), '| want', JSON.stringify(want)); } };
const ok = (c, msg) => eq(!!c, true, msg);
const C = { fileName: 'x.pdf', created: '2026-10-22', today: '2026-10-22' };

// Amounts: Indonesian receipts use "." for thousands (Rp53.500), English invoices use "," (2,028,000).
// Reading either as a decimal point would book Rp 53.5 instead of Rp 53,500.
eq(I.parseAmount('Rp53.500'), 53500, 'Grab total, dot thousands');
eq(I.parseAmount('-Rp8.500'), -8500, 'Grab promo, negative');
eq(I.parseAmount('62.000'), 62000, 'Grab fees');
eq(I.parseAmount('2,028,000'), 2028000, 'invoice total, comma thousands');
eq(I.parseAmount('1.234.567,89'), 1234567.89, 'Indonesian decimals');
eq(I.parseAmount('2,028,000.50'), 2028000.5, 'English decimals');
eq(I.parseAmount('12.5'), 12.5, 'real decimal (not 3 digits after the dot)');
eq(I.parseAmount(507000), 507000, 'model already sent a number');
eq(I.parseAmount(null), null, 'missing stays missing, not 0');
eq(I.parseAmount('-'), null, 'dash is not a number');

// Math: some invoices print Subtotal AFTER the discount (2,028,000), a ride-app screenshot BEFORE it (62,000).
// Both are correct documents and must pass; a real mismatch must not.
eq(I.mathCheck(2535000, 507000, 0, 2028000), '', 'subtotal before discount');
eq(I.mathCheck(2028000, 507000, 0, 2028000), '', 'subtotal printed after discount');
eq(I.mathCheck(62000, 8500, null, 53500), '', 'Grab: fees - promo = total');
ok(I.mathCheck(62000, 8500, 0, 60000), 'wrong total is flagged');
ok(I.mathCheck(null, null, null, null), 'no total is flagged');
eq(I.mathCheck(null, null, null, 53500), '', 'total only (simple struk) is fine');

// Dates: screenshots carry no date, so the WhatsApp file name is the next best source.
eq(I.dateFromName('WhatsApp Image 2026-10-22 at 13.49.55.jpeg'), '2026-10-22', 'WhatsApp name');
eq(I.dateFromName('IMG_20261019_101500.jpg'), '2026-10-19', 'camera name');
eq(I.dateFromName('Invoice - Example Co (19 October 2026).pdf'), '', 'month words are not guessed');
eq(I.validDate('2026-02-30'), '', 'impossible date rejected');
eq(I.validDate('19-Sep-26'), '', 'model must send ISO, anything else is rejected');

// File types the model can read; HEIC (iPhone default) is not one of them.
eq(I.fileKind('application/pdf', 'a.pdf'), 'pdf', 'pdf');
eq(I.fileKind('image/jpeg', 'a.jpeg'), 'image', 'jpeg');
eq(I.fileKind('application/octet-stream', 'scan.PNG'), 'image', 'extension fallback');
eq(I.fileKind('image/heic', 'IMG_1.HEIC'), '', 'heic rejected');
eq(I.fileKind('application/zip', 'a.zip'), '', 'zip rejected');

// Duplicates: the same invoice uploaded twice (re-download, different file) must not be booked twice.
eq(I.dupKey('PT Contoh Broker Asuransi', 'INV-001', 2028000), I.dupKey('PT. Contoh Broker Asuransi ', "'inv001", '2028000'), 'same doc, different punctuation');
ok(I.dupKey('A', 'INV-001', 100) !== I.dupKey('A', 'INV-001', 200), 'same number, different total = different doc');
eq(I.dupKey('Grab Express', '', 53500), '', 'no doc number = no dedupe (two rides can cost the same)');

// AI text is written to cells: anything Sheets would run as a formula is neutralised.
eq(I.safeText('=IMPORTXML("http://x")'), "'=IMPORTXML(\"http://x\")", 'formula injection');
eq(I.safeText('- 20 pax'), "'- 20 pax", 'leading dash');
eq(I.safeText('Grab Express'), 'Grab Express', 'plain text untouched');

// validate: sample invoice as the model should return it -> OK row.
const inv = I.validate({ type: 'Invoice', vendor: 'PT Contoh Broker Asuransi', doc_number: 'INV-001', doc_date: '2026-09-19',
  due_date: '2026-10-20', items: 'Travel insurance, 39 people', subtotal: 2535000, discount: 507000, tax: 0, total: 2028000,
  currency: 'IDR', payment_method: null, category: 'Insurance', is_final: true, confidence: 'high', notes: '' }, C);
eq(inv.status, 'OK', 'clean invoice is OK');
eq([inv.docDate, inv.dueDate, inv.total, inv.category], ['2026-09-19', '2026-10-20', 2028000, 'Insurance'], 'invoice fields');

// Grab screenshot: no date, order still in progress -> written, but Needs review, date from file name.
const grab = I.validate({ type: 'Receipt', vendor: 'Grab Express', doc_number: 'IN-3-EXAMPLEORDERID000', doc_date: null, due_date: null,
  items: 'Courier delivery', subtotal: 62000, discount: -8500, tax: null, total: 53500, currency: 'IDR', payment_method: 'VISA card',
  category: 'Transport & Courier', is_final: false, confidence: 'high', notes: '' },
  { fileName: 'WhatsApp Image 2026-10-22 at 13.49.55.jpeg', created: '2026-10-22', today: '2026-10-22' });
eq(grab.status, 'Needs review', 'pending order needs review');
eq(grab.discount, 8500, 'negative promo stored as positive discount');
eq(grab.docDate, '2026-10-22', 'date from file name');
ok(/not a final receipt/.test(grab.notes) && /file name/.test(grab.notes), 'notes say why');

// Model mistakes that must not slip through as OK.
const bad = I.validate({ type: 'Invoice', vendor: 'Your Company', doc_number: 'X', doc_date: '2027-01-01', total: 'abc',
  category: 'Misc stuff', is_final: true, confidence: 'low' }, C);
eq(bad.status, 'Needs review', 'bad extraction needs review');
ok(/Your Company/.test(bad.notes) && /no total/.test(bad.notes) && /future/.test(bad.notes) && /category/.test(bad.notes) && /confidence/.test(bad.notes), 'each problem named');
eq(bad.category, 'Other', 'unknown category falls back to Other');

// Handwritten shop receipt: written Jumlah 58.000 = 24.000 + 2 x 17.000. A real model read 24.000 as 29.000,
// summed the lines itself to 63,000, and read the year 2026 as 2024; the row passed as OK before these checks.
// Each check below must catch it on its own.
const handRaw = { type: 'Invoice', vendor: 'Toko Air Segar', doc_number: 'TA 0101', doc_date: '2024-10-17', due_date: null,
  items: 'Mineral water 330ml x1, water gallon x2', lines: [
    { description: 'Mineral water 330ml', qty: 1, unit_price: 29000, amount: 24000 },
    { description: 'Water gallon', qty: 2, unit_price: 17000, amount: 34000 }],
  subtotal: null, discount: null, tax: null, total: 58000, currency: 'IDR', payment_method: null,
  category: 'Office & Operations', is_final: true, handwritten: false, confidence: 'high', notes: '' };
eq(I.linesCheck(handRaw.lines, null, null, null, 58000), ['line 1: 1 x 29000 is not 24000'], 'misread unit price caught per line');
ok(I.linesCheck([{ qty: 1, unit_price: 29000, amount: 29000 }, { qty: 2, unit_price: 17000, amount: 34000 }], null, null, null, 58000).length,
  'misread amount caught by lines not adding up to the written total');
ok(/does not match Total/.test(I.validate(Object.assign({}, handRaw, { doc_date: '2026-10-17', subtotal: 63000,
  lines: [{ qty: 1, unit_price: 29000, amount: 29000 }, { qty: 2, unit_price: 17000, amount: 34000 }] }),
  { fileName: 'a.jpg', created: '2026-10-22', today: '2026-10-22' }).notes), 'model-computed subtotal 63,000 vs written total 58,000 caught by mathCheck');
eq(I.linesCheck([{ qty: 1, unit_price: 24000, amount: 24000 }, { qty: 2, unit_price: 17000, amount: 34000 }], null, null, null, 58000), [], 'correct reading passes');
eq(I.linesCheck([{ qty: 20, unit_price: 65000, amount: 1300000 }, { qty: 19, unit_price: 65000, amount: 1235000 }, { qty: 0, unit_price: 0, amount: 0 }],
  2028000, 507000, 0, 2028000), [], 'lines before discount, subtotal printed after it');
eq(I.linesCheck([], null, null, null, 53500), [], 'no item rows (total only): nothing to check');
eq(I.linesCheck([{ description: 'x', qty: null, unit_price: null, amount: null }], null, null, null, 100), [], 'unreadable line amounts: no sum check');
const hand = I.validate(handRaw, { fileName: 'IMG_0085.JPG', created: '2026-10-22', today: '2026-10-22' });
eq(hand.status, 'Needs review', 'handwritten misread needs review');
ok(/735 days before upload/.test(hand.notes), 'year 2024 on a 2026 upload flagged');
ok(/handwritten/.test(I.validate(Object.assign({}, handRaw, { lines: [], doc_date: '2026-10-17', handwritten: true }),
  { fileName: 'a.jpg', created: '2026-10-22', today: '2026-10-22' }).notes), 'handwritten alone is enough for review');
eq(I.validate(Object.assign({}, handRaw, { doc_date: '2026-08-24', lines: [] }), { fileName: 'a.jpg', created: '2026-10-22', today: '2026-10-22' }).status,
  'OK', '59 days old is still fine (monthly batch uploads)');
eq(I.daysBetween('2026-10-17', '2026-10-22'), 5, 'daysBetween');

// Currency: amounts stay in the document currency; the home-currency total comes from in-sheet formulas (checked live
// in a sheet, Oct 2026: SAR 1,000 -> IDR 4,812,267 via USD/3.75; Google's direct SAR rate was ~3% low that week).
const fx = I.fxFormulaR1C1(15, 13, 6);   // FX Rate col O, Currency M, Doc Date F
ok(fx.indexOf('R[0]C[-2]="IDR",1') > 0, 'IDR rate is 1 (GOOGLEFINANCE IDRIDR returned 0.9968)');
ok(/R\[0\]C\[-2\]="SAR",LET\(t,GOOGLEFINANCE\("CURRENCY:"&"USDIDR".*\/3\.75/.test(fx), 'SAR goes through USD and the 3.75 peg');
ok(fx.indexOf('R[0]C[-9]-7') > 0 && fx.indexOf('"no rate"') > 0 && fx.indexOf('"no date"') > 0, 'weekend fallback + readable failures');
eq(I.totalHomeFormulaR1C1(16, 12, 15), '=IF(AND(ISNUMBER(R[0]C[-4]),ISNUMBER(R[0]C[-1])),ROUND(R[0]C[-4]*R[0]C[-1],2),"")', 'Total home = Total x rate');
I.CFG.HOME_CURRENCY = 'USD';
const fxUsd = I.fxFormulaR1C1(15, 13, 6);
ok(fxUsd.indexOf('R[0]C[-2]="USD",1') > 0 && /="SAR",1\/3\.75/.test(fxUsd) && fxUsd.indexOf('"EUR') < 0, 'home currency USD: USD = 1, SAR = 1/3.75 (no USDUSD lookup)');
I.CFG.HOME_CURRENCY = 'IDR';
const vcur = c => I.validate(Object.assign({}, handRaw, { doc_date: '2026-10-17', lines: [], currency: c }), { fileName: 'a.jpg', created: '2026-10-22', today: '2026-10-22' });
eq([vcur('SAR').currency, vcur('SAR').status], ['SAR', 'OK'], 'SAR kept as SAR, no conversion in the amounts');
eq(vcur('Rp').currency, 'IDR', 'Rp alias');
eq(vcur('SR').currency, 'SAR', 'SR alias (Saudi receipts)');
eq([vcur(null).currency, vcur(null).status], ['IDR', 'Needs review'], 'missing currency is assumed IDR but flagged, never silent');
eq(vcur('Riyal Saudi').status, 'Needs review', 'unrecognised currency text flagged');
eq(I.HEAD.slice(I.HEAD.indexOf('Currency'), I.HEAD.indexOf('Currency') + 3), ['Currency', 'FX Rate', 'Total IDR'], 'new columns sit after Currency');

// PDFs as page images: Drive OCR returned no totals at all for 2-page bilingual (Arabic/English) invoices.
eq(Array.from(I.toSignedBytes(new Uint8Array([0, 127, 128, 255]))), [0, 127, -128, -1], 'pdf-lib bytes -> Apps Script signed bytes');
ok(/only the first 6 of 9 PDF pages/.test(I.validate(Object.assign({}, inv, { type: 'Invoice', vendor: 'X', total: 1, lines: [], category: 'Other' }),
  Object.assign({}, C, { pageCount: 9, pagesRead: 6 })).notes), 'long PDF: unread pages flagged');
eq(I.validate(Object.assign({}, handRaw, { doc_date: '2026-10-17', lines: [] }), Object.assign({}, C, { pageCount: 2, pagesRead: 2 })).status, 'OK', 'all pages read: no flag');

// Possible duplicate: written + flagged, never skipped. A real invoice was once lost because the AI put the seller's
// VAT number (the same on every invoice from that seller) in Doc No., so a different invoice looked like a duplicate.
const dupRec = I.markPossibleDuplicate({ status: 'OK', notes: '' }, 16);
eq([dupRec.status, dupRec.notes], ['Needs review', 'possible duplicate of row 16 (same Vendor + Doc No. + Total)'], 'duplicate flagged, not dropped');
ok(/Never a VAT, tax or company registration number/.test(I.SYSTEM_PROMPT), 'prompt forbids VAT number as Doc No.');
ok(/insurance policy or certificate/.test(I.SYSTEM_PROMPT) && /shopping cart/.test(I.SYSTEM_PROMPT), 'policies and carts are not final receipts');

// Saudi-style tax invoice: lines show unit price 162 excl. VAT and amount 186.30 incl. 15% VAT; 6 x 186.30 = Total
// 1,117.80. A correct reading must not be flagged.
const vatLines = Array.from({ length: 6 }, (_, i) => ({ description: 'Ticket ' + i, qty: 1, unit_price: 162, amount: 186.3 }));
eq(I.linesCheck(vatLines, 972, null, 145.8, 1117.8), [], 'tax-inclusive line amounts accepted');
eq(I.validate({ type: 'Invoice', vendor: 'Example Railways Co.', doc_number: 'RAIL-000123', doc_date: '2026-10-12', due_date: null,
  items: '6 tickets', lines: vatLines, subtotal: 972, discount: null, tax: 145.8, total: 1117.8, currency: 'SAR', payment_method: null,
  category: 'Transport & Courier', is_final: true, handwritten: false, confidence: 'high', notes: '' }, C).status, 'OK', 'VAT-inclusive invoice read correctly = OK');
ok(I.linesCheck([{ qty: 1, unit_price: 162, amount: 200 }], 162, null, 24.3, 186.3).length, 'a line that is neither excl. nor incl. tax is still flagged');
ok(I.linesCheck([{ qty: 1, unit_price: 162, amount: 186.3 }], null, null, null, 186.3).length, 'no subtotal/tax on the document: no tax excuse for the line');

// Optional DeepSeek fallback: only for Ollama capacity failures, always labelled.
// Each scenario gets a fresh script instance with fake Ollama/DeepSeek endpoints.
const fakeRun = (ollama, deepseek, keys) => {
  const calls = [], c2 = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => keys[k] || null }) },
    UrlFetchApp: { fetch: (url) => {
      const isDs = url.indexOf('deepseek') >= 0, r = isDs ? deepseek : ollama; calls.push(isDs ? 'deepseek' : 'ollama');
      if (r === 'throw') throw new Error('DNS error');
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    } } };
  vm.createContext(c2); vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), c2);
  return { M: c2.INVOICE_IMPORT._, calls };
};
const okOllama = { code: 200, body: JSON.stringify({ message: { content: '{"total": 1}' } }) };
const okDs = { code: 200, body: JSON.stringify({ choices: [{ message: { content: '{"total": 2}' } }] }) };
const both = { OLLAMA_API_KEY: 'o', DEEPSEEK_API_KEY: 'd' };
const tryCall = M => { try { return M.callModel('p', []); } catch (e) { return { error: e.message, transient: !!e.transient }; } };
let r = fakeRun(okOllama, okDs, both);
eq([tryCall(r.M).provider, r.calls], ['ollama', ['ollama']], 'Ollama fine: DeepSeek never called');
r = fakeRun({ code: 429, body: 'rate limited' }, okDs, both);
const first = tryCall(r.M), second = tryCall(r.M);
eq([first.provider, first.raw.total, second.provider, r.calls], ['deepseek', 2, 'deepseek', ['ollama', 'deepseek', 'deepseek']],
  'Ollama 429: DeepSeek reads it, and the rest of the run skips Ollama');
ok(/Ollama HTTP 429/.test(first.why), 'reason kept for the Notes label');
r = fakeRun('throw', okDs, both); eq(tryCall(r.M).provider, 'deepseek', 'Ollama unreachable: fallback');
r = fakeRun({ code: 503, body: '' }, okDs, both); eq(tryCall(r.M).provider, 'deepseek', 'Ollama 5xx: fallback');
r = fakeRun({ code: 401, body: 'Unauthorized' }, okDs, both);
eq([tryCall(r.M).error.slice(0, 15), r.calls], ['Ollama HTTP 401', ['ollama']], 'bad Ollama key is NOT papered over by DeepSeek');
r = fakeRun({ code: 429, body: '' }, okDs, { OLLAMA_API_KEY: 'o' });
eq([tryCall(r.M).transient, r.calls], [true, ['ollama']], 'no DeepSeek key: fallback off (RETRY next run)');
r = fakeRun({ code: 429, body: '' }, { code: 429, body: '' }, both);
const bothDown = tryCall(r.M); eq(bothDown.transient, true, 'both rate-limited: RETRY, no try used'); ok(/DeepSeek HTTP 429/.test(bothDown.error), 'says both were down');
r = fakeRun({ code: 429, body: '' }, { code: 200, body: JSON.stringify({ choices: [{ message: { content: '  ' } }] }) }, both);
const empty = tryCall(r.M); eq([empty.error, empty.transient], ['DeepSeek returned empty content', false], 'empty DeepSeek answer = error, never a blank row');
const dsb = I.deepseekBody('File: a.pdf', ['AAA', 'BBB']);
eq([dsb.model, dsb.response_format.type, dsb.messages[1].content.length, dsb.messages[1].content[1].image_url.url.slice(0, 22)],
  ['deepseek-flash', 'json_object', 3, 'data:image/png;base64,'], 'DeepSeek request: images in the user message, json mode');
ok(/json/.test(dsb.messages[0].content) && dsb.messages[0].content.indexOf('"category"') > 0, 'schema + the word json in the prompt (DeepSeek JSON mode requires it)');
eq(I.markProvider({ notes: 'x' }, 'Ollama HTTP 429').notes, 'read by DeepSeek API (Ollama: Ollama HTTP 429); x', 'row says who read it');

// Retries: a file moved back from Needs Review by hand gets fresh tries.
const h = I.logHistory([
  ['f1', 'a', '', '', 'ERROR'], ['f1', 'a', '', '', 'ERROR'], ['f1', 'a', '', '', 'GAVE UP'], ['f1', 'a', '', '', 'ERROR'],
  ['f2', 'b', 'md5b', '', 'OK (needs review)', 7], ['f3', 'c', '', '', 'RETRY']]);
eq(h.errors.f1, 1, 'count restarts after GAVE UP');
eq(h.errors.f3, undefined, 'Ollama outage (RETRY) does not use up tries');
eq(h.okMd5.md5b, 7, 'imported file remembered for duplicate check');

// Request: images go in "images" (PDF pages too), the schema forces the category list.
const body = I.requestBody(I.buildPrompt('a.jpg', null), ['BASE64']);
eq([body.model, body.stream, body.messages[1].images.length], ['deepseek-v4.1-flash', false, 1], 'image request');
ok(/2 of 2 pages/.test(I.buildPrompt('a.pdf', { read: 2, count: 2 })), 'pdf prompt says how many pages are attached');
ok(!('images' in I.requestBody(I.buildPrompt('a.pdf', { read: 1, count: 1 }), []).messages[1]), 'no empty images array');
eq(body.format.properties.category.enum, I.CFG.CATEGORIES, 'schema category list = CFG list');
eq(I.parseJson('```json\n{"a":1}\n```'), { a: 1 }, 'fenced JSON');

console.log(fail ? `${fail}/${n} FAILED` : `all ${n} passed`);
process.exit(fail ? 1 : 0);
