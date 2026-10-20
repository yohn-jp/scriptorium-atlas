# Q05 owned Chromium process crash result

The process-crash acceptance passed on the committed runner at persistence HEAD `904bc4e7a1ef8d097e5c5027a1df398e95b9833f`. It used the production Story Host UI at `http://127.0.0.1:44990`, Host checkout HEAD `71e5e22942772cdcde8afdfa5f8aee9971cfc81d`, Node `v24.21.0`, and Chromium `155.0.8059.79`.

Command, run from `packages/persistence`:

```sh
ATLAS_HOST_ROOT=/home/sophia/src/scriptorium-atlas-host \
ATLAS_Q05_BASE_URL=http://127.0.0.1:44990 \
ATLAS_Q05_TMPDIR=/data/atlas-v1-verification-tmp \
ATLAS_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
node test/q05-browser-crash.mjs
```

Result: `PASS`. The runner created and removed a fresh synthetic persistent profile outside both checkouts; the runner verified that the profile directory was gone at completion. It confirmed the draft's durable acknowledgement and exact bytes before killing its owned Chromium child with `SIGKILL`; after relaunching the same profile, the committed baseline and source revision were unchanged, the same pending operation and draft bytes were recovered, Host approval committed that operation, and a reload returned the exact draft bytes with a receipt. The pending draft SHA-256 was `74eda79e3350d5396e3ebae69a414af2b0629fdb0ada5a17db5d6b0c64484782`.

No profile, page recording, or raw browser log was retained.
