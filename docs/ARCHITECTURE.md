# FullShot — Architecture & implementation contract

Full-page screen capture for Chrome (Manifest V3). Original implementation; no
third-party extension code, name or branding is reused.

This document is the **contract** between the four independently implemented
subsystems. Anything specified here is binding: message names, payload shapes,
file paths, function signatures. If an implementation needs to deviate, it must
report `BLOCKED` rather than silently changing the interface.

---

## 1. Product goals

| Goal | How it is met |
|---|---|
| Capture a full scrollable page | Scroll & stitch via `tabs.captureVisibleTab` (§5) |
| Capture a region or a single element | One unified on-page overlay (§6) |
| Works offline | Zero network requests, zero remote code, zero CDN, no analytics |
| Works on secure/HTTPS sites | Content scripts run in the isolated world; UI is closed shadow DOM with inline styles, so page CSP never applies to it |
| Minimal clicks | Toolbar click = immediate capture (default action, configurable); 4 keyboard shortcuts; right-click menu on both the page and the toolbar icon |
| Secure by construction | `activeTab` only — **no host permissions**, no `<all_urls>`, nothing readable until the user acts |

### Non-goals (v1)
Video capture, cloud upload, account, OCR, `chrome.debugger`-based capture.

---

## 2. Permission model — do not widen

```
"permissions": ["activeTab","scripting","storage","offscreen","contextMenus","downloads","clipboardWrite"]
"host_permissions": ABSENT — intentionally
```

`activeTab` is granted by any of: toolbar click, keyboard command, context-menu
click. That grant is exactly what `tabs.captureVisibleTab` and
`scripting.executeScript` need, and it expires on navigation. **Adding a host
permission would change the install-time warning to "read all your data on all
websites" and is forbidden.**

Consequences every implementer must respect:

* Never call `chrome.tabs.query` expecting `url`/`title` to be populated in the
  general case. Get page identity from the content script (`document.title`,
  `location.href`), which is always available once injected.
* The content script is injected **on demand** with `chrome.scripting.executeScript`.
  There are no `content_scripts` entries in the manifest.
* `chrome://`, `edge://`, `devtools://`, `view-source:`, the Chrome Web Store and
  other extensions' pages cannot be captured — Chrome blocks it. Detect with
  `FS.isRestrictedUrl(url)` and surface `FS.ERR.RESTRICTED_URL` as a friendly
  message, never a silent failure.
* `file://` pages work only if the user enables "Allow access to file URLs" in
  `chrome://extensions`. Detect the failure and say so.

---

## 3. Loading model — classic scripts, no build step

There is **no bundler, no npm dependency, no ES module** anywhere in `src/`.
Every shared file is a classic script that attaches to `globalThis.FS`:

```js
(function () { const FS = (globalThis.FS = globalThis.FS || {}); /* … */ })();
```

This single style loads identically in all three worlds:

| World | How shared files load |
|---|---|
| Service worker | `importScripts('../shared/protocol.js', …)` at the top of `service-worker.js` |
| Content script | `chrome.scripting.executeScript({ files: ['src/shared/protocol.js', 'src/content/page-driver.js'] })` — files run in order in the same isolated world |
| Extension page | `<script src="../shared/protocol.js"></script>` before the page script |

The service worker is therefore **classic, not `type: "module"`** — the manifest
already reflects this. Do not change it.

Already written and owned by the architect (read them, do not modify):

* `src/shared/protocol.js` — message names, modes, error codes, canvas limits, `isRestrictedUrl`
* `src/shared/settings.js` — `FS.Settings.get/set/reset/onChange`, defaults, validation
* `src/shared/util.js` — filename templating/sanitizing, `dataUrlToBlob`, `fitToBudget`, `t()`, `localizeDocument`

---

## 4. File layout & ownership

```
manifest.json                        architect (done)
icons/icon.svg, icon{16,32,48,128}.png              → task E
src/shared/{protocol,settings,util}.js              architect (done)
src/background/service-worker.js                    → task A
src/background/capture-engine.js                    → task A
src/background/paced-capture.js                     → task A
src/background/offscreen-host.js                    → task A
src/offscreen/offscreen.html                        → task A
src/offscreen/offscreen.js                          → task A
src/content/page-driver.js                          → task B
src/content/select-overlay.js                       → task B
src/editor/editor.{html,css,js}                     → task C
src/lib/pdf.js                                      → task D
src/popup/popup.{html,css,js}                       → task E
src/options/options.{html,css,js}                   → task E
src/shared/theme.css                                → task E   (shared CSS variables)
_locales/en/messages.json, _locales/fr/messages.json → task E
tools/make-icons.mjs, tools/validate.mjs            → task E
README.md, docs/INSTALL.md, docs/PRIVACY.md         → task E
```

