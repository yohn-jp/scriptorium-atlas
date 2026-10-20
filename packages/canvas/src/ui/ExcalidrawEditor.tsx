import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Excalidraw,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type {
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { PointerEvent as ReactPointerEvent } from "react";
import { restoreExcalidrawScene, serializeExcalidrawScene } from "../io/scene.js";
import type { CanvasEditorProps, CanvasPoint, CanvasViewport } from "./types.js";
import "@excalidraw/excalidraw/index.css";

type InternalProps = Pick<CanvasEditorProps, "sceneText" | "onChange" | "readOnly" | "renderOverlay">;
type ExcalidrawLinkEvent = CustomEvent<{
  nativeEvent: MouseEvent | ReactPointerEvent<HTMLCanvasElement>;
}>;

function makeInitialData(sceneText: string): ExcalidrawInitialDataState {
  const restored = restoreExcalidrawScene(sceneText);
  return {
    elements: restored.elements,
    appState: restored.appState,
    files: restored.files,
  };
}

export function ExcalidrawEditor({ sceneText, onChange, readOnly, renderOverlay }: InternalProps) {
  const [initialData] = useState(() => makeInitialData(sceneText));
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rawTextRef = useRef(sceneText);
  const [viewportRevision, setViewportRevision] = useState(0);

  const updateViewport = useCallback(() => setViewportRevision((revision) => revision + 1), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(root);
    updateViewport();
    return () => observer.disconnect();
  }, [updateViewport]);

  const viewport = useMemo<CanvasViewport>(() => {
    const api = apiRef.current;
    const state = api?.getAppState();
    const root = rootRef.current;
    const bounds = root?.getBoundingClientRect();
    const appState = state ?? {
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      offsetLeft: 0,
      offsetTop: 0,
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
    } as AppState;

    const toViewport = (point: CanvasPoint): CanvasPoint => {
      const position = sceneCoordsToViewportCoords(
        { sceneX: point.x, sceneY: point.y },
        appState,
      );
      return {
        x: position.x - (root?.getBoundingClientRect().left ?? 0),
        y: position.y - (root?.getBoundingClientRect().top ?? 0),
      };
    };
    const toScene = (point: CanvasPoint): CanvasPoint => {
      const position = viewportCoordsToSceneCoords(
        {
          clientX: point.x + (root?.getBoundingClientRect().left ?? 0),
          clientY: point.y + (root?.getBoundingClientRect().top ?? 0),
        },
        appState,
      );
      return position;
    };

    return {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
      width: appState.width,
      height: appState.height,
      sceneToViewport: toViewport,
      viewportToScene: toScene,
    };
  }, [viewportRevision]);

  const onExcalidrawChange = useCallback((
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const serialized = serializeExcalidrawScene(
      { elements, appState, files },
      rawTextRef.current,
    );
    if (serialized === rawTextRef.current) return;
    rawTextRef.current = serialized;
    onChange(serialized);
  }, [onChange]);

  const onApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    updateViewport();
  }, [updateViewport]);

  const overlay: ReactNode = renderOverlay?.(viewport);

  return (
    <div className="atlas-canvas-editor-surface" ref={rootRef}>
      <div className="atlas-canvas-excalidraw">
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={onApi}
          onChange={onExcalidrawChange}
          onScrollChange={updateViewport}
          langCode="ja-JP"
          viewModeEnabled={readOnly}
          validateEmbeddable={() => false}
          onLinkOpen={(
            _element: NonDeletedExcalidrawElement,
            event: ExcalidrawLinkEvent,
          ) => event.detail.nativeEvent.preventDefault()}
          aiEnabled={false}
          UIOptions={{
            canvasActions: {
              saveToActiveFile: false,
              loadScene: false,
              export: { saveFileToDisk: true },
            },
          }}
          autoFocus={false}
          detectScroll={false}
          handleKeyboardGlobally={false}
        />
      </div>
      <div className="atlas-canvas-overlay" aria-label="Canvas overlay">
        {overlay}
      </div>
    </div>
  );
}

export default ExcalidrawEditor;
