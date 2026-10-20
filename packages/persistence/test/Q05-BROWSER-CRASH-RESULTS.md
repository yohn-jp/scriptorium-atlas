# Q05 owned Chromium process crash result

The process-crash acceptance passed on the committed runner at persistence HEAD `18dd1dd452af1c5d7917000f3aea274ceb701fec`. It used the production `combined` Host profile at `http://127.0.0.1:44990`, Host checkout HEAD `16dc41ba8eda264fa630e014e6c828cc359106db`, Node `v24.21.0`, and Chromium `155.0.8059.79`. Before launching Chromium, the runner verified the root index and every served file against `dist/combined`; the artifact digest is `7792a4d101a24580ef4f24929f98334a849bba67e27ceb926a87c7e0ebd72cde` (747 files, 55,421,602 bytes).

Command, run from `packages/persistence`:

```sh
ATLAS_HOST_ROOT=/home/sophia/src/scriptorium-atlas-host \
ATLAS_Q05_PROFILE=combined \
ATLAS_Q05_BASE_URL=http://127.0.0.1:44990 \
ATLAS_Q05_TMPDIR=/data/atlas-v1-verification-tmp \
ATLAS_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
node test/q05-browser-crash.mjs
```

Result: `PASS`. The runner created and removed a fresh synthetic persistent profile outside both checkouts; it verified that the profile directory was gone at completion. It confirmed the draft's durable acknowledgement and exact bytes before killing its owned Chromium child with `SIGKILL`; after relaunching the same profile, the committed baseline and source revision were unchanged, the same pending operation and draft bytes were recovered, Host approval committed that operation, and a reload returned the exact draft bytes with a receipt. The pending draft SHA-256 was `74eda79e3350d5396e3ebae69a414af2b0629fdb0ada5a17db5d6b0c64484782`.

No profile, page recording, or raw browser log was retained.
