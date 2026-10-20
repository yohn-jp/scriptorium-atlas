# Q05 browser-process crash recovery

This runner proves that an actual Chromium process crash does not lose committed files or a prepared, durably journaled draft. It launches Chromium itself with a fresh persistent profile under the OS temporary directory, connects Playwright over the process's DevTools port, and only signals the Chromium child it spawned. It reuses the production Host UI and the real Host-origin IndexedDB.

The production Host build selected by `ATLAS_Q05_PROFILE` must be served at the configured URL. The runner supports `atlas`, `story`, and `combined`, and verifies that the root page and every file in `dist/$ATLAS_Q05_PROFILE` exactly match what the URL serves before launching Chromium. From the Host checkout, run:

```sh
ATLAS_HOST_ROOT="$PWD" \
ATLAS_Q05_PROFILE=combined \
ATLAS_Q05_BASE_URL=http://127.0.0.1:44990 \
ATLAS_E2E_CHROMIUM=/path/to/chromium \
pnpm --filter @scriptorium-atlas/persistence test:browser:q05:crash
```

Set `ATLAS_Q05_TMPDIR` only when needed; it must name an existing temporary directory outside both repositories. The runner creates a unique synthetic browser profile there and removes it after the test. It never attaches to a pre-existing browser or profile. The JSON result records the Host origin and commit, persistence commit, browser version, synthetic workspace and operation IDs, and baseline/draft checks. It contains no page recordings or raw logs.

The acceptance sequence commits a baseline file, prepares a replacement and confirms its durable acknowledgement and journal bytes, sends `SIGKILL` to the owned Chromium child, then relaunches that same profile. After restart it checks that the committed baseline and workspace revision remain current, the exact replacement bytes remain in the prepared journal and UI, explicitly approves the recovered proposal through the Host UI, and reloads to verify the final bytes and receipt.
