export type CanvasAssetRecord = Readonly<{
  path: string;
  family: string;
  license: "MIT" | "OFL-1.1";
  bytes: number;
  sha256: string;
}>;

export type CanvasAssetsCopyResult = Readonly<{
  outputDirectory: string;
  fontDirectory: string;
  manifestPath: string;
  noticePath: string;
  excalidrawVersion: string;
  fileCount: number;
  totalBytes: number;
  files: readonly CanvasAssetRecord[];
}>;

export type ExcalidrawWorkerVitePlugin = Readonly<{
  name: string;
  enforce: "pre";
  resolveId(source: string, importer?: string): string | null;
  load(id: string): string | null;
}>;

/** Copy the pinned Excalidraw fonts and a license/hash manifest into `<outputDirectory>/fonts`. */
export declare function copyCanvasAssets(
  outputDirectory: string,
): Promise<CanvasAssetsCopyResult>;

/**
 * Return a Node-only Vite plugin that routes Excalidraw 0.18.1's subset worker
 * through Vite's worker pipeline while preserving the official worker module.
 */
export declare function excalidrawWorkerVitePlugin(): ExcalidrawWorkerVitePlugin;
