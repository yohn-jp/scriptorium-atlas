# Q05 browser result

Three persistence acceptance cases passed against the production `story` profile with real Chromium and Host-origin IndexedDB. The browser run used a working tree based on persistence commit `2385d1261e12fe8c814a8c065063118a2a73eadc`; rerun on the final integrated HEAD remains required.

| Case | Result |
| --- | --- |
| Two-tab CAS from one workspace generation | PASS — stale commit rejected, winner bytes retained, losing draft recovered after reload |
| Explicit write transaction abort | PASS — prior source bytes and no-receipt state preserved; prepared draft recovered and committed with the same operation ID |
| COMMIT_UNKNOWN recovery | PASS — unresolved operation ID shown after interruption; retry resolved a durable receipt and preserved exact source text after reload |

Environment: Node `v24.21.0`, Linux `6.18.52` x64, Chromium `155.0.8059.79`. Host commit `b5bd84bc727f379cc057067c4d06a137c025b94b`; production `dist/story` artifact SHA-256 `9dc1265072dacf3d3879c5daad336a06fa98a89594065d5f7d484e549310b086` (25 files, 6,000,582 bytes).

Command: `ATLAS_HOST_ROOT=/home/sophia/src/scriptorium-atlas-host ATLAS_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium node packages/persistence/test/q05-host-browser.mjs`.

During the explicit-abort case, the current Host instance displayed `READ_ONLY` and a commit-outcome error. A page reload reopened IndexedDB writable, restored the prepared draft, and allowed the same operation to commit. The browser run used synthetic test workspaces only and preserved no raw logs or recordings.
