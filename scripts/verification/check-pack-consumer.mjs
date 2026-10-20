import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
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
  consumer: { status: 'NOT_CHECKED', node: { status: 'NOT_CHECKED' }, browser: { status: 'NOT_CHECKED' } },
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

function isBrowserModule(module) {
  return module.specifier.endsWith('/ui') || module.specifier.endsWith('/ui.css') || module.target.endsWith('.css');
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
  const checks = [];
  for (const [name, record] of records) {
    for (const module of moduleSpecifiers(name, record.manifest)) checks.push({ package: name, ...module });
  }
  const browserChecks = checks.filter(isBrowserModule);
  const nodeChecks = checks.filter(module => !isBrowserModule(module));
  if (browserChecks.length) {
    const standaloneManifestPath = join(repoRoot, 'apps', 'standalone', 'package.json');
    const standaloneManifest = JSON.parse(await readFile(standaloneManifestPath, 'utf8'));
    const viteVersion = standaloneManifest.devDependencies?.vite;
    assert.ok(typeof viteVersion === 'string' && viteVersion.length > 0, 'the standalone app must pin Vite for external browser-consumer verification');
    packageJson.devDependencies = { vite: viteVersion };
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
    node: { status: 'NOT_CHECKED', checkedCount: nodeChecks.length },
    browser: { status: 'NOT_CHECKED', checkedCount: browserChecks.length },
    error: null
  };
  if (install.exitStatus !== 0) {
    evidence.status = 'FAIL';
    evidence.error = `external pnpm install exited ${install.exitStatus}: ${(install.stderr || install.stdout).slice(-2000)}`;
    return evidence;
  }

  const consumerSource = `import { readFile } from 'node:fs/promises';\nimport { fileURLToPath } from 'node:url';\nconst checks=${JSON.stringify(nodeChecks)};\nconst results=[];\nfor(const check of checks){const resolved=import.meta.resolve(check.specifier);if(resolved.endsWith('.json')){JSON.parse(await readFile(fileURLToPath(resolved),'utf8'));}else if(!/\\.(?:[cm]?js)$/.test(new URL(resolved).pathname)){const bytes=await readFile(fileURLToPath(resolved));if(!bytes.byteLength)throw new Error('Empty exported asset: '+check.specifier);}else{await import(check.specifier);}results.push({package:check.package,specifier:check.specifier,resolved});}\nprocess.stdout.write(JSON.stringify(results));\n`;
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
    evidence.node.status = evidence.exportedModules.length === nodeChecks.length ? 'PASS' : 'FAIL';
    if (evidence.node.status === 'FAIL') evidence.node.error = `resolved ${evidence.exportedModules.length} of ${nodeChecks.length} Node-compatible exported modules`;
  } catch (error) {
    evidence.node.status = 'FAIL';
    evidence.node.error = `consumer returned invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (evidence.node.status === 'FAIL') {
    evidence.status = 'FAIL';
    evidence.error = evidence.node.error ?? 'The external Node consumer failed.';
    return evidence;
  }

  if (browserChecks.length) evidence.browser = await runBrowserConsumer(consumerDirectory, browserChecks);
  else evidence.browser = { status: 'NOT_CHECKED', checkedCount: 0, reason: 'No public UI or CSS exports were present in this consumer fixture.' };
  evidence.status = evidence.browser.status === 'FAIL' ? 'FAIL' : 'PASS';
  if (evidence.browser.status === 'FAIL') evidence.error = evidence.browser.error ?? 'The external browser consumer failed.';
  return evidence;
}

const uiComponents = new Map([
  ['@scriptorium-atlas/canvas/ui', 'CanvasEditor'],
  ['@scriptorium-atlas/atlas/ui', 'AtlasPlugin'],
  ['@scriptorium-atlas/story-knowledge/ui', 'StoryKnowledge']
]);

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local browser-consumer port.');
  await new Promise(resolveClose => server.close(resolveClose));
  return address.port;
}

async function waitForHttp(url, server) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.ok) return true;
    } catch { /* wait for Vite preview to bind */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function stopChild(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => server.child.once('exit', resolveExit)),
    new Promise(resolveDelay => setTimeout(resolveDelay, 5_000))
  ]);
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
}

async function runBrowserConsumer(consumerDirectory, browserChecks) {
  const evidence = { status: 'NOT_CHECKED', checkedCount: browserChecks.length, importedEntries: browserChecks.map(({ package: name, specifier }) => ({ package: name, specifier })), error: null };
  const knownUi = browserChecks.filter(module => module.specifier.endsWith('/ui'));
  const knownCss = browserChecks.filter(module => module.specifier.endsWith('/ui.css') || module.target.endsWith('.css'));
  const unsupported = knownUi.filter(module => !uiComponents.has(module.specifier));
  if (unsupported.length) {
    evidence.status = 'FAIL';
    evidence.error = `No browser mount is defined for public UI export(s): ${unsupported.map(module => module.specifier).join(', ')}`;
    return evidence;
  }

  const uiImports = knownUi.map((module, index) => `import { ${uiComponents.get(module.specifier)} as Ui${index} } from ${JSON.stringify(module.specifier)};`).join('\n');
  const cssImports = knownCss.map(module => `import ${JSON.stringify(module.specifier)};`).join('\n');
  const hasCanvas = knownUi.some(module => module.specifier === '@scriptorium-atlas/canvas/ui');
  const editableScene = JSON.stringify({ type: 'excalidraw', version: 2, source: 'packed-consumer', elements: [], appState: {}, files: {} });
  const canvasSetup = hasCanvas ? `import { configureExcalidrawAssets } from '@scriptorium-atlas/canvas';
import { exportExcalidrawScene, downloadBlob } from '@scriptorium-atlas/canvas/io';
configureExcalidrawAssets('/');
const editable = new URL(location.href).searchParams.has('editable');
let packedCanvasScene = editable ? ${JSON.stringify(editableScene)} : '{}';
` : '';
  const mounts = knownUi.map((module, index) => {
    if (module.specifier === '@scriptorium-atlas/canvas/ui') {
      return `React.createElement('section',{id:'canvas-consumer'},React.createElement(Ui${index},{sceneText:packedCanvasScene,style:{height:480},onChange:(scene)=>{packedCanvasScene=scene;globalThis.__packedCanvasScene=scene;}}),editable&&React.createElement('button',{id:'packed-svg-export',onClick:async()=>downloadBlob(await exportExcalidrawScene(packedCanvasScene,'svg'),'packed-consumer.svg')},'SVG export'))`;
    }
    const id = module.specifier === '@scriptorium-atlas/atlas/ui' ? 'atlas-consumer' : 'story-consumer';
    return `React.createElement('section',{id:${JSON.stringify(id)}},React.createElement(Ui${index},{host}))`;
  }).join(',\n');
  const source = `import React from 'react';
import { createRoot } from 'react-dom/client';
${uiImports}
${cssImports}
${canvasSetup}
const workspace={workspaceId:'pack-consumer-workspace',sourceRevision:'${'a'.repeat(64)}',epoch:1};
const host={snapshot:async()=>({workspace,files:[],nextCursor:null,complete:true}),list:async()=>({workspaceId:workspace.workspaceId,files:[],nextCursor:null,complete:true}),read:async()=>{throw new Error('Unexpected source read in empty consumer fixture.');},prepare:async()=>{throw new Error('Unexpected prepare in read-only consumer fixture.');},beginAsset:async()=>{throw new Error('Unexpected asset write in read-only consumer fixture.');},appendAsset:async()=>{throw new Error('Unexpected asset write in read-only consumer fixture.');},prepareAsset:async()=>{throw new Error('Unexpected asset write in read-only consumer fixture.');},requestSource:async()=>{throw new Error('Unexpected source request in empty consumer fixture.');},describeProviders:async()=>[],acquireProvider:async()=>{throw new Error('Unexpected provider acquisition in empty consumer fixture.');},providerCall:async()=>{throw new Error('Unexpected provider call in empty consumer fixture.');},releaseProvider:async()=>{},subscribeWorkspace:()=>()=>{}};
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,${mounts}));
`;
  const consumerCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'";
  await writeFile(join(consumerDirectory, 'index.html'), `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${consumerCsp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Atlas packed UI consumer</title></head><body><div id="root"></div><script type="module" src="/browser-consumer.mjs"></script></body></html>\n`, 'utf8');
  await writeFile(join(consumerDirectory, 'browser-consumer.mjs'), source, 'utf8');
  const canvasPlugins = hasCanvas ? `import { fileURLToPath } from 'node:url';
import { copyCanvasAssets, excalidrawWorkerVitePlugin } from '@scriptorium-atlas/canvas/assets';
const plugins=[excalidrawWorkerVitePlugin(),{name:'packed-canvas-assets',async closeBundle(){await copyCanvasAssets(fileURLToPath(new URL('./browser-dist',import.meta.url)));}}];\n` : 'const plugins=[];\n';
  await writeFile(join(consumerDirectory, 'vite.config.mjs'), `${canvasPlugins}export default { base: './', plugins, worker:{format:'es'}, build: { modulePreload:{polyfill:false}, outDir: 'browser-dist', emptyOutDir: true, manifest: true } };\n`, 'utf8');

  const build = await run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.mjs'], consumerDirectory);
  evidence.buildExitStatus = build.exitStatus;
  if (build.exitStatus !== 0) {
    evidence.status = 'FAIL';
    evidence.error = `external Vite browser build exited ${build.exitStatus}: ${(build.stderr || build.stdout).slice(-2500)}`;
    return evidence;
  }

  let manifest;
  try { manifest = JSON.parse(await readFile(join(consumerDirectory, 'browser-dist', '.vite', 'manifest.json'), 'utf8')); }
  catch (error) {
    evidence.status = 'FAIL';
    evidence.error = `external Vite build omitted a readable manifest: ${error instanceof Error ? error.message : String(error)}`;
    return evidence;
  }
  const lazyUiChunks = Object.values(manifest)
    .filter(entry => entry.isDynamicEntry && /excalidraw/i.test(entry.file))
    .map(entry => entry.file);
  if (!lazyUiChunks.length) {
    evidence.status = 'FAIL';
    evidence.error = 'the Canvas UI consumer build did not retain the lazy Excalidraw editor chunk';
    return evidence;
  }
  evidence.lazyUiChunks = lazyUiChunks;

  const port = await reservePort();
  const preview = { child: spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--config', 'vite.config.mjs'], { cwd: consumerDirectory, stdio: ['ignore', 'pipe', 'pipe'] }) };
  let previewOutput = '';
  for (const stream of [preview.child.stdout, preview.child.stderr]) stream.setEncoding('utf8').on('data', chunk => { previewOutput = (previewOutput + chunk).slice(-4000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    if (!await waitForHttp(baseUrl, preview)) throw new Error(`external Vite preview did not become ready: ${previewOutput.slice(-1800)}`);
    const requireFromRepository = createRequire(join(repoRoot, 'package.json'));
    const playwrightPackageJson = requireFromRepository.resolve('@playwright/test/package.json');
    const playwrightManifest = JSON.parse(await readFile(playwrightPackageJson, 'utf8'));
    const playwrightImport = playwrightManifest.exports?.['.']?.import;
    assert.equal(typeof playwrightImport, 'string', '@playwright/test must provide its ESM entry for browser verification');
    const { chromium } = await import(pathToFileURL(join(dirname(playwrightPackageJson), playwrightImport)).href);
    const executablePath = process.env.ATLAS_E2E_CHROMIUM;
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const requested = [];
      const pageErrors = [];
      page.on('request', request => requested.push(new URL(request.url()).pathname));
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      const rendered = [];
      if (knownUi.some(module => module.specifier === '@scriptorium-atlas/canvas/ui')) {
        const canvas = page.locator('#canvas-consumer .atlas-canvas-readonly');
        await canvas.waitFor({ state: 'visible', timeout: 30_000 });
        const position = await canvas.evaluate(element => getComputedStyle(element).position);
        assert.equal(position, 'relative', 'packed Canvas CSS must be applied in Chromium');
        rendered.push({ package: '@scriptorium-atlas/canvas', rendered: 'read-only Canvas', cssPosition: position });
      }
      if (knownUi.some(module => module.specifier === '@scriptorium-atlas/atlas/ui')) {
        const atlas = page.locator('#atlas-consumer .atlas-plugin');
        await atlas.waitFor({ state: 'visible', timeout: 30_000 });
        const display = await atlas.evaluate(element => getComputedStyle(element).display);
        assert.equal(display, 'flex', 'packed Atlas CSS must be applied in Chromium');
        rendered.push({ package: '@scriptorium-atlas/atlas', rendered: 'Atlas Plugin', cssDisplay: display });
      }
      if (knownUi.some(module => module.specifier === '@scriptorium-atlas/story-knowledge/ui')) {
        const story = page.locator('#story-consumer h1');
        await story.getByText('Story Knowledge', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
        rendered.push({ package: '@scriptorium-atlas/story-knowledge', rendered: 'Story Knowledge' });
      }
      assert.deepEqual(pageErrors, [], `packed browser UI raised page errors: ${pageErrors.join(' | ')}`);
      const requestedLazyUiChunks = requested.filter(path => lazyUiChunks.some(file => path.endsWith(`/${file}`)));
      assert.deepEqual(requestedLazyUiChunks, [], 'the invalid read-only scene must keep the lazy Excalidraw editor unloaded');
      if (hasCanvas) {
        await page.goto(`${baseUrl}?editable=1`, { waitUntil: 'domcontentloaded' });
        const editor = page.locator('#canvas-consumer .excalidraw');
        await editor.locator('canvas.excalidraw__canvas.interactive').waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('#canvas-consumer .atlas-canvas-accessibility > summary').click();
        await page.getByLabel('追加する要素').selectOption('text');
        await page.getByLabel('追加する文字').fill('PACKED_CANVAS_SVG');
        await page.getByRole('button', { name: '要素を追加', exact: true }).click();
        await page.waitForFunction(() => globalThis.__packedCanvasScene?.includes('PACKED_CANVAS_SVG'));
        const downloadPromise = page.waitForEvent('download');
        await page.locator('#packed-svg-export').click();
        const download = await downloadPromise;
        const svg = await readFile(await download.path(), 'utf8');
        assert.ok(svg.includes('<svg') && svg.includes('PACKED_CANVAS_SVG'), 'packed Canvas must export its actual native text through the public IO entry');
        assert.deepEqual(pageErrors, [], 'the editable packed Canvas and official font Worker must not raise browser errors');
        rendered.push({ package: '@scriptorium-atlas/canvas', rendered: 'editable native Canvas and SVG export', svgBytes: Buffer.byteLength(svg), svgSha256: createHash('sha256').update(svg).digest('hex') });
      }
      evidence.rendered = rendered;
      evidence.requestedLazyUiChunks = requestedLazyUiChunks;
      evidence.browser = { name: 'Chromium', version: browser.version(), executablePath: executablePath ?? 'Playwright bundled Chromium' };
      evidence.status = 'PASS';
    } finally {
      await browser.close();
    }
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    await stopChild(preview);
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
