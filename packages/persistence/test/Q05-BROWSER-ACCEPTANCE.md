# Q05 real-browser persistence checks

Run the production Host profile against real Chromium and its real Host-origin IndexedDB with:

```sh
ATLAS_HOST_ROOT=/path/to/scriptorium-atlas-host \
ATLAS_E2E_CHROMIUM=/path/to/chromium \
npm run test:browser:q05 --workspace @scriptorium-atlas/persistence
```

`dist/story` must already be a production build. The runner serves it through the Host's static production server and does not change Host source files. It records a concise JSON summary to stdout or to `ATLAS_Q05_REPORT`; it does not preserve page recordings, raw browser logs, or user workspace data.

The cases exercise two Host tabs racing from one workspace generation, an explicit abort of the real multi-store IndexedDB commit transaction followed by source and draft recovery, and page loss after the durable `committing` journal transaction but before file/receipt mutation. The last case reloads the Host, checks the visible `COMMIT_UNKNOWN` operation ID, retries the same operation, and verifies its durable receipt and exact source text after another reload.
