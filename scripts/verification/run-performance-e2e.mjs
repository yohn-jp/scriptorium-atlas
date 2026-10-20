import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentHead, hashTree } from './artifact-evidence.mjs';

const repoRoot = resolve(process.env.ATLAS_PERF_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const report = {
  schemaVersion: 'atlas.performance-e2e-evidence/v1',
  purpose: 'Real Chromium performance subset for deterministic Graph and Canvas datasets; this is not a full Q12 or Q01-Q15 verdict.',
  headSha: currentHead(repoRoot),
  exactCli: process.env.ATLAS_PERF_EXACT_CLI ?? `${process.argv[0]} ${process.argv.slice(1).join(' ')}`,
  argv: process.argv,
  environment: { node: process.version, platform: os.platform(), release: os.release(), architecture: os.arch(), logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), browser: null },
  profile: null,
  profileArtifact: null,
  datasetGeneration: [],
  scenarios: [],
  explicitlyNotChecked: [
    { id: 'Q12-force-cancellation-ack', status: 'NOT_CHECKED', reason: 'This runner measures the production 1k Force request but does not yet guarantee cancellation while a calculation is in flight.' },
    { id: 'Q12-disabled-plugin-network-poll-and-heavy-import', status: 'NOT_CHECKED', reason: 'Dedicated Worker teardown is observed; network polling and dynamic heavy-code import are not yet independently audited here.' },
    { id: 'Q12-commit-reload-manifest-revision-equality', status: 'NOT_CHECKED', reason: 'This runner does not create a performance Board commit and compare the post-reload Host manifest and revision.' },
  ],
  suiteStatus: 'NOT_CHECKED',
  exitStatus: null,
};

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function reservePorts() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = 36_000 + Math.floor(Math.random() * 20_000);
    const servers = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = createServer();
        await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
        servers.push(server);
      }
      await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
      return base;
    } catch {
      await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
    }
  }
  throw new Error('Could not reserve three consecutive loopback ports.');
}

function spawnCaptured(argv, cwd, env) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const hash = createHash('sha256');
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; });
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  return { child, argv, exited, evidence: () => ({ outputBytes: bytes, outputSha256: hash.copy().digest('hex') }) };
}

async function waitServer(server, url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.ok) return true;
    } catch { /* wait for the three profile listeners */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return { exitStatus: server.child.exitCode, signal: server.child.signalCode };
  server.child.kill('SIGTERM');
  const exit = await Promise.race([server.exited, new Promise((resolveDelay) => setTimeout(() => resolveDelay(null), 5_000))]);
  if (exit) return exit;
  server.child.kill('SIGKILL');
  return server.exited;
}

async function generateDataset(generator, tempRoot, name, args) {
  const archivePath = resolve(tempRoot, `${name}.zip`);
  const summaryPath = resolve(tempRoot, `${name}.summary.json`);
  const argv = [process.execPath, generator, ...args, '--output', archivePath, '--report', summaryPath];
  const processResult = spawnCaptured(argv, repoRoot, process.env);
  const exit = await processResult.exited;
  const evidence = { name, argv, exitStatus: exit.code, signal: exit.signal, ...processResult.evidence() };
  report.datasetGeneration.push(evidence);
  if (exit.code !== 0) return null;
  const [archive, summaryText] = await Promise.all([readFile(archivePath), readFile(summaryPath, 'utf8')]);
  const summary = JSON.parse(summaryText);
  if (digest(archive) !== summary.archiveSha256) throw new Error(`${name} archive digest does not match the generator summary.`);
  evidence.archiveBytes = archive.byteLength;
  evidence.archiveSha256 = summary.archiveSha256;
  return { archive, summary };
}

