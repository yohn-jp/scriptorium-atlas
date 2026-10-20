import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const hostRoot = process.env.ATLAS_HOST_ROOT;
if (!hostRoot) throw new Error('Set ATLAS_HOST_ROOT to the Host checkout containing dist/atlas and apps/standalone/scripts/serve.mjs.');

const requireFromHost = createRequire(resolve(hostRoot, 'package.json'));
const { chromium } = requireFromHost('@playwright/test');
const serverScript = resolve(hostRoot, 'apps/standalone/scripts/serve.mjs');
const browserPath = process.env.ATLAS_E2E_CHROMIUM;
const profile = process.env.ATLAS_PROFILE ?? 'atlas';
const report = { artifactRoot: resolve(hostRoot, `dist/${profile}`), artifactHead: process.env.ATLAS_ARTIFACT_HEAD ?? null, profile, cases: [], browser: null };

async function reservePorts() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = 36000 + Math.floor(Math.random() * 24000);
    const servers = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = createServer();
        await new Promise((resolveListen, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolveListen);
        });
        servers.push(server);
      }
      await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
      return base;
    } catch {
      await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
    }
  }
  throw new Error('Could not reserve three loopback ports for the Host server.');
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
    } catch {
      // Host and plugin servers may still be binding.
    }
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

