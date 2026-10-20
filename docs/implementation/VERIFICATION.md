# Standalone V1 verification ledger

F01–F31 remain implemented and required; Q01–Q15 retain their original contracts and budgets. Current implementation checks ran on the fully verified implementation/test snapshot `64c9d6a858dc16fa5dbc5dac39936ccbb001db70`. Historical and explicitly carried-forward evidence retains its recorded revision. The subsequent delivery commit changes documentation/evidence only; its identity and exact-HEAD reconfirmation will be published after validation in [PR #1](https://github.com/yohn-jp/scriptorium-atlas/pull/1). The commit does not embed its own SHA.

The [compact evidence manifest](evidence/standalone-v1.json) retains environment, artifact/report hashes, counts, measured summaries and historical failures. No production Scriptorium SDK or Git integration is claimed. Raw logs/datasets remain outside Git.

## Environment and artifact identity

Node 24.21.0; pnpm 12.10.1; Linux 6.18.52 x86_64; 16 logical CPUs; 50,994,450,432 bytes RAM. Chromium 155.0.8059.79, headless 1440×1000. This matches the gate's approximate machine class; RAM is approximately 47.5 GiB rather than the 32 GiB minimum. Browser tests use the real production builds, separate-origin Plugin frames and real IndexedDB. Inputs are generated synthetic data.

| Profile | Files / bytes | SHA-256 |
| --- | --- | --- |
| atlas | 743 / 63,567,382 | `e76e75153e90d57cbe70c90363a5ae8be3772174a5a55c0276c86093a1b400ff` |
| story | 25 / 6,041,280 | `8c827488c541bae78a03aa819316ecfc5a6a52686a24e08509916e0fbfbf798d` |
| combined | 752 / 65,151,861 | `916848a71922788c82098452e441e17f13efc96b6fca0e73482f6e6364e0bf4e` |

Hash method: `scripts/verification/artifact-evidence.mjs` hashes sorted POSIX-relative file paths, NUL, byte length, NUL and file bytes. An older Q05 runner digest uses a different encoding; its summary names both methods and verifies every served file byte. These digests are not interchangeable.

## Gate verdicts for snapshot 64c9d6a

| Gate | Status | Observed evidence |
| --- | --- | --- |
| Q01 | PASS | Three production builds, profile serving/operations, exclusion closure; Story artifact excludes Atlas/Excalidraw |
| Q02 | PASS | Host browser acceptance: atlas 10, story 6, combined 10 cases; empty Workspace creation/edit/list/detail/reopen with exact source bytes |
| Q03 | PASS | Valid Bundle/Board/Excalidraw roundtrips; hostile ZIP/hash/version/path/duplicate/bomb refusal preserves existing Workspace; maximum-count unit roundtrip |
| Q04 | PASS | Graph/Canvas/Story exact IDs, positions and bytes across explicit Host author review, durable multi-file commits and reload |
| Q05 | PASS | Real IDB two-tab race, transaction abort, COMMIT_UNKNOWN (3 cases); quota/denial/journal recovery; owned Chromium SIGKILL and exact receipt recovery; frame/Worker faults |
| Q06 | PASS | Contract/Graph/Provider unit coverage; real pagination, scopes, same-local-ID identities, partial/missing, deltas/resync, leases; corrected grant refresh 4/4 |
| Q07 | PASS | Graph interaction 17/17, history 7/7, structured views 7/7, provider refresh 6/6, Freeform viewport 6/6; physical drag, keyboard, pin/group/path/layout/filter/viewport persistence |
| Q08 | PASS | Dedicated Story acceptance 18/18 Story-only and 19/19 combined; 12 domain CRUD/search, relations, appearance/POV/location/hierarchy/thread/time, source/diagnostic, same-source revision |
| Q09 | PASS | Native Canvas operations and keyboard suites; Cards/export 11/11 and keyboard 3/3; shape/freehand/text/image/arrow/group, PNG/SVG/Board/scene/Bundle roundtrips and unknown preservation |
| Q10 | PASS | Malformed/duplicate/dangling/cross-scope/grant refusal with healthy data retained; 14 real-browser SVG CSP inputs and ZIP validation |
| Q11 | PASS | Nine malformed/stale/exception/rejection frame faults; timeout/hang/cancel-ignore/Worker crash and independent recovery; Host draft remains usable |
| Q12 | PASS | All five canonical serialized scenarios PASS, exit 0, no NOT_CHECKED; native resize observability and exact persistence assertions retained |
| Q13 | PASS | Host IME/mobile/theme cases plus Atlas/Card/Canvas keyboard tests, focus movement, native history and saved view state; 390px and desktop |
| Q14 | PASS | Three closure/lazy/legal audits; 8 isolated pnpm archives, 25 public Node exports, 4 browser entries and a real editable Canvas/export consumer; Worker release verified |
| Q15 | PASS (64c9 snapshot) | Fully verified implementation/test snapshot. The final delivery verdict comes from the exact-HEAD confirmation linked in PR after validation. |

Delivery Q15 remains NOT_CHECKED until the exact-HEAD report linked from PR is published; that report supplies the delivery verdict without embedding a commit’s SHA inside itself. The table above certifies the recorded snapshot.

Frozen install, strict typecheck and unit suite passed: 157 tests, zero failures, one explicit optional ZIP-file generation skip. The ordinary maximum-count Export/Import test runs in this suite. The separately executed Python 3.13.15 oracle passed on the unchanged ZIP implementation: 100,000 total entries, 99,999 manifest payloads, all payload hashes/workspace revision/CRCs, nonempty tail. Archive size 14,682,752 bytes; SHA-256 `b6f577a073a19b215bc4769828eec3b9d6665863894d9941ae82b4073dc0226b`. Its source equality/carry-forward is explicit in the storage summary.

Workspace caps remain 100,000 files / 256 MiB. Import and Export reserve one manifest entry and count its actual serialized bytes inside those caps; ZIP metadata/compressed archive size are checked separately. A legacy oversized Workspace fails explicitly without deletion/truncation and retains original bytes and revisions.

## Q12 product measurements

Canonical five-case run on `64c9d6a858dc16fa5dbc5dac39936ccbb001db70`: five PASS, exit 0, no NOT_CHECKED. Report SHA-256 `02cb1270e71b8174b048816a1ea39cfa151e1953265ef3f3f9a0c3c57d555abe`; stdout `8a0fd9416a640e59f73833a0d571aa29bafa8c591aa9c35e768509526f7e19e8`. Other browser/build/unit jobs were stopped during measurement.

| Assertion | Actual | Unchanged limit |
| --- | --- | --- |
| 1k cold first visible, 5 cache-cleared samples | p95 1957.05 ms | 3,000 ms |
| 1k warmed Japanese/tag/type search, 30 each | p95 7.10 ms | 100 ms |
| 1k Force, 1,000 finite positions | 874.40 ms | 2,000 ms |
| Trusted in-flight Force cancel, matched request/no stale response | 1.20 ms | 500 ms |
| 10k/20k index | 282.70 ms | 10,000 ms |
| 10k warmed search, 30 each | p95 11.90 ms | 250 ms |
| 10k neighbors depths 1/2/3, 30 each / five-hop paths, 30 | p95 12.00 / 2.70 ms | 500 ms |
| Freeform 100 / 500 actual objects | drag p50 59.88 / 59.88 fps, pan same; Long Task observer supported | ≥30 fps; no sustained >50ms tasks |
| Disable Atlas, 5 seconds | Workers 0, Plugin-origin requests 0 | 0 / 0 |
| 500-object Commit/reload | exact scene/Board/viewport/manifest/inventory; explicit author-approved receipts | zero lost/mismatched saved data |

Cold timings include JS/CSS transfer; the manifest records each sample/download summary separately, never subtracting transfer time. Heap is Chromium `performance.memory`, approximate/shared renderer JS heap, not isolated Plugin/Worker heap or process RSS. Disable heavy-code inactivity follows frame destruction plus closure/Worker/network evidence; no direct import-hook count is claimed.

Native ResizeObserver events before disable: 0. During the 1001ms enabled idle, metrics changed 0→0; interval delta 0. Visible counter before/after: `{"present": false, "visible": false, "count": null, "text": null, "updatedAt": null}` / `{"present": false, "visible": false, "count": null, "text": null, "updatedAt": null}`; counter delta `null`. Post-disable 5s notification delta: 0. Absent counters are not reported as measured zero deltas. Host and Graph usability were checked around the enabled idle; Host retained its Workspace after disable.

## Exact reproduction commands

Runner invocations below reproduce the recorded runs from `/data/atlas-v1-verification` unless the command supplies another cwd. Directory creation and `pipefail` are setup steps to preserve output and shell exit status; recorded exact runner invocations remain in the manifest. Use Node 24 and pinned pnpm, and point Chromium at an installed executable on other systems. Runner-specific exact invocations/report hashes are retained in the evidence manifest and owner summaries.

```sh
export TMPDIR=/data/atlas-v1-verification-tmp
export ATLAS_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium
pnpm install --frozen-lockfile --store-dir /data/atlas-v1-pnpm-store
pnpm typecheck
pnpm test
pnpm --filter @scriptorium-atlas/standalone build:atlas
pnpm --filter @scriptorium-atlas/standalone build:story
pnpm --filter @scriptorium-atlas/standalone build:combined
node scripts/verification/check-profile-closures.mjs
node scripts/verification/check-pack-consumer.mjs
ATLAS_E2E_REPORT=/data/atlas-v1-verification-tmp/candidate-64c9d6a/host.json node scripts/verification/run-browser-e2e.mjs
ATLAS_HOST_ROOT=/data/atlas-v1-verification ATLAS_E2E_PROFILE=story node plugins/story-knowledge/tests/browser-acceptance.mjs
ATLAS_HOST_ROOT=/data/atlas-v1-verification ATLAS_E2E_PROFILE=combined node plugins/story-knowledge/tests/browser-acceptance.mjs
```

Start `ATLAS_HOST_PORT=44960 node apps/standalone/scripts/serve.mjs combined` for fault/crash checks; the following two ports belong to Plugin origins. Browser suites also start and release isolated static servers themselves.

```sh
ATLAS_FAULT_BASE_URL=http://127.0.0.1:44960 ATLAS_FAULT_PROFILE=combined node apps/standalone/test/frame-recovery.mjs
ATLAS_FAULT_BASE_URL=http://127.0.0.1:44960 ATLAS_FAULT_PROFILE=combined node apps/standalone/test/provider-fault-browser.mjs
ATLAS_Q05_REPORT=/data/atlas-v1-verification-tmp/candidate-64c9d6a/storage/q05-host.json ATLAS_HOST_ROOT=/data/atlas-v1-verification node packages/persistence/test/q05-host-browser.mjs
ATLAS_Q05_PROFILE=combined ATLAS_Q05_BASE_URL=http://127.0.0.1:44960 ATLAS_Q05_TMPDIR=/data/atlas-v1-verification-tmp node packages/persistence/test/q05-browser-crash.mjs
ATLAS_SVG_MODULE=/data/atlas-v1-verification/packages/persistence/dist/svg.js pnpm --dir packages/persistence exec playwright test --config test/playwright.config.ts test/svg.browser.ts
ATLAS_HOST_ROOT=/data/atlas-v1-verification node packages/canvas/test/browser-operations.mjs
ATLAS_HOST_ROOT=/data/atlas-v1-verification node packages/canvas/test/browser-keyboard-controls.mjs
```

Atlas exact invocations are recorded per suite in the evidence manifest. Use `ATLAS_HOST_ROOT=/data/atlas-v1-verification ATLAS_ARTIFACT_HEAD=$(git rev-parse HEAD) ATLAS_PROFILE=atlas` with `graph-history`, `structured-views`, `card-keyboard`, `card-export`, `freeform-viewport`; use `ATLAS_PROFILE=combined` with `graph-interactions`, `provider-refresh`, `grant-refresh`. The command is `node plugins/atlas/tests/browser-<suite>.mjs`. Canvas native suites use Atlas-only. The separate ZIP64 oracle commands (cwd `packages/persistence`) were `ATLAS_BUNDLE_OUTPUT=/data/atlas-v1-verification-tmp/max-cap.zip pnpm exec vitest run test/zip64-interoperability.test.ts` and `python3 test/zip64_interoperability.py /data/atlas-v1-verification-tmp/max-cap.zip`.

Canonical serialized performance reproduction (the recorded invocation is also retained in the manifest):

```sh
set -o pipefail
mkdir -p /data/atlas-v1-verification-tmp/candidate-64c9d6a
TMPDIR=/data/atlas-v1-verification-tmp ATLAS_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium ATLAS_PERF_REPORT=/data/atlas-v1-verification-tmp/candidate-64c9d6a/q12.json node scripts/verification/run-performance-e2e.mjs 2>&1 | tee /data/atlas-v1-verification-tmp/candidate-64c9d6a/q12.stdout
```

## Retained failures and practical limits

Earlier runs remain failures in their reports. The c639 delivery run failed because FrameBoundary treated a browser-native ResizeObserver deferred-delivery notice as a fatal exception. A bounded diagnostic localized it to official React Flow node measurement with stable CSS dimensions; no recurring size feedback was established. The [Resize Observer spec](https://drafts.csswg.org/resize-observer/#deliver-resize-loop-error) defines this ErrorEvent. The corrected classifier requires the exact trusted/no-exception/zero-location/document-source shape, leaves event/console visibility intact, counts every notice, and preserves the editor. Actual same-message exceptions, synthetic notices and rejections remain fatal and recoverable. Two sequential native notices and nine genuine/protocol faults passed the real browser regression. This changes classification, not the library's resize algorithm.

 Graph rendering feedback, cancellation generation handling, native Canvas hit-test offsets and Freeform camera persistence required production corrections. A later Graph timeout did not reproduce under trusted-pointer diagnostics; the final test explicitly verifies the intended selected ID before neighbor queries. Grant pagination now asserts the two actual paginated traversals rather than an incidental fifth request. Q12 readiness failures (0.375px clipping and pre-measurement root movement) are retained; final preparation centers/hit-tests the true target and waits for stable geometry/status. Counts, measured gestures, original budgets and exact persistence assertions were not relaxed. Focused passes were not substituted for the final canonical five-case run.

Only Host-acknowledged journals/commits establish durability. Unacknowledged transient UI edits can be lost on a forced browser failure. Prepared changes require explicit author approval; tests drain successive proposals until current bytes are durably committed. This Standalone Host does not implement Scriptorium Core's production Git/Recovery/authorization ownership.

Official font sources list CDN fallbacks; CSP blocks those attempts. Bundled same-origin fonts return 200, render locally and are embedded in SVG. Do not interpret blocked fallbacks as successful external fetches. The exact upstream OFL text intentionally retains a trailing space at `packages/canvas/scripts/licenses/OFL-1.1.txt:13`; full `git diff --check` reports it. The diff check excluding that verbatim license passes. No source whitespace exception or license-text modification is introduced.

## F01–F31 evidence map

Every feature remains required and maps to the passing gates above.

| Feature | Verified evidence surface | Required gates |
| --- | --- | --- |
| F01 | Standalone profile composition and closure verifier | Q01/Q14 |
| F02 | Host Workspace UI and real Host storage browser suite | Q02/Q03 |
| F03 | Persistence bundle/ZIP validation and rejected-import preservation | Q03/Q10 |
| F04 | IndexedDB journal/CAS/receipts and Q05 browser runner | Q04/Q05 |
| F05 | Static metadata, Host lease broker, Story public Provider | Q06/Q11 |
| F06 | Graph identities and Host Provider scope checks | Q06 |
| F07 | Story incremental indexes/diffs and Graph delta resync | Q06/Q12 |
| F08 | React Flow UI, selection/Inspector/manual placement | Q07/Q13 |
| F09 | Graph search/filter/reveal and Worker index | Q07/Q12 |
| F10 | Worker neighbors/path/components and UI actions | Q07/Q12 |
| F11 | Seeded Force/ELK/timeline/manual layout Workers | Q07/Q11/Q12 |
| F12 | Atlas manual node/edge commands and history | Q07/Q04 |
| F13 | Pinned Source references, Host read/navigation ACL | Q07/Q08 |
| F14 | Atlas document Boards/views/viewport/filter/group/pin | Q04/Q07 |
| F15 | Official Excalidraw lazy editor and native browser operation/keyboard suites | Q07/Q09 |
| F16 | Atlas text/image/source/provider Cards and Inspector | Q07/Q09 |
| F17 | Node/Card reference and navigation commands | Q07/Q08 |
| F18 | Atlas/Excalidraw/Bundle I/O and official Card export overlay | Q03/Q09 |
| F19 | Structured lane/order/timeline document fields and views | Q07/Q09 |
| F20 | Independent Japanese Story UI | Q01/Q08 |
| F21 | Story edit plans and real create/edit/delete browser flows | Q04/Q08 |
| F22 | Story directed relations and incoming-reference protection | Q08/Q10 |
| F23 | Story appearance/POV/location/thread/time projections and source navigation | Q08 |
| F24 | Source parser/domain diagnostics and healthy entity retention | Q08/Q10 |
| F25 | Canonical generated schema, scoped Host RPC and fail-closed Core adapter | Q06/Q10/Q11 |
| F26 | Public package entries and isolated archive consumers | Q14 |
| F27 | Japanese UI/IME guards, keyboard workflows, focus, themes and mobile browser cases | Q13 |
| F28 | Lossless source/scene documents and atomic Host proposals | Q04/Q05/Q09 |
| F29 | Lazy chunks, bounded queues/caches and Worker release | Q12/Q14 |
| F30 | Isolated frame/provider and durable storage failure handling | Q05/Q10/Q11 |
| F31 | Public draft PR #1, progress/provenance and this verification ledger | Q15 |