A task **must not create or edit files outside its own list.** If task C needs a
CSS variable, it uses the ones declared in §9.1 — `theme.css` is authored by E to
match that table.

---

## 5. Capture engine (task A + task B)

### 5.1 Coordinate spaces

Three spaces, never mixed:

* **Document space** — CSS px, origin at the top-left of the full document.
  `DocRect` in `protocol.js`.
* **Viewport space** — CSS px relative to the current scroll offset.
* **Device space** — the pixels of the stitched image. `DevRect`.

The conversion factor is `scale = capturedImageWidth / plan.windowWidth`,
**measured from the first captured frame**, never assumed from
`devicePixelRatio`. Page zoom, OS scaling and Chrome's rounding all fold into
that one measured number.

`windowWidth` — not `viewportWidth` — is the denominator, because a captured
frame always spans the whole browser window. The two are the same only when the
window itself is the scroller; with a nested scroller `viewportWidth` describes
the container. Getting this wrong scales the entire canvas by the ratio between
them, which is exactly the bug the pipeline harness caught.

For the same reason the plan carries `sourceRect`: the region *inside* the frame
that actually holds scroller content. It is `{0, 0, viewportWidth, viewportHeight}`
for window scrolling, and the container's client box for a nested scroller — so
the app chrome around it (a sidebar, a toolbar) is cropped out instead of being
stitched into every tile.

### 5.2 Sequence

```
user gesture (action click | command | context menu)
  └─ service-worker: resolve tab, guard restricted URL
     ├─ scripting.executeScript([shared/protocol.js, shared/util.js, content/page-driver.js])
     ├─ (SELECT mode) executeScript(content/select-overlay.js) → CS_SELECT → DocRect | cancelled
     ├─ CS_PREPARE  → PagePlan (freezes the page, measures it, builds the tile list)
     ├─ offscreen.ensure() ; OFF_INIT { width, height }
     ├─ for each tile:
     │    CS_GOTO { x, y, index, total, hideFixed }  → actual { x, y }
     │    pacedCapture()                              → dataUrl
     │    OFF_DRAW { dataUrl, sx,sy,sw,sh, dx,dy,dw,dh }
     │    badge + CS_PROGRESS
     ├─ CS_RESTORE  (always, including on error/cancel — use try/finally)
     ├─ OFF_EXPORT { format, quality, crop }          → { url, width, height, byteLength }
     └─ dispatch per settings.afterCapture (§7)
```

Cancellation: the content script listens for `Escape` and sends `BG_CANCEL`. The
engine checks a per-capture `cancelled` flag between every step, then runs the
same `finally` path. Cancel must never leave the page scrolled, frozen or with
elements hidden.

### 5.3 `CS_PREPARE` — what the content script must do

1. **Pick the scroller.** Normally `document.scrollingElement`. If its
   `scrollHeight <= clientHeight + 1` while a descendant has
   `scrollHeight > clientHeight + 32` and covers ≥ 60 % of the viewport, use that
   descendant instead (single-page apps with an inner scroll container). Report
   `scrollsWindow: false` and scroll that element in `CS_GOTO`.
2. **Snapshot** everything that will be mutated: scroll offsets, and nothing else
   (all styling is done through one injected `<style>` element that is simply
   removed on restore).
3. **Freeze** by injecting one `<style id="fullshot-freeze">`:
   ```css
   html { scroll-behavior: auto !important; }
   * { scroll-behavior: auto !important; scroll-snap-type: none !important;
       animation-play-state: paused !important; transition: none !important; }
   [data-fullshot-hidden] { visibility: hidden !important; }
   [data-fullshot-static]  { position: static !important; }
   ```
   Attribute-based hiding, never inline styles: restoring is then a matter of
   removing attributes and the `<style>` node, and the page's own inline styles
   are never clobbered.
