import type { CSSProperties, ReactNode } from "react";

export type CanvasPoint = Readonly<{ x: number; y: number }>;

/** Excalidraw's persisted board-view values, independent of the raw scene file. */
export type CanvasViewportState = Readonly<{
  /** Scene-space horizontal scroll offset. */
  scrollX: number;
  /** Scene-space vertical scroll offset. */
  scrollY: number;
  /** Excalidraw zoom multiplier. */
  zoom: number;
}>;

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
  /** Restore the active board view; scene files intentionally omit this transient state. */
  viewport?: CanvasViewportState;
  /** Emits settled pan/zoom without changing scene text; flushes a pending value when this editor unmounts. */
  onViewportChange?(viewport: CanvasViewportState): void;
  /** Atlas-owned cards can render here while remaining in `.atlas.json`. */
  renderOverlay?: (viewport: CanvasViewport) => ReactNode;
};
