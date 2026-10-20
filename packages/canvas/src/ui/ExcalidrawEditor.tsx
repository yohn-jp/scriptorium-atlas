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
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { restoreExcalidrawScene, serializeExcalidrawScene } from "../io/scene-core.js";
import type { CanvasEditorProps, CanvasPoint, CanvasViewport } from "./types.js";
import { KeyboardControls } from "./KeyboardControls.js";
import "@excalidraw/excalidraw/index.css";

type InternalProps = Pick<CanvasEditorProps, "sceneText" | "onChange" | "readOnly" | "renderOverlay">;
type ExcalidrawLinkEvent = CustomEvent<{
  nativeEvent: MouseEvent | ReactPointerEvent<HTMLCanvasElement>;
}>;

function activateHistoryButtonWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  if (event.repeat || (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar")) return;
  if (!(event.target instanceof Element)) return;

  const button = event.target.closest<HTMLButtonElement>(
    'button[data-testid="button-undo"], button[data-testid="button-redo"]',
  );
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;

  // Excalidraw 0.18.1 renders these history controls as buttons but does not
  // activate them from keyboard events. Invoke the same official button action
  // after preventing the browser's synthetic activation from duplicating it.
  event.preventDefault();
  event.stopPropagation();
  button.click();
}

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
  const refreshFrameRef = useRef<number | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [controlsExpanded, setControlsExpanded] = useState(false);

  const updateViewport = useCallback(() => setViewportRevision((revision) => revision + 1), []);

  const refreshSceneBounds = useCallback(() => {
    if (refreshFrameRef.current !== null) return;
    refreshFrameRef.current = window.requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      const api = apiRef.current;
      const container = rootRef.current?.querySelector<HTMLElement>(".excalidraw-container");
      if (!api || !container) {
        updateViewport();
        return;
      }

      const bounds = container.getBoundingClientRect();
      const appState = api.getAppState();
      const moved = Math.abs(bounds.left - appState.offsetLeft) > 0.5
        || Math.abs(bounds.top - appState.offsetTop) > 0.5;
      if (moved) {
        // Excalidraw caches this DOM offset for pointer hit testing. Its
        // detectScroll listener can attach before the Host iframe's eventual
        // scroll container is established, so refresh through its public API
        // when ancestor layout or scrolling moves the official container.
        api.refresh();
        window.requestAnimationFrame(updateViewport);
        return;
      }
      updateViewport();
    });
  }, [updateViewport]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(refreshSceneBounds);
      // Ancestor size changes can move the editor without changing its own
      // dimensions (for example, when a Host frame finishes laying out its
      // toolbar). Excalidraw's own observer only tracks its container size.
      for (let ancestor: HTMLElement | null = root; ancestor; ancestor = ancestor.parentElement) {
        observer.observe(ancestor);
      }
    }

    // Scroll events from nested Host containers do not bubble. Capturing at
    // the document lets the wrapper refresh Excalidraw if its initial
    // detectScroll target was chosen before that container became scrollable.
    document.addEventListener("scroll", refreshSceneBounds, true);
    refreshSceneBounds();
    return () => {
      observer?.disconnect();
      document.removeEventListener("scroll", refreshSceneBounds, true);
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
    };
  }, [refreshSceneBounds]);

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
    refreshSceneBounds();
  }, [refreshSceneBounds]);

  const overlay: ReactNode = renderOverlay?.(viewport);

  return (
    <div className="atlas-canvas-editor-surface" ref={rootRef}>
      <div className="atlas-canvas-excalidraw" onKeyDownCapture={activateHistoryButtonWithKeyboard}>
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={onApi}
          onChange={onExcalidrawChange}
          onScrollChange={refreshSceneBounds}
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
          // Canvas can scroll inside the Host-owned iframe; Excalidraw needs
          // to refresh its coordinate offset so pointer hit-testing stays
          // aligned with the visible scene after that document scrolls.
          detectScroll
          handleKeyboardGlobally={false}
        />
      </div>
      {!readOnly && (
        <details
          className="atlas-canvas-accessibility"
          onToggle={(event) => setControlsExpanded(event.currentTarget.open)}
        >
          <summary>キーボード操作と要素一覧</summary>
          {controlsExpanded && apiRef.current && rootRef.current && (
            <KeyboardControls api={apiRef.current} canvasRoot={rootRef.current} />
          )}
        </details>
      )}
      <div className="atlas-canvas-overlay" aria-label="Canvas overlay">
        {overlay}
      </div>
    </div>
  );
}

export default ExcalidrawEditor;
