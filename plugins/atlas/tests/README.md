# Atlas browser acceptance

`browser-card-export.mjs` starts the Atlas profile server from a built Host checkout, creates an isolated Playwright browser context and workspace, and verifies that all four card kinds render in the Canvas overlay and appear in PNG/SVG downloads.

Run it with a Host checkout that has `dist/atlas` built and `@playwright/test` installed:

```sh
ATLAS_HOST_ROOT=/path/to/scriptorium-atlas \
ATLAS_E2E_CHROMIUM=/path/to/chromium \
node plugins/atlas/tests/browser-card-export.mjs
```

The test uses a temporary browser context and commits only to that context's IndexedDB. It does not alter the Host build or source tree. The Chromium path can be omitted when Playwright's bundled browser is available. Set `ATLAS_ARTIFACT_HEAD` to record the exact Host build commit in the JSON report; set `ATLAS_EXPORT_ARTIFACT_DIR` to copy the generated PNG and SVG previews to a local directory. The report includes SHA-256 hashes and output dimensions for both exports.
