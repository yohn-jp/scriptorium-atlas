import type { IMAGE_MIME_TYPES } from "@excalidraw/excalidraw/constants";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

export type CanvasImageFormat = "png" | "svg";
export type CanvasExportImageMimeType =
  (typeof IMAGE_MIME_TYPES)[keyof typeof IMAGE_MIME_TYPES];

/** Browser-friendly file input. Canvas normalizes IDs and data URLs for Excalidraw. */
export type CanvasExportFile = Readonly<{
  id: string;
  mimeType: CanvasExportImageMimeType;
  dataURL: string;
  created?: number;
}>;

type ImageElementSkeleton = Extract<ExcalidrawElementSkeleton, { type: "image" }>;

/** Excalidraw skeletons with image file IDs kept neutral at the package boundary. */
export type CanvasExportElementSkeleton =
  | Exclude<ExcalidrawElementSkeleton, { type: "image" }>
  | (Omit<ImageElementSkeleton, "fileId"> & { fileId: string });

/**
 * Ephemeral Excalidraw content to include in a raster/vector export.
 * These elements are converted with Excalidraw's official skeleton API and
 * are never written back to the board scene.
 */
export type CanvasExportOverlay = Readonly<{
  elements: readonly CanvasExportElementSkeleton[];
  files?: readonly CanvasExportFile[];
}>;

function normalizeOverlayFiles(
  fileInputs: readonly CanvasExportFile[] | undefined,
  sceneFiles: BinaryFiles,
  validMimeTypes: ReadonlySet<string>,
): BinaryFiles {
  const normalized: Record<string, BinaryFileData> = Object.create(null) as Record<
    string,
    BinaryFileData
  >;

  for (const file of fileInputs ?? []) {
    if (!file.id.trim()) {
      throw new Error("Canvas export overlay files require a non-empty id.");
    }
    if (Object.hasOwn(sceneFiles, file.id) || Object.hasOwn(normalized, file.id)) {
      throw new Error(`Canvas export overlay fileId '${file.id}' conflicts with an existing file.`);
    }
    if (!file.mimeType.startsWith("image/") || !validMimeTypes.has(file.mimeType)) {
      throw new Error(`Canvas export overlay file '${file.id}' has unsupported image MIME type.`);
    }
    const dataUrlMimeType = /^data:([^;,]+)/.exec(file.dataURL)?.[1];
    if (dataUrlMimeType !== file.mimeType || !file.dataURL.includes(",")) {
      throw new Error(`Canvas export overlay file '${file.id}' has an invalid data URL.`);
    }

    normalized[file.id] = {
      id: file.id as BinaryFileData["id"],
      mimeType: file.mimeType,
      dataURL: file.dataURL as BinaryFileData["dataURL"],
      created: file.created ?? 0,
    };
  }

  return normalized as unknown as BinaryFiles;
}

function normalizeOverlayElements(
  elements: readonly CanvasExportElementSkeleton[],
  files: BinaryFiles,
): ExcalidrawElementSkeleton[] {
  return elements.map((element) => {
    if (element.type !== "image") {
      return element;
    }
    if (!Object.hasOwn(files, element.fileId)) {
      throw new Error(
        `Canvas export overlay image references missing fileId '${element.fileId}'.`,
      );
    }
    return { ...element, fileId: element.fileId as ImageElementSkeleton["fileId"] };
  }) as ExcalidrawElementSkeleton[];
}

export function downloadExcalidrawScene(sceneText: string, filename = "drawing.excalidraw"): void {
  const blob = new Blob([sceneText], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, filename);
}

export async function exportExcalidrawScene(
  sceneText: string,
  format: CanvasImageFormat,
  overlay?: CanvasExportOverlay,
): Promise<Blob> {
  const [excalidraw, sceneIo] = await Promise.all([
    import("@excalidraw/excalidraw"),
    import("./scene.js"),
  ]);
  const restored = await sceneIo.restoreExcalidrawScene(sceneText);
  const {
    convertToExcalidrawElements,
    exportToBlob,
    exportToSvg,
    getNonDeletedElements,
  } = excalidraw;
  const sceneFiles = restored.files ?? {};
  const overlayFiles = normalizeOverlayFiles(
    overlay?.files,
    sceneFiles,
    new Set(Object.values(excalidraw.MIME_TYPES)),
  );
  const files = { ...sceneFiles, ...overlayFiles };
  const overlaySkeletons = overlay?.elements.length
    ? normalizeOverlayElements(overlay.elements, files)
    : [];
  const overlayElements = overlaySkeletons.length
    ? convertToExcalidrawElements([...overlaySkeletons], { regenerateIds: true })
    : [];
  const elements = getNonDeletedElements([...restored.elements, ...overlayElements]);
  const appState = restored.appState;
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
