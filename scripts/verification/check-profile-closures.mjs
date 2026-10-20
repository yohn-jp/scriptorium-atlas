import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentHead, hashTree } from './artifact-evidence.mjs';
import { bundleDependencyClosure, verifiedLicenseSupplement } from './write-bundle-licenses.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const knownProfiles = ['atlas', 'story', 'combined'];
const expectedOwner = {
  atlas: /(?:^|\/)plugins\/atlas\//,
  story: /(?:^|\/)plugins\/story-knowledge\//,
  combined: null
};
const forbidden = {
  atlas: [/plugins\/story-knowledge\//, /node_modules\/yaml\//],
  story: [
    /plugins\/atlas\//,
    /packages\/canvas\//,
    /packages\/(?:graph|layout)\//,
    /node_modules\/(?:@excalidraw\/|@xyflow\/react\/|d3-force\/|elkjs\/)/
  ],
  combined: []
};
const lazyDependencies = {
  atlas: [/@xyflow\/react\//, /@excalidraw\/excalidraw\//],
  story: [/node_modules\/yaml\//],
  combined: [/@xyflow\/react\//, /@excalidraw\/excalidraw\//, /node_modules\/yaml\//]
};

function check(condition, message) {
  assert.ok(condition, message);
}

function localTarget(fromFile, target, chunks, label) {
  check(typeof target === 'string' && target.length > 0, `${label} must be a non-empty file name`);
  check(!posix.isAbsolute(target) && posix.normalize(target) === target && !target.startsWith('../'), `${label} escapes the profile output: ${target}`);
  const targetChunk = chunks.get(target);
  check(targetChunk, `${label} references missing chunk ${target} from ${fromFile}`);
  return targetChunk.file;
}

async function htmlEntryChunks(directory, chunkByFile) {
  const entries = [];
  for (const htmlName of ['index.html', 'frame.html']) {
    const html = await readFile(resolve(directory, htmlName), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
    check(scripts.length > 0, `${htmlName} must load a built JavaScript entry`);
    let matched = 0;
    for (const match of scripts) {
      const url = new URL(match[1], 'http://atlas.invalid');
      if (url.origin !== 'http://atlas.invalid') continue;
      const file = url.pathname.replace(/^\/+/, '');
      if (chunkByFile.has(file)) {
        entries.push(file);
        matched += 1;
      }
    }
    check(matched > 0, `${htmlName} script source must appear in closure.json`);
  }
  return [...new Set(entries)];
}

function traverse(startFiles, chunks, edgeName) {
  const visited = new Set();
  const pending = [...startFiles];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const chunk = chunks.get(file);
    if (!chunk) continue;
    for (const dependency of chunk[edgeName]) pending.push(dependency);
  }
  return visited;
}

async function digestFile(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function auditLicenseInventory(profile, directory, closure) {
  const licensesDirectory = resolve(directory, 'licenses');
  const manifestPath = resolve(licensesDirectory, 'manifest.json');
  const noticePath = resolve(licensesDirectory, 'THIRD_PARTY_NOTICES.md');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  check(manifest.schemaVersion === 'atlas.bundle-licenses/v1' && manifest.profile === profile, `${profile} license inventory has an unknown schema or profile`);
  check(manifest.hashAlgorithm === 'sha256' && Array.isArray(manifest.packages) && Array.isArray(manifest.assets), `${profile} license inventory is malformed`);
  const noticeInfo = await digestFile(noticePath);
  check(noticeInfo.bytes > 0, `${profile} third-party notice is empty`);

  const expected = await bundleDependencyClosure({ repoRoot, closure });
  const expectedByKey = new Map(expected.map(({ packageInfo, modules }) => [`${packageInfo.name}@${packageInfo.version}`, { packageInfo, modules }]));
  const actualByKey = new Map();
  const noticeText = await readFile(noticePath, 'utf8');
  for (const dependency of manifest.packages) {
    check(dependency && typeof dependency.name === 'string' && typeof dependency.version === 'string', `${profile} license inventory has an invalid package row`);
    const key = `${dependency.name}@${dependency.version}`;
    check(!actualByKey.has(key), `${profile} license inventory repeats ${key}`);
    check(Array.isArray(dependency.includedModules) && dependency.includedModules.length > 0, `${key} has no included module provenance`);
    check(Array.isArray(dependency.licenseFiles) && dependency.licenseFiles.length > 0, `${key} has no license text`);
    const exactSupplement = await verifiedLicenseSupplement(expectedByKey.get(key)?.packageInfo ?? { name: dependency.name, version: dependency.version, manifest: { license: dependency.license } });
    const hasSupplement = dependency.licenseFiles.some(license => license.sourceKind === 'verified-upstream-supplement');
    check(hasSupplement === Boolean(exactSupplement), `${key} legal text does not match the exact package license supplement requirements`);
    actualByKey.set(key, dependency.includedModules);
    for (const license of dependency.licenseFiles) {
      check(typeof license.output === 'string' && !posix.isAbsolute(license.output) && posix.normalize(license.output) === license.output && !license.output.startsWith('../'), `${key} has an unsafe license output path`);
      const path = resolve(licensesDirectory, license.output);
      check(path.startsWith(`${licensesDirectory}/`), `${key} license text escapes the inventory directory`);
      const actual = await digestFile(path);
      check(actual.bytes === license.bytes && actual.sha256 === license.sha256, `${key} legal text digest does not match the included file ${license.output}`);
      if (license.sourceKind === 'verified-upstream-supplement') {
        const expectedPackage = expectedByKey.get(key)?.packageInfo;
        check(expectedPackage, `${key} supplement is not tied to an included package`);
        const supplement = exactSupplement;
        check(supplement, `${key} uses a supplement without an exact allowlist entry`);
        check(dependency.license === supplement.entry.license, `${key} supplement license differs from the package declaration`);
        for (const field of ['sourceUrl', 'sourceFile', 'sourceRevision', 'sourceIntegrity', 'sourceNote', 'packageArtifactUrl', 'packageArtifactIntegrity', 'packageGitHead']) {
          check(license[field] === supplement.provenance[field], `${key} supplement ${field} differs from the pinned provenance`);
        }
        check(JSON.stringify(license.sourceVerificationUrls) === JSON.stringify(supplement.provenance.sourceVerificationUrls), `${key} supplement verification sources differ from the pinned provenance`);
        check(actual.sha256 === createHash('sha256').update(supplement.content).digest('hex'), `${key} supplement bytes differ from the pinned text`);
        check(noticeText.includes(supplement.provenance.sourceUrl) && noticeText.includes(supplement.entry.packageArtifactIntegrity), `${key} third-party notice omits supplement provenance`);
      } else {
        check(license.sourceKind === undefined, `${key} has an unsupported legal text provenance kind`);
      }
    }
  }
  check(expectedByKey.size === actualByKey.size, `${profile} license package inventory differs from included module closure: expected ${expectedByKey.size}, recorded ${actualByKey.size}`);
  for (const [key, expectedPackage] of expectedByKey) {
    const recordedModules = actualByKey.get(key);
    check(recordedModules, `${profile} license inventory omits bundled package ${key}`);
    check(JSON.stringify([...recordedModules].sort()) === JSON.stringify([...expectedPackage.modules].sort()), `${key} module provenance differs from closure.json`);
  }

  const assetSources = new Set();
  for (const asset of manifest.assets) {
    check(typeof asset.source === 'string' && !posix.isAbsolute(asset.source) && posix.normalize(asset.source) === asset.source && !asset.source.startsWith('../'), `${profile} license inventory has an unsafe asset path`);
    check(!assetSources.has(asset.source), `${profile} license inventory repeats asset ${asset.source}`);
    assetSources.add(asset.source);
    const source = resolve(directory, asset.source);
    check(source.startsWith(`${directory}/`), `asset path escapes ${profile} build output`);
    const sourceDigest = await digestFile(source);
    check(sourceDigest.bytes === asset.bytes && sourceDigest.sha256 === asset.sha256, `asset digest differs from included output ${asset.source}`);
    if (asset.output) {
      check(!posix.isAbsolute(asset.output) && posix.normalize(asset.output) === asset.output && !asset.output.startsWith('../'), `asset output path is unsafe: ${asset.output}`);
      const output = resolve(licensesDirectory, asset.output);
      check(output.startsWith(`${licensesDirectory}/`), `copied asset escapes the license directory: ${asset.output}`);
      const outputDigest = await digestFile(output);
      check(outputDigest.bytes === asset.bytes && outputDigest.sha256 === asset.sha256, `copied asset digest differs for ${asset.source}`);
    }
  }
  if (profile !== 'story') {
    for (const required of ['fonts/manifest.json', 'fonts/THIRD_PARTY_NOTICES.md']) check(assetSources.has(required), `${profile} license inventory omits ${required}`);
    check([...assetSources].some(path => path.startsWith('fonts/licenses/MIT.txt')), `${profile} license inventory omits the font MIT license text`);
    check([...assetSources].some(path => path.startsWith('fonts/licenses/OFL-1.1.txt')), `${profile} license inventory omits the OFL-1.1 license text`);
  } else {
    check(![...assetSources].some(path => path.startsWith('fonts/')), 'story profile unexpectedly includes canvas font assets');
  }
  return {
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    noticeSha256: createHash('sha256').update(await readFile(noticePath)).digest('hex'),
    packageCount: manifest.packages.length,
    packages: manifest.packages.map(({ name, version, license, includedModuleCount, licenseFiles }) => ({
      name,
      version,
      license,
      includedModuleCount,
      licenseFiles: licenseFiles.map(({ output, bytes, sha256 }) => ({ output, bytes, sha256 }))
    })),
    assetCount: manifest.assets.length
  };
}

async function auditProfile(profile) {
  const directory = resolve(repoRoot, 'dist', profile);
  const artifact = await hashTree(directory);
  const closurePath = resolve(directory, 'closure.json');
  const closureBytes = await readFile(closurePath);
  const closure = JSON.parse(closureBytes.toString('utf8'));
  check(closure && closure.profile === profile && Array.isArray(closure.chunks), `closure.json must describe profile ${profile}`);
  check(closure.chunks.length > 0, `${profile} closure must contain emitted JavaScript chunks`);

  const emittedChunks = new Map();
  for (const chunk of closure.chunks) {
    check(chunk && typeof chunk === 'object', `${profile} closure contains a malformed chunk`);
    check(typeof chunk.file === 'string' && chunk.file.endsWith('.js'), `closure chunk must be a JavaScript output file`);
    check(!emittedChunks.has(chunk.file), `closure contains duplicate chunk ${chunk.file}`);
    check(Array.isArray(chunk.imports) && Array.isArray(chunk.dynamicImports) && Array.isArray(chunk.modules), `${chunk.file} must list imports, dynamic imports, and modules`);
    check(Number.isSafeInteger(chunk.bytes) && chunk.bytes >= 0, `${chunk.file} has an invalid byte count`);
    const outputPath = resolve(directory, chunk.file);
    check(outputPath.startsWith(`${directory}/`), `chunk path escapes ${profile} output`);
    const actual = await readFile(outputPath);
    check(actual.byteLength === chunk.bytes, `${chunk.file} byte count differs from closure.json`);
    for (const module of chunk.modules) check(typeof module === 'string', `${chunk.file} has a non-string module identifier`);
    emittedChunks.set(chunk.file, chunk);
  }
  const chunkByFile = new Map(closure.chunks.map(chunk => [chunk.file, {
    ...chunk,
    imports: chunk.imports.map(value => localTarget(chunk.file, value, emittedChunks, 'static import')),
    dynamicImports: chunk.dynamicImports.map(value => localTarget(chunk.file, value, emittedChunks, 'dynamic import'))
  }]));

  const entryFiles = await htmlEntryChunks(directory, chunkByFile);
  const staticReachable = traverse(entryFiles, chunkByFile, 'imports');
  const dynamicRoots = [...staticReachable].flatMap(file => chunkByFile.get(file)?.dynamicImports ?? []);
  const dynamicReachable = traverse(dynamicRoots, chunkByFile, 'imports');
  const modules = closure.chunks.flatMap(chunk => chunk.modules);

  if (expectedOwner[profile]) check(modules.some(module => expectedOwner[profile].test(module)), `${profile} closure has no ${profile} plugin modules`);
  if (profile === 'combined') {
    check(modules.some(module => /plugins\/atlas\//.test(module)), 'combined closure has no Atlas plugin modules');
    check(modules.some(module => /plugins\/story-knowledge\//.test(module)), 'combined closure has no Story Knowledge plugin modules');
  }
  for (const pattern of forbidden[profile]) {
    const violation = modules.find(module => pattern.test(module));
    check(!violation, `${profile} closure includes forbidden module ${violation}`);
  }

  const lazyEvidence = [];
  for (const pattern of lazyDependencies[profile]) {
    const dependencyChunks = closure.chunks.filter(chunk => chunk.modules.some(module => pattern.test(module)));
    check(dependencyChunks.length > 0, `${profile} closure does not contain required lazy dependency ${pattern}`);
    const eager = dependencyChunks.filter(chunk => staticReachable.has(chunk.file));
    check(eager.length === 0, `${profile} eager entry imports heavy dependency chunks: ${eager.map(chunk => chunk.file).join(', ')}`);
    const unreachable = dependencyChunks.filter(chunk => !dynamicReachable.has(chunk.file));
    check(unreachable.length === 0, `${profile} heavy dependency chunks are not connected through a lazy import: ${unreachable.map(chunk => chunk.file).join(', ')}`);
    lazyEvidence.push({ pattern: String(pattern), chunks: dependencyChunks.map(chunk => chunk.file) });
  }
  const licenseEvidence = await auditLicenseInventory(profile, directory, closure);

  const chunks = await Promise.all(closure.chunks.map(async chunk => ({
    file: chunk.file,
    bytes: chunk.bytes,
    sha256: createHash('sha256').update(await readFile(resolve(directory, chunk.file))).digest('hex'),
    moduleCount: chunk.modules.length,
    imports: chunk.imports,
    dynamicImports: chunk.dynamicImports
  })));
  return {
    profile,
    status: 'PASS',
    artifact,
    closureSha256: createHash('sha256').update(closureBytes).digest('hex'),
    entryFiles,
    staticReachable: [...staticReachable].sort(),
    lazyDependencies: lazyEvidence,
    licenses: licenseEvidence,
    chunks
  };
}

const requested = (process.env.ATLAS_CLOSURE_PROFILES ?? knownProfiles.join(','))
  .split(',').map(value => value.trim()).filter(Boolean);
const invalidProfiles = requested.filter(profile => !knownProfiles.includes(profile));
const report = {
  schemaVersion: 'atlas.profile-closure-evidence/v1',
  purpose: 'Verify generated Vite module closure, profile exclusion rules, entry reachability, and lazy heavy-package boundaries. Does not establish the full Q14 gate.',
  headSha: currentHead(repoRoot),
  exactCli: process.env.ATLAS_CLOSURE_EXACT_CLI ?? `${process.argv[0]} ${process.argv.slice(1).join(' ')}`,
  argv: process.argv,
  environment: { node: process.version, platform: os.platform(), release: os.release(), architecture: os.arch() },
  profiles: [],
  status: 'NOT_CHECKED',
  exitStatus: null
};

if (invalidProfiles.length) report.profiles.push({ profile: invalidProfiles.join(','), status: 'FAIL', error: 'Unknown profile name.' });
for (const profile of requested.filter(name => knownProfiles.includes(name))) {
  const directory = resolve(repoRoot, 'dist', profile);
  try {
    const output = await stat(directory);
    check(output.isDirectory(), `dist/${profile} is not a directory`);
  } catch (error) {
    report.profiles.push({
      profile,
      status: error?.code === 'ENOENT' ? 'NOT_CHECKED' : 'FAIL',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
    continue;
  }
  try {
    report.profiles.push(await auditProfile(profile));
  } catch (error) {
    report.profiles.push({
      profile,
      status: 'FAIL',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
  }
}

for (const profile of report.profiles) {
  if (profile.status === 'PASS') profile.exitStatus = 0;
  else if (profile.status === 'FAIL') profile.exitStatus = 1;
  else profile.exitStatus = 2;
  profile.exactCli = report.exactCli;
}

if (invalidProfiles.length || report.profiles.some(profile => profile.status === 'FAIL')) report.status = 'FAIL';
else if (report.profiles.length === 0 || report.profiles.some(profile => profile.status === 'NOT_CHECKED')) report.status = 'NOT_CHECKED';
else report.status = 'PASS';
report.exitStatus = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.ATLAS_CLOSURE_REPORT) await writeFile(resolve(process.env.ATLAS_CLOSURE_REPORT), serialized, 'utf8');
process.stdout.write(serialized);
process.exitCode = report.exitStatus;
