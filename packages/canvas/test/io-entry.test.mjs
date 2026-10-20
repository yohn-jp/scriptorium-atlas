import assert from "node:assert/strict";
import test from "node:test";
import * as canvasIo from "@scriptorium-atlas/canvas/io";

test("the public I/O entry resolves without eagerly loading the Excalidraw runtime", () => {
  assert.equal(typeof canvasIo.createEmptyExcalidrawScene, "function");
  assert.equal(typeof canvasIo.restoreExcalidrawScene, "function");
  assert.equal(typeof canvasIo.serializeExcalidrawScene, "function");
  assert.equal(typeof canvasIo.exportExcalidrawScene, "function");
  assert.equal(typeof canvasIo.downloadExcalidrawScene, "function");
});
