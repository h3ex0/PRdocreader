(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---------- storage (IndexedDB) ----------
  // books: metadata + progress; files: raw epub bytes; notes: highlights & bookmarks
  let dbp;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open("docreader", 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore("books", { keyPath: "id" });
          d.createObjectStore("files");
          d.createObjectStore("notes", { keyPath: "id" }).createIndex("bookId", "bookId");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  const get = (s, k) => tx(s, "readonly", (o) => o.get(k));
  const put = (s, v, k) => tx(s, "readwrite", (o) => o.put(v, k));
  const del = (s, k) => tx(s, "readwrite", (o) => o.delete(k));
  const all = (s) => tx(s, "readonly", (o) => o.getAll());
  const notesFor = (bookId) => tx("notes", "readonly", (o) => o.index("bookId").getAll(bookId));

  // ---------- helpers ----------
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.id);
    toast.id = setTimeout(() => (t.hidden = true), 2500);
  }
  const settings = {
    get theme() { return localStorage.getItem("dr.theme") || "light"; },
    set theme(v) { localStorage.setItem("dr.theme", v); },
    get size() { return +localStorage.getItem("dr.size") || 100; },
    set size(v) { localStorage.setItem("dr.size", v); },
    get flow() { return localStorage.getItem("dr.flow") || "paginated"; },
    set flow(v) { localStorage.setItem("dr.flow", v); },
  };

  // Content-based id so the same book matches across machines (for export/import).
  async function bookId(buf) {
    if (window.crypto && crypto.subtle) {
      try {
        const h = await crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(h)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
      } catch (e) { /* fall through */ }
    }
    const u = new Uint8Array(buf);
    let h = 2166136261 ^ u.length;
    const step = Math.max(1, Math.floor(u.length / 50000));
    for (let i = 0; i < u.length; i += step) h = Math.imul(h ^ u[i], 16777619);
    return "f" + (h >>> 0).toString(16) + u.length.toString(16);
  }

  // ---------- library ----------
  async function addBook(buf, nameHint) {
    const id = await bookId(buf);
    if (await get("books", id)) { toast("Already in your library"); return id; }
    const book = ePub(buf.slice(0));
    const meta = await book.loaded.metadata;
    let cover = null;
    try {
      const url = (await book.loaded.cover) ? await book.coverUrl() : null;
      if (url) cover = await blobToDataUrl(await (await fetch(url)).blob());
    } catch (e) { /* no cover */ }
    await book.ready.catch(() => {});
    try { book.destroy(); } catch (e) {}
    await put("files", buf, id);
    await put("books", {
      id, title: meta.title || nameHint || "Untitled", author: meta.creator || "",
      cover, added: Date.now(), opened: 0, cfi: null, percent: 0, locations: null,
    });
    return id;
  }
  const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

  async function addFiles(files) {
    for (const f of files) {
      if (!/\.epub$/i.test(f.name)) { toast(`${f.name}: only .epub is supported for now`); continue; }
      try { await addBook(await f.arrayBuffer(), f.name.replace(/\.epub$/i, "")); }
      catch (e) { console.error(e); toast(`Could not read ${f.name}`); }
    }
    renderShelf();
  }

  async function renderShelf() {
    const books = (await all("books")).sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
    const shelf = $("shelf");
    shelf.innerHTML = books.length ? "" : '<div class="empty">No books yet.</div>';
    for (const b of books) {
      const el = document.createElement("div");
      el.className = "book";
      el.innerHTML = `<div class="cover" style="${b.cover ? `background-image:url(${b.cover})` : ""}">${b.cover ? "" : esc(b.title)}</div>
        <div class="prog"><i style="width:${Math.round((b.percent || 0) * 100)}%"></i></div>
        <div class="meta"><b title="${esc(b.title)}">${esc(b.title)}</b><small>${esc(b.author)}</small></div>
        <button class="rm">Remove</button>`;
      el.onclick = () => openBook(b.id);
      el.querySelector(".rm").onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove “${b.title}” and its highlights/notes/bookmarks from this browser?`)) return;
        for (const n of await notesFor(b.id)) await del("notes", n.id);
        await del("files", b.id); await del("books", b.id);
        renderShelf();
      };
      shelf.appendChild(el);
    }
  }

  // ---------- reader ----------
  let cur = null; // { meta, book, rendition, notes, loc }

  function applyTheme() {
    document.body.dataset.theme = settings.theme;
    $("btn-theme").textContent = settings.theme[0].toUpperCase() + settings.theme.slice(1);
    if (cur) applyRenditionStyle();
  }
  const THEMES = { light: ["#1d1d1f", "#ffffff"], sepia: ["#4a3b27", "#f4ecd8"], dark: ["#d8d8dc", "#16171a"] };
  function applyRenditionStyle() {
    const [fg, bg] = THEMES[settings.theme];
    cur.rendition.themes.override("color", fg);
    cur.rendition.themes.override("background", bg);
    cur.rendition.themes.fontSize(settings.size + "%");
  }

  async function openBook(id) {
    const meta = await get("books", id);
    const buf = await get("files", id);
    if (!meta || !buf) return toast("Book data missing");
    $("library").hidden = true;
    $("reader").hidden = false;
    $("book-title").textContent = meta.title;
    $("viewer").innerHTML = "";

    const book = ePub(buf.slice(0));
    const rendition = book.renderTo("viewer", {
      width: "100%", height: "100%", flow: settings.flow === "scrolled" ? "scrolled-doc" : "paginated",
      spread: "none", allowScriptedContent: false,
    });
    cur = { meta, book, rendition, notes: await notesFor(id), loc: null, ready: false };
    applyRenditionStyle();
    $("btn-flow").textContent = settings.flow === "scrolled" ? "Scroll" : "Paged";

    rendition.on("relocated", onRelocated);
    rendition.on("selected", onSelected);
    rendition.on("keyup", onKey);
    rendition.on("click", () => hideSelbar());

    // Restore highlights now; epub.js re-draws them as pages render.
    for (const n of cur.notes) if (n.type === "highlight") drawHighlight(n);

    await rendition.display(meta.cfi || undefined);

    book.loaded.navigation.then(renderToc);
    renderNotes(); renderMarks();
    meta.opened = Date.now(); put("books", meta);

    // Locations give us stable % progress; cache them since generation is slow.
    try {
      if (meta.locations) book.locations.load(meta.locations);
      else { await book.locations.generate(1000); meta.locations = book.locations.save(); put("books", meta); }
      cur.ready = true;
      if (cur.loc) onRelocated(cur.loc);
    } catch (e) { console.warn("locations failed", e); }
  }

  function closeBook() {
    if (cur) { try { cur.rendition.destroy(); cur.book.destroy(); } catch (e) {} }
    cur = null;
    hideSelbar();
    $("panel").hidden = true;
    $("reader").hidden = true;
    $("library").hidden = false;
    renderShelf();
  }

  function onRelocated(loc) {
    if (!cur) return;
    cur.loc = loc;
    const cfi = loc.start.cfi;
    const pct = cur.ready ? cur.book.locations.percentageFromCfi(cfi) : loc.start.percentage || 0;
    cur.meta.cfi = cfi;
    cur.meta.percent = pct || 0;
    put("books", cur.meta);
    $("slider").value = Math.round(cur.meta.percent * 1000);
    $("pct").textContent = Math.round(cur.meta.percent * 100) + "%";
    const chap = tocLabelFor(loc.start.href);
    $("where").textContent = chap;
    const marked = cur.notes.some((n) => n.type === "bookmark" && n.cfi === cfi);
    $("btn-bookmark").style.opacity = marked ? 1 : 0.55;
  }

  function flattenToc(items, out = []) {
    for (const t of items || []) { out.push(t); flattenToc(t.subitems, out); }
    return out;
  }
  function tocLabelFor(href) {
    if (!cur || !cur.book.navigation) return "";
    const flat = flattenToc(cur.book.navigation.toc);
    const clean = (h) => (h || "").split("#")[0];
    const hit = flat.filter((t) => clean(t.href) === clean(href)).pop();
    return hit ? hit.label.trim() : "";
  }

  function renderToc(nav) {
    const build = (items) => `<ul>${items.map((t) => `<li><a data-href="${esc(t.href)}">${esc(t.label.trim())}</a>${t.subitems && t.subitems.length ? build(t.subitems) : ""}</li>`).join("")}</ul>`;
    const el = $("tab-toc");
    el.innerHTML = nav.toc.length ? build(nav.toc) : '<div class="empty">No table of contents.</div>';
    el.querySelectorAll("a").forEach((a) => (a.onclick = () => { cur.rendition.display(a.dataset.href); if (innerWidth < 700) $("panel").hidden = true; }));
  }

  // ----- highlights -----
  let pending = null; // current selection { cfiRange, text }

  function drawHighlight(n) {
    cur.rendition.annotations.highlight(
      n.cfiRange, { id: n.id }, () => editNote(n.id), "hl",
      { fill: n.color, "fill-opacity": "0.4", "mix-blend-mode": "multiply" }
    );
  }

  async function onSelected(cfiRange) {
    let text = "";
    try { text = (await cur.book.getRange(cfiRange)).toString().trim(); } catch (e) {}
    if (!text) return;
    pending = { cfiRange, text };
    $("selbar").hidden = false;
  }
  function hideSelbar() {
    $("selbar").hidden = true; pending = null;
  }
  function clearSelection() {
    try { cur.rendition.getContents().forEach((c) => c.window.getSelection().removeAllRanges()); } catch (e) {}
  }

  async function createHighlight(color, withNote) {
    if (!pending) return;
    const n = { id: uid(), bookId: cur.meta.id, type: "highlight", cfiRange: pending.cfiRange, text: pending.text,
      color, note: "", chapter: tocLabelFor(cur.loc && cur.loc.start.href), created: Date.now() };
    cur.notes.push(n);
    await put("notes", n);
    drawHighlight(n);
    clearSelection(); hideSelbar();
    renderNotes();
    if (withNote) editNote(n.id);
  }

  function editNote(id) {
    const n = cur.notes.find((x) => x.id === id);
    if (!n) return;
    $("note-quote").textContent = n.text;
    $("note-text").value = n.note || "";
    const dlg = $("note-dialog");
    dlg.onclose = async () => {
      if (dlg.returnValue === "save") {
        n.note = $("note-text").value.trim();
        await put("notes", n);
      } else if (dlg.returnValue === "delete") {
        cur.rendition.annotations.remove(n.cfiRange, "highlight");
        cur.notes = cur.notes.filter((x) => x.id !== id);
        await del("notes", id);
      }
      renderNotes();
    };
    dlg.returnValue = "";
    dlg.showModal();
  }

  function renderNotes() {
    const list = cur.notes.filter((n) => n.type === "highlight").sort((a, b) => a.created - b.created);
    const el = $("tab-notes");
    el.innerHTML = list.length ? "" : '<div class="empty">Select text in the book to highlight it.</div>';
    for (const n of list) {
      const d = document.createElement("div");
      d.className = "item";
      d.style.borderLeftColor = n.color;
      d.innerHTML = `<q>${esc(n.text)}</q>${n.note ? `<div class="note">${esc(n.note)}</div>` : ""}<small>${esc(n.chapter || "")}</small>`;
      d.onclick = () => cur.rendition.display(n.cfiRange);
      d.ondblclick = () => editNote(n.id);
      d.title = "Click to jump · double-click to edit note";
      el.appendChild(d);
    }
  }

  // ----- bookmarks -----
  async function toggleBookmark() {
    if (!cur || !cur.loc) return;
    const cfi = cur.loc.start.cfi;
    const existing = cur.notes.find((n) => n.type === "bookmark" && n.cfi === cfi);
    if (existing) {
      cur.notes = cur.notes.filter((n) => n !== existing);
      await del("notes", existing.id);
      toast("Bookmark removed");
    } else {
      const n = { id: uid(), bookId: cur.meta.id, type: "bookmark", cfi, percent: cur.meta.percent,
        chapter: tocLabelFor(cur.loc.start.href), created: Date.now() };
      cur.notes.push(n);
      await put("notes", n);
      toast("Bookmarked");
    }
    $("btn-bookmark").style.opacity = existing ? 0.55 : 1;
    renderMarks();
  }
  function renderMarks() {
    const list = cur.notes.filter((n) => n.type === "bookmark").sort((a, b) => a.percent - b.percent);
    const el = $("tab-marks");
    el.innerHTML = list.length ? "" : '<div class="empty">No bookmarks yet. Press 🔖 or B.</div>';
    for (const n of list) {
      const d = document.createElement("div");
      d.className = "item";
      d.innerHTML = `<q>${esc(n.chapter || "Bookmark")}</q><small>${Math.round(n.percent * 100)}% · ${new Date(n.created).toLocaleDateString()}</small>`;
      d.onclick = () => cur.rendition.display(n.cfi);
      el.appendChild(d);
    }
  }

  // ----- controls -----
  function onKey(e) {
    if (e.key === "ArrowRight" || e.key === "PageDown") cur.rendition.next();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") cur.rendition.prev();
    else if (e.key === "b") toggleBookmark();
    else if (e.key === "t") $("panel").hidden = !$("panel").hidden;
    else if (e.key === "Escape") hideSelbar();
  }
  document.addEventListener("keyup", (e) => {
    if (!cur || e.target.closest("textarea,input[type=text]") || $("note-dialog").open) return;
    onKey(e);
  });

  $("btn-back").onclick = closeBook;
  $("btn-prev").onclick = () => cur.rendition.prev();
  $("btn-next").onclick = () => cur.rendition.next();
  $("btn-bookmark").onclick = toggleBookmark;
  $("btn-panel").onclick = () => ($("panel").hidden = !$("panel").hidden);
  $("btn-theme").onclick = () => { const o = ["light", "sepia", "dark"]; settings.theme = o[(o.indexOf(settings.theme) + 1) % 3]; applyTheme(); };
  $("btn-larger").onclick = () => { settings.size = Math.min(250, settings.size + 10); applyRenditionStyle(); };
  $("btn-smaller").onclick = () => { settings.size = Math.max(60, settings.size - 10); applyRenditionStyle(); };
  $("btn-flow").onclick = () => {
    settings.flow = settings.flow === "paginated" ? "scrolled" : "paginated";
    $("btn-flow").textContent = settings.flow === "scrolled" ? "Scroll" : "Paged";
    cur.rendition.flow(settings.flow === "scrolled" ? "scrolled-doc" : "paginated");
  };
  $("slider").onchange = () => {
    if (!cur || !cur.ready) return toast("Still indexing the book…");
    cur.rendition.display(cur.book.locations.cfiFromPercentage($("slider").value / 1000));
  };
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    ["toc", "notes", "marks"].forEach((t) => ($("tab-" + t).hidden = t !== b.dataset.tab));
  }));
  document.querySelectorAll(".swatch").forEach((s) => (s.onclick = () => createHighlight(s.dataset.color, false)));
  $("sel-note").onclick = () => createHighlight("#ffd54f", true);
  $("sel-cancel").onclick = () => { clearSelection(); hideSelbar(); };

  // ----- library controls -----
  $("file-input").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  const drop = $("drop");
  ["dragover", "dragenter"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  document.addEventListener("drop", (e) => { if (!cur) addFiles([...e.dataTransfer.files]); });

  $("btn-url").onclick = async () => {
    const url = prompt("Direct link to an .epub file (the server must allow cross-origin downloads):");
    if (!url) return;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      await addBook(await r.arrayBuffer(), decodeURIComponent(url.split("/").pop().replace(/\.epub.*$/i, "")));
      renderShelf();
    } catch (e) {
      toast("Download failed (blocked or no CORS). Download the file and use “Add book” instead.");
    }
  };

  // ----- export / import (move your notes between machines) -----
  $("btn-export").onclick = async () => {
    const books = (await all("books")).map(({ cover, locations, ...m }) => m);
    const notes = await all("notes");
    const blob = new Blob([JSON.stringify({ app: "docreader", version: 1, books, notes }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `docreader-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("import-input").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "docreader") throw new Error("not a DocReader export");
      let nn = 0, np = 0;
      for (const n of data.notes || []) { if (!(await get("notes", n.id))) { await put("notes", n); nn++; } }
      // Progress only applies to books already in this library; keep whichever is further along.
      for (const m of data.books || []) {
        const mine = await get("books", m.id);
        if (mine && (m.percent || 0) > (mine.percent || 0)) { mine.cfi = m.cfi; mine.percent = m.percent; await put("books", mine); np++; }
      }
      toast(`Imported ${nn} notes/bookmarks, updated progress on ${np} books. Books themselves must be added separately.`);
      renderShelf();
    } catch (err) { toast("Import failed: " + err.message); }
  };

  // ----- boot -----
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
  applyTheme();
  renderShelf();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
