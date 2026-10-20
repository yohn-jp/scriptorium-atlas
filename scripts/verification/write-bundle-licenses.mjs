import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIRD_PARTY_NOTICE_NAMES = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[._-].*)?$/i;
const INTERNAL_PACKAGE_SCOPE = '@scriptorium-atlas/';
const FONT_LICENSE_TEXTS = new Map([
  ['MIT', 'MIT.txt'],
  ['OFL-1.1', 'OFL-1.1.txt']
]);
const SUPPLEMENT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), 'license-supplements');
const SUPPLEMENT_MANIFEST_PATH = join(SUPPLEMENT_DIRECTORY, 'manifest.json');
let cachedSupplementManifest;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function posixPath(value) {
  return value.split(sep).join('/');
}

function safeSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function modulePaths(closure) {
  assert.ok(closure && Array.isArray(closure.chunks), 'closure must contain a chunks array');
  const paths = [];
  for (const chunk of closure.chunks) {
    assert.ok(Array.isArray(chunk.modules), `closure chunk ${chunk.file ?? '<unknown>'} must contain module paths`);
    for (const module of chunk.modules) {
      const path = typeof module === 'string' ? module : module?.path ?? module?.id ?? module?.source;
      if (typeof path === 'string' && path && !path.startsWith('\0') && !path.startsWith('virtual:') && !path.startsWith('<virtual>')) paths.push(path);
    }
  }
  return [...new Set(paths)].sort();
}

