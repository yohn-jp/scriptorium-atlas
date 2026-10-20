import type { ExcalidrawSceneData } from "./inspect.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeObject(source: JsonRecord, current: JsonRecord): JsonRecord {
  const result: JsonRecord = { ...source };
  for (const [key, value] of Object.entries(current)) {
    result[key] = isRecord(value) && isRecord(source[key])
      ? mergeObject(source[key] as JsonRecord, value)
      : value;
  }
  return result;
}

function mergeElements(sourceElements: unknown[], currentElements: unknown[]): unknown[] {
  const sourceById = new Map<string, JsonRecord>();
  for (const element of sourceElements) {
    if (isRecord(element) && typeof element.id === "string") {
      sourceById.set(element.id, element);
    }
  }

  return currentElements.map((element) => {
    if (!isRecord(element) || typeof element.id !== "string") return element;
    const source = sourceById.get(element.id);
    return source ? mergeObject(source, element) : element;
  });
}

/**
 * Retain fields the installed Excalidraw serializer does not know about while
 * letting its current values win for every field it does emit. Deleted scene
 * elements remain deleted because the serialized element list is authoritative.
 */
export function preserveSceneExtensions(
  original: ExcalidrawSceneData,
  serializedText: string,
): string {
  const serialized = JSON.parse(serializedText) as unknown;
  if (!isRecord(serialized) || !Array.isArray(serialized.elements)) return serializedText;

  const merged = mergeObject(original, serialized);
  merged.elements = mergeElements(original.elements, serialized.elements);
  return `${JSON.stringify(merged, null, 2)}\n`;
}
