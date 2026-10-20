import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const packageJson = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8"),
);
const WORKER_VIRTUAL_PREFIX = "\0@scriptorium-atlas/canvas/excalidraw-subset-worker:";

/**
 * Keep Excalidraw's production subset worker in Vite's dedicated worker graph.
 * Excalidraw 0.18.1 exports a URL created from import.meta.url, which prevents
 * Vite from recognizing the official worker entry without this narrow rewrite.
 */
export function excalidrawWorkerVitePlugin() {
  const require = createRequire(import.meta.url);
  const excalidrawEntry = require.resolve("@excalidraw/excalidraw");
  const productionDirectory = dirname(excalidrawEntry);
  const excalidrawPackagePath = resolve(productionDirectory, "../../package.json");
  const excalidrawPackage = JSON.parse(readFileSync(excalidrawPackagePath, "utf8"));
  const expectedVersion = packageJson.dependencies?.["@excalidraw/excalidraw"];
  if (excalidrawPackage.version !== expectedVersion) {
    throw new Error(
      `Canvas expects @excalidraw/excalidraw@${expectedVersion}, found ${excalidrawPackage.version}.`,
    );
  }

  const importerPath = resolve(productionDirectory, "chunk-K2UTITRG.js");
  const workerPath = resolve(productionDirectory, "subset-worker.chunk.js");
  const importerText = readFileSync(importerPath, "utf8");
  if (!importerText.includes('import("./subset-worker.chunk.js")')) {
    throw new Error(
      `The pinned Excalidraw subset-worker import was not found in ${importerPath}.`,
    );
  }
  const workerModuleId = `${WORKER_VIRTUAL_PREFIX}${workerPath}`;
  const viteWorkerUrlSpecifier = `${workerPath}?worker&url`;

  return {
    name: "@scriptorium-atlas/canvas/excalidraw-worker",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source !== "./subset-worker.chunk.js" ||
        !importer ||
        importer.includes("?") ||
        resolve(importer) !== importerPath
      ) {
        return null;
      }
      return workerModuleId;
    },
    load(id) {
      if (id !== workerModuleId) return null;
      return [
        `import workerUrl from ${JSON.stringify(viteWorkerUrlSpecifier)};`,
        "export const WorkerUrl = new URL(workerUrl, import.meta.url);",
      ].join("\n");
    },
  };
}

const FONT_LICENSES = Object.freeze({
  Assistant: {
    family: "Assistant",
    license: "OFL-1.1",
    sourceOwner: "The Assistant Project Authors; The Source Sans Pro Authors",
    licenseSourceUrl: "https://github.com/TypeNetwork/Assistant/blob/2b5ffdccb0216ccbdbdc8a623f3b935fc5b5e04a/OFL.txt",
  },
  Cascadia: {
    family: "Cascadia Code",
    license: "OFL-1.1",
    sourceOwner: "Microsoft Corporation",
    licenseSourceUrl: "https://github.com/microsoft/cascadia-code/blob/4e01cd4fd3758ae081848154b5eb01f04b447947/LICENSE",
  },
  ComicShanns: {
    family: "Comic Shanns Mono",
    license: "MIT",
    sourceOwner: "Shannon Miwa; Jesus Gonzalez; Rodrigo Batista de Moraes; Fini Jastrow; Kyle Beechly",
    licenseSourceUrl: "https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/ComicShanns/index.ts",
  },
  Excalifont: {
    family: "Excalifont",
    license: "OFL-1.1",
    sourceOwner: "Excalidraw (copyright); Your Own Font Foundry (Virgil); Ján Filípek / DizajnDesign (modifications)",
    licenseSourceUrl: "https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/Excalifont/index.ts",
  },
  Liberation: {
    family: "Liberation Sans",
    license: "OFL-1.1",
    sourceOwner: "Google Corporation; Red Hat, Inc.",
    licenseSourceUrl: "https://github.com/liberationfonts/liberation-fonts/blob/380277b57ffb0b49ca655962c850ff0224a61cae/LICENSE",
  },
  Lilita: {
    family: "Lilita One",
    license: "OFL-1.1",
    sourceOwner: "Juan Montoreano",
    licenseSourceUrl: "https://github.com/google/fonts/blob/90abd17b4f97671435798b6147b698aa9087612f/ofl/lilitaone/OFL.txt",
  },
  Nunito: {
    family: "Nunito",
    license: "OFL-1.1",
    sourceOwner: "The Nunito Project Authors",
    licenseSourceUrl: "https://github.com/google/fonts/blob/a5bd0ea86b2576f86672aab557a6024d272187a5/ofl/nunito/OFL.txt",
  },
  Virgil: {
    family: "Virgil",
    license: "OFL-1.1",
    sourceOwner: "Ellinor Rapp",
    licenseSourceUrl: "https://github.com/excalidraw/virgil/blob/45fe1d8e3dba504adbd87a90b20449862fc0cb4d/LICENSE.md",
  },
  Xiaolai: {
    family: "Xiaolai SC",
    license: "OFL-1.1",
    sourceOwner: "LXGW (copyright); Nozomi Seto (designer)",
    licenseSourceUrl: "https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/Xiaolai/index.ts",
  },
});

