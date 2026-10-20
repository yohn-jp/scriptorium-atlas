const ASSET_PATH_KEY = "EXCALIDRAW_ASSET_PATH";
type ExcalidrawWindow = Window & { EXCALIDRAW_ASSET_PATH?: string };

export function configureExcalidrawAssets(assetPath: string): string {
  if (typeof window === "undefined") {
    throw new Error("Excalidraw font assets can only be configured in a browser.");
  }

  if (!assetPath.endsWith("/")) {
    throw new Error("The Excalidraw asset path must end with '/'.");
  }

  const resolved = new URL(assetPath, window.location.href);
  if (
    resolved.origin !== window.location.origin ||
    resolved.search.length > 0 ||
    resolved.hash.length > 0
  ) {
    throw new Error("Excalidraw fonts must be served from the current origin.");
  }

  (window as ExcalidrawWindow).EXCALIDRAW_ASSET_PATH = resolved.href;
  return resolved.href;
}

export function getConfiguredExcalidrawAssetPath(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const configured = (window as ExcalidrawWindow)[ASSET_PATH_KEY];
  if (!configured || !configured.endsWith("/")) return undefined;

  try {
    const resolved = new URL(configured, window.location.href);
    return resolved.origin === window.location.origin ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}
