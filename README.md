# DocReader

A zero-install, in-browser book reader: highlights, notes, bookmarks, and reading progress.
Everything runs client-side; your books and annotations stay in the browser (IndexedDB).

## Run
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
