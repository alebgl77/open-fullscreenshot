# Privacy

FullShot is designed to need nothing beyond the browser tab you point it at.
This document says exactly what is captured, what is stored, and why every
permission it requests exists.

## What is captured

When you trigger a capture (toolbar click, keyboard shortcut, or right-click
menu), FullShot reads the pixels of the current tab — either the visible
viewport, the whole scrollable page, or a region/element you select — plus
the page's `document.title` and `location.href` (used only to name the output
file and to show you which page an image came from). Nothing is captured
outside of an explicit user action.

## What leaves the device

Nothing. FullShot makes zero network requests. There is no server, no API
key, no cloud upload, no update-check beyond what the Chrome Web Store itself
performs for the installed package, and no analytics or crash-reporting
library of any kind. Every step — scrolling, stitching, encoding, editing —
runs inside your browser.

## What is stored, and where

- **Settings** (default action, output format, filename template, etc.) are
  stored with `chrome.storage.local`. This keeps them on the device only —
  `chrome.storage.sync`, which would sync them to a signed-in Google account,
  is never used.
- **Capture results** live only in memory / as a temporary `blob:` URL for
  the duration of the editor tab, and are released when that tab closes.
  Nothing is written to disk unless you explicitly choose to save or download
  the image.

## Permissions requested, and why

| Permission | Why it is needed |
|---|---|
| `activeTab` | Grants temporary access to the tab you're currently on, only when you invoke the extension. This is what lets `tabs.captureVisibleTab` and the on-demand content-script injection work, and it expires the moment you navigate away. FullShot deliberately does **not** request a host permission (e.g. `<all_urls>`), which would let it read every website you visit at any time. |
| `scripting` | Lets the extension inject its capture/selection scripts into the current tab on demand. There are no scripts running automatically in the background on pages you haven't asked FullShot to act on. |
| `storage` | Lets the extension save your settings locally with `chrome.storage.local` (see above). |
| `offscreen` | Lets the extension open a hidden document to stitch captured tiles onto a `<canvas>` and encode the final image — service workers have no DOM/canvas of their own. |
| `contextMenus` | Adds the right-click menu entries (on the page and on the toolbar icon) for starting a capture. |
| `downloads` | Lets the extension save the finished image or PDF to your Downloads folder (or wherever you choose) when you pick "download" as the destination. |
| `clipboardWrite` | Lets the extension copy the finished image to the system clipboard when you choose "copy". |

No `host_permissions` are declared, and the extension does not use
`web_accessible_resources` — nothing inside it is reachable from a web page.

## Questions

FullShot has no support server or telemetry channel by design. If you have a
question, read the source — every file under `src/` is plain, unminified
JavaScript.
