# Contributing

Open FullScreenshot uses Node 22, has no dependencies, and has no build step for development. Clone the repository and edit the files directly.

Before opening a pull request, run the Node-only checks:

```bash
node tools/validate.mjs
node tools/test-pdf.mjs
node mcp/server.mjs --selftest
```

Changes to capture behavior should also run the Chrome-backed checks:

```bash
node test/e2e.mjs
node test/pipeline.mjs --fixture=long-article
```

Keep each pull request focused on one concern. Explain the user-visible behavior and risks, add or update relevant tests and documentation, and include the commands you ran and their results in the pull request description.
