# Chromium Worker measurements

Run from the repository root after building graph and layout, with the repository's `vite` and `playwright` development dependencies installed:

```sh
pnpm --filter @scriptorium-atlas/graph build
pnpm --filter @scriptorium-atlas/layout build
pnpm --filter @scriptorium-atlas/graph benchmark:browser
```

The script starts Vite, opens a real headless Chromium page, and exercises the package-owned module Workers. It reports Worker snapshot indexing, Japanese substring search, depth-three neighbors, shortest paths, and force-layout cancellation for deterministic 1,000- and 10,000-node chains. Each graph query runs 30 samples by default. Set `ATLAS_BENCH_SIZES` or `ATLAS_BENCH_SAMPLES` to change those inputs, and `CHROMIUM_PATH` if Chromium is installed outside Playwright's default browser cache.

The report contains Worker task timings only. It does not measure or claim UI frame time, canvas rendering, or completion of any Atlas performance quality gate.
