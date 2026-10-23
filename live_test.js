// Real model calls with the script's own prompt, schema and checks, on your own files. Nothing is written to Sheets.
//   node live_test.js samples/*                          -> what each file would become as a row
//   MODEL=minimax-m3.1-flash node live_test.js samples/*  -> try another Ollama model
//   PROVIDER=deepseek node live_test.js samples/*         -> the DeepSeek API fallback path
//   TRUTH=truth.json node live_test.js samples/*          -> also score against hand-checked values (see truth.example.json)
// Images are sent as-is. PDFs are rendered with pdftoppm (poppler) at 1024 px wide, the width Drive thumbnails give the
// script. Keys: $OLLAMA_API_KEY / $DEEPSEEK_API_KEY, else macOS Keychain items "ollama-api-key" / "deepseek-api-key".
// This sends your files to the provider. Keep real documents in samples/ (git-ignored).
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), { execSync, execFileSync } = require('child_process');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), ctx);
const I = ctx.INVOICE_IMPORT._;
if (process.env.MODEL) I.CFG.MODEL = process.env.MODEL;

const DS = process.env.PROVIDER === 'deepseek', item = DS ? 'deepseek-api-key' : 'ollama-api-key';
let key = DS ? process.env.DEEPSEEK_API_KEY : process.env.OLLAMA_API_KEY;
if (!key && process.platform === 'darwin') {
  try { key = execSync('security find-generic-password -s ' + item + ' -w', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) {}
}
if (!key) { console.error('No key: set ' + (DS ? 'DEEPSEEK_API_KEY' : 'OLLAMA_API_KEY')); process.exit(2); }

// truth.json: { "<part of the file name>": { "total": 58000, "doc": "TA 0101", "date": "2026-10-17", "cur": "IDR", "status": "OK" } }
// Optional keys: subtotal, tax, due. "date": null means "no date printed on the document".
const truth = process.env.TRUTH ? JSON.parse(fs.readFileSync(process.env.TRUTH, 'utf8')) : null;
let right = 0, total = 0;
const norm = v => String(v == null ? '' : v).replace(/\W/g, '').toUpperCase();
const num = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= 0.011;
function score(name, raw, rec) {
  const frag = Object.keys(truth).find(k => name.indexOf(k) >= 0);
  if (!frag) return;
  const exp = truth[frag], got = { total: rec.total, subtotal: rec.subtotal, tax: rec.tax, doc: rec.docNo, date: raw.doc_date || null,
    due: rec.dueDate || null, cur: rec.currency, status: rec.status };
  Object.keys(exp).forEach(k => {
    total++;
    const okk = ['total', 'subtotal', 'tax'].indexOf(k) >= 0 ? num(got[k], exp[k]) : k === 'doc' ? norm(got[k]) === norm(exp[k]) : got[k] === exp[k];
    if (okk) right++; else console.log(`   MISS ${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(exp[k])}`);
  });
}

(async () => {
  for (const file of process.argv.slice(2)) {
    const name = path.basename(file), kind = I.fileKind('', name);
    if (!kind) { console.log(name, '-> unsupported'); continue; }
    let prompt, images;
    if (kind === 'pdf') {
      const count = +/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())[1];
      const n = Math.min(count, I.CFG.MAX_PDF_PAGES), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
      execFileSync('pdftoppm', ['-png', '-scale-to-x', '1024', '-scale-to-y', '-1', '-l', String(n), file, path.join(dir, 'p')]);
      images = fs.readdirSync(dir).sort().map(f => fs.readFileSync(path.join(dir, f)).toString('base64'));
      prompt = I.buildPrompt(name, { read: images.length, count });
    } else {
      prompt = I.buildPrompt(name, null);
      images = [fs.readFileSync(file).toString('base64')];
    }
    const t0 = Date.now();
    const res = await fetch(DS ? I.CFG.FALLBACK_URL : I.CFG.OLLAMA_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(DS ? I.deepseekBody(prompt, images) : I.requestBody(prompt, images))
    });
    const text = await res.text(), secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!res.ok) { console.log(`\n== ${name}  HTTP ${res.status} (${secs} s)\n${text.substring(0, 500)}`); continue; }
    let raw;
    try { raw = I.parseJson(DS ? I.deepseekContent(text) : JSON.parse(text).message.content); }
    catch (e) { console.log(`\n== ${name}  BAD ANSWER (${secs} s): ${e.message}`); continue; }
    const today = new Date().toISOString().slice(0, 10);
    const rec = I.validate(raw, { fileName: name, created: today, today: today });
    console.log(`\n== ${name}  ${secs} s  -> ${rec.status}`);
    console.log('AI raw:', JSON.stringify(raw));
    console.log('Row   :', JSON.stringify(rec));
    if (truth) score(name, raw, rec);
  }
  if (truth) console.log(`\nScore (${DS ? 'DeepSeek API' : I.CFG.MODEL}): ${right}/${total} fields correct`);
})();
