import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentHead, hashTree } from './artifact-evidence.mjs';

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
  const outputDigest = createHash('sha256');
  let outputBytes = 0;
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ exitStatus: code, signal })));
  const capture = stream => stream.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputDigest.update(bytes);
    outputBytes += bytes.byteLength;
  });
  capture(child.stdout);
  capture(child.stderr);
  return {
    child,
    argv: [process.execPath, ...argv],
    exited,
    get outputEvidence() { return { bytes: outputBytes, sha256: outputDigest.copy().digest('hex') }; }
  };
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

const report = {
  schemaVersion: 'atlas.browser-e2e-evidence/v1',
  purpose: 'Host storage and profile-origin E2E subset. These checks do not establish Q01-Q15 as a whole.',
  headSha: currentHead(repoRoot),
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
  const { chromium } = await import('@playwright/test');
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
      exactCli: report.exactCli,
      artifact: artifact && { sha256: artifact.sha256, files: artifact.files, bytes: artifact.bytes },
      cases: notCheckedCases(`Chromium could not launch: ${browserError}`),
      server: null
    });
  }
} else {
  const { runHostStorageCases } = await import('../../tests/e2e/host-storage.mjs');
  for (const profile of requestedProfiles.filter(name => profileNames.includes(name))) {
    const profileReport = { profile, artifact: null, cases: [], server: null };
    profileReport.exactCli = report.exactCli;
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
          outputEvidence: server.outputEvidence,
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
          outputEvidence: server.outputEvidence,
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
for (const profile of report.profiles) {
  const cases = profile.cases ?? [];
  if (cases.some(test => test.status === 'FAIL')) profile.status = 'FAIL';
  else if (cases.length === 0 || cases.some(test => test.status === 'NOT_CHECKED')) profile.status = 'NOT_CHECKED';
  else profile.status = 'PASS';
  profile.exitStatus = profile.status === 'PASS' ? 0 : profile.status === 'FAIL' ? 1 : 2;
}
const allCases = report.profiles.flatMap(profile => profile.cases ?? []);
if (invalidProfiles.length || allCases.some(test => test.status === 'FAIL')) report.suiteStatus = 'FAIL';
else if (allCases.length === 0 || allCases.some(test => test.status === 'NOT_CHECKED')) report.suiteStatus = 'NOT_CHECKED';
else report.suiteStatus = 'PASS';
report.exitStatus = report.suiteStatus === 'PASS' ? 0 : report.suiteStatus === 'FAIL' ? 1 : 2;

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.ATLAS_E2E_REPORT) await writeFile(resolve(process.env.ATLAS_E2E_REPORT), serialized, 'utf8');
process.stdout.write(serialized);
process.exitCode = report.exitStatus;
