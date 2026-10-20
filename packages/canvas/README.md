# `@scriptorium-atlas/canvas`

The Canvas package wraps the official Excalidraw React editor for Atlas. The root entry exports only small package metadata and the font-path configurator. Import the editor from `@scriptorium-atlas/canvas/ui`, image/document I/O helpers from `@scriptorium-atlas/canvas/io`, and the Node-only static asset copier from `@scriptorium-atlas/canvas/assets`.

```tsx
import { useState } from "react";
import { configureExcalidrawAssets } from "@scriptorium-atlas/canvas";
import { CanvasEditor } from "@scriptorium-atlas/canvas/ui";
import { createEmptyExcalidrawScene } from "@scriptorium-atlas/canvas/io";

configureExcalidrawAssets("/");

function BoardCanvas() {
  // Keep this text in a separate `<board-id>.excalidraw` Host draft/file.
  const [sceneText, setSceneText] = useState(() => createEmptyExcalidrawScene());
  return <CanvasEditor sceneText={sceneText} onChange={setSceneText} />;
}
```

The Node-only `copyCanvasAssets(outputDirectory)` helper writes the exact pinned Excalidraw production fonts to `<outputDirectory>/fonts`, plus the exact MIT and OFL-1.1 license texts under `fonts/licenses/`. `manifest.json` records hashes for every font and license text and identifies each font family's source and license provenance; `THIRD_PARTY_NOTICES.md` lists the same paths, hashes, and sources. A Vite config can dynamically import `@scriptorium-atlas/canvas/assets` for the `atlas` and `combined` profiles, include `excalidrawWorkerVitePlugin()` in both the app and worker plugin lists, and call `copyCanvasAssets("dist/atlas")` from `closeBundle`. The plugin routes only the pinned Excalidraw 0.18.1 subset worker through Vite's `?worker&url` pipeline. Under a CSP that blocks dynamic code evaluation, it catches only the worker's `unsafe-eval` `EvalError` and returns the saved full font bytes, preserving portable SVG font data without relaxing CSP; all other errors still escape. Do not import this Node-only helper from browser code.

For a direct public-folder copy, the CLI does the same work:

```sh
pnpm --filter @scriptorium-atlas/canvas copy-fonts -- ../../apps/standalone/public/fonts
```

Since Excalidraw font URLs already include `fonts/`, use `/` as the asset base when deploying at the origin root. `configureExcalidrawAssets()` must run before the editor is mounted. It accepts a same-origin path ending in `/`; the editor does not load unless a local asset base is configured. Include the copied fonts in the deployed app so offline sessions use the self-hosted files. The font files are generated from the pinned npm dependency and are not checked into Git.

`CanvasEditor` receives and returns the `.excalidraw` document text. Its optional `viewport` prop accepts `{ scrollX, scrollY, zoom }` from Excalidraw's app state, and `onViewportChange` reports a settled pan or zoom through that same value shape. Keep those values in the Host-owned `.atlas.json` Board view; they are transient editor state and do not alter `.excalidraw` scene bytes. The prop restores the active view on mount and applies changed Host values through the official Excalidraw API. The `@scriptorium-atlas/canvas/io` entry exports these Host-facing helpers:

- `createEmptyExcalidrawScene(): Promise<string>` creates a valid Excalidraw v2 JSON document for a new board's separate `.excalidraw` file.
- `restoreExcalidrawScene(sceneText): Promise<RestoredExcalidrawScene>` validates and restores supported scenes with Excalidraw's official `restore` API.
- `serializeExcalidrawScene(snapshot, originalSceneText?): Promise<string>` serializes a `ExcalidrawSceneSnapshot` with Excalidraw's official `serializeAsJSON` API, retaining original bytes on a no-op and unknown JSON fields during edits.
- `exportExcalidrawScene(sceneText, format: "png" | "svg", overlay?): Promise<Blob>` renders the scene and optional Host-owned overlays to PNG or SVG.
- `downloadExcalidrawScene(sceneText, filename?)` downloads the original scene text as `.excalidraw`.

Unsupported versions or element kinds stay read-only and offer the original source for download. The Excalidraw editor supplies shape, arrow, freehand, text, image, grouping, undo, and redo interactions.

The optional `renderOverlay(viewport)` prop lets Atlas render interactive cards above the drawing. Its coordinate helpers use Excalidraw's scene/viewport conversion APIs. Card content, size, source/provider bindings, and identity remain in the Host-owned `.atlas.json` Board document; this package never writes them into Excalidraw `customData`.

For PNG/SVG output, pass those Host-owned cards as a third-argument `CanvasExportOverlay`: `{ elements, files? }`. `elements` accepts official Excalidraw element skeletons in scene coordinates through `CanvasExportElementSkeleton`; image skeletons take a plain string `fileId`. Canvas converts them with Excalidraw's `convertToExcalidrawElements` API and includes them only in the export. Add image data to `files` as `{ id, mimeType, dataURL, created? }` using the same ID referenced by the image skeleton. Every overlay image ID must resolve to a scene or supplied file, and supplied file IDs must not collide with scene file IDs. This keeps card data out of the persisted `.excalidraw` text while allowing exports to include it.

`exportExcalidrawScene(text, "png" | "svg", overlay?)` returns an image `Blob`; `downloadExcalidrawScene(text)` preserves the input document text in a `.excalidraw` download. The Host remains responsible for routing file downloads and draft persistence.
