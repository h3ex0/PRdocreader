# DocReader

A zero-install, in-browser book reader: highlights, notes, bookmarks, and reading progress.
Everything runs client-side; your books and annotations stay in the browser (IndexedDB).

## Deploy to GitHub Pages
1. Merge to `main` (the workflow in `.github/workflows/pages.yml` publishes on every push to `main`).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Your reader is at `https://<user>.github.io/PRdocreader/`. Installable as an app and works offline after the first visit.

Note: browser storage is per-origin, so your books/notes live in the browser profile you use on `github.io`; use Export/Import to move them.

## Run locally
- Any static host (e.g. GitHub Pages), or locally: `python3 -m http.server` and open http://localhost:8000
- Opening `index.html` directly from disk also works in most browsers.

## Use
- **Add book**: pick or drag in `.epub` files, or "Open from URL" (needs CORS on the host).
- **Highlight**: select text, pick a colour (or "Highlight + note"). Click a highlight to edit its note.
- **Bookmark**: 🔖 or `B`. **Contents / highlights / bookmarks**: ☰ or `T`. Arrow keys turn pages.
- **Move between machines**: "Export data" saves notes, bookmarks and progress as JSON; "Import data" merges it
  on another machine (add the same book there first).

## Roadmap
PDF support, search, cloud-drive sync (OneDrive/Google Drive), tags/collections.

`vendor/` holds epub.js 0.3.93 and JSZip 3.10.1 so no CDN is needed.
