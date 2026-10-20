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

/** Copy the pinned Excalidraw fonts and a license/hash manifest into `<outputDirectory>/fonts`. */
export declare function copyCanvasAssets(
  outputDirectory: string,
): Promise<CanvasAssetsCopyResult>;
