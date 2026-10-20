import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { copyCanvasAssets, excalidrawWorkerVitePlugin } from "@scriptorium-atlas/canvas/assets";

test("Vite plugin rewrites only Excalidraw's pinned unqueried production subset worker import", () => {
  const require = createRequire(import.meta.url);
  const productionDirectory = dirname(require.resolve("@excalidraw/excalidraw"));
  const importer = resolve(productionDirectory, "chunk-K2UTITRG.js");
  const worker = resolve(productionDirectory, "subset-worker.chunk.js");
  const plugin = excalidrawWorkerVitePlugin();

  assert.equal(plugin.name, "@scriptorium-atlas/canvas/excalidraw-worker");
  assert.equal(plugin.enforce, "pre");
  const virtualId = plugin.resolveId("./subset-worker.chunk.js", importer);
  assert.match(virtualId ?? "", /^\0@scriptorium-atlas\/canvas\/excalidraw-subset-worker:/u);
  assert.equal(plugin.resolveId("./subset-worker.chunk.js?raw", importer), null);
  assert.equal(plugin.resolveId("./subset-worker.chunk.js", `${importer}?worker`), null);
  assert.equal(plugin.resolveId("./subset-shared.chunk.js", importer), null);
  assert.equal(plugin.resolveId("./subset-worker.chunk.js", resolve(productionDirectory, "index.js")), null);
  assert.equal(plugin.resolveId("./subset-worker.chunk.js", "/other-package/chunk-K2UTITRG.js"), null);

  const virtualModule = plugin.load(virtualId);
  assert.ok(virtualModule);
  assert.ok(virtualModule.includes(`${worker}?worker&url`));
  assert.ok(virtualModule.includes("export const WorkerUrl = new URL(workerUrl, import.meta.url);"));
  assert.equal(plugin.load("\0unrelated-module"), null);
});

test("Node asset helper copies pinned fonts and emits reproducible license/hash metadata", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "atlas-canvas-assets-"));
  try {
    const result = await copyCanvasAssets(temporaryRoot);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const notice = await readFile(result.noticePath, "utf8");
    const expectedFamilyCounts = {
      Assistant: 4,
      Cascadia: 1,
      ComicShanns: 4,
      Excalifont: 7,
      Liberation: 1,
      Lilita: 2,
      Nunito: 5,
      Virgil: 1,
      Xiaolai: 209,
    };
    const expectedFamilyPolicies = {
      Assistant: ["Assistant", "OFL-1.1", "The Assistant Project Authors; The Source Sans Pro Authors"],
      Cascadia: ["Cascadia Code", "OFL-1.1", "Microsoft Corporation"],
      ComicShanns: ["Comic Shanns Mono", "MIT", "Shannon Miwa; Jesus Gonzalez; Rodrigo Batista de Moraes; Fini Jastrow; Kyle Beechly"],
      Excalifont: ["Excalifont", "OFL-1.1", "Excalidraw (copyright); Your Own Font Foundry (Virgil); Ján Filípek / DizajnDesign (modifications)"],
      Liberation: ["Liberation Sans", "OFL-1.1", "Google Corporation; Red Hat, Inc."],
      Lilita: ["Lilita One", "OFL-1.1", "Juan Montoreano"],
      Nunito: ["Nunito", "OFL-1.1", "The Nunito Project Authors"],
      Virgil: ["Virgil", "OFL-1.1", "Ellinor Rapp"],
      Xiaolai: ["Xiaolai SC", "OFL-1.1", "LXGW (copyright); Nozomi Seto (designer)"],
    };

    assert.equal(result.outputDirectory, resolve(temporaryRoot));
    assert.equal(result.fontDirectory, resolve(temporaryRoot, "fonts"));
    assert.equal(result.excalidrawVersion, "0.18.1");
    assert.equal(result.fileCount, 234);
    assert.ok(result.totalBytes > 0);
    assert.equal(manifest.totalBytes, result.totalBytes);
    assert.equal(manifest.hashAlgorithm, "sha256");
    assert.equal(manifest.source.package, "@excalidraw/excalidraw");
    assert.equal(manifest.source.version, "0.18.1");
    assert.deepEqual(Object.keys(manifest.licenses).sort(), ["MIT", "OFL-1.1"]);
    assert.deepEqual(
      Object.fromEntries(manifest.fontFamilies.map(({ directory, fileCount }) => [directory, fileCount])),
      expectedFamilyCounts,
    );
    assert.equal(manifest.files.length, 234);

    for (const [spdx, license] of Object.entries(manifest.licenses)) {
      const licenseBytes = await readFile(join(result.fontDirectory, license.path));
      assert.equal(license.bytes, licenseBytes.byteLength);
      assert.equal(license.sha256, createHash("sha256").update(licenseBytes).digest("hex"));
      assert.match(license.sourceUrl, /\/v0\.18\.1\//);
      assert.ok(notice.includes(license.path));
      assert.ok(notice.includes(license.sha256));
      assert.ok(notice.includes(license.sourceUrl));
      if (spdx === "MIT") assert.match(licenseBytes.toString("utf8"), /Copyright \(c\) 2024 Kyle Beechly/);
      if (spdx === "OFL-1.1") assert.match(licenseBytes.toString("utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
    }

    const observedFamilyCounts = {};
    for (const asset of manifest.files) {
      const directory = asset.path.split("/")[0];
      const [family, license, sourceOwner] = expectedFamilyPolicies[directory] ?? [];
      assert.ok(family, `unexpected font family directory ${directory}`);
      observedFamilyCounts[directory] = (observedFamilyCounts[directory] ?? 0) + 1;
      assert.equal(asset.family, family);
      assert.equal(asset.license, license);
      assert.equal(asset.sourceOwner, sourceOwner);
      assert.equal(asset.licenseTextPath, manifest.licenses[license].path);
      assert.match(asset.familySourceUrl, /\/tree\/v0\.18\.1\/packages\/excalidraw\/fonts\//);
      assert.ok(
        asset.licenseSourceUrl.includes("/v0.18.1/") || /\/[0-9a-f]{40}\//.test(asset.licenseSourceUrl),
        `license source for ${asset.path} is not pinned`,
      );
      assert.ok(notice.includes(asset.familySourceUrl));
      assert.ok(notice.includes(asset.licenseSourceUrl));

      const assetBytes = await readFile(join(result.fontDirectory, asset.path));
      assert.equal(asset.bytes, assetBytes.byteLength, `byte count mismatch for ${asset.path}`);
      assert.equal(
        asset.sha256,
        createHash("sha256").update(assetBytes).digest("hex"),
        `hash mismatch for ${asset.path}`,
      );
    }
    assert.deepEqual(observedFamilyCounts, expectedFamilyCounts);
    assert.equal(new Set(manifest.files.map(({ license }) => license)).size, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
