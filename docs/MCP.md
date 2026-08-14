# Open FullScreenshot — MCP server

Give an AI agent — Claude, Gemini, ChatGPT/Codex, Qwen, Cursor, or anything else that speaks
MCP — the ability to take a **full-page screenshot of a web page** in one call, and get back the
absolute path of the saved image.

```
node mcp/server.mjs
```

That is the whole thing. It is a standard **stdio** MCP server: no ports, no daemon, no install
step, no dependencies. It installs nothing on your machine — no registry key, no
native-messaging host, no service, no scheduled task. What it does leave on disk is its output
directory and a Chrome profile of its own (about 100 MB, path below); both are ordinary folders
you can delete at any time.

---

## Read this before you configure anything

Three limitations are structural. They are not bugs and they are not going to be fixed in this
milestone; if you find out about them by surprise, you will rightly feel misled.

**1. Captures use a separate, signed-out Chrome profile — not your everyday browser.**
Chrome 136 and later refuse remote debugging on the default user-data-dir, so this server
launches its own Chrome with its own profile
(`%LOCALAPPDATA%\OpenFullScreenshot\mcp-profile` on Windows,
`~/Library/Application Support/OpenFullScreenshot/mcp-profile` on macOS,
`~/.local/state/open-fullscreenshot/mcp-profile` on Linux).

That profile is signed out of everything. **A page behind a login will capture as the login
wall**, and a page that varies by account will capture as the anonymous version. Your cookies,
your extensions and your open tabs are not involved. It is a real directory that keeps growing
like any browser profile — roughly 100 MB — and nothing here ever deletes it; if you stop using
the server, delete that folder.

**2. It runs the capture engine, not the installed extension.**
The server injects the extension's own engine sources into the page it drives, so the tiling,
sticky-header handling, lazy-image pre-pass, stitching and encoding are exactly the shipped
code. But your saved options and the post-capture editor belong to the extension in your
browser, and are not consulted here. Tool arguments are the only settings.

