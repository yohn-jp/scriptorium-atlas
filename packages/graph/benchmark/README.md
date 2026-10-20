# Chromium Worker measurements

Run from the repository root after building graph and layout, with the repository's `vite` and `playwright` development dependencies installed:

```sh
pnpm --filter @scriptorium-atlas/graph build
pnpm --filter @scriptorium-atlas/layout build
pnpm --filter @scriptorium-atlas/graph benchmark:browser
```

The harness makes a temporary Vite production build of the benchmark page and serves it with Vite preview, then opens it in real headless Chromium with the HTTP cache disabled. The temporary build is removed when the run ends. A local proxy counts actual script response payload bytes, including compression, and request durations; headers are excluded and repeated Worker fetches count separately. If Chromium is outside Playwright's default browser cache, set `ATLAS_E2E_CHROMIUM` to its executable path; `CHROMIUM_PATH` is also accepted.

By default it uses a deterministic 1,000-node/2,000-edge ring and a 10,000-node/20,000-edge ring. Each node has two directed outgoing edges to its successor. Search, depth-three neighbors, and shortest path each run 30 samples. The 1,000-node force case reports full completion for 240 iterations with a fixed seed and two manual pins; the 10,000-node case exercises cancellation of a 10,000-iteration force request. Both Worker clients close before the harness checks that Chromium has zero live Workers. Set `ATLAS_BENCH_SIZES` or `ATLAS_BENCH_SAMPLES` to change the workload.

The report measures package Workers only. It excludes browser UI, canvas rendering, frame time, and quality-gate evaluation, so it does not claim that an Atlas performance quality gate passed.