function repoRelativePath(modulePath, repoRoot) {
  const noQuery = modulePath.replace(/[?#].*$/, '').replace(/^file:\/\//, '');
  const absolute = isAbsolute(noQuery) ? resolve(noQuery) : resolve(repoRoot, noQuery);
  const relativePath = relative(repoRoot, absolute);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
  return posixPath(relativePath);
}

async function packageForModule(relativeModulePath, repoRoot) {
  const parts = relativeModulePath.split('/');
  if (!parts.includes('node_modules')) return null;
  let current = resolve(repoRoot, relativeModulePath);
  try {
    if (!(await stat(current)).isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  while (current.startsWith(`${repoRoot}${sep}`)) {
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        return { name: manifest.name, version: manifest.version, directory: current, manifest };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Cannot resolve package.json for included module ${relativeModulePath}`);
}

async function listLicenseFiles(packageDirectory) {
  const paths = [];
  async function walkLicenseDirectory(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isFile()) paths.push(absolutePath);
      else if (entry.isDirectory()) await walkLicenseDirectory(absolutePath);
    }
  }
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(packageDirectory, entry.name);
    if (entry.isFile() && THIRD_PARTY_NOTICE_NAMES.test(entry.name)) paths.push(absolutePath);
    else if (entry.isDirectory() && /^licenses?$/i.test(entry.name)) await walkLicenseDirectory(absolutePath);
  }
  return paths.sort();
}

async function loadSupplementManifest() {
  if (!cachedSupplementManifest) {
    cachedSupplementManifest = (async () => {
      const manifest = JSON.parse(await readFile(SUPPLEMENT_MANIFEST_PATH, 'utf8'));
      assert.equal(manifest.schemaVersion, 'atlas.bundle-license-supplements/v1', 'license supplement manifest has an unsupported schema');
      assert.ok(manifest.sources && typeof manifest.sources === 'object' && Array.isArray(manifest.entries), 'license supplement manifest is malformed');
      const keys = new Set();
      for (const entry of manifest.entries) {
        const key = `${entry.packageName}@${entry.version}`;
        assert.ok(!keys.has(key), `license supplement manifest repeats ${key}`);
        keys.add(key);
        assert.ok(manifest.sources[entry.sourceId], `${key} references missing supplement source ${entry.sourceId}`);
      }
      return manifest;
    })();
  }
  return cachedSupplementManifest;
}

/** Return validated exact-version supplement provenance, or null when no exact entry exists. */
export async function verifiedLicenseSupplement(packageInfo) {
  if (packageInfo.directory && (await listLicenseFiles(packageInfo.directory)).length > 0) return null;
  const manifest = await loadSupplementManifest();
  const entry = manifest.entries.find(item => item.packageName === packageInfo.name && item.version === packageInfo.version);
  if (!entry) return null;
  assert.equal(packageInfo.manifest.license, entry.license, `${entry.packageName}@${entry.version} declared license differs from its supplement`);
  const source = manifest.sources[entry.sourceId];
  assert.ok(typeof source.textFile === 'string' && source.textFile && source.textFile === source.textFile.split(/[\\/]/).at(-1), `${entry.packageName}@${entry.version} has an unsafe supplement text path`);
  assert.ok(typeof source.url === 'string' && source.url.startsWith('https://'), `${entry.packageName}@${entry.version} supplement source must use HTTPS`);
  assert.ok(typeof source.revision === 'string' && source.revision.length > 0, `${entry.packageName}@${entry.version} supplement must pin its upstream revision`);
  assert.ok(typeof entry.packageArtifactUrl === 'string' && entry.packageArtifactUrl.startsWith('https://registry.npmjs.org/'), `${entry.packageName}@${entry.version} must pin its NPM artifact URL`);
  assert.ok(typeof entry.packageArtifactIntegrity === 'string' && /^sha512-[A-Za-z0-9+/]+=*$/.test(entry.packageArtifactIntegrity), `${entry.packageName}@${entry.version} must include its NPM artifact integrity`);
  const content = await readFile(join(SUPPLEMENT_DIRECTORY, source.textFile));
  const digest = sha256(content);
  assert.equal(digest, source.sha256, `${entry.packageName}@${entry.version} supplement text hash mismatch`);
  return {
    entry,
    source,
    content,
    provenance: {
      sourceKind: 'verified-upstream-supplement',
      sourceUrl: source.url,
      sourceFile: source.file,
      sourceRevision: source.revision,
      sourceIntegrity: source.sourceIntegrity ?? null,
      sourceVerificationUrls: source.verifiedAt ?? [],
      sourceNote: source.note,
      packageArtifactUrl: entry.packageArtifactUrl,
      packageArtifactIntegrity: entry.packageArtifactIntegrity,
      packageGitHead: entry.packageGitHead ?? null
    }
  };
}

async function writeDependencyLicense({ packageInfo, modulePaths: includedModules, licensesRoot, repoRoot }) {
  const legalFiles = await listLicenseFiles(packageInfo.directory);
  let supplement;
  if (legalFiles.length === 0) {
    supplement = await verifiedLicenseSupplement(packageInfo);
    assert.ok(supplement, `${packageInfo.name}@${packageInfo.version} has included code but no bundled LICENSE/COPYING/NOTICE text`);
  }
  const destinationRoot = join(licensesRoot, 'text', `${safeSegment(packageInfo.name)}@${safeSegment(packageInfo.version)}`);
  await mkdir(destinationRoot, { recursive: true });
  const licenseFiles = [];
  if (supplement) {
    const destinationRelative = posixPath(join('text', `${safeSegment(packageInfo.name)}@${safeSegment(packageInfo.version)}`, 'LICENSE.txt'));
    const outputPath = join(licensesRoot, destinationRelative);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, supplement.content);
    licenseFiles.push({
      source: `supplement:${supplement.entry.sourceId}`,
      output: destinationRelative,
      bytes: supplement.content.byteLength,
      sha256: sha256(supplement.content),
      ...supplement.provenance
    });
  }
  for (const sourcePath of legalFiles) {
    const content = await readFile(sourcePath);
    assert.ok(content.byteLength > 0, `${packageInfo.name} has an empty legal notice: ${sourcePath}`);
    const sourceRelative = posixPath(relative(packageInfo.directory, sourcePath));
    const destinationRelative = posixPath(join('text', `${safeSegment(packageInfo.name)}@${safeSegment(packageInfo.version)}`, sourceRelative));
    const outputPath = join(licensesRoot, destinationRelative);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content);
    licenseFiles.push({
      source: sourceRelative,
      output: posixPath(relative(licensesRoot, outputPath)),
      bytes: content.byteLength,
      sha256: sha256(content)
    });
  }
  return {
    name: packageInfo.name,
    version: packageInfo.version,
    license: packageInfo.manifest.license ?? null,
    repositoryPath: posixPath(relative(repoRoot, packageInfo.directory)),
    includedModuleCount: includedModules.length,
    includedModules,
    licenseFiles
  };
}

async function includeFontAssets({ profile, outputDirectory, licensesRoot }) {
  const fontDirectory = resolve(outputDirectory, 'fonts');
  const manifestPath = join(fontDirectory, 'manifest.json');
  const noticePath = join(fontDirectory, 'THIRD_PARTY_NOTICES.md');
  let fontManifest;
  try { fontManifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT' && profile === 'story') return [];
    throw new Error(`${profile} profile is missing a valid self-hosted font manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.ok(fontManifest && Array.isArray(fontManifest.files), 'font manifest must list copied asset files');
  const notice = await readFile(noticePath);
  assert.ok(notice.byteLength > 0, 'font notice must not be empty');
  const copiedAssetDirectory = join(licensesRoot, 'assets', 'fonts');
  await mkdir(copiedAssetDirectory, { recursive: true });
  const assets = [];
  for (const [sourcePath, outputPath] of [
    [manifestPath, join(copiedAssetDirectory, 'manifest.json')],
    [noticePath, join(copiedAssetDirectory, 'THIRD_PARTY_NOTICES.md')]
  ]) {
    const content = await readFile(sourcePath);
    await writeFile(outputPath, content);
    assets.push({
      source: posixPath(relative(outputDirectory, sourcePath)),
      output: posixPath(relative(licensesRoot, outputPath)),
      bytes: content.byteLength,
      sha256: sha256(content)
    });
  }

  const mappedLicenses = [...new Set(fontManifest.files.map(file => file.license))].sort();
  for (const license of mappedLicenses) {
    const fileName = FONT_LICENSE_TEXTS.get(license);
    assert.ok(fileName, `font manifest contains unrecognized license ${license}`);
    const sourcePath = join(fontDirectory, 'licenses', fileName);
    const content = await readFile(sourcePath);
    assert.ok(content.byteLength > 0, `font license text ${sourcePath} is empty`);
    const outputPath = join(copiedAssetDirectory, 'licenses', fileName);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content);
    assets.push({
      source: posixPath(relative(outputDirectory, sourcePath)),
      output: posixPath(relative(licensesRoot, outputPath)),
      bytes: content.byteLength,
      sha256: sha256(content),
      license
    });
  }

  for (const file of fontManifest.files) {
    assert.ok(typeof file.path === 'string' && typeof file.sha256 === 'string', 'font manifest contains a malformed asset entry');
    const assetPath = resolve(fontDirectory, file.path);
    assert.ok(!isAbsolute(file.path) && assetPath.startsWith(`${fontDirectory}${sep}`), `font asset path escapes the font directory: ${file.path}`);
    const content = await readFile(assetPath);
    assert.equal(content.byteLength, file.bytes, `font asset byte count mismatch for ${file.path}`);
    assert.equal(sha256(content), file.sha256, `font asset hash mismatch for ${file.path}`);
    assets.push({
      source: posixPath(relative(outputDirectory, assetPath)),
      bytes: content.byteLength,
      sha256: file.sha256,
      license: file.license
    });
  }
  for (const license of mappedLicenses) {
    const licensePath = posixPath(join('assets', 'fonts', 'licenses', FONT_LICENSE_TEXTS.get(license)));
    const assetLicense = assets.find(asset => asset.output === licensePath);
    assert.ok(assetLicense, `font license ${license} is missing from the included assets inventory`);
  }
  return assets;
}

/** Resolve the exact external packages present in a generated module closure. */
export async function bundleDependencyClosure({ repoRoot, closure }) {
  const root = resolve(repoRoot);
  const includedByPackage = new Map();
  for (const originalPath of modulePaths(closure)) {
    const relativePath = repoRelativePath(originalPath, root);
    if (!relativePath) {
      assert.ok(!/(?:^|\/)node_modules\//.test(originalPath), `third-party module path is outside the repository: ${originalPath}`);
      continue;
    }
    const packageInfo = await packageForModule(relativePath, root);
    if (!packageInfo || packageInfo.name.startsWith(INTERNAL_PACKAGE_SCOPE)) continue;
    const key = `${packageInfo.name}@${packageInfo.version}`;
    if (!includedByPackage.has(key)) includedByPackage.set(key, { packageInfo, modules: new Set() });
    includedByPackage.get(key).modules.add(relativePath);
  }
  return [...includedByPackage.values()]
    .map(({ packageInfo, modules }) => ({ packageInfo, modules: [...modules].sort() }))
    .sort((left, right) => left.packageInfo.name.localeCompare(right.packageInfo.name));
}

/**
 * Emit exact third-party legal text and provenance for dependencies present in built chunks.
 * `closure.chunks[].modules` must preserve full repository-relative or absolute module paths.
 */
export async function writeBundleLicenses({ repoRoot, profile, closure, outputDirectory = resolve(repoRoot, 'dist', profile) }) {
  assert.ok(['atlas', 'story', 'combined'].includes(profile), `unknown Atlas profile: ${profile}`);
  const root = resolve(repoRoot);
  const output = resolve(outputDirectory);
  assert.ok(output.startsWith(`${root}${sep}`), 'license output directory must be within the repository');
  const licensesRoot = join(output, 'licenses');
  await rm(licensesRoot, { recursive: true, force: true });
  await mkdir(licensesRoot, { recursive: true });

  const packages = [];
  const includedPackages = await bundleDependencyClosure({ repoRoot: root, closure });
  for (const { packageInfo, modules } of includedPackages) {
    packages.push(await writeDependencyLicense({
      packageInfo,
      modulePaths: modules,
      licensesRoot,
      repoRoot: root
    }));
  }
  const assets = await includeFontAssets({ profile, outputDirectory: output, licensesRoot });
  const manifest = {
    schemaVersion: 'atlas.bundle-licenses/v1',
    profile,
    hashAlgorithm: 'sha256',
    modulePathFormat: 'repository-relative POSIX paths retained from the generated Vite module closure',
    packages,
    assets
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(licensesRoot, 'manifest.json'), manifestBytes);

  const noticeLines = [
    '# Third-party notices',
    '',
    `This ${profile} bundle contains the third-party packages and assets listed below. The exact upstream legal text and SHA-256 for each dependency are included under \`licenses/text/\`.`,
    ''
  ];
  for (const dependency of packages) {
    noticeLines.push(`## ${dependency.name}@${dependency.version}`, '', `Declared license: ${String(dependency.license ?? 'unspecified')}`, '');
    for (const legalFile of dependency.licenseFiles) {
      noticeLines.push(`- ${legalFile.output} — ${legalFile.bytes} bytes, SHA-256 ${legalFile.sha256}`);
      if (legalFile.sourceKind === 'verified-upstream-supplement') {
        noticeLines.push(`  - Source: ${legalFile.sourceUrl} (${legalFile.sourceRevision}; ${legalFile.sourceFile})`);
        noticeLines.push(`  - NPM artifact: ${legalFile.packageArtifactUrl} (${legalFile.packageArtifactIntegrity})`);
        if (legalFile.sourceNote) noticeLines.push(`  - Provenance: ${legalFile.sourceNote}`);
      }
    }
    noticeLines.push('');
  }
  if (assets.length) {
    noticeLines.push('## Self-hosted assets', '');
    for (const asset of assets) noticeLines.push(`- ${asset.source}${asset.license ? ` (${asset.license})` : ''} — ${asset.bytes} bytes, SHA-256 ${asset.sha256}${asset.output ? `; copied as ${asset.output}` : ''}`);
    noticeLines.push('', 'The original upstream asset notice and the exact font license texts are copied under `licenses/assets/fonts/`.', '');
  }
  await writeFile(join(licensesRoot, 'THIRD_PARTY_NOTICES.md'), noticeLines.join('\n'));
  return { manifestPath: join(licensesRoot, 'manifest.json'), packageCount: packages.length, assetCount: assets.length };
}