**3. It captures `http` and `https` only, and writes into one directory only.**
Both are deliberate limits on what an agent can do with this tool, and both are explained under
[What an agent can and cannot do with this](#what-an-agent-can-and-cannot-do-with-this). If you
want local files captured too, you turn that on yourself with `OFS_MCP_ALLOW_FILE=1`.

Everything else works on any public page: long documents, nested scrollers, HiDPI, and sites
with a strict Content-Security-Policy.

---

## Requirements

| | |
|---|---|
| Node | 22 or newer (`node --version`) |
| Chrome | Google Chrome, found automatically; override with `CHROME_PATH` |
| This repository | a complete checkout — the server reads `src/**` for the capture engine |
| Network ports | **none**; CDP travels over an inherited pipe, not `--remote-debugging-port` |

## First run: prove it works before wiring an agent to it

```
node mcp/server.mjs --selftest
```

Runs the protocol against itself — handshake, unknown protocol version, tool schemas,
notifications, unknown methods, malformed JSON, a deliberately fragmented input stream, and the
path handling that keeps a hostile page's title from choosing where a file lands — and prints one
PASS/FAIL line per case. **No Chrome is launched.** Exit code 0 means the server is sound and any
remaining problem is in the client configuration.

*VERIFIED: 27/27 cases pass on Windows 11 + Node 22.23.1.*

Then, from your agent, call the `check_setup` tool. It reports whether Chrome was found, its
version, whether the debugging pipe answers, and where images will be written.

---

## Client configuration

Every snippet below launches the same command. **Replace the path** with the absolute path to
`mcp/server.mjs` in your checkout.

Windows notes that save an hour of debugging:

* Use **forward slashes** in JSON (`C:/Users/you/...`). Node accepts them, and they cannot be
  mangled by JSON escaping. Backslashes must be doubled: `C:\\Users\\you\\...`.
* If the path contains **spaces**, keep it as a single array element (as below). Do not
  hand-build a `cmd /c "node ..."` string unless your client forces you to.
* If your client cannot find `node`, give it the **absolute interpreter path**, e.g.
  `C:/Program Files/nodejs/node.exe` (present on this machine). Some clients do not inherit
  your shell `PATH`.

The marker on each block says whether the *file location and format* were confirmed here.
The server itself is verified end to end (see "What was actually verified" below); what varies
between clients is only where their config lives.

### Claude Code

`UNVERIFIED — command not run on this machine; format per Claude Code documentation.`

The supported way is the CLI, from your project directory:

```
claude mcp add open-fullscreenshot -- node "C:/Users/you/path/to/repo/mcp/server.mjs"
```

Or commit a project-scoped `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "open-fullscreenshot": {
      "command": "node",
      "args": ["C:/Users/you/path/to/repo/mcp/server.mjs"]
    }
  }
}
```

*User-scoped servers live in `~/.claude.json` — that file exists on this machine, but it was
not read or modified.*

### Claude Desktop

`PATH VERIFIED (the file exists on this machine); CONTENT UNVERIFIED (not edited, not tested).`

Settings → Developer → Edit Config, or edit directly:

* Windows: `%APPDATA%\Claude\claude_desktop_config.json`
* macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "open-fullscreenshot": {
      "command": "node",
      "args": ["C:/Users/you/path/to/repo/mcp/server.mjs"]
    }
  }
}
```

Restart the app afterwards. If the server does not appear, replace `"node"` with the absolute
interpreter path — Claude Desktop is launched by the OS, not by your shell.

### Cursor

`DIRECTORY VERIFIED — ~/.cursor exists on this machine; FILE AND FORMAT UNVERIFIED.`

Project scope: `.cursor/mcp.json` in the project root. Global scope: `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "open-fullscreenshot": {
      "command": "node",
      "args": ["C:/Users/you/path/to/repo/mcp/server.mjs"]
    }
  }
}
```

### Gemini CLI

`DIRECTORY VERIFIED — ~/.gemini exists on this machine; FILE AND FORMAT UNVERIFIED.`

`~/.gemini/settings.json` (global) or `.gemini/settings.json` (project):

```json
{
  "mcpServers": {
    "open-fullscreenshot": {
      "command": "node",
      "args": ["C:/Users/you/path/to/repo/mcp/server.mjs"],
      "timeout": 300000
    }
  }
}
```

The tool schemas are deliberately kept to flat objects of strings, numbers, booleans and string
enums, because Gemini's function-calling layer rejects `oneOf`/`anyOf`/`$ref` and nested
schemas. Raise `timeout` if you capture very long pages: a 24 000 px page takes about 9 seconds
here, but a slow site can take much longer.

### OpenAI Codex CLI

`PATH VERIFIED — ~/.codex/config.toml exists on this machine; CONTENT UNVERIFIED (not read, not edited).`

Codex uses **TOML**, not JSON — `~/.codex/config.toml`:

```toml
[mcp_servers.open_fullscreenshot]
command = "node"
args = ["C:/Users/you/path/to/repo/mcp/server.mjs"]
```

TOML table names cannot contain a hyphen without quoting, hence the underscore.

### Qwen Code

`UNVERIFIED — no Qwen Code installation on this machine; format per its documentation, which follows the Gemini CLI layout.`

`~/.qwen/settings.json`:

```json
{
  "mcpServers": {
    "open-fullscreenshot": {
      "command": "node",
      "args": ["C:/Users/you/path/to/repo/mcp/server.mjs"]
    }
  }
}
```

### Any other MCP client

`GENERIC — this is a plain stdio MCP server.`

Tell your client to run the command below and speak MCP over its stdin/stdout. Consult that
client's own documentation for where its configuration file lives; do not trust a path from
this document that is not marked verified.

```
command: node
args:    ["<absolute path>/mcp/server.mjs"]
```

* Transport: **stdio**, newline-delimited JSON (one JSON object per line, UTF-8). Not
  `Content-Length` framing.
* Protocol versions accepted: `2024-11-05`, `2025-03-26`, `2025-06-18`. Any other value is
  answered with the newest supported version rather than an error, so a newer client still
  connects.
* Capabilities: `tools` only.
* stdout carries JSON-RPC and nothing else; all logging goes to stderr.

---

## Tools

All four take flat arguments, and every capture writes a file and returns its **absolute path**
in a text block — the part every client can use, whether or not it can render images.

### `capture_full_page`

The whole scrollable document, scrolled and stitched into one image.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `url` | string, **required** | — | `http` or `https` URL (`file` only with `OFS_MCP_ALLOW_FILE=1`) |
| `format` | `png` \| `jpeg` \| `webp` | `png` | output encoding |
| `quality` | number 0.1–1 | 0.92 | jpeg/webp only |
| `out_dir` | string | the output directory | a path **relative to** the output directory, created if missing; anything outside it is refused |
| `viewport_width` | number 200–5000 | 1280 | decides the responsive layout captured — try 390 for a phone |
| `viewport_height` | number 200–5000 | 900 | affects tiling only |
| `load_wait_ms` | number 0–60000 | 500 | extra wait after `load`; raise for slow SPAs |
| `settle_ms` | number 0–3000 | 0 (auto) | extra wait after each scroll step |
| `return_image` | boolean | `false` | also embed the image as base64 |

### `capture_visible_area`

One screenshot of the viewport, no scrolling. Same arguments minus `settle_ms`.

### `capture_region`

One rectangle, in CSS pixels from the top-left of the **document** (not the viewport). The
region may extend far below the fold — it is scrolled and stitched like a full-page capture.
Same arguments plus required `x`, `y`, `width`, `height` (minimum 4 × 4).

### `check_setup`

Returns a diagnosis, not a dump: Chrome path and version, debugging-pipe latency, output
directory and whether it is writable, engine sources, the `file://` policy, and a `Diagnosis:`
line naming what to fix. **Run this first when a capture fails.**