4. **Classify fixed/sticky elements once.** Walk the DOM (cap the walk at 20 000
   elements for safety), and for each element whose computed `position` is
   `fixed` or `sticky`, record it plus its viewport rect. Classify:
   * `topAnchored` — `rect.top <= 4`
   * `bottomAnchored` — `rect.bottom >= viewportHeight - 4` and `rect.height < viewportHeight * 0.6`
   * `other` — chat bubbles, centred modals, back-to-top buttons…

   `hideFixed` policy:

   | setting | frame 0 | frames ≥ 1 |
   |---|---|---|
   | `smart` (default) | hide `bottomAnchored` + `other` | hide **all** fixed; `sticky` → `data-fullshot-static` |
   | `always` | hide all | hide all |
   | `never` | hide none | hide none |

   Rationale for `smart`: a sticky header is captured once, at the top, where it
   belongs; a cookie bar or chat widget is never baked into the middle of the
   image. This is the single biggest quality difference in a stitched capture.
5. **Lazy-load pre-pass** when `preScrollForLazy`: set `img[loading="lazy"]` to
   `eager`, then scroll to the bottom in ~0.85 viewport steps waiting ~60 ms per
   step, return to the origin, wait 250 ms. Skip entirely if the document is
   shorter than 1.5 viewports. **Re-run step 4 afterwards**: elements that only
   mount once the page has been scrolled — a back-to-top button, a lazily
   created sticky bar — are invisible to a classification made before this pass.
5b. **Rebase an incoming `options.rect`.** The selection overlay reports in
   window-document space (§6). When a nested element turns out to be the
   scroller, the rectangle is converted into that element's content space here,
   in the one place that knows which scroller was picked. Skipping this captures
   the wrong part of the page on any app with an inner scroll container.
6. **Measure and tile.** `fullWidth/fullHeight` = max of `scrollWidth`,
   `offsetWidth`, `clientWidth` across `documentElement` and `body` (or the
   chosen scroller). Tiles step by `viewportWidth`/`viewportHeight` over
   `area`, row-major, top-to-bottom. Return the `PagePlan` from `protocol.js`.

### 5.4 `CS_GOTO`

Scroll, then **settle**: `requestAnimationFrame` twice, plus `settleMs`
(`settings.settleMs`, `0` meaning auto → 90 ms, raised to 250 ms for the first
tile). Hide the HUD before resolving so it is never captured. Resolve with the
**actual** clamped scroll offsets and the current viewport size (a page can
change size mid-capture; the engine re-clamps against them).

### 5.5 Frame placement (task A)

For a frame whose actual scroll offset is `(ax, ay)` in document CSS px, relative
to the capture `area`:

```
sx = round(sourceRect.x * scale)        // 0 unless a nested element scrolls
sy = round(sourceRect.y * scale)
sw = round(viewportWidth  * scale)      // scrollbar strip dropped
sh = round(viewportHeight * scale)
dx = round((ax - area.x) * scale * outScale)
dy = round((ay - area.y) * scale * outScale)
dw = round(sw * outScale)
dh = round(sh * outScale)
```

`outScale` is `1` for `scaleMode:'device'`, and `1/scale` for `scaleMode:'css'`.
Clip `dw/dh` so the frame never writes past the canvas edge. Later frames
overwrite earlier ones, which is exactly what makes the clamped final tile
harmless.

### 5.6 `paced-capture.js` (task A)

`chrome.tabs.captureVisibleTab` is quota-limited and the exact limit is not
documented per Chrome version. Implement an adaptive pacer, module-level state so it is learned
once per service-worker lifetime:

```js
FS.PacedCapture = {
  /** @returns {Promise<string>} data URL */
  async capture(windowId, options),   // options: { format:'png' }
  reset()
}
```

* Enforce `minInterval` (start 60 ms) between calls.
* On an error matching `/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i`:
  `minInterval = min(1200, minInterval * 1.6 + 40)`, wait `minInterval`, retry.
  Up to 8 retries, then throw `FS.ERR.QUOTA`.
* Treat `/Tab was closed|No tab with id|Cannot access|activeTab/i` as fatal:
  throw immediately with `FS.ERR.CAPTURE_FAILED`.
* Always capture as PNG. JPEG/WebP is applied once, at export, so the stitched
  image is never double-compressed.

### 5.7 Size guard

Before `OFF_INIT`, run `FS.util.fitToBudget(widthDev, heightDev, settings.maxPixels)`.
If `clamped`, multiply `outScale` by the returned `scale`, and set
`truncated: true` on the result so the editor can warn "downscaled to fit
Chrome's canvas limit".

