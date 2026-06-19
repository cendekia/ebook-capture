#!/usr/bin/env node
'use strict';

/*
 * capture-ebook.js
 * ----------------
 * Capture a Universitas Terbuka (Kotobee Reader) ebook into a single Markdown file.
 *
 * Reads credentials from a .env file (see .env.example):
 *     url=https://univterbuka.kotobee.com/#/login
 *     username=...@ecampus.ut.ac.id
 *     password=...
 *
 * Usage:
 *     node capture-ebook.js [BOOK_CODE] [OUTPUT_FILE]
 *
 * Examples:
 *     node capture-ebook.js                       # defaults: MKWN411001 -> Pancasila.md
 *     node capture-ebook.js MKWN411001 Pancasila.md
 *     node capture-ebook.js MSIM420202 Struktur-Data-raw.md
 *
 * Env toggles:
 *     HEADLESS=false   show the browser window (useful for debugging / first run)
 *     ENV_PATH=../.env point at a .env in another folder (default: ../.env then ./.env)
 *
 * Note: only use this on materials you are authorised to access (your own
 * enrolled courses). Output is for personal study/summary use.
 */

const fs = require('fs');
const path = require('path');

// Load .env — prefer the parent folder (project root) then the local folder.
const envPath = process.env.ENV_PATH
  ? path.resolve(process.env.ENV_PATH)
  : (fs.existsSync(path.resolve(__dirname, '..', '.env'))
      ? path.resolve(__dirname, '..', '.env')
      : path.resolve(__dirname, '.env'));
require('dotenv').config({ path: envPath });

const { chromium } = require('playwright');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

// ---- Configuration ---------------------------------------------------------
const LOGIN_URL = process.env.url || 'https://univterbuka.kotobee.com/#/login';
const USERNAME = process.env.username;
const PASSWORD = process.env.password;
const HEADLESS = process.env.HEADLESS !== 'false';

const BOOK_CODE = process.argv[2] || 'MKWN411001';
const OUTPUT_FILE = path.resolve(process.argv[3] || 'Pancasila.md');

if (!USERNAME || !PASSWORD) {
  console.error(`✗ Missing username/password. Looked for .env at: ${envPath}`);
  process.exit(1);
}

// ---- HTML -> Markdown converter -------------------------------------------
const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  hr: '---',
});
td.use(gfm); // GitHub-flavoured: tables, strikethrough, task lists
// Drop empty paragraphs that only held spacing in the reader.
td.addRule('dropEmptyParagraphs', {
  filter: (node) =>
    node.nodeName === 'P' && !node.textContent.trim() && !node.querySelector('img'),
  replacement: () => '',
});

// ---- Helpers ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headingFor(title) {
  // Top-level structural chapters get H2 (module title pages, course overview,
  // author bio); sub-sections (Pendahuluan, Kegiatan Belajar, Latihan,
  // Rangkuman, Tes Formatif, Daftar Pustaka, Glosarium, …) get H3.
  const isTop =
    /^MODUL\s+\d+/i.test(title) ||
    /TINJAUAN MATA KULIAH/i.test(title) ||
    /Riwayat Penulis/i.test(title);
  return isTop ? '##' : '###';
}

function tidyMarkdown(md) {
  return md
    .replace(/ /g, ' ')          // non-breaking spaces
    .replace(/[ \t]+\n/g, '\n')       // trailing whitespace
    .replace(/\n{3,}/g, '\n\n')       // collapse big gaps
    .trim();
}

