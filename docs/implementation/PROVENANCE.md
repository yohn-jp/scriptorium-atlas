# Provenance

No project license has been selected. The eight first-party package manifests use `UNLICENSED`; provisional MIT declarations and the generated first-party persistence MIT text were removed. This makes no new license grant for project code. Third-party dependency and font notices retain their upstream licenses and exact texts.

## Reference source

Story compatibility work read the public `yohn-jp/scriptorium` source at `eaa52ce09e2e5217e55e68b139a578a313a5ea0b`: `modules/story/src/snapshot.ts`, `modules/story/src/domain/graph.ts`, and `LICENSE` (MIT, copyright yohn-jp 2026). The documented path/field inventory informs an independently implemented parser. No source code, manuscripts, credentials, or private data have been copied from that repository. Duplicate-ID overwrite, Markdown trimming, and lost relation provenance are explicitly excluded.

## Dependency provenance under verification

Exact package manifests and the dependency lockfile are authoritative. Version/license/asset checks are recorded here as they are executed; a metadata check does not prove browser behavior.

| Dependency | Exact version selected | License / source evidence | Purpose |
| --- | --- | --- | --- |
| React / React DOM | 18.3.1 | Installed pinned package metadata; MIT; strict Excalidraw/Radix peer compatibility verified | Standalone and independent plugin UIs |
| Vite | 8.3.4 | npm registry metadata; MIT | Three static production compositions |
| Excalidraw | 0.18.1 | official package, MIT; official installation docs | Freeform drawing and standard scene/image exports |
| React Flow | 12.12.0 | official `@xyflow/react` package; MIT | Graph interaction |
| d3-force | 3.0.0 | npm registry metadata; ISC | Worker force layout |
| elkjs | 0.12.0 | npm registry metadata; EPL-2.0 OR GPL-3.0-or-later | Worker layered layout (license notice must accompany packaging) |
| @types/d3-force | 3.0.10 | npm registry metadata; MIT | Layout types |
| yaml | 2.9.1 | Installed pinned package and bundled license text | Story source parsing |
| fflate | 0.8.2 | Installed pinned package and bundled license text | ZIP I/O and deterministic synthetic performance archives |
| Ajv | 8.20.0 | Pinned build dependency; generated standalone validators | Canonical schema validation without runtime compilation |

Excalidraw fonts are copied below `/fonts/` and configured with a same-origin asset base before Atlas UI loads. This follows [official installation guidance](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation) and the pinned [0.18.1 font URL implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/ExcalidrawFontFace.ts). The Atlas frame's connect policy permits only its own `/fonts/` path because official font export reads use `fetch`; Host and Story retain `connect-src 'none'`. Browser checks confirm a local font fetch succeeds while other static paths, the Host origin, external origins and encoded traversal are denied. Path-scoped source matching follows [CSP Level 3](https://www.w3.org/TR/CSP3/#match-paths). Product text drawing and fallback behavior remain under verification; external font fetch is not accepted as proof of offline packaging.

Dependency legal inventories are derived from actual emitted module closures, including Worker chunks. Missing npm legal texts use only the exact package/version entries in `scripts/verification/license-supplements/manifest.json`, with retained upstream revision/source, text SHA-256 and npm artifact integrity. No license guard is disabled. Self-hosted font manifests include every copied file digest and the exact MIT/OFL-1.1 texts. Intermediate three-profile closure audits passed for 143 Atlas, 5 Story and 144 combined external packages; the final-HEAD rerun remains required.

Large generated assets, browser logs, and measurements belong in ignored artifact directories. Commit only manifests, hashes, summaries, and reproduction commands.