---

## 6. Selection overlay (task B) — `src/content/select-overlay.js`

One mode for both element and region capture. This is the main ergonomics win
over "pick a mode first, then select".

* Injected on demand; renders into a `div` appended to `document.documentElement`
  with `attachShadow({ mode: 'closed' })`. All styling is inline inside the shadow
  root, so no page CSS and no page CSP can affect it. `z-index: 2147483647`.
* **Hover** → the element under the cursor is outlined and its size is shown in a
  small readout. Use `document.elementFromPoint`, skipping the overlay itself.
  Walk up to the nearest ancestor with a non-zero rect if the hit is a text node
  wrapper smaller than 8×8.
* **Click without dragging** (< 5 px movement) → capture that element's rect.
* **Drag** → free rectangle with a dimmed backdrop, live `W × H` readout, and
  8 resize handles once released; `Enter` or a click on the ✓ button confirms.
* **Keyboard**: `Escape` cancels; arrows nudge the selection by 1 px, `Shift`+arrows
  by 10 px; `Enter` confirms; `Space` toggles element/region mode explicitly.
* Auto-scrolls when the pointer is within 40 px of a viewport edge during a drag,
  so a region can exceed the viewport.
* Resolves `CS_SELECT` with `{ rect: DocRect, kind }` in **document space**
  (`rect.x = viewportRect.left + scrollX`), or `{ cancelled: true }` on Escape.
  Reject empty selections (`w < 4 || h < 4`) as `FS.ERR.EMPTY_SELECTION`.
* Removes itself completely on resolve — no leftover node, no leftover listener.

---

## 7. Result dispatch & blob lifetime (task A)

`OFF_EXPORT` returns a `blob:` URL **created by the offscreen document**, so the
offscreen document must outlive its consumer. The service worker owns a
`Map<id, CaptureResult>` and closes the offscreen document only when every
consumer is done, or after a 90 s safety timeout.

| `afterCapture` | Behaviour |
|---|---|
| `editor` (default) | `tabs.create({ url: 'src/editor/editor.html#<id>', index: tab.index + 1 })`. The editor calls `UI_GET_CAPTURE`, `fetch()`es the blob URL into its own `Blob`, then sends `UI_RELEASE_CAPTURE`. |
| `download` | `chrome.downloads.download({ url, filename, saveAs })` straight from the worker; release on `downloads.onChanged` → `state.complete`. |
| `copy` | Clipboard, see below. |
| `download-copy` | Both. |

**Clipboard** must be attempted in this order, because only the first has a real
chance of holding focus:

1. `CS_CLIPBOARD_WRITE` in the captured tab (the tab is focused; the extension
   holds `clipboardWrite`, so `navigator.clipboard.write` is permitted from a
   content script). Payload is a data URL; the content script rebuilds the Blob.
2. `OFF_CLIPBOARD` in the offscreen document.
3. Fall back to opening the editor with a "copy failed, press Ctrl+C" notice.

The badge reports state: `'…'` while capturing (percent when > 4 tiles),
`'✓'` green for 1.5 s on success, `'!'` red on error. Always clear it afterwards.

---

## 8. PDF writer (task D) — `src/lib/pdf.js`

Pure, dependency-free, classic script. Must run in a browser page (the editor).

```js
FS.pdf = {
  /**
   * @param {Blob} imageBlob        image/jpeg or image/png
   * @param {Object} opts
   * @param {number} opts.width     image width in px
   * @param {number} opts.height    image height in px
   * @param {'fit'|'a4'|'letter'} opts.pageSize
   *        'fit' = one page exactly the size of the image at 96 dpi
   *        'a4' / 'letter' = portrait pages, image scaled to the page width and
   *        sliced vertically across as many pages as needed
   * @param {string} [opts.title]
   * @returns {Promise<Blob>} application/pdf
   */
  async fromImage(imageBlob, opts)
}
```

Implementation notes:

* JPEG input embeds directly as `/DCTDecode` — no re-encoding, no quality loss.
* PNG/lossless input: decode to RGB via a canvas, compress with
  `new CompressionStream('deflate')` and embed as `/FlateDecode` with
  `/ColorSpace /DeviceRGB /BitsPerComponent 8`. No external zlib.
