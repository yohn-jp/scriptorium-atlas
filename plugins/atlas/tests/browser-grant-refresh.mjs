import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const hostRoot = process.env.ATLAS_HOST_ROOT;
if (!hostRoot) throw new Error('Set ATLAS_HOST_ROOT to the Host checkout containing dist/combined and scripts/verification/generate-performance-dataset.mjs.');

const profile = 'combined';
const artifactRoot = resolve(hostRoot, `dist/${profile}`);
const requireFromHost = createRequire(resolve(hostRoot, 'package.json'));
const { chromium } = requireFromHost('@playwright/test');
const serverScript = resolve(hostRoot, 'apps/standalone/scripts/serve.mjs');
const generatorScript = resolve(hostRoot, 'scripts/verification/generate-performance-dataset.mjs');
const browserPath = process.env.ATLAS_E2E_CHROMIUM;
const report = {
  artifactRoot,
  artifactHead: process.env.ATLAS_ARTIFACT_HEAD ?? null,
  profile,
  dataset: { storyFiles: 600, totalFiles: 601, snapshotPageLimit: 500 },
  browser: null,
  cases: [],
};

function installAtlasSnapshotHold() {
  if (window === window.top || new URL(location.href).searchParams.get('plugin') !== 'atlas') return;
  const originalPostMessage = MessagePort.prototype.postMessage;
  const trace = [];
  let held = null;
  globalThis.__atlasSnapshotTrace = trace;
  globalThis.__atlasSnapshotHoldAvailable = false;
  MessagePort.prototype.postMessage = function (message, ...args) {
    if (message?.type === 'atlas.host.request' && message.method === 'snapshot') {
      const entry = { cursor: message.params?.cursor ?? null, limit: message.params?.limit ?? null };
      trace.push(entry);
      if (entry.cursor && held === null) {
        held = { port: this, message, args };
        globalThis.__atlasSnapshotHoldAvailable = true;
        return;
      }
    }
    return originalPostMessage.call(this, message, ...args);
  };
  globalThis.__releaseAtlasSnapshotHold = () => {
    if (!held) return false;
    const request = held;
    held = null;
    originalPostMessage.call(request.port, request.message, ...request.args);
    return true;
  };
}

async function reservePort() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = 36000 + Math.floor(Math.random() * 24000);
    const server = createServer();
    try {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolveListen);
      });
      await new Promise((resolveClose) => server.close(resolveClose));
      return port;
    } catch {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
  throw new Error('Could not reserve a loopback port for the Host server.');
}

