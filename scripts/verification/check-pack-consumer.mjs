import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentHead } from './artifact-evidence.mjs';

const repoRoot = resolve(process.env.ATLAS_PACK_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const packageRoots = ['packages', 'plugins'];
const internalScope = '@scriptorium-atlas/';
const workspacePackages = new Map();
const report = {
  schemaVersion: 'atlas.pack-consumer-evidence/v1',
  purpose: 'Checks standalone workspace package archives, exported files, internal dependency rewrites, and a temporary external Node consumer. This is a Q14 subcheck only.',
  headSha: currentHead(repoRoot),
  exactCli: process.env.ATLAS_PACK_EXACT_CLI ?? `${process.argv[0]} ${process.argv.slice(1).join(' ')}`,
  argv: process.argv,
  environment: { node: process.version, platform: os.platform(), release: os.release(), architecture: os.arch() },
  packages: [],
  consumer: { status: 'NOT_CHECKED' },
  status: 'NOT_CHECKED',
  exitStatus: null
};

function run(command, args, cwd, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-24000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-24000); });
    child.once('error', rejectRun);
    child.once('close', exitStatus => resolveRun({ exitStatus, stdout, stderr }));
  });
}

function parsePackResult(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, 'pnpm pack --json did not return a JSON object');
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
}

