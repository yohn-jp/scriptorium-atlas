# Atlas browser acceptance

`browser-card-export.mjs` starts the Atlas profile server from a built Host checkout, creates an isolated Playwright browser context and workspace, and verifies that all four card kinds render in the Canvas overlay and appear in PNG/SVG downloads.

Run it with a Host checkout that has `dist/atlas` built and `@playwright/test` installed:

```sh
ATLAS_HOST_ROOT=/path/to/scriptorium-atlas \
ATLAS_E2E_CHROMIUM=/path/to/chromium \
node plugins/atlas/tests/browser-card-export.mjs
```

The test uses a temporary browser context and commits only to that context's IndexedDB. It does not alter the Host build or source tree. The Chromium path can be omitted when Playwright's bundled browser is available. Set `ATLAS_ARTIFACT_HEAD` to record the exact Host build commit in the JSON report; set `ATLAS_EXPORT_ARTIFACT_DIR` to copy the generated PNG and SVG previews to a local directory. The report includes SHA-256 hashes and output dimensions for both exports.

`browser-graph-history.mjs` uses the same environment variables to verify prompt-free manual-node creation, visible ReactFlow nodes, inspector rename, duplicate, undo/redo, Host commit, and reload persistence:

```sh
ATLAS_HOST_ROOT=/path/to/scriptorium-atlas \
ATLAS_E2E_CHROMIUM=/path/to/chromium \
ATLAS_ARTIFACT_HEAD=<built-host-commit> \
node plugins/atlas/tests/browser-graph-history.mjs
```

`browser-structured-views.mjs` exercises Kanban lane and card ordering, assignment, explicit timeline axis confirmation/cancellation with unknown values, storyboard ordering, Host commit, and reload persistence using an imported board fixture.

`browser-card-keyboard.mjs` verifies that Tab can select two existing Canvas cards after reload, arrow keys move and resize them, and Host commit/reload preserves their geometry:

```sh
ATLAS_HOST_ROOT=/path/to/scriptorium-atlas \
ATLAS_E2E_CHROMIUM=/path/to/chromium \
ATLAS_ARTIFACT_HEAD=<built-host-commit> \
node plugins/atlas/tests/browser-card-keyboard.mjs
```

`browser-graph-interactions.mjs` uses `ATLAS_PROFILE=combined` and exercises real Story-provider search/navigation, provider node selection and grouping, physical group drag and pin persistence, keyboard edge CRUD, MiniMap navigation, viewport/layout persistence, multiple boards, and Host reload. It records an artifact commit in its report; run it against the combined Host profile:

```sh
ATLAS_PROFILE=combined \
ATLAS_HOST_ROOT=/path/to/scriptorium-atlas \
ATLAS_E2E_CHROMIUM=/path/to/chromium \
ATLAS_ARTIFACT_HEAD=<built-host-commit> \
node plugins/atlas/tests/browser-graph-interactions.mjs
```
