# `@scriptorium-atlas/canvas`

The Canvas package wraps the official Excalidraw React editor for Atlas. The root entry exports only small package metadata and the font-path configurator. Import the editor from `@scriptorium-atlas/canvas/ui` and image/document I/O helpers from `@scriptorium-atlas/canvas/io`.

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

Copy the exact pinned Excalidraw production fonts into the app's public `fonts/` directory during its build. Since Excalidraw font URLs already include `fonts/`, configure the asset base as `/`:

```sh
pnpm --filter @scriptorium-atlas/canvas copy-fonts -- apps/standalone/public/fonts
```

`configureExcalidrawAssets()` must run before the editor is mounted. It accepts a same-origin path ending in `/`; the editor does not load unless a local asset base is configured. Include the copied fonts in the deployed app so offline sessions use the self-hosted files. The font files are generated from the pinned npm dependency and are not checked into Git.

`CanvasEditor` receives and returns the `.excalidraw` document text. The `@scriptorium-atlas/canvas/io` entry exports these Host-facing helpers:

- `createEmptyExcalidrawScene(): string` creates a valid Excalidraw v2 JSON document for a new board's separate `.excalidraw` file.
- `restoreExcalidrawScene(sceneText): RestoredExcalidrawScene` validates and restores supported scenes with Excalidraw's official `restore` API.
- `serializeExcalidrawScene(snapshot, originalSceneText?): string` serializes a `ExcalidrawSceneSnapshot` with Excalidraw's official `serializeAsJSON` API, retaining original bytes on a no-op and unknown JSON fields during edits.
- `exportExcalidrawScene(sceneText, format: "png" | "svg"): Promise<Blob>` renders a PNG or SVG export.
- `downloadExcalidrawScene(sceneText, filename?)` downloads the original scene text as `.excalidraw`.

Unsupported versions or element kinds stay read-only and offer the original source for download. The Excalidraw editor supplies shape, arrow, freehand, text, image, grouping, undo, and redo interactions.

The optional `renderOverlay(viewport)` prop lets Atlas render interactive cards above the drawing. Its coordinate helpers use Excalidraw's scene/viewport conversion APIs. Card content, size, source/provider bindings, and identity remain in the Host-owned `.atlas.json` Board document; this package never writes them into Excalidraw `customData`.

`exportExcalidrawScene(text, "png" | "svg")` returns an image `Blob`; `downloadExcalidrawScene(text)` preserves the input document text in a `.excalidraw` download. The Host remains responsible for routing file downloads and draft persistence.
