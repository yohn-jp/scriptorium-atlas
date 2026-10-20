import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getConfiguredExcalidrawAssetPath } from "../assets.js";
import { inspectExcalidrawScene } from "../scene/inspect.js";
import type { CanvasEditorProps } from "./types.js";
import "./styles.css";

export type { CanvasEditorProps, CanvasPoint, CanvasViewport, CanvasViewportState } from "./types.js";

function downloadRawScene(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "drawing.excalidraw";
  link.rel = "noopener";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ReadOnlyScene({ sceneText, message }: { sceneText: string; message: string }) {
  return (
    <section className="atlas-canvas atlas-canvas-readonly" aria-label="読み取り専用のExcalidrawデータ">
      <p role="status">{message}</p>
      <button type="button" onClick={() => downloadRawScene(sceneText)}>
        原文をダウンロード
      </button>
    </section>
  );
}

function FontAssetError({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <section className={`atlas-canvas atlas-canvas-error ${className ?? ""}`} style={style} role="alert">
      Excalidrawのフォントを同一オリジンから配信できるよう、Canvasを表示する前に
      configureExcalidrawAssets() を設定してください。
    </section>
  );
}

export function CanvasEditor(props: CanvasEditorProps) {
  const inspection = inspectExcalidrawScene(props.sceneText);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const lastEmittedText = useRef<string | null>(null);
  const lastPropText = useRef(props.sceneText);
  const onChange = useRef(props.onChange);
  const onViewportChange = useRef(props.onViewportChange);
  onChange.current = props.onChange;
  onViewportChange.current = props.onViewportChange;

  useEffect(() => {
    if (lastEmittedText.current === props.sceneText) {
      lastEmittedText.current = null;
    } else if (lastPropText.current !== props.sceneText) {
      setEditorEpoch((epoch) => epoch + 1);
    }
    lastPropText.current = props.sceneText;
  }, [props.sceneText]);

  const assetPath = getConfiguredExcalidrawAssetPath();
  const LazyEditor = useMemo(
    () => lazy(async () => {
      if (!assetPath) {
        throw new Error("Excalidraw fonts must be configured for same-origin hosting before the editor is loaded.");
      }
      // Excalidraw reads this global while its editor module initializes.
      (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = assetPath;
      return import("./ExcalidrawEditor.js");
    }),
    [assetPath],
  );

  if (inspection.status === "read-only") {
    return <ReadOnlyScene sceneText={props.sceneText} message={inspection.message} />;
  }

  if (!assetPath) {
    return <FontAssetError className={props.className} style={props.style} />;
  }

  return (
    <div className={`atlas-canvas ${props.className ?? ""}`} style={props.style}>
      <Suspense fallback={<div className="atlas-canvas-loading" role="status">Canvasを読み込んでいます…</div>}>
        <LazyEditor
          key={editorEpoch}
          sceneText={props.sceneText}
          onChange={(sceneText) => {
            lastEmittedText.current = sceneText;
            onChange.current(sceneText);
          }}
          readOnly={props.readOnly ?? false}
          viewport={props.viewport}
          onViewportChange={(viewport) => onViewportChange.current?.(viewport)}
          renderOverlay={props.renderOverlay}
        />
      </Suspense>
    </div>
  );
}
