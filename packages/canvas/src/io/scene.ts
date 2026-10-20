import type {
  ExcalidrawSceneSnapshot,
  RestoredExcalidrawScene,
} from "./scene-core.js";

export type { ExcalidrawSceneSnapshot, RestoredExcalidrawScene };

/** Create Excalidraw v2 JSON for a new board's separate `.excalidraw` file. */
export async function createEmptyExcalidrawScene(): Promise<string> {
  const core = await import("./scene-core.js");
  return core.createEmptyExcalidrawScene();
}

/** Import supported Excalidraw v2 JSON through Excalidraw's official restore API. */
export async function restoreExcalidrawScene(
  sceneText: string,
): Promise<RestoredExcalidrawScene> {
  const core = await import("./scene-core.js");
  return core.restoreExcalidrawScene(sceneText);
}

/**
 * Serialize with Excalidraw's official local scene serializer. Existing bytes
 * stay verbatim on a no-op, and unknown fields survive edits to supported scenes.
 */
export async function serializeExcalidrawScene(
  snapshot: ExcalidrawSceneSnapshot,
  originalSceneText?: string,
): Promise<string> {
  const core = await import("./scene-core.js");
  return core.serializeExcalidrawScene(snapshot, originalSceneText);
}
