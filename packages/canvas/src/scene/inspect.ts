export type ExcalidrawSceneData = {
  type: "excalidraw";
  version: number;
  source?: string;
  elements: unknown[];
  appState?: Record<string, unknown> | null;
  files?: Record<string, unknown>;
  [key: string]: unknown;
};

export type EditableSceneInspection = {
  status: "editable" | "empty";
  rawText: string;
  data: ExcalidrawSceneData;
};

export type ReadOnlySceneInspection = {
  status: "read-only";
  rawText: string;
  reason:
    | "invalid-json"
    | "unsupported-format"
    | "unsupported-version"
    | "unsupported-element";
  message: string;
};

export type SceneInspection = EditableSceneInspection | ReadOnlySceneInspection;

const ELEMENT_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "image",
  "frame",
  "magicframe",
  "embeddable",
  "iframe",
]);

export const EMPTY_EXCALIDRAW_SCENE: ExcalidrawSceneData = {
  type: "excalidraw",
  version: 2,
  source: "scriptorium-atlas",
  elements: [],
  appState: {},
  files: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inspectExcalidrawScene(rawText: string): SceneInspection {
  if (rawText.trim() === "") {
    return {
      status: "empty",
      rawText,
      data: EMPTY_EXCALIDRAW_SCENE,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return {
      status: "read-only",
      rawText,
      reason: "invalid-json",
      message: "このExcalidrawデータはJSONとして読めないため、原文のまま保持しています。",
    };
  }

  if (!isRecord(parsed) || parsed.type !== "excalidraw") {
    return {
      status: "read-only",
      rawText,
      reason: "unsupported-format",
      message: "このファイルは編集可能なExcalidrawシーンではありません。原文はそのまま保持しています。",
    };
  }

  if (parsed.version !== 2) {
    return {
      status: "read-only",
      rawText,
      reason: "unsupported-version",
      message: `Excalidraw version ${String(parsed.version)} はこのAtlas Canvasでは編集できません。原文はそのまま保持しています。`,
    };
  }

  if (!Array.isArray(parsed.elements)) {
    return {
      status: "read-only",
      rawText,
      reason: "unsupported-format",
      message: "Excalidraw elements が配列ではないため、原文のまま保持しています。",
    };
  }

  const seenIds = new Set<string>();
  const unknownElement = parsed.elements.find((element) => {
    if (!isRecord(element) || typeof element.type !== "string" || !ELEMENT_TYPES.has(element.type)) {
      return true;
    }
    if (
      typeof element.id !== "string" ||
      element.id.length === 0 ||
      seenIds.has(element.id) ||
      !Number.isFinite(element.x) ||
      !Number.isFinite(element.y) ||
      !Number.isFinite(element.width) ||
      !Number.isFinite(element.height)
    ) {
      return true;
    }
    seenIds.add(element.id);
    return false;
  });
  if (unknownElement) {
    const elementType = isRecord(unknownElement) ? String(unknownElement.type ?? "invalid") : "unknown";
    return {
      status: "read-only",
      rawText,
      reason: isRecord(unknownElement) && ELEMENT_TYPES.has(String(unknownElement.type))
        ? "unsupported-format"
        : "unsupported-element",
      message: `Excalidraw要素 (${elementType}) が未対応または不正なため編集を止めています。原文はそのまま保持しています。`,
    };
  }

  if (
    (parsed.appState !== undefined && parsed.appState !== null && !isRecord(parsed.appState)) ||
    (parsed.files !== undefined && !isRecord(parsed.files))
  ) {
    return {
      status: "read-only",
      rawText,
      reason: "unsupported-format",
      message: "Excalidraw appState または files の形式が不正なため、原文のまま保持しています。",
    };
  }

  return {
    status: "editable",
    rawText,
    data: parsed as ExcalidrawSceneData,
  };
}