One optional argument, `out_dir`: check that directory instead of the default, to find out
whether the capture tools would accept it. (It also exists because a tool whose schema declares
*no* properties is rejected by Google's function-calling API — see the compatibility notes.)

### About `return_image`

`false` by default, on purpose. A multi-megabyte base64 blob is refused or silently truncated by
several clients and burns an enormous number of tokens. Even when `true`, an image above
**3 MB** is not embedded: the result degrades to path-only and the text block says so. The file
is always written either way — a 24 000 px page routinely exceeds the ceiling.

---

## Environment variables

| Variable | Effect |
|---|---|
| `CHROME_PATH` | absolute path to the Chrome executable, when auto-detection fails |
| `OFS_MCP_OUT_DIR` | **the one directory captures may be written into**, overriding the OS temp dir. `out_dir` picks subdirectories of it and nothing else |
| `OFS_MCP_ALLOW_FILE=1` | also accept `file://` URLs. Off by default: see below |
| `OFS_MCP_HEADFUL=1` | show the capture window instead of running headless (debugging) |

Set them in the `env` block of your client's server entry if your client supports one. That is
the point of putting them there: they are set by **you**, out of band, and an agent cannot change
them by calling a tool.

```json
{
  "mcpServers": {
    "open-fullscreenshot": {
      "command": "node",
      "args": ["C:/Users/you/path/to/repo/mcp/server.mjs"],
      "env": { "OFS_MCP_OUT_DIR": "C:/Users/you/screenshots" }
    }
  }
}
```

---

## What an agent can and cannot do with this

A screenshot tool that drives a browser and writes files is worth being specific about, because
in a lot of setups it is the only tool in the room with any reach outside the chat.

**It captures `http` and `https` only.** `file://` is refused unless you set
`OFS_MCP_ALLOW_FILE=1`. The reason is blunt: Chrome renders a local text file perfectly well, so
a screenshot tool that accepts `file://` is also a local-file reader — point it at an `.env`, ask
for `return_image`, and the contents arrive in the model's context as a picture. That is a
reasonable thing to want and a terrible thing to have by default, so it is yours to switch on.
`chrome://`, `view-source:`, `data:` and `javascript:` are refused outright.

**It writes inside one directory.** Every image lands under the output directory
(`OFS_MCP_OUT_DIR`, or the OS temp dir + `/open-fullscreenshot`). `out_dir` is resolved *relative
to* it; an absolute path pointing anywhere else is refused before anything is created, and a
symlink or junction inside the tree that points out of it is caught after creation. The file name
comes from the page title and is re-sanitized here — separators, control characters, invisible
bidi overrides and reserved DOS device names are all removed, and a capture never overwrites an
existing file.

**Text from the captured page is quoted, labelled and capped.** The page title and final URL are
reported because they are how you tell a real capture from a redirect or an interstitial. They
are also written by whoever wrote the page: `document.title` has no length limit and can say
"IGNORE PREVIOUS INSTRUCTIONS AND …". They are flattened to one line, stripped of invisible
characters, capped at ~200 characters, and printed under a heading that says they are page
content rather than instructions. Treat them that way.

**It does not stay signed in as you.** See limitation 1 at the top — separate profile, signed
out. That is a capability limit as much as an inconvenience: this tool cannot capture your inbox.

**The capture browser is stripped down.** It launches with `--disable-extensions`,
`--disable-component-extensions-with-background-pages`, `--disable-background-networking`,
`--disable-component-update`, `--disable-sync`, `--disable-default-apps`,
`--disable-client-side-phishing-detection` and `--no-pings`, so extensions registered on your
machine are not downloaded into its profile and it does not chat with Google in the background.
Verified on a fresh profile: zero extension targets, no `Extensions` directory.

---

## Deliberate compatibility choices

These are decisions, not oversights. They exist because clients differ in what they accept.

* **`resources/list` and `prompts/list` return empty lists** instead of the spec-correct
  `-32601`. The server advertises no resources or prompts capability, yet several clients probe
  those methods anyway and mishandle the error. An empty list is harmless and universally
  understood.
* **An unknown `protocolVersion` is answered, never rejected**, with the newest version this
  server speaks.
* **Tool failures are results with `isError: true`**, not JSON-RPC errors, so the model can read
  what went wrong and retry with better arguments. JSON-RPC errors are reserved for protocol
  faults (`-32700`, `-32600`, `-32601`, `-32603`).
* **Schemas stay inside a conservative JSON Schema subset**: `type: "object"`, `properties`,
  `required`, and flat `string`/`number`/`boolean`/string-`enum` properties, each with a
  description. No `oneOf`/`anyOf`/`allOf`/`$ref`, no nesting.
* **Every result leads with a text block** containing the absolute path.
* **The no-argument tool takes an argument.** `check_setup` declares one optional `out_dir`
  rather than the honest `properties: {}`, because Google's function-calling API rejects a
  declaration whose OBJECT parameters are empty — and rejects the *whole* tools payload with it,
  which would make all four tools vanish in Gemini rather than just the one.
* **`arguments` sent as a JSON string is parsed**, not dropped. Spec-compliant clients send an
  object; some function-call→MCP shims send the object's JSON text. Dropping it produces the
  worst possible error message — "url is required" when the model plainly supplied a url.
* **Malformed input never kills the server.** Bad JSON is answered with `-32700` and the process
  keeps running. A request *without* an `id` member is answered with silence; a request carrying
  `id: null` is answered, because JSON-RPC 2.0 defines a notification as a request without the
  member, and a client that stamps a null id on a real call would otherwise wait forever. Any
  `notifications/*` method is silent whatever id it carries.
* **An oversize line costs exactly one `-32700`.** The rest of that line is discarded rather than
  handed on as a second, meaningless message.

---

## Troubleshooting

**"Chrome quit immediately … the capture profile … is almost certainly already in use"**, or
**"Chrome did not answer on the debugging pipe"**
Something else already holds that profile: a Chrome window you opened on it, or — much more
likely — a **second MCP client running this server at the same time**. This is the one failure
the design admits, and it is easy to walk into: follow two of the configuration snippets above
and the second client to start up gets this. Chrome allows one process per user-data-dir, so two
agents cannot share the capture profile. Close the other client, or point the second one at a
different profile by giving it a different `LOCALAPPDATA` (Windows) / `XDG_STATE_HOME` (Linux) in
its `env` block. Recovery needs nothing else: the moment the other server exits, the next capture
works. Within one client, concurrent capture calls are safe — they are queued and run one at a
time.

**"out_dir resolves to … which is outside the output directory"**
By design: this server writes only under its output directory. Pass a relative path
(`"out_dir": "pricing-shots"`), or set `OFS_MCP_OUT_DIR` in your client config to move the whole
tree somewhere you prefer.

**"this server does not capture file:// URLs"**
Also by design; see [What an agent can and cannot do with this](#what-an-agent-can-and-cannot-do-with-this).
Set `OFS_MCP_ALLOW_FILE=1` in the server's `env` block if you want local files captured.

**Everything shows the login wall.** Expected — see the top of this document. The capture
profile is signed out.

**`net::ERR_NAME_NOT_RESOLVED` / `navigation failed`.** The URL never loaded. The message
carries Chrome's own error text.

**The capture is blank or clipped.** Raise `load_wait_ms` (slow app), then `settle_ms`
(scroll-triggered animations).

**The image is huge.** A full page can be 24 000 px tall. Use `capture_region`, a narrower
`viewport_width`, or `format: "jpeg"`.

**The client shows nothing at all / "server disconnected".** Run
`node mcp/server.mjs --selftest`. If it passes, the server is fine and the problem is the
command, the path or the interpreter in your client's configuration.

---

## What this server does *not* do

Worth stating plainly, because a screenshot tool that drives a browser could reasonably be
suspected of more:

* **No network port.** Chrome is driven over `--remote-debugging-pipe`, on inherited file
  descriptors. Nothing listens; no other local process can connect to it.
* **No change to the installed extension.** `manifest.json` is untouched; no permission is
  requested, granted or needed.
* **Nothing installed, and nothing that starts itself.** No registry key, no native-messaging
  host, no service, no scheduled task, no login item. Removing the entry from your client's
  config removes the server. Two ordinary folders are left behind and are yours to delete: the
  output directory, and the Chrome profile named at the top of this document — a normal
  user-data-dir, roughly 100 MB after a few runs, which nothing here ever prunes.
* **No dependencies.** Nothing is downloaded; there is no `package.json` and no `node_modules`.
* **No CSP tampering.** Reading the finished image back out of the page uses the `Blob` the
  stitcher already produced, so the captured site's Content-Security-Policy is left enforced
  rather than switched off with `Page.setBypassCSP` — which is the usual shortcut.
* **Chrome is launched without** `--remote-debugging-port`, `--remote-debugging-address`,
  `--load-extension`, `--enable-unsafe-extension-debugging` or `--allow-file-access-from-files`;
  `mcp/chrome-launch.mjs` refuses to start if any of them is smuggled in, and `--selftest`
  asserts that refusal.
* **No reading of local files** unless you set `OFS_MCP_ALLOW_FILE=1`, and no writing outside the
  output directory at all.

---

## What was actually verified

On this machine — Windows 11, Node 22.23.1, Chrome 151.0.7922.137 — driving the server over
stdio exactly as a client would:

| Check | Result |
|---|---|
| `node mcp/server.mjs --selftest` | 27/27 PASS, exit 0 |
| `check_setup` | full diagnosis, pipe answered in 331 ms |
| `capture_full_page` on `https://example.com` at a 390 px viewport | 390 × 900 px PNG, 17 KB, embedded inline |
| `capture_full_page` on a long MDN page (strict CSP) | 1265 × 24391 px PNG, 3.7 MB, 8.9 s |
| `capture_visible_area`, jpeg, into a relative `out_dir` | written to `<output dir>/agent-shots/…jpg` |
| `capture_region` 600 × 900, webp | exact dimensions |
| `return_image` above the ceiling | degraded to path-only with an explanation |
| invalid URL, `chrome://` URL, unresolvable host, 2 px region | `isError: true`, readable text, server alive |
| `file://` URL with the default config | refused, no image block, opt-in named |
| absolute `out_dir` at `~/ofs-verify-escape` | refused; the directory was **not** created |
| a page whose `<title>` is an injection payload | title quoted, flattened, capped at 200 chars, labelled as page content |
| a second server launched while the first held the profile | `profile_busy`, and `check_setup` names "a SECOND MCP CLIENT running this server" |
| a fresh capture profile, `Target.getTargets` | **0** extension targets, no `Extensions` directory |

Not verified: any actual MCP client's configuration file. No client configuration on this
machine was read or modified. Gemini's rejection of empty `properties` is a documented
constraint of Google's API, not something reproduced here — the hedge costs one optional
argument, so it is applied regardless.
