# drive-invoice-to-sheet

Drop invoices and receipts (PDFs, photos, phone screenshots) into a Google Drive folder. Every 10 minutes an Apps Script reads each new file with an AI vision model, writes a checked row into Google Sheets, converts the total to your home currency, and moves the file to `Archived`.

One file, no server, no build step. Built for a small Indonesian business (rupiah, Saudi riyal and US dollar invoices, WhatsApp screenshots, handwritten shop receipts) and tested against the documents that broke earlier versions.

```
Drive folder ──(every 10 min)──► Apps Script ──► AI reads the file ──► code checks it ──► row in Sheets
                                                                                        │
                                          OK or "Needs review" + reason ◄───────────────┘
                                          file → Archived (or Needs Review folder)
```

## The approach (why it's built this way)

**1. The AI only reads; code decides.** The model returns raw fields as JSON. Every judgement (is it OK, does it add up, is it a duplicate) is plain code you can test. Rows that fail a check are still written, with `Status = Needs review` and the reason in `Notes`, so nothing silently disappears.

**2. Copy the total, never compute it.** The model is told to copy the total exactly as written and to list each item line on its own. Code then checks qty × price = amount per line, and that the lines add up to the written total. In testing, a model misread a handwritten `24.000` as `29.000`, then "fixed" the total to match its own mistake (63,000 instead of the written 58,000). Comparing the written total with the lines catches that.

