import {
  exportToBlob,
  exportToSvg,
  getNonDeletedElements,
} from "@excalidraw/excalidraw";
import { restoreExcalidrawScene } from "./scene.js";

export type CanvasImageFormat = "png" | "svg";

export function downloadExcalidrawScene(sceneText: string, filename = "drawing.excalidraw"): void {
  const blob = new Blob([sceneText], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, filename);
}

export async function exportExcalidrawScene(
  sceneText: string,
  format: CanvasImageFormat,
): Promise<Blob> {
  const restored = restoreExcalidrawScene(sceneText);
  const elements = getNonDeletedElements(restored.elements);
  const appState = restored.appState;
  const files = restored.files;
  const viewBackgroundColor = appState.viewBackgroundColor ?? "#ffffff";

  if (format === "png") {
    return exportToBlob({
      elements,
      appState: {
        ...appState,
        exportBackground: true,
        viewBackgroundColor,
      },
      files,
      mimeType: "image/png",
      exportPadding: 10,
    });
  }

  const svg = await exportToSvg({
    elements,
    appState: {
      ...appState,
      exportBackground: true,
      viewBackgroundColor,
    },
    files,
    exportPadding: 10,
    renderEmbeddables: false,
  });
  return new Blob([new XMLSerializer().serializeToString(svg)], {
    type: "image/svg+xml;charset=utf-8",
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