* Write a correct `xref` table and `trailer`; byte offsets must be computed over
  the actual encoded bytes (build the file as `Uint8Array` chunks, not as a JS
  string, or you will corrupt offsets on any non-ASCII byte).
* For `a4`/`letter` slicing, each page draws the **same** image XObject with a
  clipped, translated CTM — embed the image once, reference it N times.
* Ship `tools/test-pdf.mjs`: a Node script that stubs the few browser APIs used
  (`CompressionStream` exists in Node 18+; canvas decoding is only needed for the
  PNG path, so the Node test covers the JPEG path plus header/xref validity) and
  asserts the output starts with `%PDF-1.7`, ends with `%%EOF`, and that every
  `xref` offset points at the matching `N 0 obj`.

---

## 9. UI (tasks C and E)

### 9.1 Shared design tokens — `src/shared/theme.css` (task E authors, C consumes)

```
--fs-bg, --fs-bg-elev, --fs-surface, --fs-border,
--fs-text, --fs-text-dim, --fs-accent, --fs-accent-text,
--fs-danger, --fs-ok, --fs-shadow, --fs-radius (10px), --fs-radius-sm (6px)
```

Light values on `:root`; dark values under both `@media (prefers-color-scheme: dark)`
and `:root[data-theme="dark"]`; `:root[data-theme="light"]` forces light. The
`theme` setting sets `data-theme` on `<html>` at page load. System font stack, no
web fonts (offline requirement). Never ship an icon font — inline SVG only.

### 9.2 Popup — `src/popup/` (task E)

Only shown when `settings.defaultAction === 'menu'`, or from the "More…" context
menu item. Four large buttons — Full page / Visible area / Select area / Last
capture settings — each with its keyboard shortcut displayed on the right, plus a
gear opening the options page. Sends `UI_CAPTURE { mode }` and closes itself
immediately (`window.close()`), because the popup stealing focus interferes with
capture.

### 9.3 Editor — `src/editor/` (task C)

Opened as a normal tab at `editor.html#<captureId>`.

* **Header**: editable filename, format `<select>` (PNG / JPEG / WebP / PDF),
  quality slider shown only for JPEG/WebP, primary **Save**, then Copy, and Close.
* **Tool rail**: Crop, Redact (opaque black rectangles — a privacy tool, it must
  rasterize into the image, not overlay it), Undo, Reset, Zoom out / Zoom to fit /
  Zoom 100 %.
* **Canvas**: checkerboard backdrop, wheel to scroll, `Ctrl`+wheel to zoom around
  the cursor, drag to pan, image never blurry at 100 % (`image-rendering: pixelated`
  above 200 % zoom only).
* **Drag-out**: dragging the image sets
  `dataTransfer.setData('DownloadURL', 'image/png:name.png:' + blobUrl)` so it can
  be dropped straight into a folder or another app.
* **Status bar**: `W × H px`, encoded size, source URL (elided, `title` = full URL),
  and a warning chip when `truncated`.
* **Keyboard**: `Ctrl+S` save, `Ctrl+Shift+S` save as, `Ctrl+C` copy, `Ctrl+Z` undo,
  `Esc` cancel the active tool then close, `0` fit, `+`/`-` zoom.
* All editing happens on an in-memory canvas; **the original blob is never
  mutated** so Reset is always exact.

### 9.4 Options — `src/options/` (task E)

Grouped sections mirroring `FS.Settings.DEFAULTS`: Capture / Output / Shortcuts /
Advanced / About. Every control writes through `FS.Settings.set` and reflects
external changes via `FS.Settings.onChange`. The Shortcuts section links to
`chrome://extensions/shortcuts` with a copy-to-clipboard button (Chrome forbids
navigating there directly from an extension page — render it as selectable text
plus a copy button, not an `<a href>`). Include a "Reset to defaults" button and
a live preview of the filename template.

---

## 10. i18n (task E)

`_locales/en/messages.json` is the source of truth; `_locales/fr/messages.json`
must contain exactly the same keys. Naming: `snake_case`, grouped by prefix
(`ext_`, `action_`, `popup_`, `editor_`, `options_`, `err_`, `cmd_`).

Every user-visible string in HTML uses `data-i18n="key"` (text) or
`data-i18n-attr="title:key;aria-label:key2"`, resolved by
`FS.util.localizeDocument()` on `DOMContentLoaded`. Strings inside JS use
`FS.util.t('key')`. **No hard-coded English or French in JS or HTML.**

