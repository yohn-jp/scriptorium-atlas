import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
  restoreElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElementSkeleton,
  ValidLinearElement,
} from "@excalidraw/excalidraw/data/transform";
import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawLinearElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

type AddKind = "rectangle" | "diamond" | "ellipse" | "arrow" | "freedraw" | "text";
type GeometryDraft = Readonly<{ x: string; y: string; width: string; height: string }>;
type Geometry = Readonly<{ x: number; y: number; width: number; height: number }>;

const CREATE_OPTIONS: ReadonlyArray<Readonly<{ value: AddKind; label: string }>> = [
  { value: "rectangle", label: "矩形" },
  { value: "diamond", label: "ひし形" },
  { value: "ellipse", label: "楕円" },
  { value: "arrow", label: "矢印" },
  { value: "freedraw", label: "フリーハンド" },
  { value: "text", label: "テキスト" },
];

function activeElementsSignature(elements: readonly ExcalidrawElement[]): string {
  return elements.map((element) => [
    element.id,
    element.version,
    element.type,
    element.x,
    element.y,
    element.width,
    element.height,
    element.groupIds.join(","),
    element.type === "text" ? element.text : "",
  ].join("\u001f")).join("\u001e");
}

function makeFreehandElement(
  x: number,
  y: number,
  appState: ReturnType<ExcalidrawImperativeAPI["getAppState"]>,
): ExcalidrawFreeDrawElement {
  const points: ExcalidrawFreeDrawElement["points"] = [
    [0, 0] as ExcalidrawFreeDrawElement["points"][number],
    [45, 28] as ExcalidrawFreeDrawElement["points"][number],
    [90, 8] as ExcalidrawFreeDrawElement["points"][number],
    [130, 40] as ExcalidrawFreeDrawElement["points"][number],
  ];

  return {
    id: crypto.randomUUID(),
    type: "freedraw",
    x,
    y,
    width: 130,
    height: 40,
    points,
    pressures: points.map(() => 0.5),
    simulatePressure: true,
    lastCommittedPoint: null,
    strokeColor: appState.currentItemStrokeColor,
    backgroundColor: appState.currentItemBackgroundColor,
    fillStyle: appState.currentItemFillStyle,
    strokeWidth: appState.currentItemStrokeWidth,
    strokeStyle: appState.currentItemStrokeStyle,
    roundness: null,
    roughness: appState.currentItemRoughness,
    opacity: appState.currentItemOpacity,
    angle: 0 as ExcalidrawFreeDrawElement["angle"],
    seed: Math.floor(Math.random() * 2_147_483_647),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_147_483_647),
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function makeArrowSkeleton(x: number, y: number): ValidLinearElement {
  const points: ExcalidrawLinearElement["points"] = [
    [0, 0] as ExcalidrawLinearElement["points"][number],
    [130, 64] as ExcalidrawLinearElement["points"][number],
  ];
  return { type: "arrow", x, y, points };
}

function createElement(
  kind: AddKind,
  x: number,
  y: number,
  text: string,
  api: ExcalidrawImperativeAPI,
): OrderedExcalidrawElement[] {
  let skeleton: ExcalidrawElementSkeleton;
  switch (kind) {
    case "rectangle":
    case "diamond":
    case "ellipse":
      skeleton = { type: kind, x, y, width: 130, height: 80 };
      break;
    case "arrow":
      skeleton = makeArrowSkeleton(x, y);
      break;
    case "freedraw":
      skeleton = makeFreehandElement(x, y, api.getAppState());
      break;
    case "text":
      skeleton = { type: "text", x, y, text };
      break;
  }

  return restoreElements(
    convertToExcalidrawElements([skeleton], { regenerateIds: true }),
    null,
    { refreshDimensions: true },
  );
}

function sceneCenter(api: ExcalidrawImperativeAPI, root: HTMLDivElement): { x: number; y: number } {
  const bounds = root.getBoundingClientRect();
  const point = viewportCoordsToSceneCoords({
    clientX: bounds.left + bounds.width / 2,
    clientY: bounds.top + bounds.height / 2,
  }, api.getAppState());
  return { x: point.x, y: point.y };
}

function scaledPoints<TPoint extends readonly [number, number]>(
  points: readonly TPoint[],
  scaleX: number,
  scaleY: number,
): TPoint[] {
  return points.map((point) => [point[0] * scaleX, point[1] * scaleY] as unknown as TPoint);
}

function withGeometry(
  element: OrderedExcalidrawElement,
  geometry: Geometry,
): OrderedExcalidrawElement {
  const scaleX = geometry.width / (element.width || 1);
  const scaleY = geometry.height / (element.height || 1);
  const updates = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };

  if (element.type === "freedraw" || element.type === "arrow" || element.type === "line") {
    return newElementWith(element, {
      ...updates,
      points: scaledPoints(element.points, scaleX, scaleY),
    }, true);
  }
  return newElementWith(element, updates, true);
}

