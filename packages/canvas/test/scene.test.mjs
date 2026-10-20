import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectExcalidrawScene,
  preserveSceneExtensions,
} from "../dist/scene/index.js";

const baseElement = {
  id: "element-1",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 60,
  customData: { plugin: "atlas", nested: { retained: true } },
};

test("inspection keeps the original text and accepts supported Excalidraw v2 scenes", () => {
  const raw = ` { "type":"excalidraw", "version":2, "elements":[${JSON.stringify(baseElement)}] } `;
  const result = inspectExcalidrawScene(raw);

  assert.equal(result.status, "editable");
  assert.equal(result.rawText, raw);
});

test("future versions and unknown element kinds stay read-only with original bytes", () => {
  const future = '{"type":"excalidraw","version":3,"elements":[]}';
  const unknownElement = '{"type":"excalidraw","version":2,"elements":[{"id":"future","type":"future-shape"}]}';

  const futureResult = inspectExcalidrawScene(future);
  const unknownResult = inspectExcalidrawScene(unknownElement);

  assert.equal(futureResult.status, "read-only");
  assert.equal(futureResult.rawText, future);
  assert.equal(unknownResult.status, "read-only");
  assert.equal(unknownResult.rawText, unknownElement);
});

test("invalid JSON remains read-only and empty input creates a new scene without rewriting input", () => {
  const invalid = "{broken";
  const invalidResult = inspectExcalidrawScene(invalid);
  const emptyResult = inspectExcalidrawScene("  ");

  assert.equal(invalidResult.status, "read-only");
  assert.equal(invalidResult.rawText, invalid);
  assert.equal(emptyResult.status, "empty");
  assert.equal(emptyResult.rawText, "  ");
  assert.equal(emptyResult.data.version, 2);
});

test("serialization preserves nested unknown fields but honors element edits and deletions", () => {
  const original = {
    type: "excalidraw",
    version: 2,
    extension: { owner: "another-tool", retained: true },
    elements: [
      baseElement,
      { id: "element-2", type: "ellipse", x: 0, y: 0, width: 1, height: 1 },
    ],
    appState: { extensionState: { retained: true } },
  };
  const current = {
    type: "excalidraw",
    version: 2,
    source: "excalidraw",
    elements: [{ ...baseElement, x: 42, customData: { nested: { changed: true } } }],
    appState: { viewBackgroundColor: "#fff" },
    files: {},
  };

  const output = preserveSceneExtensions(original, JSON.stringify(current));
  const parsed = JSON.parse(output);

  assert.equal(parsed.extension.owner, "another-tool");
  assert.equal(parsed.extension.retained, true);
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0].x, 42);
  assert.equal(parsed.elements[0].customData.plugin, "atlas");
  assert.equal(parsed.elements[0].customData.nested.retained, true);
  assert.equal(parsed.elements[0].customData.nested.changed, true);
  assert.deepEqual(parsed.appState.extensionState, { retained: true });
  assert.ok(output.endsWith("\n"));
});
