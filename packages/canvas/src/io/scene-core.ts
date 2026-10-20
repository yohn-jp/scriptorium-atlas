import { restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { EMPTY_EXCALIDRAW_SCENE, inspectExcalidrawScene } from "../scene/inspect.js";
import { preserveSceneExtensions } from "../scene/preserve.js";

export type RestoredExcalidrawScene = ReturnType<typeof restore>;

export type ExcalidrawSceneSnapshot = Readonly<{
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}>;

/** Create official Excalidraw JSON for a new board's separate `.excalidraw` file. */
export function createEmptyExcalidrawScene(): string {
  const restored = restore(
    EMPTY_EXCALIDRAW_SCENE as Parameters<typeof restore>[0],
    null,
    null,
  );
  return preserveSceneExtensions(
    EMPTY_EXCALIDRAW_SCENE,
    serializeAsJSON(restored.elements, restored.appState, restored.files, "local"),
  );
}

/** Import supported Excalidraw v2 JSON through Excalidraw's official restore API. */
export function restoreExcalidrawScene(sceneText: string): RestoredExcalidrawScene {
  const inspection = inspectExcalidrawScene(sceneText);
  if (inspection.status === "read-only") {
    throw new Error(inspection.message);
  }
  return restore(inspection.data as Parameters<typeof restore>[0], null, null);
}

/**
 * Serialize a restored editor snapshot using Excalidraw's local scene format.
 * Existing bytes are returned verbatim if the editor has made no semantic
 * change; unknown fields are retained when a supported scene is edited.
 */
export function serializeExcalidrawScene(
  snapshot: ExcalidrawSceneSnapshot,
  originalSceneText?: string,
): string {
  const serialized = serializeAsJSON(
    snapshot.elements,
    snapshot.appState,
    snapshot.files,
    "local",
  );

  if (originalSceneText === undefined) return serialized;

  const inspection = inspectExcalidrawScene(originalSceneText);
  if (inspection.status === "read-only") {
    throw new Error(inspection.message);
  }

  const previous = restore(
    inspection.data as Parameters<typeof restore>[0],
    null,
    null,
  );
  const previousCanonical = serializeAsJSON(
    previous.elements,
    previous.appState,
    previous.files,
    "local",
  );
  if (previousCanonical === serialized) return originalSceneText;

  return preserveSceneExtensions(inspection.data, serialized);
}
