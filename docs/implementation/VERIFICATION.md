# Standalone V1 verification ledger

The final-delivery rerun on `c6391e1bf948846b99dbc72542dbc8ac86c4b766` failed Q12: during 10k traversal the Atlas frame entered its fatal screen with `ResizeObserver loop completed with undelivered notifications`. Q12 is FAIL and Q15 is NOT_CHECKED until this defect is fixed and affected final-HEAD verification passes. The earlier `1e005e3` five-case PASS below remains historical evidence, not the delivery verdict. The final confirmation has not been published as a pass.

F01–F31 remain required; Q01–Q15 retain their original contracts and budgets. The implementation snapshot is `ad2abd3c6002bae7e3178262039f76c8f9f70477`; the final test-readiness snapshot is `1e005e307d5856904dc2b81ad6f07bdfc5528b14`. Only test diagnostics/readiness and progress documentation differ between them. Production source and all three artifacts are byte-identical. The delivery HEAD, final confirmation commands/results and report hashes will be published in [implementation PR #1](https://github.com/yohn-jp/scriptorium-atlas/pull/1); this avoids embedding a commit's own SHA inside that commit.

The compact [evidence manifest](evidence/standalone-v1.json) records environment, artifact hashes, sample counts, metrics, report hashes and retained failures. Raw logs and generated datasets remain outside Git. Results below are observed results, not target values. No production Scriptorium SDK or Git integration is claimed.

## Environment and artifact identity

Node 24.21.0; pnpm 12.10.1; Linux 6.18.52 x86_64; 16 logical CPUs; 50,994,450,432 bytes RAM. Chromium 155.0.8059.79, headless 1440×1000. This matches the gate's approximate machine class; RAM is approximately 47.5 GiB rather than the 32 GiB minimum. Browser tests use the real production builds, separate-origin Plugin frames and real IndexedDB. Inputs are generated synthetic data.

| Profile | Files / bytes | SHA-256 |
| --- | --- | --- |
| atlas | 743 / 63,563,775 | `bc060650a24606749054ad8e9b091c85afbb9147e1abc11ea6c78f2f85076990` |
| story | 25 / 6,037,673 | `fa9e4199aefd43f673e8441c24eb143de31b71398b6c48ae180bc5e6985634f9` |
| combined | 752 / 65,148,254 | `174eb69b849cfa54c1bdcd69cb54ff88622ab97e67738fe838f904ec6ab7555b` |

Hash method: `scripts/verification/artifact-evidence.mjs` hashes sorted POSIX-relative file paths, NUL, byte length, NUL and file bytes. An older Q05 runner digest uses a different encoding; its summary names both methods and verifies every served file byte. These digests are not interchangeable.

## Gate verdicts

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
| Q11 | PASS | Seven malformed/stale/exception/rejection frame faults; timeout/hang/cancel-ignore/Worker crash and independent recovery; Host draft remains usable |
| Q12 | FAIL | Delivery c6391e1: 10k Atlas frame failed with a ResizeObserver delivery-loop ErrorEvent; the other four cases passed. Earlier five-case PASS is historical only. |
| Q13 | PASS | Host IME/mobile/theme cases plus Atlas/Card/Canvas keyboard tests, focus movement, native history and saved view state; 390px and desktop |
| Q14 | PASS | Three closure/lazy/legal audits; 8 isolated pnpm archives, 25 public Node exports, 4 browser entries and a real editable Canvas/export consumer; Worker release verified |
| Q15 | NOT_CHECKED | Delivery Q12 failed. Final affected-HEAD confirmation and updated PR verdict remain required. |

Frozen install, strict typecheck and unit suite passed: 156 tests, zero failures, one explicit optional ZIP-file generation skip. The ordinary maximum-count Export/Import test runs in this suite. The separately executed Python 3.13.15 oracle passed on the unchanged ZIP implementation: 100,000 total entries, 99,999 manifest payloads, all payload hashes/workspace revision/CRCs, nonempty tail. Archive size 14,682,752 bytes; SHA-256 `b6f577a073a19b215bc4769828eec3b9d6665863894d9941ae82b4073dc0226b`. Its source equality/carry-forward is explicit in the storage summary.

Workspace caps remain 100,000 files / 256 MiB. Import and Export reserve one manifest entry and count its actual serialized bytes inside those caps; ZIP metadata/compressed archive size are checked separately. A legacy oversized Workspace fails explicitly without deletion/truncation and retains original bytes and revisions.

## Q12 product measurements

The canonical five-case run on `1e005e3` exited 0 with five PASS and no NOT_CHECKED items. Report SHA-256 `525df9023d9342ef26bdfdfa22d782f1fb0620168a1b3a8bed8d8e5d84c15e4d`; stdout `2fa67d7f8f42150f065607a538614377a3295a226d5ba826ea81fc101a481538`. No other browser/build/unit jobs ran during measurement.

| Assertion | Actual | Unchanged limit |
| --- | --- | --- |
| 1k/2k cold first visible, 5 cache-cleared samples | p95 1,960.24 ms | 3,000 ms |
| 1k warmed Japanese/tag/type search, 30 each | p95 7.6 ms | 100 ms |
| 1k Force, 1,000 finite positions | 881.1 ms | 2,000 ms |
| Trusted in-flight Force cancel | 0.7 ms dispatch to Worker termination; exact request matched, no stale response | 500 ms |
| 10k/20k index | 225.8 ms, exact counts | 10,000 ms |
| 10k warmed search, 30 each | p95 11 ms | 250 ms |
| 10k neighbors depths 1/2/3, 30 each | aggregate p95 6.4 ms, exact result IDs/depths | 500 ms |
| 10k shortest path, 30 five-hop paths | p95 2.5 ms, exact endpoints | 500 ms |
| Freeform 100 and 500 actual objects | drag/pan p50 59.88 fps; supported Long Task observer, zero tasks >50 ms | ≥30 fps; no sustained >50 ms tasks |
| Disable Atlas, 5-second observation | zero live Workers, zero Plugin-origin requests | 0 / 0 |
| 500-object Commit/reload | two explicit author-approved receipts; exact scene/Board/manifest/inventory and viewport | zero lost/mismatched saved data |

Cold timings include JS/CSS transfer. Per-resource timings/transfer bytes are retained separately, never subtracted from the visible result. The manifest records all five cold samples and download summaries. Query arrays/sample counts remain in the report. Heap is Chromium `performance.memory`, explicitly approximate/shared renderer JS heap, not isolated Plugin/Worker heap or Chrome process RSS. Disable's heavy-code inactivity follows destruction of the Plugin frame plus closure/Worker/network evidence; no direct dynamic-import hook measurement is claimed.

## Exact reproduction commands

These were run from `/data/atlas-v1-verification` unless the command supplies another cwd. Use Node 24 and pinned pnpm, and point Chromium at an installed executable on other systems. Runner-specific exact invocations/report hashes are retained in the evidence manifest and owner summaries.

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
ATLAS_E2E_REPORT=/data/atlas-v1-verification-tmp/final-ad2abd3/host.json node scripts/verification/run-browser-e2e.mjs
ATLAS_HOST_ROOT=/data/atlas-v1-verification ATLAS_E2E_PROFILE=story node plugins/story-knowledge/tests/browser-acceptance.mjs
ATLAS_HOST_ROOT=/data/atlas-v1-verification ATLAS_E2E_PROFILE=combined node plugins/story-knowledge/tests/browser-acceptance.mjs
```

Start `ATLAS_HOST_PORT=44960 node apps/standalone/scripts/serve.mjs combined` for fault/crash checks; the following two ports belong to Plugin origins. Browser suites also start and release isolated static servers themselves.

```sh
ATLAS_FAULT_BASE_URL=http://127.0.0.1:44960 ATLAS_FAULT_PROFILE=combined node apps/standalone/test/frame-recovery.mjs
ATLAS_FAULT_BASE_URL=http://127.0.0.1:44960 ATLAS_FAULT_PROFILE=combined node apps/standalone/test/provider-fault-browser.mjs
ATLAS_Q05_REPORT=/data/atlas-v1-verification-tmp/final-ad2abd3/storage/q05-host.json ATLAS_HOST_ROOT=/data/atlas-v1-verification node packages/persistence/test/q05-host-browser.mjs
ATLAS_Q05_PROFILE=combined ATLAS_Q05_BASE_URL=http://127.0.0.1:44960 ATLAS_Q05_TMPDIR=/data/atlas-v1-verification-tmp node packages/persistence/test/q05-browser-crash.mjs
ATLAS_SVG_MODULE=/data/atlas-v1-verification/packages/persistence/dist/svg.js pnpm --dir packages/persistence exec playwright test --config test/playwright.config.ts test/svg.browser.ts
ATLAS_HOST_ROOT=/data/atlas-v1-verification node packages/canvas/test/browser-operations.mjs
ATLAS_HOST_ROOT=/data/atlas-v1-verification node packages/canvas/test/browser-keyboard-controls.mjs
```

Each Atlas runner uses `ATLAS_HOST_ROOT=/data/atlas-v1-verification ATLAS_PROFILE=combined ATLAS_ARTIFACT_HEAD=$(git rev-parse HEAD)` with `node plugins/atlas/tests/browser-<suite>.mjs`: `graph-history`, `graph-interactions`, `provider-refresh`, `structured-views`, `card-keyboard`, `card-export`, `grant-refresh`, `freeform-viewport`. Canvas native suites use the Atlas-only artifact. The independent ZIP oracle commands (cwd `packages/persistence`) were `ATLAS_BUNDLE_OUTPUT=/data/atlas-v1-verification-tmp/max-cap.zip pnpm exec vitest run test/zip64-interoperability.test.ts` then `python3 test/zip64_interoperability.py /data/atlas-v1-verification-tmp/max-cap.zip`.

Canonical serialized performance invocation:

```sh
TMPDIR=/data/atlas-v1-verification-tmp ATLAS_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium ATLAS_PERF_REPORT=/data/atlas-v1-verification-tmp/final-1e005e3/q12.json node scripts/verification/run-performance-e2e.mjs > /data/atlas-v1-verification-tmp/final-1e005e3/q12.stdout 2>&1
```

## Retained failures and practical limits

Earlier runs remain failures in their reports. Graph rendering feedback, cancellation generation handling, native Canvas hit-test offsets and Freeform camera persistence required production corrections. A later Graph timeout did not reproduce under trusted-pointer diagnostics; the final test explicitly verifies the intended selected ID before neighbor queries. Grant pagination now asserts the two actual paginated traversals rather than an incidental fifth request. Q12 readiness failures (0.375px clipping and pre-measurement root movement) are retained; final preparation centers/hit-tests the true target and waits for stable geometry/status. Counts, measured gestures, original budgets and exact persistence assertions were not relaxed. Focused passes were not substituted for the final canonical five-case run.

Only Host-acknowledged journals/commits establish durability. Unacknowledged transient UI edits can be lost on a forced browser failure. Prepared changes require explicit author approval; tests drain successive proposals until current bytes are durably committed. This Standalone Host does not implement Scriptorium Core's production Git/Recovery/authorization ownership.

Official font sources list CDN fallbacks; CSP blocks those attempts. Bundled same-origin fonts return 200, render locally and are embedded in SVG. Do not interpret blocked fallbacks as successful external fetches. The exact upstream OFL text intentionally retains a trailing space at `packages/canvas/scripts/licenses/OFL-1.1.txt:13`; full `git diff --check` reports it. The diff check excluding that verbatim license passes. No source whitespace exception or license-text modification is introduced.

## F01–F31 evidence map

Every feature remains required and maps to the gates above. Q12/Q15 remain incomplete.

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
