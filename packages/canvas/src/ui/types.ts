import type { CSSProperties, ReactNode } from "react";

export type CanvasPoint = Readonly<{ x: number; y: number }>;

export type CanvasViewport = Readonly<{
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
  sceneToViewport(point: CanvasPoint): CanvasPoint;
  viewportToScene(point: CanvasPoint): CanvasPoint;
}>;

export type CanvasEditorProps = {
  /** The exact `.excalidraw` document text owned by the Host draft. */
  sceneText: string;
  /** Emitted only after an actual drawing edit; pass it to the Host draft. */
  onChange(sceneText: string): void;
  className?: string;
  style?: CSSProperties;
  readOnly?: boolean;
  /** Atlas-owned cards can render here while remaining in `.atlas.json`. */
  renderOverlay?: (viewport: CanvasViewport) => ReactNode;
};
