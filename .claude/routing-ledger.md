# Routing ledger — FullShot (Chrome MV3 full-page capture)

One row per dispatched task. Written by the main thread only.

## Rows

| # | Class | Tier | Agent | Outcome | Notes |
|---|---|---|---|---|---|
| 1 | MV3 background capture engine (SW, quota pacing, offscreen stitcher) | T2 | heavy-executor | PASS | 6 files, 1452 lines. Own stub-harness: 198 checks. Two contract deviations proposed and accepted (`OFF_INIT` after frame 0; offscreen.html loads 3 scripts). |
| 2 | Content scripts (page driver + selection overlay) | T2 | heavy-executor | PASS w/ 2 defects | 1606 lines. Stub-DOM harness passed 170 checks but **missed both real defects** — see distilled pattern D1. |
| 3 | Dependency-free PDF writer + Node self-test | T1 | executor | PASS | Clean first pass. Structural assertions (xref offsets, page slicing, single XObject) held on re-verification. |
| 4 | Editor page (crop, redact, zoom, drag-out, save) | T1 | executor | PASS w/ 1 nit | 1268 lines. Invented 3 i18n keys outside §10 — correctly flagged rather than silently added; main thread added them to both locales. |
| 5 | Popup + options + theme tokens + i18n catalogue | T1 | executor | PASS | 140 keys × 2 locales, exact parity first try. |
| 6 | Icons, static validator, ZIP packager, docs | T1 | executor | PASS | Validator found 5 real issues across other tasks' files and reported instead of touching them — the ownership rule worked. |

## Verification performed by the main thread

`tools/validate.mjs` 33/33 · `tools/test-pdf.mjs` 3/3 · `test/e2e.mjs` 40/40 ·
`test/pipeline.mjs` 14/14 on each of 3 fixtures, plus visual inspection of every
stitched PNG.

## Defects the VERIFY step caught (none were caught by the agents)

1. **Overlay took zero mouse input.** Listeners sat on the shadow root, but the
   backdrop's hit target was the *host* element, which is outside the shadow
   tree, so the event path never included the root. Fixed with a transparent
   full-viewport catcher appended first inside the shadow root.
2. **Nested scrollers stitched at the wrong scale and included app chrome.**
   `scale` was derived from the container's width while the captured frame spans
   the whole window (observed factor 1.2366 instead of 1.0), and the source was
   never cropped to the container. Fixed by adding `windowWidth`, `windowHeight`
   and `sourceRect` to the PagePlan contract.
3. Dead `soundOnDone` setting shipped a toggle that did nothing — removed.
4. Two i18n keys used in HTML existed in neither locale; a `fetch()` and two URL
   literals tripped the security validator.

## Distilled patterns

**D1 — A stub DOM does not verify DOM code.** Both content-script defects were
invisible to a hand-written stub DOM that passed 170 assertions, because a stub
dispatches events where the author *expects* them and reproduces no hit-testing,
no shadow-tree retargeting and no layout. For anything touching real layout,
events or coordinates, require verification in a real browser; a stub harness is
a unit test, never the acceptance gate.

**D2 — Measure the conversion factor against the thing that was actually
measured.** The scale bug came from dividing a whole-window screenshot by a
container's width. When two coordinate spaces coincide in the common case
(window scrolling) and diverge in the rare one (nested scroller), the divergent
case must be represented explicitly in the contract, not derived.

**D3 — Parallel dispatch works when the contract is written first.** Six agents,
~5 800 lines, zero merge conflicts and zero interface drift: every deviation was
reported rather than improvised. The cost is entirely front-loaded into writing
`docs/ARCHITECTURE.md` and the shared files before any dispatch.

**D4 — Give each agent an exclusive file list.** Task 6's validator found real
problems in three other tasks' files and reported them instead of fixing them,
which kept the diffs clean and surfaced the issues to the orchestrator.

## Routing priors for this repo

- Chrome-extension UI pages (popup/options/editor) from a precise spec → **T1**.
- Pure, testable algorithms with a written spec (PDF writer, validators) → **T1**.
- Anything involving live DOM geometry, event hit-testing or coordinate spaces →
  **T2**, and budget main-thread time for real-browser verification regardless
  of what the agent's own tests report.
