import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CaptureUpdateAction,
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
import type {
  CanvasEditorProps,
  CanvasPoint,
  CanvasViewport,
  CanvasViewportState,
} from "./types.js";
import { KeyboardControls } from "./KeyboardControls.js";
import "@excalidraw/excalidraw/index.css";

type InternalProps = Pick<
  CanvasEditorProps,
  "sceneText" | "onChange" | "readOnly" | "renderOverlay" | "viewport" | "onViewportChange"
>;
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

function validViewportState(value: CanvasViewportState | undefined): CanvasViewportState | null {
  if (!value
    || !Number.isFinite(value.scrollX)
    || !Number.isFinite(value.scrollY)
    || !Number.isFinite(value.zoom)
    || value.zoom <= 0) {
    return null;
  }
  return value;
}

function viewportStateFromAppState(appState: AppState): CanvasViewportState {
  return {
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom.value,
  };
}

function sameViewportState(
  left: CanvasViewportState | null,
  right: CanvasViewportState | null,
): boolean {
  return left === right || Boolean(left && right
    && Math.abs(left.scrollX - right.scrollX) < 0.0001
    && Math.abs(left.scrollY - right.scrollY) < 0.0001
    && Math.abs(left.zoom - right.zoom) < 0.0001);
}

function makeInitialData(
  sceneText: string,
  viewport?: CanvasViewportState,
): ExcalidrawInitialDataState {
  const restored = restoreExcalidrawScene(sceneText);
  const initialViewport = validViewportState(viewport);
  return {
    elements: restored.elements,
    appState: initialViewport
      ? {
        ...restored.appState,
        scrollX: initialViewport.scrollX,
        scrollY: initialViewport.scrollY,
        zoom: { value: initialViewport.zoom as AppState["zoom"]["value"] },
      }
      : restored.appState,
    files: restored.files,
  };
}

export function ExcalidrawEditor({
  sceneText,
  onChange,
  readOnly,
  renderOverlay,
  viewport: savedViewport,
  onViewportChange,
}: InternalProps) {
  const [initialData] = useState(() => makeInitialData(sceneText, savedViewport));
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rawTextRef = useRef(sceneText);
  const refreshFrameRef = useRef<number | null>(null);
  const viewportTimerRef = useRef<number | null>(null);
  const latestViewportRef = useRef<CanvasViewportState | null>(validViewportState(savedViewport));
  const previousViewportRef = useRef<CanvasViewportState | null>(validViewportState(savedViewport));
  const lastReportedViewportRef = useRef<CanvasViewportState | null>(null);
  const onViewportChangeRef = useRef(onViewportChange);
  latestViewportRef.current = validViewportState(savedViewport);
  onViewportChangeRef.current = onViewportChange;
  const [viewportRevision, setViewportRevision] = useState(0);
  const [controlsExpanded, setControlsExpanded] = useState(false);

  const updateViewport = useCallback(() => setViewportRevision((revision) => revision + 1), []);

  const cancelViewportReport = useCallback(() => {
    if (viewportTimerRef.current !== null) {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
  }, []);

  const reportSettledViewport = useCallback(() => {
    viewportTimerRef.current = null;
    const appState = apiRef.current?.getAppState();
    if (!appState) return;
    const current = viewportStateFromAppState(appState);
    if (sameViewportState(lastReportedViewportRef.current, current)) return;
    lastReportedViewportRef.current = current;
    onViewportChangeRef.current?.(current);
  }, []);

  const scheduleViewportReport = useCallback(() => {
    cancelViewportReport();
    viewportTimerRef.current = window.setTimeout(reportSettledViewport, 180);
  }, [cancelViewportReport, reportSettledViewport]);

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

  const applyViewportState = useCallback((api: ExcalidrawImperativeAPI, next: CanvasViewportState) => {
    const current = viewportStateFromAppState(api.getAppState());
    if (sameViewportState(current, next)) {
      lastReportedViewportRef.current = current;
      return;
    }

    cancelViewportReport();
    // View restoration belongs to Atlas board state, not Excalidraw's undoable
    // drawing history or the raw `.excalidraw` scene text.
    lastReportedViewportRef.current = next;
    api.updateScene({
      appState: {
        scrollX: next.scrollX,
        scrollY: next.scrollY,
        zoom: { value: next.zoom as AppState["zoom"]["value"] },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    refreshSceneBounds();
  }, [cancelViewportReport, refreshSceneBounds]);

  useEffect(() => {
    const next = latestViewportRef.current;
    if (sameViewportState(previousViewportRef.current, next)) return;
    previousViewportRef.current = next ? { ...next } : null;
    cancelViewportReport();

    const api = apiRef.current;
    if (next && api) {
      applyViewportState(api, next);
    } else if (api) {
      lastReportedViewportRef.current = viewportStateFromAppState(api.getAppState());
    }
  }, [
    savedViewport?.scrollX,
    savedViewport?.scrollY,
    savedViewport?.zoom,
    applyViewportState,
    cancelViewportReport,
  ]);

  useEffect(() => () => {
    // The active board may switch while a pan is in its debounce window. Flush
    // the last official state through the callback captured by this editor,
    // without scheduling React state updates during unmount.
    cancelViewportReport();
    reportSettledViewport();
  }, [cancelViewportReport, reportSettledViewport]);

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
  const keyboardViewport: CanvasViewportState = {
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    zoom: viewport.zoom,
  };

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
    if (lastReportedViewportRef.current === null) {
      lastReportedViewportRef.current = viewportStateFromAppState(api.getAppState());
    }
    const initialViewport = latestViewportRef.current;
    if (initialViewport) applyViewportState(api, initialViewport);
    refreshSceneBounds();
  }, [applyViewportState, refreshSceneBounds]);

  const onExcalidrawScrollChange = useCallback(() => {
    refreshSceneBounds();
    scheduleViewportReport();
  }, [refreshSceneBounds, scheduleViewportReport]);

  const overlay: ReactNode = renderOverlay?.(viewport);

  return (
    <div className="atlas-canvas-editor-surface" ref={rootRef}>
      <div className="atlas-canvas-excalidraw" onKeyDownCapture={activateHistoryButtonWithKeyboard}>
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={onApi}
          onChange={onExcalidrawChange}
          onScrollChange={onExcalidrawScrollChange}
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
            <KeyboardControls
              api={apiRef.current}
              canvasRoot={rootRef.current}
              viewport={keyboardViewport}
              onViewportAction={onExcalidrawScrollChange}
            />
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
