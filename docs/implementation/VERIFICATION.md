# V1 verification ledger

This is an intermediate ledger. The immutable Goal, F01–F31 and Q01–Q15 remain in force. No complete gate is claimed here. Final-HEAD runs, exact artifact hashes and the completed feature/gate mapping are still required before release readiness.

Environment observed: Node 24.21.0, pnpm 12.10.1, Linux 6.18.52 x86_64, 16 logical CPUs, 50,994,450,432 bytes system memory; Chromium 155.0.8059.79. The working browser is selected with `ATLAS_E2E_CHROMIUM`; Playwright's cached default binary cannot launch on this Nix environment. System memory is not a measurement of Plugin heap.

## Reproduction entry points

Run from a clean checkout with Node 24 and the pinned pnpm version. These commands are verification entry points, not a claim that every listed command currently passes.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:profiles
node scripts/verification/check-profile-closures.mjs
node scripts/verification/check-pack-consumer.mjs
node scripts/verification/run-browser-e2e.mjs
pnpm --filter @scriptorium-atlas/story-knowledge test:browser
pnpm --filter @scriptorium-atlas/persistence test:browser:q05
node scripts/verification/run-performance-e2e.mjs
pnpm --filter @scriptorium-atlas/graph benchmark:browser
```

Standalone static servers are started with `node apps/standalone/scripts/serve.mjs atlas`, `story` or `combined`. `ATLAS_HOST_PORT` selects the Host port and the two subsequent loopback ports are reserved for Plugin origins. The Host-only transport fault scripts use `ATLAS_FAULT_BASE_URL` and the served profile; see `apps/standalone/test/frame-recovery.mjs` and `provider-fault-browser.mjs`. Browser fixtures are generated synthetic data, not user manuscripts.

## Intermediate evidence

- Fresh lockfile installation and `pnpm typecheck` passed in an isolated detached checkout at `8510c03`. Later source changes require reruns. All three profiles subsequently built at `2d1b95c`; later Canvas integration fixes are still under browser verification.
- Story Host storage suite: six real Chromium/IndexedDB cases passed. The intermediate report references `3c40499`, artifact tree SHA-256 `76ae68b2052b0dca3fc06d128ee85bb0a0bc35040669d19b13b73bb15b096d24`. It covers Source create/edit/commit/reload, Bundle roundtrip and rejected import preservation, pending Journal recovery, origin isolation, storage denial and quota-aborted recovery.
- Story UI acceptance: eight real browser scenarios passed after source fixes `cb38e75` and `b3203eb`, using runner `f3c3167`. They exercise all 12 UI-creatable types, preview/Host author commit/reload, entity edit/delete, relation CRUD and incoming-reference protection, scene/source navigation, and malformed/duplicate diagnostics with a healthy entity retained. See `plugins/story-knowledge/tests/browser-acceptance.mjs`; final artifact hashes remain pending.
- Real two-tab CAS, explicit IndexedDB transaction abort, and COMMIT_UNKNOWN recovery passed with the persistence-owned runner. Its intermediate artifact/head and exact scope are recorded in `packages/persistence/test/Q05-BROWSER-RESULTS.md`; it must run again on the final artifact.
- Persistence tests passed 15/15 before the public path-export smoke test was added. Exact serialized manifest bytes and one manifest entry are reserved inside the unchanged 256 MiB/100,000 limits. ZIP archive metadata and compressed size are checked separately. A nonempty legacy 100,000th file, its revision and Workspace revision survive explicit Export refusal without deletion or truncation.
- Real combined transport checks passed: four delayed Provider opens plus nine queued interactive queries; all nine settled as TIMEOUT in approximately 5,008 ms. Metadata discovery/denied acquisition created no Workers; last-lease close left zero. A malicious out-of-scope Provider SourceRef isolated the producer; ignored Cancel plus hung responses stopped only that Provider while the author could still commit the preserved Host draft.
- Combined frame faults passed stale epoch, malformed method, 8 MiB, cyclic object and BigInt rejection, independent frame reload with renewed nonce/epoch, and exact bytes through author commit/Host reload. These are transport subsets, not a complete Q11 declaration.
- Package Worker measurements, 30 samples for each query dataset, are in `packages/graph/benchmark/RUN-2026-10-21.md`: exact 1k/2k and 10k/20k generated graphs, 1k seeded Force completion 1,195.1 ms, 10k cancellation 137.7 ms, zero Workers after close. Raw report SHA-256 `6667aa28bcaa4e8650a1d144c688d6516e77856b3fb0c5c547218ecc8c100976`. These do not prove product UI performance.
- Independent package verification subsequently passed at intermediate Host `2ce9412`: eight archives, isolated dependency installation, 25 public Node exports, and a real Vite/Chromium consumer rendering Canvas, Atlas and Story UI. Runner `scripts/verification/check-pack-consumer.mjs` now checks browser exports in a browser; final-HEAD rerun remains pending.
- The first closure audit exposed post-emission byte substitutions and incomplete nested/Worker edge accounting. Producer accounting and audit traversal are corrected. Intermediate three-profile closure runs passed (Atlas 143, Story 5, combined 144 external packages); final-HEAD reruns remain pending.
- Graph browser/history flow passed with runner `plugins/atlas/tests/browser-graph-history.mjs`: visible manual node, physical selection, rename, duplicate, undo/redo, author Commit, explicit Workspace reopen and exact IDs/labels after reload. Controlled React Flow nodes now have explicit dimensions, and manual-node creation uses an inline form compatible with the frame sandbox.
- The expanded Host Q02/Q03 cases passed against intermediate combined artifact `50dcbb6`: Workspace rename/close/reopen, source edit/reload with unchanged revisions; valid Bundle roundtrip plus invalid ZIP, unknown schema version, hash mismatch, traversal, duplicate ZIP entry and declared expansion-bomb rejection. Every rejected input retains source bytes/revision and a separate existing Workspace. `tests/e2e/host-storage.mjs` generates these small synthetic archives; no ZIP fixture is committed.
- Actual Canvas Card PNG/SVG exports include text, image, source and Provider reference Cards. The official Excalidraw browser runner passed two rectangles/group, arrow, freehand, text, PNG insertion, Undo/Redo, exact scene import/export and author Commit/reload with matching Host bytes and all six element IDs/positions/groups. It drains successive prepared proposals before asserting a clean save; the earlier single-proposal run observed an older autosave and did not establish a persistence defect. Local font responses were all 2xx (nine observed); the official FontFace source lists also contain CDN fallback URLs, whose 460 attempts were blocked by CSP. No failed/exhausted local font or external successful response was observed. Full Q09 remains pending. Atlas board/node Japanese composing-Enter and legacy keyCode 229 checks passed; full Q13 remains pending.
- Structured view browser acceptance passed on intermediate combined `eba8788`: Kanban lane reorder/rename/add/assignment, Timeline axis cancel/confirm and unknown values, storyboard reorder, document export, author Commit and reload. Canonically sorted lane records now follow persisted `laneIds` for display/commands. Strict Atlas typecheck passed after correcting a union-kind narrowing error; Graph tests passed 18/18 and Atlas tests 13/13.
- A read-only contract audit found restricted inventory paths exposed in filtered list/snapshot cursors. Host now wraps internal cursors in bounded, frame-local random tokens scoped to method, Workspace identity/revision/epoch, grant and prefix. Strict Host typecheck and 11 tests passed; the real-browser grant/cursor regression is pending against the rebuilt artifact.
- A real 65,536-entry export exposed pinned fflate's 16-bit EOCD count overflow. Fix `8db2a1c` adds count-only ZIP64 end metadata around the existing compressor and uses bounded import chunks to avoid fflate stack overflow on legal high-count input. Typecheck and bundle tests (7/7) passed, including 65,534/65,535/65,536-entry exports and 99,999-payload Export/Import with the same Workspace SHA. Python 3.13.15 independently read all 100,000 entries, the 99,999-file manifest, a nonempty tail payload with matching SHA and every CRC (`ZipFile.testzip() is None`). That 14,682,752-byte archive has SHA-256 `b6f577a073a19b215bc4769828eec3b9d6665863894d9941ae82b4073dc0226b`; it remains outside Git. The limits, original Workspace data, Goal and gates remain unchanged. Final-HEAD rerun remains required.

Raw browser logs, ZIP fixtures, heap data and large generated bundles stay outside Git. Release evidence will retain concise manifests, hashes, environment, exact CLI, sample counts and PASS/FAIL/NOT_CHECKED results.

## Gate status on the release candidate

These statuses remain provisional until all affected checks run on the final HEAD.

| Gate | Status | Outstanding evidence |
| --- | --- | --- |
| Q01 | NOT_CHECKED | Final three-profile build, operation and exclusion closure together |
| Q02 | NOT_CHECKED | Final profile reruns; intermediate real Host flows passed |
| Q03 | NOT_CHECKED | Final ZIP/JSON/Excalidraw and hostile input browser matrix |
| Q04 | NOT_CHECKED | Complete Graph/Canvas/Story/multi-file commit and reload matrix |
| Q05 | NOT_CHECKED | Final rerun of real storage/frame/receipt fault cases |
| Q06 | NOT_CHECKED | Final Provider pagination/identity/scope/delta/lease matrix |
| Q07 | NOT_CHECKED | Full graph and structured-view pointer/keyboard persistence flows |
| Q08 | NOT_CHECKED | Final Story-only and combined revision/navigation coverage |
| Q09 | NOT_CHECKED | Intermediate drawing/Card/scene I/O passed; final full roundtrip matrix pending |
| Q10 | NOT_CHECKED | Final malformed source/path/grant/identity rejection matrix |
| Q11 | NOT_CHECKED | Final transport and cross-Plugin fault reruns |
| Q12 | FAIL | Serialized candidates `5a8ffff` and `62b80c2` failed. Cursor recovery, snapshot sizing, cancellation and Graph no-op rendering were corrected; combined Canvas physical drag still fails. Bounded diagnostics are not a full performance pass; final serialized budgets remain pending. |
| Q13 | NOT_CHECKED | Complete IME, keyboard alternatives, focus, theme and 390px runs |
| Q14 | NOT_CHECKED | Intermediate closure and packed browser/Node consumer passed; final runs pending |
| Q15 | NOT_CHECKED | Final HEAD, completed F/Q evidence, published implementation PR readiness |

## Feature evidence map

Every row remains required. Implementation paths below identify the current implementation and its tests; they are not final acceptance declarations.

| Feature | Current evidence surface | Required gates |
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
| F15 | Official Excalidraw lazy editor; browser operation verification pending | Q07/Q09 |
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
| F27 | Japanese UI/IME guards; full accessibility matrix pending | Q13 |
| F28 | Lossless source/scene documents and atomic Host proposals | Q04/Q05/Q09 |
| F29 | Lazy chunks, bounded queues/caches and Worker release | Q12/Q14 |
| F30 | Isolated frame/provider and durable storage failure handling | Q05/Q10/Q11 |
| F31 | Draft PR #1, progress/provenance and this pending final ledger | Q15 |

## Focused product performance checkpoint (Q12 still FAIL)

At integration candidate `29bbace26d2cae6ec73489ff8f5c3d76947042b7`, the unchanged production performance helper passed the selected Graph cases in isolation. The cancel and 100/500-object Freeform cases were explicitly NOT_CHECKED by this focused invocation. This does not replace the complete final-HEAD Q12 run. The combined artifact SHA-256 was `e0e69786988475d2a85cd6cd2ee1d5d9f0bd9cad733e85f9b61858bccd702687` (752 files, 65,120,753 bytes).

| Selected assertion | Actual | Existing limit |
| --- | --- | --- |
| 1k cold first-visible, 5 cache-cleared samples | p95 1,988.131 ms; individual 1,980.887 / 1,932.822 / 1,949.449 / 1,978.559 / 1,988.131 ms | 3,000 ms |
| 1k warmed search, Japanese/tag/type, 30 each | overall p95 6.2 ms | 100 ms |
| 1k Force, successful 1,000 finite positions | 907.1 ms | 2,000 ms |
| 10k/20k Worker index | 288.5 ms, exact counts | 10,000 ms |
| 10k warmed search, Japanese/tag/type, 30 each | overall p95 12.2 ms | 250 ms |
| 10k neighbors, 30 each of depth 1/2/3 | per-class p95 15.6 / 3.3 / 2.5 ms, exact complete result IDs/depths | 500 ms |
| 10k shortest path, 30 nontrivial five-hop results | p95 2.7 ms, exact endpoints | 500 ms |
| Disable Atlas, 5-second observation | active Workers 0, Plugin-origin requests 0 | 0 / 0 |

Environment: Node 24.21.0, Linux 6.18.52 x86_64, 16 logical CPUs, 50,994,450,432 bytes RAM, Chromium 155.0.8059.79 headless at 1440×1000. Heap uses Chromium `performance.memory` and is explicitly approximate/shared renderer JavaScript heap; it is not isolated Plugin/Worker heap or process RSS. Cold results include JS/CSS transfer; per-resource timing is separately retained, never subtracted.

Exact invocation: `TMPDIR=/data/atlas-v1-verification-tmp ATLAS_PERF_REPO_ROOT=/data/atlas-v1-verification ATLAS_PERF_REPORT=/data/atlas-v1-verification-tmp/q12-visible-providers-29bbace.json ATLAS_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium node /data/atlas-v1-verification-tmp/run-q12-visible-provider-only.mjs`. Exit 0 means the two selected cases passed. The temporary driver imports the existing helper and filters only via its recording callback; all other scenarios are reported NOT_CHECKED.

Report SHA-256: `b45ee7a786fb7738366a7b007ad5acb187f27110dff891083cfc22a4f2905c72`; stdout: `a2c8e04d9a589ecee80752c0f72ba50a8bde1585e24bed69bece89bb0ebe944a`; temporary driver: `1d8d171ffc97e0a1b35bd117ba315a98825080f47aaf04b9ebcd9ab305652ce7`; helper: `514fd04437039e18e9f5f961bc3044f2a387e01f470c518135931a9bbcbb84c2`. The deterministic input ZIP hashes remain `25c2b803f987f6360bd98582b9b12bb65c84422de6b4daa1f30cd2052827b751` (1k/2k plus 1k-node layout) and `c54ab3a662cc60fcef7d88036849c6f8c1f85dd6cc4b8bb32e966259f1957c47` (10k/20k, no initial layout). Generated archives and raw reports remain outside Git.