// ---- Main ------------------------------------------------------------------
(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    console.log('→ Logging in…');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Email').fill(USERNAME);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL(/#\/library/, { timeout: 45000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log(`→ Opening book "${BOOK_CODE}"…`);
    await page.getByText(BOOK_CODE, { exact: true }).first().click();
    await page.waitForURL(/#\/library\/book\/\d+/, { timeout: 45000 });
    await page.getByText('Read', { exact: true }).first().click();
    await page.waitForURL(/#\/book\/\d+\/reader/, { timeout: 45000 });

    // Wait for the Kotobee reader internals to be ready.
    await page.waitForFunction(
      () =>
        window.chapters &&
        typeof window.chapters.maxIndex === 'number' &&
        (document.querySelector('#spreadL') || document.querySelector('#epubContent')),
      null,
      { timeout: 60000 }
    );

    const bookId = (page.url().match(/book\/(\d+)\//) || [])[1];
    const meta = await page.evaluate(() => {
      const cb = (window.book && window.book.currentBook) || {};
      const m = cb.meta || {};
      return {
        maxIndex: window.chapters.maxIndex,
        name: cb.name || null,
        author: m.author || m.creator || null,
        description: m.description || null,
      };
    });
    const titles = await page.evaluate((max) => {
      const out = [];
      for (let i = 0; i <= max; i++) {
        let t = null;
        try { t = window.book.getTitleByIndex(i); } catch (e) { /* ignore */ }
        out.push(t || '');
      }
      return out;
    }, meta.maxIndex);

    console.log(`  book id=${bookId} • chapters 0..${meta.maxIndex} • author=${meta.author || 'n/a'}`);

    const parts = [];
    let prevSig = null;
    let captured = 0;

    for (let i = 0; i <= meta.maxIndex; i++) {
      const hash = `#/book/${bookId}/reader/chapter/${i}`;
      await page.evaluate((h) => { window.location.hash = h; }, hash);

      // Wait until the reader finished loading this chapter and the content
      // actually changed from the previous one (guards against reading the
      // previous chapter before the new one renders).
      let timedOut = false;
      try {
        await page.waitForFunction(
          (prev) => {
            const ch = window.chapters;
            if (ch && ch.busy) return false;
            const el = document.querySelector('#spreadL') || document.querySelector('#epubContent');
            if (!el) return false;
            const txt = (el.innerText || '').trim();
            if (!txt) return false;
            const sig = txt.length + '|' + txt.slice(0, 120);
            return prev === null || sig !== prev;
          },
          prevSig,
          { timeout: 20000, polling: 200 }
        );
      } catch (e) {
        timedOut = true;
      }
      await sleep(350); // small settle for late-rendered nodes

      const chap = await page.evaluate(() => {
        const doc = document;
        const el = doc.querySelector('#spreadL') || doc.querySelector('#epubContent');
        if (!el) return { html: '', sig: '' };
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,svg,audio,video,iframe').forEach((n) => n.remove());

        const flattenInline = (cell) =>
          (cell.innerText || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();

        // Tables — Kotobee tables have no <th>, so the GFM converter would skip
        // them and leak raw HTML. Convert "clean" tabular tables to GFM tables
        // (promoting the first row to a header, the convention for header-less
        // tables) and unwrap layout/complex tables into block content.
        // Process innermost tables first so nesting is handled correctly.
        let guard = 0;
        while (guard++ < 50) {
          const tables = [...clone.querySelectorAll('table')].filter((t) => !t.querySelector('table'));
          if (!tables.length) break;
          for (const table of tables) {
            const rows = [...table.rows];
            if (!rows.length) { table.remove(); continue; }
            const colCount = Math.max(...rows.map((r) => r.cells.length));
            const cells = rows.flatMap((r) => [...r.cells]);
            const hasImg = cells.some((c) => c.querySelector('img'));
            const hasBlock = cells.some((c) => c.querySelector('ul,ol,table,p + p'));
            const multiLine = cells.some((c) => (c.innerText || '').trim().includes('\n'));
            const nonEmpty = cells.filter((c) => (c.innerText || '').trim());
            const clean =
              colCount >= 2 && rows.length >= 2 && nonEmpty.length >= 3 &&
              !hasImg && !hasBlock && !multiLine;
            if (clean) {
              const thead = doc.createElement('thead');
              const htr = doc.createElement('tr');
              for (let ci = 0; ci < colCount; ci++) {
                const th = doc.createElement('th');
                th.textContent = rows[0].cells[ci] ? flattenInline(rows[0].cells[ci]) : '';
                htr.appendChild(th);
              }
              thead.appendChild(htr);
              const tbody = doc.createElement('tbody');
              for (let ri = 1; ri < rows.length; ri++) {
                const tr = doc.createElement('tr');
                for (let ci = 0; ci < colCount; ci++) {
                  const td = doc.createElement('td');
                  td.textContent = rows[ri].cells[ci] ? flattenInline(rows[ri].cells[ci]) : '';
                  tr.appendChild(td);
                }
                tbody.appendChild(tr);
              }
              const nt = doc.createElement('table');
              nt.appendChild(thead);
              nt.appendChild(tbody);
              table.replaceWith(nt);
            } else {
              const frag = doc.createDocumentFragment();
              for (const c of cells) {
                if ((c.innerText || '').trim() || c.querySelector('img')) {
                  const div = doc.createElement('div');
                  while (c.firstChild) div.appendChild(c.firstChild);
                  frag.appendChild(div);
                }
              }
              table.replaceWith(frag);
            }
          }
        }

        // Images: absolutise real URLs, replace blob/data with a caption.
        clone.querySelectorAll('img').forEach((img) => {
          let src = img.getAttribute('src') || '';
          const alt = img.getAttribute('alt') || '';
          try { if (src && !/^(blob:|data:)/.test(src)) src = new URL(src, location.href).href; } catch (e) {}
          if (!src || /^(blob:|data:)/.test(src)) {
            const em = doc.createElement('em');
            em.textContent = `(Gambar: ${alt || 'tanpa keterangan'})`;
            img.replaceWith(em);
          } else {
            img.setAttribute('src', src);
          }
        });

        const txt = (el.innerText || '').trim();
        return { html: clone.innerHTML, sig: txt.length + '|' + txt.slice(0, 120) };
      });

      const title = titles[i] || '';
      const body = chap.html ? tidyMarkdown(td.turndown(chap.html)) : '';

      if (!body && !title) {
        console.log(`  [${String(i).padStart(2)}] (empty, skipped)`);
        continue;
      }

      const h = title ? `${headingFor(title)} ${title}\n\n` : '';
      parts.push((h + body).trim());
      if (chap.sig) prevSig = chap.sig;
      captured++;
      console.log(
        `  [${String(i).padStart(2)}] ${title || '(untitled)'} — ${body.length} chars` +
          (timedOut ? '  (load wait timed out, captured anyway)' : '')
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const header =
      `# ${meta.name && meta.name !== BOOK_CODE ? meta.name + ' — ' : ''}${BOOK_CODE}\n\n` +
      (meta.author ? `**Penulis:** ${meta.author}  \n` : '') +
      `**Sumber:** Universitas Terbuka — Kotobee Reader (book id ${bookId})  \n` +
      `**Diambil:** ${today} • untuk keperluan ringkasan/belajar pribadi\n`;

    const md = header + '\n' + parts.join('\n\n---\n\n') + '\n';
    fs.writeFileSync(OUTPUT_FILE, md, 'utf8');
    console.log(`\n✓ Saved ${captured} sections → ${OUTPUT_FILE} (${md.length.toLocaleString()} chars)`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('\n✗ ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
