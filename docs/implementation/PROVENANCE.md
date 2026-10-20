# Provenance

## Reference source

Story compatibility work read the public `yohn-jp/scriptorium` source at `eaa52ce09e2e5217e55e68b139a578a313a5ea0b`: `modules/story/src/snapshot.ts`, `modules/story/src/domain/graph.ts`, and `LICENSE` (MIT, copyright yohn-jp 2026). The documented path/field inventory informs an independently implemented parser. No source code, manuscripts, credentials, or private data have been copied from that repository. Duplicate-ID overwrite, Markdown trimming, and lost relation provenance are explicitly excluded.

## Dependency provenance under verification

Exact package manifests and the dependency lockfile are authoritative. Version/license/asset checks are recorded here as they are executed; a metadata check does not prove browser behavior.

| Dependency | Exact version selected | License / source evidence | Purpose |
| --- | --- | --- | --- |
| React / React DOM | 19.3.1 | npm registry package metadata; MIT | Standalone and independent plugin UIs |
| Vite | 8.3.4 | npm registry metadata; MIT | Three static production compositions |
| Excalidraw | 0.18.1 | official package, MIT; official installation docs | Freeform drawing and standard scene/image exports |
| React Flow | 12.12.0 | official `@xyflow/react` package; MIT | Graph interaction |
| d3-force | 3.0.0 | npm registry metadata; ISC | Worker force layout |
| elkjs | 0.12.0 | npm registry metadata; EPL-2.0 OR GPL-3.0-or-later | Worker layered layout (license notice must accompany packaging) |
| @types/d3-force | 3.0.10 | npm registry metadata; MIT | Layout types |

Excalidraw fonts must be hosted from the application's own static origin; `window.EXCALIDRAW_ASSET_PATH` is `/` and font assets reside below `/fonts/`. This follows [official installation guidance](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation) and the pinned [0.18.1 font URL implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/ExcalidrawFontFace.ts). Font licenses and asset inclusion still require packaging verification. No external font fetch is accepted as proof of offline packaging.

Large generated assets, browser logs, and measurements belong in ignored artifact directories. Commit only manifests, hashes, summaries, and reproduction commands.
