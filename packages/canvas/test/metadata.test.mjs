import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasPackageMetadata,
  getConfiguredExcalidrawAssetPath,
} from "../dist/index.js";

test("the package root exposes metadata without loading browser UI", () => {
  assert.equal(canvasPackageMetadata.excalidrawVersion, "0.18.1");
  assert.equal(canvasPackageMetadata.sceneVersion, 2);
  assert.equal(getConfiguredExcalidrawAssetPath(), undefined);
});