Keys required by tasks A–D (task E must provide them in both locales):

```
ext_name, ext_description, action_title,
cmd_default, cmd_fullpage, cmd_visible, cmd_region,
menu_capture_fullpage, menu_capture_visible, menu_capture_select, menu_options,
progress_capturing, progress_stitching, progress_encoding,
toast_cancelled, toast_copied, toast_copy_failed, toast_saved,
hud_cancel_hint, hud_title,
select_hint_element, select_hint_region, select_hint_keys,
err_restricted_url, err_no_content_script, err_capture_failed, err_quota,
err_too_large, err_cancelled, err_clipboard, err_empty_selection, err_file_urls,
editor_save, editor_save_as, editor_copy, editor_close, editor_crop,
editor_redact, editor_undo, editor_reset, editor_zoom_in, editor_zoom_out,
editor_zoom_fit, editor_filename, editor_format, editor_quality,
editor_truncated_warning, editor_pdf_page_size, editor_pdf_fit,
editor_pdf_a4, editor_pdf_letter, editor_dimensions, editor_size,
popup_fullpage, popup_visible, popup_select, popup_options,
options_* (one per setting key, plus a _desc variant where a hint is useful)
```

---

## 11. Security & privacy rules (all tasks)

1. **No network.** No `fetch`/`XMLHttpRequest`/`WebSocket` to any http(s) URL, no
   `<link>`/`<script>`/`<img>` pointing off-extension, no web fonts, no analytics.
   `fetch()` of a `blob:` or `data:` URL is fine. `tools/validate.mjs` enforces this.
2. **No dynamic code.** No `eval`, no `new Function`, no `setTimeout('string')`,
   no `innerHTML` with anything derived from page content. Build DOM with
   `createElement`/`textContent`. The one allowed `innerHTML` use is a
   hard-coded, literal template string containing no interpolation.
3. **Treat page data as hostile.** `document.title`, `location.href`, element text
   and attributes all come from the page. Sanitize before use in a filename
   (`FS.util.sanitizeFilename`), and never inject them as HTML.
4. **Least privilege.** Do not add permissions. Do not add
   `web_accessible_resources` — nothing in `src/` needs to be reachable from a
   web page.
5. **Fail closed and loudly.** Every failure path ends in a localized message and
   a restored page. No `catch {}` that swallows.
6. Settings live in `chrome.storage.local`, never `sync`: they stay on the device.

---

## 12. Verification

Google Chrome 137+ removed the `--load-extension` switch entirely — a stable
Chrome logs `--load-extension is not allowed in Google Chrome, ignoring` and
carries on without it, so **no automation can side-load this extension**.
Loading it by hand from `chrome://extensions` still works and is what
`docs/INSTALL.md` describes.

The harnesses therefore run the real source files directly inside a real page,
with only the `chrome.*` APIs stubbed:

| Command | What it proves |
|---|---|
| `node tools/validate.mjs` | The static contract below. |
| `node tools/test-pdf.mjs` | The PDF writer's structure: xref offsets, page slicing, single embedded image. |
| `node test/e2e.mjs` | `page-driver.js` against three fixtures (plan, tile walk, byte-identical DOM restore), `select-overlay.js` under synthetic input, and that the editor, popup and options pages boot and localize. |
| `node test/pipeline.mjs [--fixture=…] [--trace]` | The **whole engine** end to end — pacer, offscreen stitcher and driver in one page, with `tabs.captureVisibleTab` wired through CDP to genuine screenshots. Writes the stitched PNG to `test/out/` for inspection. |

`tools/validate.mjs` checks:

manifest parses and every path it references exists; every `src/**/*.html`
references only local files; no forbidden network/dynamic-code patterns;
`_locales/fr` has exactly the key set of `_locales/en`; every `data-i18n*` key in
HTML exists in `_locales/en`; every `FS.MSG.X` referenced anywhere is declared in
`protocol.js`; and the manifest declares neither `host_permissions` nor
`web_accessible_resources`.

Manual smoke matrix (documented in `docs/INSTALL.md`): a long article, an
infinite-scroll feed, a page with a sticky header + cookie banner, a page with an
inner scroll container, a horizontally wide page, a HiDPI display, a `file://`
page, and a restricted `chrome://` page (must show a clean error).
