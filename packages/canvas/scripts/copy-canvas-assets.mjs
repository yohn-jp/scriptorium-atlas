import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const packageJson = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8"),
);

const FONT_LICENSES = Object.freeze({
  Assistant: { family: "Assistant", license: "OFL-1.1" },
  Cascadia: { family: "Cascadia Code", license: "OFL-1.1" },
  ComicShanns: { family: "Comic Shanns Mono", license: "MIT" },
  Excalifont: { family: "Excalifont", license: "OFL-1.1" },
  Liberation: { family: "Liberation Sans", license: "OFL-1.1" },
  Lilita: { family: "Lilita One", license: "OFL-1.1" },
  Nunito: { family: "Nunito", license: "OFL-1.1" },
  Virgil: { family: "Virgil", license: "OFL-1.1" },
  Xiaolai: { family: "Xiaolai SC", license: "OFL-1.1" },
});

const LICENSE_DETAILS = Object.freeze({
  "MIT": {
    name: "MIT License",
    url: "https://opensource.org/license/mit/",
  },
  "OFL-1.1": {
    name: "SIL Open Font License 1.1",
    url: "https://openfontlicense.org/open-font-license-official-text/",
  },
});

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

  const familyNames = [...new Set(sourceFiles.map(({ path }) => path.split("/")[0]))].sort();
  for (const directoryName of familyNames) {
    if (!FONT_LICENSES[directoryName]) {
      throw new Error(`No license metadata is registered for bundled font family '${directoryName}'.`);
    }
  }

  await rm(fontDirectory, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(sourceDirectory, fontDirectory, { recursive: true, errorOnExist: true, force: false });

  const files = [];
  let totalBytes = 0;
  for (const sourceFile of sourceFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    const content = await readFile(resolve(fontDirectory, sourceFile.path));
    const details = fontLicenseForPath(sourceFile.path);
    const record = {
      path: sourceFile.path,
      family: details.family,
      license: details.license,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    files.push(record);
    totalBytes += record.bytes;
  }

  const noticePath = resolve(fontDirectory, "THIRD_PARTY_NOTICES.md");
  await cp(resolve(scriptDirectory, "font-notices.md"), noticePath);

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
    licenses: Object.values(FONT_LICENSES)
      .filter(({ license }) => familyNames.some((name) => FONT_LICENSES[name].license === license))
      .reduce((licenses, { license }) => {
        licenses[license] = LICENSE_DETAILS[license];
        return licenses;
      }, {}),
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
