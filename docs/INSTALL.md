# Install (Windows 11)

Open FullScreenshot is not built or bundled — Chrome loads `src/` and `manifest.json`
directly. There is nothing to `npm install`.

## 1. Load the extension unpacked

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. In the file picker, select the project's root folder — the one that
   directly contains `manifest.json` (e.g.
   `C:\Users\<you>\Documents\AI\Claudius\Chrome extension gofullpage screencapture`).
5. Open FullScreenshot should appear in the extensions list and its icon should show up
   in the toolbar (click the puzzle-piece icon and pin it if it doesn't).

Whenever you edit any file under `src/`, go back to `chrome://extensions` and
click the reload icon on the Open FullScreenshot card to pick up the changes.

## 2. Allow access to `file://` pages (optional)

By default no extension can read local files. To let Open FullScreenshot capture pages
opened with `file:///...`:

1. Go to `chrome://extensions`.
2. Find Open FullScreenshot and click **Details**.
3. Turn on **Allow access to file URLs**.

Without this toggle, Open FullScreenshot will show a clear "file URLs not allowed"
message instead of failing silently on a `file://` page.

## 3. Set keyboard shortcuts

Chrome does not let an extension page link directly to its shortcuts screen,
so:

1. Open a new tab and go to `chrome://extensions/shortcuts` (type or paste
   this — it can't be clicked from inside the extension).
2. Find the **Open FullScreenshot** section and set/change any of the six
   commands. The first four arrive with a suggested binding:
   - Default action (opens the mode chooser or the configured default mode) — `Alt+Shift+P`
   - Capture full page — `Alt+Shift+F`
   - Capture visible area — `Alt+Shift+V`
   - Capture region/element (selection overlay) — `Alt+Shift+R`

   The last two arrive with **no** binding, and stay inert until you give them
   one here:
   - Capture the full page and copy it to the clipboard
   - Select an area and copy it to the clipboard

   That is not an oversight: Chrome honours `suggested_key` for at most four
   commands per extension, and the four above spend the budget. A fifth
   suggested key would be accepted by the manifest and bind nothing, which is
   why these two ask you instead. Both skip the editor and put the image
   straight on the clipboard, for that capture only — no setting changes.
3. Chrome shows a red warning if a combination is already used elsewhere in
   the browser — pick a different one in that case.

If you would rather bind nothing, hold `Shift` while clicking a capture button
in the extension's popup: same one-capture override, same clipboard result.

## 4. Build a distributable zip

Once `tools/validate.mjs` passes (see below), build the package Chrome or the
Web Store would consume:

```powershell
node tools/package.mjs
```

This writes `dist/open-fullscreenshot-<version>.zip`, containing exactly
`manifest.json`, `icons/`, `src/` and `_locales/` — no docs, no tooling, no
`.git`. `tools/package.mjs` refuses to write a zip if `tools/validate.mjs`
reports any failure.

To only run the checks without packaging:

```powershell
node tools/validate.mjs
```

To (re)generate the toolbar icons from `icons/icon.svg`:

```powershell
node tools/make-icons.mjs
```

## 5. Manual smoke-test checklist

Run these once after loading the extension, and again after any change to
the capture engine, the content scripts, or the offscreen stitcher. Each item
should produce a clean image with no console errors, no leftover scroll
position, and no elements left hidden on the page afterwards.

- [ ] A long article page — full-page capture stitches cleanly top to bottom.
- [ ] An infinite-scroll feed — full-page capture with "pre-scroll for lazy
      images" enabled loads content before capturing, and stops at a sane
      point rather than scrolling forever.
- [ ] A page with a sticky header **and** a cookie/consent banner — the
      `smart` fixed-element policy keeps the header once at the top and hides
      the banner from every tile instead of it appearing mid-page.
- [ ] A page with an inner scroll container (a single-page app where
      `document.scrollingElement` doesn't scroll) — the engine detects and
      scrolls the inner container instead.
- [ ] A horizontally wide page (wider than the viewport) — captured without
      cropping content off the right edge.
- [ ] A HiDPI / scaled display — the stitched image is sharp, not blurry or
      mis-scaled, in both `device` and `css` scale modes.
- [ ] A `file://` page, with and without "Allow access to file URLs" enabled
      — capture works when enabled, and shows a clear error when it isn't.
- [ ] A restricted page (`chrome://extensions`, `chrome://settings`, or the
      Chrome Web Store) — Open FullScreenshot shows a friendly "can't capture this page"
      message instead of a silent failure or a raw error.
- [ ] Escape during a full-page capture cancels cleanly: the page is
      restored, no elements stay hidden, and no toast/HUD is left behind.
- [ ] Each of PNG / JPEG / WebP / PDF export opens correctly in another
      viewer after saving.
- [ ] Copy to clipboard, then paste into another app, on both a normal page
      and (if a workaround is shown) after a clipboard failure.
- [ ] Dragging the image out of the editor into a file-explorer window
      creates a valid image file.
- [ ] Switching the UI language between English and French (Options) updates
      every visible string, with no leftover raw `__MSG_...__`/key text.