async function commitPending(page, atlas) {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  try {
    await proposal.waitFor({ state: 'visible', timeout: 20000 });
  } catch (error) {
    const hostText = await page.locator('body').innerText();
    const atlasText = await atlas.locator('body').innerText();
    throw new Error(`Host did not receive the auto-prepared change. Host status: ${hostText.slice(-1200)}. Atlas status: ${atlasText.slice(-1400)}. ${error instanceof Error ? error.message : String(error)}`);
  }
  const priorStatuses = await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).allTextContents();
  await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await proposal.waitFor({ state: 'detached', timeout: 20000 });
  const status = page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).last();
  const deadline = Date.now() + 20000;
  let currentStatus = '';
  while (Date.now() < deadline) {
    currentStatus = await status.textContent().catch(() => '');
    if (currentStatus && !priorStatuses.includes(currentStatus)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(currentStatus && !priorStatuses.includes(currentStatus), 'Host should publish a new local commit receipt for each proposal.');
  await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
}

async function downloadBoard(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, 'Board export should have a readable temporary path.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function run() {
  const basePort = await reservePorts();
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
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1200 } });
    const page = await context.newPage();
    const pageErrors = [];
    const dialogs = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('dialog', async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const workspaceName = `Atlas graph ${randomUUID()}`;
    await page.getByLabel('Workspace名').fill(workspaceName);
    await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();

    const atlas = page.frameLocator('iframe[title="Atlas"]');
    await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitPending(page, atlas);
    report.cases.push('create-and-commit-board');

    await atlas.getByRole('button', { name: '＋ 手動ノード', exact: true }).click();
    const nodeNameInput = atlas.getByLabel('手動ノード名');
    await nodeNameInput.waitFor({ state: 'visible' });
    await nodeNameInput.fill('手動ノードA');
    await atlas.getByRole('button', { name: 'ノードを作成', exact: true }).click();
    const manualNodes = atlas.locator('.react-flow__node.atlas-flow-manual');
    await manualNodes.first().waitFor({ state: 'visible' });
    const visibility = await manualNodes.first().evaluate((node) => ({
      visibility: getComputedStyle(node).visibility,
      rect: { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height },
      id: node.getAttribute('data-id'),
      label: node.innerText,
    }));
    assert.equal(visibility.visibility, 'visible', `Graph node must be visibly rendered: ${JSON.stringify(visibility)}.`);
    assert.ok(visibility.rect.width >= 100 && visibility.rect.height >= 32, `Graph node must have usable hit area: ${JSON.stringify(visibility)}.`);
    assert.match(visibility.label, /手動ノードA/u);
    assert.equal(dialogs.length, 0, 'Manual node creation should work without native dialogs in the sandboxed iframe.');
    await commitPending(page, atlas);
    report.cases.push({ id: 'create-manual-node-without-native-dialog', ...visibility });

    const nodeId = visibility.id;
    assert.ok(nodeId, 'Created manual node must have a ReactFlow ID.');
    await manualNodes.first().click();
    const labelInput = atlas.getByLabel('名前');
    await labelInput.fill('手動ノードA改名');
    await labelInput.press('Tab');
    await manualNodes.first().getByText('手動ノードA改名', { exact: true }).waitFor({ state: 'visible' });
    await commitPending(page, atlas);
    report.cases.push('rename-manual-node-through-inspector');

    await manualNodes.first().click();
    await atlas.getByRole('button', { name: 'ノードを複製', exact: true }).click();
    await manualNodes.nth(1).waitFor({ state: 'visible' });
    await atlas.getByRole('button', { name: '元に戻す', exact: true }).click();
    await manualNodes.nth(1).waitFor({ state: 'detached' });
    await atlas.getByRole('button', { name: 'やり直す', exact: true }).click();
    await manualNodes.nth(1).waitFor({ state: 'visible' });
    assert.equal(await manualNodes.count(), 2, 'Redo should restore the duplicated manual node.');
    await commitPending(page, atlas);
    report.cases.push('duplicate-undo-redo-manual-node');

    const savedBoard = await downloadBoard(page, atlas);
    const savedManualNodes = savedBoard.nodes.filter((node) => node.origin === 'manual');
    assert.equal(savedManualNodes.length, 2, 'Committed board must contain both manual nodes.');
    assert.ok(savedManualNodes.some((node) => node.label === '手動ノードA改名'), 'The original node should retain its edited label.');
    assert.ok(savedManualNodes.some((node) => node.label === '手動ノードA改名 copy'), 'The duplicate should have the product-defined copy suffix.');
    assert.equal(new Set(savedManualNodes.map((node) => node.id)).size, 2, 'Duplicate must have a new stable ID.');
    report.cases.push('committed-board-contains-renamed-duplicate');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('開く').selectOption({ label: workspaceName });
    const reloadedAtlas = page.frameLocator('iframe[title="Atlas"]');
    const graphTab = reloadedAtlas.getByRole('tab', { name: /グラフ/u });
    await graphTab.waitFor({ state: 'visible' });
    await graphTab.click();
    const reloadedBoard = await downloadBoard(page, reloadedAtlas);
    const reloadedManualNodesData = reloadedBoard.nodes.filter((node) => node.origin === 'manual');
    assert.equal(reloadedManualNodesData.length, 2, `Host reload should restore both committed manual nodes; got ${JSON.stringify(reloadedManualNodesData)}.`);
    const reloadedNodes = reloadedAtlas.locator('.react-flow__node.atlas-flow-manual');
    await reloadedNodes.first().waitFor({ state: 'visible' });
    await reloadedNodes.nth(1).waitFor({ state: 'visible' });
    assert.equal(await reloadedNodes.count(), 2, 'Reloaded graph should restore both committed nodes.');
    assert.equal(await reloadedAtlas.getByLabel('ボード名').inputValue(), savedBoard.name);
    assert.deepEqual(
      reloadedManualNodesData.map((node) => ({ id: node.id, label: node.label })).sort((a, b) => a.id.localeCompare(b.id)),
      savedManualNodes.map((node) => ({ id: node.id, label: node.label })).sort((a, b) => a.id.localeCompare(b.id)),
      'Host reload should restore the exact committed manual node IDs and labels.',
    );
    report.cases.push('reload-restores-committed-graph-state');

    assert.deepEqual(dialogs, [], 'Sandboxed graph flow should not request native modal dialogs.');
    assert.deepEqual(pageErrors, [], 'Atlas Graph/history browser flow must not throw uncaught page errors.');
    report.cases.push('no-native-dialogs-or-uncaught-page-errors');
    await context.close();
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}

try {
  await run();
  process.stdout.write(`${JSON.stringify({ status: 'PASS', ...report }, null, 2)}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  const environmentBlocked = /browserType\.launch|error while loading shared libraries|Executable doesn't exist/u.test(detail);
  const status = environmentBlocked ? 'NOT_CHECKED' : 'FAIL';
  process.stderr.write(`${JSON.stringify({ status, ...report, error: detail }, null, 2)}\n`);
  if (status === 'FAIL') process.exitCode = 1;
}