const tempRoot = await mkdtemp(resolve(os.tmpdir(), 'atlas-perf-e2e-'));
let server;
let browser;
try {
  report.profile = 'combined';
  const profileRoot = resolve(repoRoot, 'dist/combined');
  const profileInfo = await stat(profileRoot).catch(() => null);
  if (!profileInfo?.isDirectory()) throw new Error('dist/combined is missing; build the combined profile before performance E2E.');
  report.profileArtifact = await hashTree(profileRoot);

  const generator = resolve(repoRoot, 'scripts/verification/generate-performance-dataset.mjs');
  const generated = [];
  generated.push(await generateDataset(generator, tempRoot, 'one-k', ['--nodes', '1000', '--edges', '2000', '--layout-nodes', '1000']));
  generated.push(await generateDataset(generator, tempRoot, 'ten-k', ['--nodes', '10000', '--edges', '20000']));
  generated.push(await generateDataset(generator, tempRoot, 'canvas-100', ['--nodes', '0', '--edges', '0', '--cards', '100']));
  generated.push(await generateDataset(generator, tempRoot, 'canvas-500', ['--nodes', '0', '--edges', '0', '--cards', '500']));
  if (generated.some((item) => !item)) throw new Error('At least one deterministic dataset bundle could not be generated.');
  const [oneK, tenK, canvas100, canvas500] = generated;
  const datasets = { oneK: oneK.summary, tenK: tenK.summary, canvas100: canvas100.summary, canvas500: canvas500.summary };

  const requireFromRepository = createRequire(resolve(repoRoot, 'package.json'));
  const playwrightPackageJson = requireFromRepository.resolve('@playwright/test/package.json');
  const playwrightManifest = JSON.parse(await readFile(playwrightPackageJson, 'utf8'));
  const playwrightImport = playwrightManifest.exports?.['.']?.import;
  if (typeof playwrightImport !== 'string') throw new Error('@playwright/test does not provide its ESM entry for performance browser verification.');
  const { chromium } = await import(pathToFileURL(resolve(dirname(playwrightPackageJson), playwrightImport)).href);
  const chromiumPath = process.env.ATLAS_E2E_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
  report.environment.browser = { name: 'Chromium', version: browser.version(), executablePath: chromiumPath ?? 'Playwright bundled Chromium' };
  const basePort = await reservePorts();
  const baseUrl = `http://127.0.0.1:${basePort}`;
  server = spawnCaptured([process.execPath, 'apps/standalone/scripts/serve.mjs', 'combined'], repoRoot, {
    ...process.env,
    ATLAS_HOST_PORT: String(basePort), ATLAS_PLUGIN_PORT: String(basePort + 1), ATLAS_STORY_PORT: String(basePort + 2),
  });
  const ready = await waitServer(server, baseUrl);
  if (!ready) throw new Error(`Combined profile static server did not become ready: ${JSON.stringify(server.evidence())}`);

  const { runPerformanceCases } = await import('../../tests/e2e/performance.mjs');
  await runPerformanceCases({ browser, baseUrl, archives: { oneK: oneK.archive, tenK: tenK.archive, canvas100: canvas100.archive, canvas500: canvas500.archive }, datasets, record: async (id, run) => {
    try {
      const evidence = await run();
      const unresolved = evidence.notCheckedReasons ?? [];
      report.scenarios.push({ id, status: unresolved.length ? 'NOT_CHECKED' : 'PASS', ...(unresolved.length ? { notCheckedReasons: unresolved } : {}), evidence });
    }
    catch (error) { report.scenarios.push({ id, status: 'FAIL', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }); }
  } });
} catch (error) {
  report.setupError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!report.scenarios.length) report.scenarios.push({ id: 'performance-runner-setup', status: 'NOT_CHECKED', reason: report.setupError });
} finally {
  await browser?.close().catch(() => undefined);
  if (server) report.server = { argv: server.argv, outputEvidence: server.evidence(), shutdown: await stopServer(server) };
  await rm(tempRoot, { recursive: true, force: true });
}

const statuses = [...report.scenarios.map((item) => item.status), ...report.explicitlyNotChecked.map((item) => item.status)];
if (statuses.includes('FAIL')) report.suiteStatus = 'FAIL';
else if (!statuses.length || statuses.includes('NOT_CHECKED')) report.suiteStatus = 'NOT_CHECKED';
else report.suiteStatus = 'PASS';
report.exitStatus = report.suiteStatus === 'PASS' ? 0 : report.suiteStatus === 'FAIL' ? 1 : 2;
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.ATLAS_PERF_REPORT) await writeFile(resolve(process.env.ATLAS_PERF_REPORT), serialized, 'utf8');
process.stdout.write(serialized);
process.exitCode = report.exitStatus;
