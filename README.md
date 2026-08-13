# Open FullScreenshot

**Résumé (FR) :** Open FullScreenshot est une extension Chrome (Manifest V3) qui capture
une page web entière (défilement + assemblage), la zone visible, ou un
élément/une région choisis à la souris via un seul overlay. L'image obtenue
peut être exportée en PNG, JPEG, WebP ou PDF, retouchée (recadrage,
redaction) dans un éditeur intégré, puis copiée, glissée-déposée ou
téléchargée. L'extension fonctionne entièrement hors ligne : aucune requête
réseau, aucune télémétrie, aucun compte, et ne demande que la permission
`activeTab` (pas d'accès permanent à un site). Les réglages restent en local
sur l'appareil (`chrome.storage.local`). Ce projet est une implémentation
originale, non affiliée à une extension de capture d'écran existante.

---

Full-page screen capture for Chrome, Manifest V3. Original implementation —
not affiliated with, derived from, or endorsed by any other screenshot
extension.

## What it is

Open FullScreenshot captures a browser tab as an image or a PDF: the whole scrollable
page (scroll & stitch), just the visible viewport, or a single element/region
you pick with the mouse — all through one on-page selection overlay. The
result opens in a built-in editor for cropping and redaction, then can be
saved, copied to the clipboard, or dragged out into another app or folder.

## Features

- **Three capture modes, one overlay** — full page, visible area, or
  element/region selection (hover to pick an element, drag to draw a free
  rectangle), reached from the toolbar icon, a keyboard shortcut, or the
  right-click menu.
- **Output formats** — PNG, JPEG, WebP, or PDF (single page sized to the
  image, or sliced across A4/Letter pages).
- **Built-in editor** — crop, and redact with opaque rectangles that are
  rasterized into the image (not just drawn on top, so the covered content is
  actually gone), undo, zoom, pan.
- **Clipboard and drag-out** — copy the result straight to the clipboard, or
  drag the image out of the editor tab into Explorer or another app.
- **Four keyboard shortcuts** — default action, full page, visible area,
  region/element selection (configurable at `chrome://extensions/shortcuts`).
- **Fully offline** — no network requests of any kind, no CDN, no analytics,
  no update-check ping beyond what Chrome itself does for the extension
  package.
- **English and French** — the UI follows Chrome's locale, with a manual
  override in Options.

## Security & privacy posture

- **`activeTab` only** — no `host_permissions`, no `<all_urls>`. The
  extension only gets access to the current tab when you explicitly invoke it
  (toolbar click, keyboard shortcut, or context-menu item), and that access
  expires on navigation. Chrome will never show an install-time warning about
  reading data on all websites, because the extension can't.
- **No network access** — nothing is ever uploaded anywhere. Every step of
  capture, stitching, encoding and editing happens locally in the browser.
- **No telemetry** — no usage tracking, no crash reporting, no analytics
  script of any kind.
- **Local-only settings** — preferences are stored with
  `chrome.storage.local`, never `chrome.storage.sync`, so they never leave
  this machine or sync to a Google account.

See [`docs/PRIVACY.md`](docs/PRIVACY.md) for the full statement, including
exactly why each requested permission is needed.

## How it works

When you trigger a capture, the service worker injects a small content script
into the current tab (on demand — there is no content script running on every
page you visit). For a full-page capture, that script freezes animations and
sticky/fixed elements, scrolls the page in viewport-sized tiles, and reports
back the actual scroll position after each step. The service worker captures
each tile with `chrome.tabs.captureVisibleTab`, hands the frames to a hidden
offscreen document that stitches them onto a canvas at the scale measured
from the first frame, and finally encodes the result to the chosen format.
The page is always restored to its original state before the capture result
is shown, including on cancel (`Escape`) or error.

## Install

See [`docs/INSTALL.md`](docs/INSTALL.md) for the full Windows walkthrough
(load-unpacked, enabling `file://` access, setting keyboard shortcuts, and
building a distributable zip with `node tools/package.mjs`).

## Verify it yourself

Everything runs on Node 22 with zero dependencies, driving your installed Chrome.

```bash
node tools/validate.mjs
```

Static contract: manifest integrity, no network calls, no dynamic code, no
`innerHTML` interpolation, English/French locale parity, and that the manifest
still declares neither host permissions nor web-accessible resources.

```bash
node test/e2e.mjs
```

Boots a real Chrome and runs the content scripts against three fixture pages:
the page plan and tile walk, a byte-identical DOM restore after capture, the
selection overlay under synthetic mouse and keyboard input, and a clean boot of
the editor, popup and options pages.

```bash
node test/pipeline.mjs --fixture=long-article
```

Runs the whole capture engine end to end — pacer, offscreen stitcher and page
driver — with `tabs.captureVisibleTab` wired to genuine DevTools screenshots.
The stitched PNG lands in `test/out/` so you can look at the real output.
`--fixture=inner-scroll` covers apps with an inner scroll container and
`--fixture=wide` covers horizontal tiling; add `--trace` to dump the plan and
the actual scroll offsets, or `--headful` to watch it happen.

Note that Chrome 137 and later removed the `--load-extension` command-line
switch, so no script can side-load the extension; installing it is a manual
step, which is why the harnesses exercise the real source files directly inside
a real page instead.

## Known limitations

- **Chrome-internal and store pages cannot be captured — by any extension.**
  `chrome://`, `chrome-extension://`, `devtools://`, `edge://`,
  `view-source:` pages, and the Chrome Web Store, are off-limits to every
  extension; Chrome enforces this itself. Open FullScreenshot detects this up front and
  shows a clear message instead of failing silently.
- **`file://` pages need one extra toggle.** By default Chrome does not let
  any extension touch local files. Enable "Allow access to file URLs" for
  Open FullScreenshot at `chrome://extensions` if you want to capture local HTML files.
- **Very long pages get downscaled.** Chrome's `<canvas>` has a hard pixel
  ceiling (roughly 268 million pixels of area, and 65 535 px on a side). An
  extremely tall page that would exceed that limit is automatically
  downscaled to fit, and the result is flagged as truncated in the editor
  rather than silently corrupted or refused.

## Non-goals

Video capture, cloud upload, accounts, OCR, and anything requiring
`chrome.debugger` are explicitly out of scope for v1.