const LICENSE_DETAILS = Object.freeze({
  MIT: {
    name: "MIT License",
    path: "licenses/MIT.txt",
    sourceUrl: "https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/ComicShanns/index.ts",
    sourceFile: "licenses/MIT.txt",
  },
  "OFL-1.1": {
    name: "SIL Open Font License 1.1",
    path: "licenses/OFL-1.1.txt",
    sourceUrl: "https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/Excalifont/index.ts",
    sourceFile: "licenses/OFL-1.1.txt",
  },
});

const EXPECTED_FONT_FAMILY_COUNTS = Object.freeze({
  Assistant: 4,
  Cascadia: 1,
  ComicShanns: 4,
  Excalifont: 7,
  Liberation: 1,
  Lilita: 2,
  Nunito: 5,
  Virgil: 1,
  Xiaolai: 209,
});

const EXPECTED_FONT_COUNT = Object.values(EXPECTED_FONT_FAMILY_COUNTS)
  .reduce((count, familyCount) => count + familyCount, 0);

async function listFiles(directory, baseDirectory = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected symbolic link in Excalidraw fonts: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, baseDirectory));
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        path: relative(baseDirectory, absolutePath).split(sep).join("/"),
      });
    }
  }

  return files;
}

function fontLicenseForPath(path) {
  const directoryName = path.split("/")[0];
  const details = FONT_LICENSES[directoryName];
  if (!details) {
    throw new Error(`No license metadata is registered for bundled font family '${directoryName}'.`);
  }
  return details;
}

