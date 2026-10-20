# Atlas V1 implementation progress

The accepted Goal and F01–F31 / Q01–Q15 remain unchanged. This file records checkpoints, not completion claims.

## 2026-10-20 — isolated implementation started

- Base: `81313c8` (`origin/main`); live GitHub had no open PRs or Issues at start. Main contains only accepted design documents. The original worktree's untracked `.codegraph/` was left untouched.
- Integration branch: `feat/atlas-v1`. Independent leaves/worktrees: `feat/atlas-v1-contracts`, `feat/atlas-v1-storage`, `feat/atlas-v1-story`, `feat/atlas-v1-graph`, `feat/atlas-v1-canvas`, `feat/atlas-v1-ui`, `feat/atlas-v1-host`. Each implementation owner edits its own worktree. Coordinator owns Standalone composition and delivery.
- G0/G1 work in progress: generated canonical schema types/validators, bounded transport, real IndexedDB transactions/journal/receipts, profile composition, separate-origin plugin frames, Host-controlled change review. No Scriptorium SDK or production Git integration is claimed.
- Host leaf paths: `apps/standalone`. Build emits a module closure per profile and rejects forbidden Story/Atlas modules. Host and frames use separate loopback ports, no HTTP write endpoint, and a CSP without runtime eval. Provider discovery uses static public metadata; queries use leased, validated MessagePorts.
- Focused checks at this checkpoint: `node --check apps/standalone/scripts/serve.mjs`, `node --check apps/standalone/scripts/run.mjs`, `git diff --check` exited 0 in the Host worktree. These are syntax/diff checks only. Typecheck/build/unit/browser/durability/closure gates remain **NOT_CHECKED** until actual integrated executions.
- Node observed: `v24.21.0`; pnpm `12.10.1`. Working browser available at `/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium` reports `Chromium 155.0.8059.79`. Browser tests have not yet run.

### Contract reconciliation

1. `DOCUMENTS-V1.md` used `pin.nodeKey` while canonical `v1.schema.json` and its example use `pin.nodeId`. Implementations follow the canonical schema's `nodeId`; no data format rename is introduced.
2. F19 requires lane assignment and explicit timeline values/range to survive reload; the initial `view` schema only had lane IDs, one card order, and an axis. The schema owner is completing that missing representation additively with typed `lanes` and `timeline` fields. The Goal and gate requirements are unchanged.
3. Workspace/ZIP limit arithmetic was reported with concrete evidence: a 100,000-file workspace plus required `manifest.json` exceeds a 100,000-entry archive cap. The user explicitly chose to reserve manifest space **inside** existing limits. On Import/Export the manifest counts as one entry and its actual serialized bytes count within 256 MiB; ZIP metadata/compressed bytes are validated separately. Oversize input fails explicitly and existing source data must never be deleted or truncated to fit. The contract owner is recording this clarification; the storage owner is implementing the matching boundary checks.
4. Runtime Ajv compilation conflicts with the accepted strict frame CSP. Validators are generated as standalone functions at build time from the same canonical schema; CSP is not relaxed.

No F/Q gate has been declared PASS at this checkpoint. An implementation PR is not a completion certificate.

## 2026-10-21 — integrated Host checkpoint

- Host composition now uses the real public persistence/Plugin APIs: author review of full before/after changes, journal recovery and staged assets, verified binary download, scoped source access, cancelable Provider leases, and separate-origin static frames. Source storage remains exclusively Host-owned.
- React and React DOM are pinned to 18.3.1 with matching React 18 types. Strict peer validation rejected the earlier React 19 selection because Excalidraw 0.18.1's nested Radix dependencies require React 18; peer validation was retained. `pnpm install --no-frozen-lockfile` then exited 0.
- On Host leaf parent `ad19264` plus the working Host changes: `pnpm -r --if-present typecheck` exited 0; `pnpm -r --if-present test` exited 0 (contracts 6, canvas 7, graph 14, layout 8, persistence 13, adapter 1, Story 23, Atlas 8); `node --test tests/verification/*.test.mjs` exited 0 (4 tests). These are intermediate checks, not final-HEAD gate evidence.
- `pnpm build:profiles` failed after generating the Atlas bundle: license validation correctly rejected missing LICENSE/COPYING/NOTICE text in the published Excalidraw package. A pinned upstream legal-text supplement is being verified; the guard remains enabled. `pnpm --filter @scriptorium-atlas/standalone build:story` exited 0, including dependency notices. Product browser tests are in progress; other profiles, full closure, fault, accessibility, performance, and complete F/Q coverage remain NOT_CHECKED.
- Bundle manifest shape is being added to the canonical schema, and matching Import/Export boundary and preservation tests are being strengthened. No Goal or quality-gate threshold was changed.

### Integrated persistence and frame checks

- Canonical manifest commit `6899f6c` and persistence follow-up `2385d12` were integrated. Contract build and persistence typecheck exited 0; persistence tests passed 15/15. The legacy fixture retains a nonempty 100,000th file, its bytes/revision and the Workspace revision after explicit export refusal. ZIP total-entry, compressed-size, central-directory and exact serialized-manifest byte boundaries are covered.
- The initial Host E2E run failed two recovery cases because the test waited only for the ordinary opened status. After correcting the legitimate recovery status and waiting for React's controlled Workspace selection, all six Story-profile Host cases passed in Chromium 155.0.8059.79. Report `/tmp/atlas-story-host-recovery-v2.json` remains an intermediate local artifact; its referenced HEAD is `3c40499`, not the final release.
- Added `apps/standalone/test/frame-recovery.mjs`. Real MessagePort stale-epoch, malformed-method and 8 MiB faults remove only the target frame while retaining the durable Host proposal. Independent frame reload now renews nonce/epoch instead of leaving a dead port attached. Restart, explicit author Commit and full Host reload preserve the exact Source bytes. This script passed against the intermediate Story production artifact; combined-profile and final-HEAD reruns remain required.
- Draft implementation PR: https://github.com/yohn-jp/scriptorium-atlas/pull/1 . Its draft status and remaining FAIL/NOT_CHECKED items are intentional; no complete quality gate is claimed.
