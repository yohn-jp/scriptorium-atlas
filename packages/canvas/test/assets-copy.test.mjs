import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { copyCanvasAssets } from "@scriptorium-atlas/canvas/assets";

test("Node asset helper copies pinned fonts and emits reproducible license/hash metadata", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "atlas-canvas-assets-"));
  try {
    const result = await copyCanvasAssets(temporaryRoot);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const notice = await readFile(result.noticePath, "utf8");

    assert.equal(result.outputDirectory, resolve(temporaryRoot));
    assert.equal(result.fontDirectory, resolve(temporaryRoot, "fonts"));
    assert.equal(result.excalidrawVersion, "0.18.1");
    assert.ok(result.fileCount > 0);
    assert.ok(result.totalBytes > 0);
    assert.equal(manifest.totalBytes, result.totalBytes);
    assert.equal(manifest.hashAlgorithm, "sha256");
    assert.equal(manifest.source.package, "@excalidraw/excalidraw");
    assert.equal(manifest.source.version, "0.18.1");
    assert.ok(manifest.files.some(({ family }) => family === "Excalifont"));
    assert.ok(manifest.files.some(({ license }) => license === "MIT"));
    assert.ok(manifest.files.some(({ license }) => license === "OFL-1.1"));
    assert.match(notice, /Comic Shanns Mono/);
    assert.match(notice, /SIL Open Font License 1\.1/);

    const firstAsset = manifest.files[0];
    const assetBytes = await readFile(join(result.fontDirectory, firstAsset.path));
    const actualHash = createHash("sha256").update(assetBytes).digest("hex");
    assert.equal(firstAsset.sha256, actualHash);
    assert.equal(firstAsset.bytes, assetBytes.byteLength);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