function elementLabel(element: ExcalidrawElement, index: number): string {
  const text = element.type === "text" ? ` — ${element.text.slice(0, 28)}` : "";
  return `${CREATE_OPTIONS.find((option) => option.value === element.type)?.label ?? element.type} ${index + 1} (${element.id.slice(0, 8)})${text}`;
}

function geometryDraft(element: ExcalidrawElement): GeometryDraft {
  return {
    x: String(element.x),
    y: String(element.y),
    width: String(element.width),
    height: String(element.height),
  };
}

function parseGeometry(draft: GeometryDraft): Geometry | null {
  const values = [draft.x, draft.y, draft.width, draft.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null;
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function isGrouped(element: ExcalidrawElement): boolean {
  return element.groupIds.length > 0;
}

export function KeyboardControls({
  api,
  canvasRoot,
}: {
  api: ExcalidrawImperativeAPI;
  canvasRoot: HTMLDivElement;
}) {
  const [elements, setElements] = useState<readonly OrderedExcalidrawElement[]>(() => [
    ...api.getSceneElements(),
  ]);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(() =>
    Object.keys(api.getAppState().selectedElementIds).sort(),
  );
  const [kind, setKind] = useState<AddKind>("rectangle");
  const [text, setText] = useState("テキスト");
  const [draft, setDraft] = useState<GeometryDraft>({ x: "0", y: "0", width: "100", height: "80" });
  const [status, setStatus] = useState("");
  const elementSignatureRef = useRef(activeElementsSignature(elements));
  const selectionSignatureRef = useRef(selectedIds.join("\u001f"));

  useEffect(() => {
    const refresh = (nextElements: readonly ExcalidrawElement[], appState: ReturnType<typeof api.getAppState>) => {
      const nextElementSignature = activeElementsSignature(nextElements.filter((element) => !element.isDeleted));
      if (elementSignatureRef.current !== nextElementSignature) {
        elementSignatureRef.current = nextElementSignature;
        setElements([...api.getSceneElements()]);
      }

      const nextSelectedIds = Object.keys(appState.selectedElementIds).sort();
      const nextSelectionSignature = nextSelectedIds.join("\u001f");
      if (selectionSignatureRef.current !== nextSelectionSignature) {
        selectionSignatureRef.current = nextSelectionSignature;
        setSelectedIds(nextSelectedIds);
      }
    };

    refresh(api.getSceneElements(), api.getAppState());
    return api.onChange(refresh);
  }, [api]);

  const selectedElements = useMemo(
    () => elements.filter((element) => selectedIds.includes(element.id)),
    [elements, selectedIds],
  );
  const selectedElement = selectedElements.length === 1 ? selectedElements[0] : null;
  const selectedElementSignature = selectedElement
    ? [selectedElement.id, selectedElement.version, selectedElement.x, selectedElement.y,
      selectedElement.width, selectedElement.height].join("\u001f")
    : "";

  useEffect(() => {
    if (selectedElement) setDraft(geometryDraft(selectedElement));
  }, [selectedElementSignature]);

  const updateSelection = useCallback((ids: readonly string[]) => {
    const uniqueIds = [...new Set(ids)].filter((id) => elements.some((element) => element.id === id)).sort();
    const signature = uniqueIds.join("\u001f");
    selectionSignatureRef.current = signature;
    setSelectedIds(uniqueIds);
    api.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(uniqueIds.map((id) => [id, true])),
        selectedGroupIds: {},
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [api, elements]);

  const addElement = () => {
    const center = sceneCenter(api, canvasRoot);
    const offset = (elements.length % 7) * 24;
    const created = createElement(kind, center.x + offset, center.y + offset, text, api);
    const allElements = api.getSceneElementsIncludingDeleted();
    const nextElements = [...allElements, ...created];
    api.updateScene({
      elements: nextElements,
      appState: {
        selectedElementIds: Object.fromEntries(created.map((element) => [element.id, true])),
        selectedGroupIds: {},
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setStatus(`${CREATE_OPTIONS.find((option) => option.value === kind)?.label ?? kind}を追加しました。`);
  };

  const applyGeometry = () => {
    if (!selectedElement) return;
    const nextGeometry = parseGeometry(draft);
    if (!nextGeometry) {
      setStatus("X、Yには数値、幅、高さには0より大きい数値を入力してください。");
      return;
    }

    const currentElements: readonly OrderedExcalidrawElement[] = api.getSceneElementsIncludingDeleted();
    const nextElements = currentElements.map((element) =>
      element.id === selectedElement.id ? withGeometry(element, nextGeometry) : element,
    );
    api.updateScene({ elements: nextElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setStatus("位置とサイズを更新しました。");
  };

  const groupSelection = () => {
    if (selectedElements.length < 2) return;
    const groupId = crypto.randomUUID();
    const selected = new Set(selectedIds);
    const currentElements: readonly OrderedExcalidrawElement[] = api.getSceneElementsIncludingDeleted();
    const nextElements = currentElements.map((element) => selected.has(element.id)
      ? newElementWith(element, { groupIds: [...element.groupIds, groupId] }, true)
      : element);
    api.updateScene({ elements: nextElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setStatus(`${selectedElements.length}個の要素をグループ化しました。`);
  };

  const ungroupSelection = () => {
    const selected = new Set(selectedIds);
    const currentElements: readonly OrderedExcalidrawElement[] = api.getSceneElementsIncludingDeleted();
    const nextElements = currentElements.map((element) => {
      if (!selected.has(element.id) || !isGrouped(element)) return element;
      return newElementWith(element, { groupIds: element.groupIds.slice(0, -1) }, true);
    });
    api.updateScene({ elements: nextElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setStatus("選択した要素のグループを解除しました。");
  };

  const canUngroup = selectedElements.some(isGrouped);

  return (
    <div className="atlas-canvas-accessibility-content">
      <p>追加、要素の選択、位置とサイズの編集をキーボードで行えます。画像はExcalidrawの「画像を挿入」（9）を使ってください。</p>

      <fieldset>
        <legend>要素を追加</legend>
        <label>
          種類
          <select aria-label="追加する要素" value={kind} onChange={(event) => setKind(event.currentTarget.value as AddKind)}>
            {CREATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {kind === "text" && (
          <label>
            文字
            <input aria-label="追加する文字" value={text} onChange={(event) => setText(event.currentTarget.value)} />
          </label>
        )}
        <button type="button" onClick={addElement}>要素を追加</button>
      </fieldset>

      <fieldset>
        <legend>要素一覧</legend>
        <div className="atlas-canvas-accessibility-actions">
          <button type="button" onClick={() => updateSelection(elements.map((element) => element.id))} disabled={elements.length === 0}>
            すべて選択
          </button>
          <button type="button" onClick={() => updateSelection([])} disabled={selectedIds.length === 0}>
            選択を解除
          </button>
          <button type="button" onClick={groupSelection} disabled={selectedElements.length < 2}>
            選択をグループ化
          </button>
          <button type="button" onClick={ungroupSelection} disabled={!canUngroup}>
            選択をグループ解除
          </button>
        </div>
        {elements.length === 0 ? (
          <p>要素はありません。</p>
        ) : (
          <ul className="atlas-canvas-accessibility-list" aria-label="Canvas要素">
            {elements.map((element, index) => (
              <li key={element.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(element.id)}
                    onChange={(event) => updateSelection(event.currentTarget.checked
                      ? [...selectedIds, element.id]
                      : selectedIds.filter((id) => id !== element.id))}
                  />
                  <span>{elementLabel(element, index)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {selectedElement && (
        <fieldset>
          <legend>選択要素の位置とサイズ</legend>
          <label>
            X
            <input aria-label="選択要素のX座標" type="number" step="1" value={draft.x}
              onChange={(event) => setDraft({ ...draft, x: event.currentTarget.value })} />
          </label>
          <label>
            Y
            <input aria-label="選択要素のY座標" type="number" step="1" value={draft.y}
              onChange={(event) => setDraft({ ...draft, y: event.currentTarget.value })} />
          </label>
          <label>
            幅
            <input aria-label="選択要素の幅" type="number" min="1" step="1" value={draft.width}
              onChange={(event) => setDraft({ ...draft, width: event.currentTarget.value })} />
          </label>
          <label>
            高さ
            <input aria-label="選択要素の高さ" type="number" min="1" step="1" value={draft.height}
              onChange={(event) => setDraft({ ...draft, height: event.currentTarget.value })} />
          </label>
          <button type="button" onClick={applyGeometry}>位置とサイズを適用</button>
        </fieldset>
      )}
      <p className="atlas-canvas-accessibility-status" role="status" aria-live="polite">{status}</p>
    </div>
  );
}

