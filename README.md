# Kotobee Ebook → Markdown capture

Logs into the Universitas Terbuka Kotobee reader with your own credentials,
walks every chapter of a book, and saves the text as a single Markdown file for
personal study/summary use.

## Prerequisites

- Node.js 18+ (you have v22)
- Your UT credentials in a `.env` file at the **project root** (one folder up
  from here) — the repo already has it. Format:

  ```ini
  url=https://univterbuka.kotobee.com/#/login
  username=055977901@ecampus.ut.ac.id
  password=••••••••
  ```

## Install

```bash
cd ebook-capture
npm install          # installs playwright + turndown, then downloads Chromium
```

If the Chromium download didn't run automatically:

```bash
npx playwright install chromium
```

## Usage

```bash
# defaults: book code MKWN411001 -> ../Pancasila.md
node capture-ebook.js MKWN411001 ../Pancasila.md

# any other book you are enrolled in (use the code shown on the library tile)
node capture-ebook.js MSIM420202 ../Struktur-Data-raw.md
```

- `BOOK_CODE` (1st arg) — the code on the library cover tile.
- `OUTPUT_FILE` (2nd arg) — where to write the Markdown.
- `HEADLESS=false node capture-ebook.js …` — watch the browser do its thing.

## How it works

1. Fills the email/password login form and submits.
2. Clicks the library tile whose label matches `BOOK_CODE`, then **Read**.
3. Reads `window.chapters.maxIndex` and `window.book.getTitleByIndex(i)` from the
   Kotobee runtime to learn the chapter list.
4. For each chapter `i`, sets the hash to `#/book/<id>/reader/chapter/<i>`, waits
   for `window.chapters.busy === false` and for the content to change, then grabs
   the `#spreadL` / `#epubContent` HTML.
5. Converts each chapter's HTML to Markdown with Turndown (GFM tables enabled)
   and concatenates them under `##`/`###` headings.

## Notes / limitations

- Use only on materials you are authorised to access (your enrolled courses).
- Images embedded as `blob:`/`data:` URLs can't be saved as portable links, so
  they are replaced with an `*(Gambar: …)*` caption placeholder. Real
  `http(s)` image URLs are kept and absolutised.
- Interactive elements (videos, formative-quiz widgets) are captured as their
  visible text only.
- If the site's markup changes, adjust the selectors near the top of
  `capture-ebook.js` (`#spreadL`, the `Login`/`Read` locators).
