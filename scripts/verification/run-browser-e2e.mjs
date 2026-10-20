import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const profileNames = ['atlas', 'story', 'combined'];
const caseIds = [
  'Q02-empty-workspace-create-edit-reload',
  'Q03-bundle-export-import-roundtrip-and-invalid-import-preserves-workspace',
  'Q05-pending-draft-recovers-after-forced-page-reload',
  'Q01-profile-plugin-presence-and-host-origin-storage-isolation',
  'Q05-indexeddb-denial-fails-closed',
  'Q05-quota-aborted-commit-preserves-source-and-recoverable-draft'
];

async function hashTree(directory) {
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await walk(directory);
  files.sort((left, right) => {
    const leftPath = relative(directory, left);
    const rightPath = relative(directory, right);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const digest = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const content = await readFile(file);
    const path = relative(directory, file).split('\\').join('/');
    bytes += content.byteLength;
    digest.update(path).update('\0').update(String(content.byteLength)).update('\0').update(content);
  }
  return { sha256: digest.digest('hex'), files: files.length, bytes };
}

async function reserveBasePort() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = 36000 + Math.floor(Math.random() * 24000);
    const reservations = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = createServer();
        await new Promise((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(port, '127.0.0.1', resolveListen);
        });
        reservations.push(server);
      }
      await Promise.all(reservations.map(server => new Promise(resolveClose => server.close(resolveClose))));
      return base;
    } catch {
      await Promise.all(reservations.map(server => new Promise(resolveClose => server.close(resolveClose))));
    }
  }
  throw new Error('Could not reserve three consecutive loopback ports for the static profile server.');
}

function spawnServer(profile, basePort) {
  const argv = ['apps/standalone/scripts/serve.mjs', profile];
  const child = spawn(process.execPath, argv, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ATLAS_HOST_PORT: String(basePort),
      ATLAS_PLUGIN_PORT: String(basePort + 1),
      ATLAS_STORY_PORT: String(basePort + 2)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ exitStatus: code, signal })));
  child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.stderr.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-12000); });
  return { child, argv: [process.execPath, ...argv], exited, get output() { return output; } };
}

async function waitForServer(server, baseUrl) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return false;
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(500) });
      const ready = response.ok;
      await response.body?.cancel();
      if (ready) return true;
    } catch {
      // The server may still be binding its Host and Plugin ports.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return false;
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return { exitStatus: server.child.exitCode, signal: server.child.signalCode };
  }
  server.child.kill('SIGTERM');
  const exit = await Promise.race([
    server.exited,
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout(null), 5000))
  ]);
  if (exit) return exit;
  server.child.kill('SIGKILL');
  return await server.exited;
}

function notCheckedCases(reason) {
  return caseIds.map(id => ({ id, status: 'NOT_CHECKED', reason }));
}

async function inspectArtifact(profile) {
  const directory = resolve(repoRoot, 'dist', profile);
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) throw new Error('not a directory');
    return { directory, ...await hashTree(directory) };
  } catch {
    return null;
  }
}

function repoHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const report = {
  schemaVersion: 'atlas.browser-e2e-evidence/v1',
  purpose: 'Host storage and profile-origin E2E subset. These checks do not establish Q01-Q15 as a whole.',
  headSha: repoHead(),
  exactCli: process.env.ATLAS_E2E_EXACT_CLI ?? `${process.argv[0]} ${process.argv.slice(1).join(' ')}`,
  argv: process.argv,
  environment: {
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    browser: null
  },
  profiles: [],
  suiteStatus: 'NOT_CHECKED',
  exitStatus: null
};

let browser;
let browserError;
try {
  const { chromium } = await import('playwright');
  const executablePath = process.env.ATLAS_E2E_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  report.environment.browser = {
    name: 'Chromium',
    version: browser.version(),
    executablePath: executablePath ?? 'Playwright bundled Chromium'
  };
} catch (error) {
  browserError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const requestedProfiles = (process.env.ATLAS_E2E_PROFILES ?? profileNames.join(','))
  .split(',').map(value => value.trim()).filter(Boolean);
const invalidProfiles = requestedProfiles.filter(profile => !profileNames.includes(profile));
if (invalidProfiles.length) {
  report.profiles.push({ profile: invalidProfiles.join(','), status: 'FAIL', reason: 'Unknown profile name.' });
}

if (browserError) {
  for (const profile of requestedProfiles.filter(name => profileNames.includes(name))) {
    const artifact = await inspectArtifact(profile);
    report.profiles.push({
      profile,
      artifact: artifact && { sha256: artifact.sha256, files: artifact.files, bytes: artifact.bytes },
      cases: notCheckedCases(`Chromium could not launch: ${browserError}`),
      server: null
    });
  }
} else {
  const { runHostStorageCases } = await import('../../tests/e2e/host-storage.mjs');
  for (const profile of requestedProfiles.filter(name => profileNames.includes(name))) {
    const profileReport = { profile, artifact: null, cases: [], server: null };
    report.profiles.push(profileReport);
    const artifact = await inspectArtifact(profile);
    if (!artifact) {
      profileReport.cases = notCheckedCases(`Build artifact dist/${profile} is missing; build this profile before browser verification.`);
      continue;
    }
    profileReport.artifact = { sha256: artifact.sha256, files: artifact.files, bytes: artifact.bytes };

    let server;
    try {
      const basePort = await reserveBasePort();
      const baseUrl = `http://127.0.0.1:${basePort}`;
      server = spawnServer(profile, basePort);
      const ready = await waitForServer(server, baseUrl);
      if (!ready) {
        profileReport.cases = notCheckedCases(`Static server did not become ready. ${server.output}`);
        profileReport.server = {
          argv: server.argv,
          ready: false,
          output: server.output,
          shutdown: await stopServer(server)
        };
        server = undefined;
        continue;
      }
      profileReport.server = { argv: server.argv, ready: true, baseUrl };
      await runHostStorageCases({
        browser,
        baseUrl,
        profile,
        record: async (id, run) => {
          try {
            profileReport.cases.push({ id, status: 'PASS', evidence: await run() });
          } catch (error) {
            profileReport.cases.push({
              id,
              status: 'FAIL',
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            });
          }
        }
      });
      profileReport.server.shutdown = await stopServer(server);
      server = undefined;
    } catch (error) {
      if (server) {
        profileReport.server = {
          ...(profileReport.server ?? {}),
          argv: server.argv,
          output: server.output,
          shutdown: await stopServer(server)
        };
      }
      profileReport.cases.push({
        id: 'profile-runner',
        status: 'FAIL',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      });
    }
  }
}

await browser?.close();
const allCases = report.profiles.flatMap(profile => profile.cases ?? []);
if (invalidProfiles.length || allCases.some(test => test.status === 'FAIL')) report.suiteStatus = 'FAIL';
else if (allCases.length === 0 || allCases.some(test => test.status === 'NOT_CHECKED')) report.suiteStatus = 'NOT_CHECKED';
else report.suiteStatus = 'PASS';
report.exitStatus = report.suiteStatus === 'PASS' ? 0 : report.suiteStatus === 'FAIL' ? 1 : 2;

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.ATLAS_E2E_REPORT) await writeFile(resolve(process.env.ATLAS_E2E_REPORT), serialized, 'utf8');
process.stdout.write(serialized);
process.exitCode = report.exitStatus;