async function discoverPackages() {
  for (const root of packageRoots) {
    const rootPath = resolve(repoRoot, root);
    let entries;
    try { entries = await readdir(rootPath, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    for (const entry of entries.filter(value => value.isDirectory())) {
      const directory = join(rootPath, entry.name);
      let manifest;
      try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith(internalScope)) continue;
      workspacePackages.set(manifest.name, { directory, manifest });
    }
  }
}

function exportTargets(exportsField, subpath = '.') {
  if (typeof exportsField === 'string') return [{ subpath, target: exportsField }];
  if (Array.isArray(exportsField)) return exportsField.flatMap(value => exportTargets(value, subpath));
  if (!exportsField || typeof exportsField !== 'object') return [];
  const hasConditions = Object.keys(exportsField).some(key => !key.startsWith('.'));
  if (hasConditions) {
    return ['import', 'default', 'node', 'browser', 'require']
      .filter(condition => Object.hasOwn(exportsField, condition))
      .flatMap(condition => exportTargets(exportsField[condition], subpath));
  }
  return Object.entries(exportsField).flatMap(([key, value]) => exportTargets(value, key));
}

function moduleSpecifiers(packageName, manifest) {
  const exportsField = manifest.exports;
  if (!exportsField) {
    if (!manifest.main) return [];
    return [{ specifier: packageName, target: manifest.main }];
  }
  const targets = exportTargets(exportsField);
  const selected = new Map();
  for (const { subpath, target } of targets) {
    if (subpath === './package.json' || !target || target.endsWith('.d.ts')) continue;
    const specifier = subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`;
    if (!selected.has(specifier)) selected.set(specifier, { specifier, target });
  }
  return [...selected.values()];
}

function normalizeArchivePath(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^package\//, '');
  return normalized;
}

function exportedTargets(manifest) {
  return exportTargets(manifest.exports).filter(({ target }) => typeof target === 'string' && target.startsWith('./'));
}

async function packageNeedsBuild(directory, manifest) {
  const targets = exportedTargets(manifest).map(({ target }) => target.slice(2));
  if (!targets.length) return false;
  const distPath = join(directory, 'dist');
  let distExists = true;
  try { await stat(distPath); } catch (error) { if (error?.code === 'ENOENT') distExists = false; else throw error; }
  if (distExists) return false;
  return targets.some(target => target === 'dist' || target.startsWith(`dist${sep}`) || target.startsWith('dist/'));
}

async function fileSha256(path) {
  const digest = createHash('sha256');
  digest.update(await readFile(path));
  return digest.digest('hex');
}

async function readPackedManifest(tarball) {
  const result = await run(process.env.TAR ?? 'tar', ['-xOf', tarball, 'package/package.json'], repoRoot);
  assert.equal(result.exitStatus, 0, `could not read package/package.json from archive: ${result.stderr.slice(-1500)}`);
  return JSON.parse(result.stdout);
}

function internalRuntimeDependencies(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies
  };
}

function allDependencies(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies
  };
}

async function packPackage(name, record, destination) {
  const { directory, manifest } = record;
  const result = {
    name,
    version: manifest.version ?? null,
    status: 'NOT_CHECKED',
    command: ['pnpm', 'pack', '--pack-destination', destination, '--json'],
    archive: null,
    files: null,
    exportedTargets: [],
    internalDependencies: [],
    error: null
  };
  if (await packageNeedsBuild(directory, manifest)) {
    result.reason = 'Package build output is absent; build this package before pack verification.';
    return result;
  }

  const packed = await run('pnpm', ['pack', '--pack-destination', destination, '--json'], directory);
  if (packed.exitStatus !== 0) {
    result.status = 'FAIL';
    result.error = `pnpm pack exited ${packed.exitStatus}: ${packed.stderr.slice(-1500) || packed.stdout.slice(-1500)}`;
    return result;
  }

  try {
    const packData = parsePackResult(packed.stdout);
    const filename = typeof packData.filename === 'string' ? packData.filename : null;
    const files = Array.isArray(packData.files) ? packData.files : [];
    assert.ok(filename, 'pack JSON did not identify a tarball filename');
    const archivePath = isAbsolute(filename) ? resolve(filename) : resolve(destination, filename);
    const archiveStats = await stat(archivePath);
    assert.ok(archiveStats.isFile() && archiveStats.size > 0, 'pack archive is missing or empty');
    const packedFiles = new Set(files.map(file => normalizeArchivePath(file.path ?? '')).filter(Boolean));
    assert.ok(packedFiles.has('package.json'), 'archive file list omits package.json');
    assert.ok(manifest.exports && Object.keys(manifest.exports).length > 0, 'public package must declare explicit exports');
    assert.ok(moduleSpecifiers(name, manifest).length > 0, 'public package must expose at least one runtime export');
    const missingTargets = exportedTargets(manifest)
      .map(({ target }) => normalizeArchivePath(target))
      .filter(target => !packedFiles.has(target));
    assert.deepEqual(missingTargets, [], `packed archive omits exported files: ${missingTargets.join(', ')}`);

    const packedManifest = await readPackedManifest(archivePath);
    assert.equal(packedManifest.name, name, 'packed package name changed');
    assert.equal(packedManifest.version, manifest.version, 'packed package version changed');
    const unresolvedWorkspace = Object.entries(allDependencies(packedManifest))
      .filter(([, range]) => typeof range === 'string' && /^(?:workspace|link|file):/.test(range));
    assert.deepEqual(unresolvedWorkspace, [], `archive retains local dependency protocol: ${JSON.stringify(unresolvedWorkspace)}`);

    const internal = Object.keys(internalRuntimeDependencies(packedManifest))
      .filter(dependency => dependency.startsWith(internalScope));
    const privateDeps = internal.filter(dependency => workspacePackages.get(dependency)?.manifest.private === true);
    assert.deepEqual(privateDeps, [], `public package depends on private package(s): ${privateDeps.join(', ')}`);

    result.status = 'PASS';
    result.archive = {
      filename: relative(destination, archivePath).split(sep).join('/'),
      bytes: archiveStats.size,
      sha256: await fileSha256(archivePath)
    };
    result.files = { count: files.length, exportedTargetCount: exportedTargets(manifest).length };
    result.exportedTargets = exportedTargets(manifest).map(({ target }) => target);
    result.internalDependencies = internal.map(dependency => ({
      name: dependency,
      version: internalRuntimeDependencies(packedManifest)[dependency]
    }));
    return result;
  } catch (error) {
    result.status = 'FAIL';
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return result;
  }
}

function peerDependencies(records) {
  const peers = new Map();
  for (const { manifest } of records.values()) {
    for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) {
      if (name.startsWith(internalScope)) continue;
      if (!peers.has(name)) peers.set(name, version);
      else if (peers.get(name) !== version) peers.set(name, '*');
    }
  }
  return Object.fromEntries(peers);
}

async function runConsumer(records, archiveRecords, temporaryRoot) {
  const consumerDirectory = join(temporaryRoot, 'external-consumer');
  const packageJson = {
    name: 'atlas-pack-external-consumer',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: {}
  };
  const overrides = {};
  const archivesByPackage = new Map(archiveRecords.map(record => [record.name, record.archiveAbsolute]));
  for (const [name, archive] of archivesByPackage) {
    packageJson.dependencies[name] = `file:${archive}`;
  }
  for (const { manifest } of records.values()) {
    for (const dependency of Object.keys(internalRuntimeDependencies(manifest))) {
      const archive = archivesByPackage.get(dependency);
      if (archive) overrides[dependency] = `file:${archive}`;
    }
  }
  Object.assign(packageJson.dependencies, peerDependencies(records));
  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(join(consumerDirectory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  const workspaceConfig = [
    'overrides:',
    ...Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, archive]) => `  ${JSON.stringify(name)}: ${JSON.stringify(archive)}`),
    ''
  ].join('\n');
  await writeFile(join(consumerDirectory, 'pnpm-workspace.yaml'), workspaceConfig);
  await writeFile(join(consumerDirectory, '.npmrc'), 'strict-peer-dependencies=true\n');

  const installArgs = ['install', '--ignore-scripts', '--no-frozen-lockfile', '--prefer-offline'];
  const install = await run('pnpm', installArgs, consumerDirectory);
  const evidence = {
    status: 'NOT_CHECKED',
    directory: '<temporary external directory>',
    installCommand: ['pnpm', ...installArgs],
    workspaceOverrideCount: Object.keys(overrides).length,
    installExitStatus: install.exitStatus,
    exportedModules: [],
    error: null
  };
  if (install.exitStatus !== 0) {
    evidence.status = 'FAIL';
    evidence.error = `external pnpm install exited ${install.exitStatus}: ${(install.stderr || install.stdout).slice(-2000)}`;
    return evidence;
  }

  const checks = [];
  for (const [name, record] of records) {
    for (const module of moduleSpecifiers(name, record.manifest)) checks.push({ package: name, ...module });
  }
  const consumerSource = `import { readFile } from 'node:fs/promises';\nimport { fileURLToPath } from 'node:url';\nconst checks=${JSON.stringify(checks)};\nconst results=[];\nfor(const check of checks){const resolved=import.meta.resolve(check.specifier);if(resolved.endsWith('.json')){JSON.parse(await readFile(fileURLToPath(resolved),'utf8'));}else if(!/\\.(?:[cm]?js)$/.test(new URL(resolved).pathname)){const bytes=await readFile(fileURLToPath(resolved));if(!bytes.byteLength)throw new Error('Empty exported asset: '+check.specifier);}else{await import(check.specifier);}results.push({package:check.package,specifier:check.specifier,resolved});}\nprocess.stdout.write(JSON.stringify(results));\n`;
  const entryPath = join(consumerDirectory, 'consumer.mjs');
  await writeFile(entryPath, consumerSource, 'utf8');
  const execution = await run(process.execPath, [entryPath], consumerDirectory);
  if (execution.exitStatus !== 0) {
    evidence.status = 'FAIL';
    evidence.error = `external consumer exited ${execution.exitStatus}: ${(execution.stderr || execution.stdout).slice(-2500)}`;
    return evidence;
  }
  try {
    evidence.exportedModules = JSON.parse(execution.stdout);
    evidence.status = evidence.exportedModules.length === checks.length ? 'PASS' : 'FAIL';
    if (evidence.status === 'FAIL') evidence.error = `resolved ${evidence.exportedModules.length} of ${checks.length} exported modules`;
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.error = `consumer returned invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  return evidence;
}

await discoverPackages();
const publicRecords = [...workspacePackages.entries()].filter(([, record]) => record.manifest.private !== true);
const temporaryRoot = await mkdtemp(join(os.tmpdir(), 'atlas-pack-consumer-'));
const archiveDirectory = join(temporaryRoot, 'archives');
await (await import('node:fs/promises')).mkdir(archiveDirectory, { recursive: true });

try {
  const archiveRecords = [];
  for (const [name, record] of publicRecords) {
    const result = await packPackage(name, record, archiveDirectory);
    report.packages.push(result);
    if (result.status === 'PASS') {
      archiveRecords.push({
        name,
        archiveAbsolute: resolve(archiveDirectory, result.archive.filename),
        archive: result.archive
      });
    }
  }

  const missingPublicPackages = publicRecords.length === 0;
  if (missingPublicPackages) {
    report.consumer = { status: 'NOT_CHECKED', reason: 'No public workspace packages were discovered.' };
  } else if (report.packages.some(result => result.status === 'FAIL')) {
    report.consumer = { status: 'NOT_CHECKED', reason: 'At least one package archive failed validation.' };
  } else if (report.packages.some(result => result.status === 'NOT_CHECKED')) {
    report.consumer = { status: 'NOT_CHECKED', reason: 'At least one public package has not been built.' };
  } else {
    report.consumer = await runConsumer(new Map(publicRecords), archiveRecords, temporaryRoot);
  }
} catch (error) {
  report.packages.push({ status: 'FAIL', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  report.consumer = { status: 'NOT_CHECKED', reason: 'Pack verification stopped before the external consumer ran.' };
} finally {
  if (process.env.ATLAS_PACK_KEEP_TEMP !== '1') await rm(temporaryRoot, { recursive: true, force: true });
}

if (report.packages.some(result => result.status === 'FAIL') || report.consumer.status === 'FAIL') report.status = 'FAIL';
else if (report.packages.length === 0 || report.packages.some(result => result.status === 'NOT_CHECKED') || report.consumer.status === 'NOT_CHECKED') report.status = 'NOT_CHECKED';
else report.status = 'PASS';
report.exitStatus = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.ATLAS_PACK_REPORT) await writeFile(resolve(process.env.ATLAS_PACK_REPORT), serialized, 'utf8');
process.stdout.write(serialized);
process.exitCode = report.exitStatus;