/** Copy pinned Excalidraw fonts and their reproducibility/license manifest into `<outputDirectory>/fonts`. */
export async function copyCanvasAssets(outputDirectory) {
  if (!outputDirectory.trim()) {
    throw new Error("An output directory is required for Canvas assets.");
  }

  const require = createRequire(import.meta.url);
  const excalidrawEntry = require.resolve("@excalidraw/excalidraw");
  const excalidrawPackagePath = resolve(dirname(excalidrawEntry), "../../package.json");
  const excalidrawPackage = JSON.parse(await readFile(excalidrawPackagePath, "utf8"));
  const expectedVersion = packageJson.dependencies?.["@excalidraw/excalidraw"];
  if (excalidrawPackage.version !== expectedVersion) {
    throw new Error(
      `Canvas expects @excalidraw/excalidraw@${expectedVersion}, found ${excalidrawPackage.version}.`,
    );
  }

  const output = resolve(process.cwd(), outputDirectory);
  const fontDirectory = resolve(output, "fonts");
  const sourceDirectory = resolve(dirname(excalidrawEntry), "fonts");
  const sourceFiles = await listFiles(sourceDirectory);
  if (sourceFiles.length === 0) {
    throw new Error(`No self-hosted font assets were found at ${sourceDirectory}.`);
  }

  const sourceRoot = `https://github.com/excalidraw/excalidraw/tree/v${excalidrawPackage.version}/packages/excalidraw/fonts`;
  const familyCounts = sourceFiles.reduce((counts, { path }) => {
    const directoryName = path.split("/")[0];
    counts[directoryName] = (counts[directoryName] ?? 0) + 1;
    return counts;
  }, {});
  for (const [directoryName, expectedCount] of Object.entries(EXPECTED_FONT_FAMILY_COUNTS)) {
    if (familyCounts[directoryName] !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} '${directoryName}' font assets from Excalidraw@${excalidrawPackage.version}, found ${familyCounts[directoryName] ?? 0}.`,
      );
    }
  }
  for (const directoryName of Object.keys(familyCounts)) {
    if (!FONT_LICENSES[directoryName]) {
      throw new Error(`No license metadata is registered for bundled font family '${directoryName}'.`);
    }
  }
  if (sourceFiles.length !== EXPECTED_FONT_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_FONT_COUNT} font assets from Excalidraw@${excalidrawPackage.version}, found ${sourceFiles.length}.`,
    );
  }

  await rm(fontDirectory, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(sourceDirectory, fontDirectory, { recursive: true, errorOnExist: true, force: false });
  await mkdir(resolve(fontDirectory, "licenses"), { recursive: true });

  const licenses = {};
  for (const [spdx, details] of Object.entries(LICENSE_DETAILS)) {
    if (!Object.values(FONT_LICENSES).some(({ license }) => license === spdx)) {
      continue;
    }
    const sourceLicensePath = resolve(scriptDirectory, details.sourceFile);
    const licenseBytes = await readFile(sourceLicensePath);
    const licenseOutputPath = resolve(fontDirectory, details.path);
    await writeFile(licenseOutputPath, licenseBytes);
    licenses[spdx] = {
      name: details.name,
      path: details.path,
      bytes: licenseBytes.byteLength,
      sha256: createHash("sha256").update(licenseBytes).digest("hex"),
      sourceUrl: details.sourceUrl,
    };
  }

  const fontFamilyAudit = Object.entries(EXPECTED_FONT_FAMILY_COUNTS)
    .map(([directoryName, fileCount]) => {
      const details = FONT_LICENSES[directoryName];
      const licenseDetails = licenses[details.license];
      return {
        directory: directoryName,
        family: details.family,
        sourceOwner: details.sourceOwner,
        license: details.license,
        licenseTextPath: licenseDetails.path,
        sourceUrl: `${sourceRoot}/${directoryName}`,
        licenseSourceUrl: details.licenseSourceUrl,
        fileCount,
      };
    });

  const files = [];
  let totalBytes = 0;
  for (const sourceFile of sourceFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    const content = await readFile(resolve(fontDirectory, sourceFile.path));
    const details = fontLicenseForPath(sourceFile.path);
    const record = {
      path: sourceFile.path,
      family: details.family,
      sourceOwner: details.sourceOwner,
      license: details.license,
      licenseTextPath: licenses[details.license].path,
      familySourceUrl: `${sourceRoot}/${sourceFile.path.split("/")[0]}`,
      licenseSourceUrl: details.licenseSourceUrl,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    files.push(record);
    totalBytes += record.bytes;
  }

  const noticePath = resolve(fontDirectory, "THIRD_PARTY_NOTICES.md");
  const noticeTemplate = await readFile(resolve(scriptDirectory, "font-notices.md"), "utf8");
  const licenseRecords = Object.entries(licenses)
    .map(([spdx, license]) =>
      `- ${license.name} (${spdx}): [\`${license.path}\`](./${license.path}), SHA-256 \`${license.sha256}\`; source: ${license.sourceUrl}`,
    )
    .join("\n");
  const familyRecords = fontFamilyAudit
    .map((family) =>
      `- ${family.family} (${family.directory}; ${family.fileCount} files): ${family.license}; source owner: ${family.sourceOwner}; license text: [\`${family.licenseTextPath}\`](./${family.licenseTextPath}); bundled family source: ${family.sourceUrl}; license source: ${family.licenseSourceUrl}`,
    )
    .join("\n");
  const notice = noticeTemplate
    .replaceAll("{{EXCALIDRAW_VERSION}}", excalidrawPackage.version)
    .replaceAll("{{SOURCE_ROOT}}", sourceRoot)
    .replace("{{LICENSE_RECORDS}}", licenseRecords)
    .replace("{{FAMILY_RECORDS}}", familyRecords);
  await writeFile(noticePath, notice, "utf8");

  const manifest = {
    schemaVersion: 1,
    generatedBy: `${packageJson.name}@${packageJson.version}`,
    assetRoot: "fonts/",
    source: {
      package: excalidrawPackage.name,
      version: excalidrawPackage.version,
      license: excalidrawPackage.license,
      repository: `https://github.com/excalidraw/excalidraw/tree/v${excalidrawPackage.version}/packages/excalidraw/fonts`,
    },
    hashAlgorithm: "sha256",
    noticeFile: "THIRD_PARTY_NOTICES.md",
    licenses,
    fontFamilies: fontFamilyAudit,
    files,
    totalBytes,
  };
  const manifestPath = resolve(fontDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    outputDirectory: output,
    fontDirectory,
    manifestPath,
    noticePath,
    excalidrawVersion: excalidrawPackage.version,
    fileCount: files.length,
    totalBytes,
    files,
  };
}