**3. PDFs are read as page images, not OCR text.** Google Drive OCR looked convenient, but on 2-page bilingual (Arabic/English) invoices it returned only part of page 1: no totals, so the model reported one ticket price as the total. Now each PDF is split into pages with [pdf-lib](https://github.com/Hopding/pdf-lib) (loaded from cdnjs, version pinned and SHA-256 checked before it runs), Drive renders each page as an image (its thumbnail, about 1024 px wide), and all pages go to the model in one request.

**4. Checks that caught real mistakes:**
| Check | Catches |
|---|---|
| Written total vs line items vs subtotal/discount/tax | misread digits, model-computed totals (VAT-inclusive line amounts are understood) |
| Document date more than 60 days before upload, or in the future | a misread year (2026 read as 2024) |
| Handwritten document | always sent to review: that's where misreads happen |
| Not a final receipt | pending ride-app orders, quotes, shopping carts, insurance policy schedules |
| Vendor = your own company | the model swapping buyer and seller |
| Same Vendor + Doc No. + Total | possible duplicates are **written and flagged**, never skipped (a VAT registration number used as "Doc No." once made two different invoices look identical) |
| Unknown or missing currency | assumed home currency **and** flagged, never silent |

**5. Currency conversion is an in-sheet formula.** `FX Rate` and `Total <HOME_CURRENCY>` are `GOOGLEFINANCE` formulas using the rate on the document date (weekends fall back to the last trading day). Apps Script itself can't read historical GOOGLEFINANCE data ([Google, 2016](https://workspaceupdates.googleblog.com/2016/09/historical-googlefinance-data-no-longer.html)), so the formula lives in the cell. Currencies pegged to the US dollar go through the peg: in October 2026 Google's own SAR→IDR history ran about 3% below USD→IDR ÷ 3.75 (the [official riyal peg](https://sama.gov.sa/en-US/News/Pages/news-557.aspx)), which a pegged currency can't do. Market rate, not your bank's: treat it as an estimate.

**6. Score models on your own documents before switching.** `live_test.js` runs the exact same prompt and checks against files you've checked by hand. On our 10-file set: `deepseek-v4.1-flash` 58/58 fields, `minimax-m3.1-flash` 56/58. Ten files is a small sample, so run your own.

## What you get in the sheet

Tab `Expenses`: Processed At · File (link) · Type · Vendor · Doc No. · Doc Date · Due Date · Items · Subtotal · Discount · Tax · Total · Currency · FX Rate · Total `<HOME_CURRENCY>` · Payment Method · Category · Status · Notes

Tab `Import Log`: one line per file (OK, OK (needs review), DUPLICATE, ERROR, RETRY, GAVE UP, SKIPPED).

## Setup (about 10 minutes)

You need: a Google account, a Google Sheet, a Drive folder, and an [Ollama](https://ollama.com) account with an API key (cloud models, see their pricing page).

1. **Create the folder and the sheet.** Put the sheet anywhere (inside the folder is fine: Google Docs/Sheets files are ignored).
2. **Open the sheet → Extensions → Apps Script.** Paste the contents of [`Code.gs`](Code.gs) into a new script file.
3. **Edit the settings at the top of `CFG`:**
   - `FOLDER_ID`: the ID from the folder's URL (`drive.google.com/drive/folders/<THIS>`)
   - `COMPANY_NAME`: your business name (the buyer)
   - `HOME_CURRENCY`: e.g. `IDR`, `USD`, `EUR`
   - `LOCALE_HINT`, `TIMEZONE`, `CATEGORIES`: adjust to your documents
4. **Add the Drive API service:** left sidebar → Services (+) → Drive API → Add (identifier `Drive`). It's needed for PDF page images.
5. **Run `invoiceImportSetup`** (select it in the toolbar → Run) and approve the permissions. It creates the tabs, the `Archived` and `Needs Review` folders, an **Invoice Import** menu and the 10-minute timer.
6. **Reload the sheet → Invoice Import → Set Ollama API key.**
7. **Drop a file into the folder → Invoice Import → Test AI on newest file.** It shows what would be written, without writing or moving anything.

From then on it runs by itself. Check rows marked `Needs review`, fix them if needed, and change the status to `OK`.

### Optional: DeepSeek fallback

If Ollama is rate-limited or down (HTTP 429/5xx, unreachable), the script can hand that file, and the rest of that run, to [DeepSeek's own API](https://api-docs.deepseek.com/) (`deepseek-flash`, which [accepts images](https://api-docs.deepseek.com/guides/vision)). It is **off** until you set a key with **Invoice Import → Set DeepSeek API key (fallback)**. Errors that aren't about capacity (a wrong Ollama key, a bad request) are never covered by the fallback. Rows it reads start with `read by DeepSeek API` in Notes.

Know before enabling: it's a second provider, and per [DeepSeek's privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) data is stored in the People's Republic of China and may be used for training unless you opt out. On our test set it scored 57/58.

## Cost and limits

- **Idle runs cost no AI tokens.** With nothing new, the script lists the folder and stops; the model is never called. Each file = one model call (all PDF pages in one request). Failed files are retried at most 3 times.
- **PDFs:** first 6 pages are read (more → Needs review). Each extra page adds about 10 s while Drive renders it.
- **File types:** PDF, JPG, PNG, WEBP. HEIC (iPhone default) goes to `Needs Review`; export as JPG.
- **Runs:** each run stops after 4.5 minutes (Apps Script's limit is 6); leftovers continue next run.
- **Amount parsing:** one separator followed by exactly 3 digits is read as thousands (`12.500` → 12500). Right for rupiah-style amounts; documents with cents almost always show 2 decimals.

## Testing

```bash
node test.js                                   # 95 checks, no Google account or API key needed
OLLAMA_API_KEY=... node live_test.js samples/*  # real model calls on your files (needs poppler for PDFs)
TRUTH=truth.json node live_test.js samples/*    # + score against hand-checked values (see truth.example.json)
MODEL=minimax-m3.1-flash node live_test.js ...  # compare another model
PROVIDER=deepseek node live_test.js ...         # test the fallback path
```

`samples/`, `truth.json` and all PDF/image files are git-ignored, so real documents can't be committed by accident. `live_test.js` sends your files to the provider.

## Credits

[pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) for splitting PDFs. Models served by [Ollama Cloud](https://ollama.com) and optionally [DeepSeek](https://www.deepseek.com).

## License

[MIT](LICENSE)