async function waitForServer(server, url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Host server exited with ${server.exitCode}.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      const ready = response.ok;
      await response.body?.cancel();
      if (ready) return;
    } catch { /* Host may still be binding. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Host server did not become ready within 15 seconds.');
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise((resolveExit) => server.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5000)),
  ]);
  if (stopped === false) {
    server.kill('SIGKILL');
    await new Promise((resolveExit) => server.once('exit', resolveExit));
  }
}

async function commitPending(page) {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.waitFor({ state: 'visible', timeout: 20000 });
  await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await proposal.waitFor({ state: 'detached', timeout: 20000 });
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).last().waitFor({ state: 'visible', timeout: 20000 });
}

async function generateDataset(tempRoot) {
  const output = resolve(tempRoot, 'grant-refresh.zip');
  const result = spawnSync(process.execPath, [generatorScript, '--nodes', '600', '--edges', '1200', '--output', output], {
    cwd: hostRoot,
    encoding: 'utf8',
    env: { ...process.env, ATLAS_GENERATOR_HEAD_SHA: process.env.ATLAS_ARTIFACT_HEAD ?? 'unrecorded' },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Performance fixture generation failed: ${result.stderr || result.stdout}`);
  return output;
}

async function run() {
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'atlas-grant-refresh-'));
  const archivePath = await generateDataset(tempRoot);
  const basePort = await reservePort();
  const baseUrl = `http://127.0.0.1:${basePort}`;
  const server = spawn(process.execPath, [serverScript, profile], {
    cwd: hostRoot,
    env: { ...process.env, ATLAS_HOST_PORT: String(basePort), ATLAS_PLUGIN_PORT: String(basePort + 1), ATLAS_STORY_PORT: String(basePort + 2) },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(server, baseUrl);
    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
    report.browser = { name: 'Chromium', version: browser.version(), executablePath: browserPath ?? 'Playwright bundled Chromium' };
    const context = await browser.newContext({ acceptDownloads: true, locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(installAtlasSnapshotHold);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Bundleをimport').setInputFiles(archivePath);
    await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor({ timeout: 60000 });

    const atlasFrame = page.frames().find((frame) => frame.url().includes('/frame.html?plugin=atlas'));
    assert.ok(atlasFrame, 'The Atlas plugin frame should be present after opening the real bundle.');
    await atlasFrame.waitForFunction(() => globalThis.__atlasSnapshotHoldAvailable === true, undefined, { timeout: 30000 });
    const heldTrace = await atlasFrame.evaluate(() => globalThis.__atlasSnapshotTrace);
    assert.equal(heldTrace.length, 2, `Atlas should reach the second cursor page before the grant changes: ${JSON.stringify(heldTrace)}`);
    assert.ok(heldTrace[0].cursor === null && heldTrace[1].cursor, 'The held request must be the continuation page with the old grant-scoped cursor.');

    const atlas = page.frameLocator('iframe[title="Atlas"]');
    await page.getByLabel('AtlasへStory ProviderとSourceの読取りを許可', { exact: true }).check();
    await atlasFrame.waitForFunction(() => globalThis.__atlasSnapshotTrace.some((entry, index) => index >= 2 && entry.cursor === null), undefined, { timeout: 15000 });
    await atlas.locator('.atlas-board-tab').filter({ hasText: 'Deterministic performance board' }).waitFor({ state: 'visible', timeout: 60000 });
    await atlas.locator('.atlas-save-indicator').filter({ hasText: 'Hostの基準状態を読み込み済み' }).waitFor({ state: 'visible', timeout: 60000 });

    const nextName = `下書き保持 ${Date.now()}`;
    const boardName = atlas.getByLabel('ボード名');
    await boardName.fill(nextName);
    await boardName.press('Tab');
    await atlas.getByRole('button', { name: '＋ 手動ノード', exact: true }).click();
    const nodeName = `履歴保持 ${Date.now()}`;
    await atlas.getByLabel('手動ノード名').fill(nodeName);
    await atlas.getByRole('button', { name: 'ノードを作成', exact: true }).click();
    const manualNode = atlas.locator('.react-flow__node.atlas-flow-manual').filter({ hasText: nodeName });
    await manualNode.waitFor({ state: 'visible', timeout: 20000 });
    await atlas.locator('.atlas-save-indicator').filter({ hasText: 'ローカル下書きに変更あり' }).waitFor({ state: 'visible' });
    const undo = atlas.getByRole('button', { name: '元に戻す', exact: true });
    await undo.waitFor({ state: 'visible' });
    assert.equal(await undo.isEnabled(), true, 'The local manual-node command should be in the undo history.');

    const released = await atlasFrame.evaluate(() => globalThis.__releaseAtlasSnapshotHold());
    assert.equal(released, true, 'The stale old-cursor request should be released after the newer inventory succeeds.');
    await page.waitForTimeout(300);
    assert.equal(await atlas.getByRole('alert').count(), 0, 'The stale cursor failure must not replace the newer successful refresh with a fatal alert.');
    await atlas.locator('.atlas-save-indicator').filter({ hasText: 'ローカル下書きに変更あり' }).waitFor({ state: 'visible' });
    assert.equal(await boardName.inputValue(), nextName, 'A grant refresh must preserve the dirty Board name.');
    await manualNode.waitFor({ state: 'visible' });

    const redo = atlas.getByRole('button', { name: 'やり直す', exact: true });
    await undo.click();
    await manualNode.waitFor({ state: 'detached' });
    await redo.waitFor({ state: 'visible' });
    assert.equal(await redo.isEnabled(), true, 'Undo after refresh should make redo available.');
    await redo.click();
    await manualNode.waitFor({ state: 'visible' });
    assert.equal(await boardName.inputValue(), nextName, 'Undo/redo after refresh must retain the Board-name draft.');

    const trace = await atlasFrame.evaluate(() => globalThis.__atlasSnapshotTrace);
    assert.ok(trace.length >= 4, `Both inventory traversals should have paged: ${JSON.stringify(trace)}`);
    assert.equal(trace[0].limit, 500);
    assert.ok(trace[1].cursor, 'The delayed initial request should carry an opaque cursor.');
    assert.equal(trace[2].cursor, null, 'The notified refresh must restart from page one.');
    assert.equal(trace[2].limit, 500, 'The notified refresh should keep the snapshot page limit.');
    assert.ok(trace[3].cursor, 'The refreshed inventory should continue with its own opaque cursor.');
    assert.equal(trace[3].limit, 500, 'The refreshed cursor page should keep the snapshot page limit.');
    assert.deepEqual(pageErrors, [], 'Grant refresh must not cause uncaught browser errors.');
    report.snapshotTrace = trace.map((entry) => ({ cursor: entry.cursor === null ? null : '<opaque>', limit: entry.limit }));
    report.cases.push('grant-notification-restarts-at-page-one-after-cursor-scope-change');
    report.cases.push('stale-cursor-failure-does-not-overwrite-newer-success-or-show-fatal-error');
    report.cases.push('dirty-board-name-and-undo-redo-history-survive-grant-refresh');
    report.cases.push('no-uncaught-browser-errors');
    await context.close();
  } finally {
    await browser?.close();
    await stopServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  await run();
  process.stdout.write(`${JSON.stringify({ status: 'PASS', ...report }, null, 2)}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  const environmentBlocked = /browserType\.launch|error while loading shared libraries|Executable doesn't exist/u.test(detail);
  const status = environmentBlocked ? 'NOT_CHECKED' : 'FAIL';
  process.stdout.write(`${JSON.stringify({ status, ...report, error: detail }, null, 2)}\n`);
  process.exitCode = status === 'NOT_CHECKED' ? 2 : 1;
}
