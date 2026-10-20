import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const hostRoot = process.env.ATLAS_HOST_ROOT;
if (!hostRoot) throw new Error('Set ATLAS_HOST_ROOT to the Host checkout containing dist/combined and apps/standalone/scripts/serve.mjs.');

const profile = process.env.ATLAS_PROFILE ?? 'combined';
const requireFromHost = createRequire(resolve(hostRoot, 'package.json'));
const { chromium } = requireFromHost('@playwright/test');
const serverScript = resolve(hostRoot, 'apps/standalone/scripts/serve.mjs');
const browserPath = process.env.ATLAS_E2E_CHROMIUM;
const report = { artifactRoot: resolve(hostRoot, `dist/${profile}`), artifactHead: process.env.ATLAS_ARTIFACT_HEAD ?? null, profile, cases: [], browser: null };

async function reservePort() {
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

async function commitPending(page, expectedText = '') {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.waitFor({ state: 'visible', timeout: 20000 });
  if (expectedText) assert.ok((await proposal.innerText()).includes(expectedText), `Host proposal should include ${expectedText}.`);
  const previous = await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).allTextContents();
  await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await proposal.waitFor({ state: 'detached', timeout: 20000 });
  const receipt = page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).last();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = await receipt.textContent().catch(() => '');
    if (current && !previous.includes(current)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.fail('Host should publish a local commit receipt for each proposal.');
}

async function commitAtlasUntilClean(page, atlas) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const indicator = atlas.locator('.atlas-save-indicator');
    if ((await indicator.textContent())?.includes('Hostの基準状態')) return;
    await commitPending(page);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await indicator.textContent())?.includes('Hostの基準状態')) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  assert.fail(`Atlas did not become clean: ${await atlas.locator('.atlas-save-indicator').textContent()}`);
}

async function createStoryCharacter(page, story, name) {
  const create = story.locator('article.card').filter({ has: story.getByRole('heading', { name: '作成', exact: true }) });
  await create.getByLabel('種類').selectOption('character');
  await create.getByLabel('表示名').fill(name);
  await create.getByLabel('別名').fill(`${name}-alias`);
  await create.getByLabel('タグ').fill('atlas-refresh');
  await create.getByLabel('追加フィールド（JSON）').fill(JSON.stringify({ description: `Provider refresh acceptance ${name}` }));
  await create.getByRole('button', { name: '作成案をプレビュー' }).click();
  await story.locator('section[aria-label="変更案プレビュー"]').waitFor({ state: 'visible' });
  await story.locator('section[aria-label="変更案プレビュー"]').getByRole('button', { name: 'HostのReviewへ変更案を提出' }).click();
  await story.getByRole('status').filter({ hasText: 'HostのReviewへ変更案を提出しました' }).waitFor({ state: 'visible' });
  await commitPending(page, name);
  await story.getByRole('option').filter({ hasText: name }).first().waitFor({ state: 'visible' });
}

async function chooseStoryCharacter(story, name) {
  await story.getByRole('button', { name: 'ライブラリ', exact: true }).click();
  const library = story.locator('aside[aria-label="Storyエンティティ一覧"]');
  await library.getByLabel('検索').fill('');
  await library.getByLabel('種類').selectOption('character');
  const option = library.getByRole('option').filter({ hasText: name }).first();
  await option.waitFor({ state: 'visible' });
  await option.click();
  return story.locator('article.card').filter({ has: story.getByRole('heading', { name: `人物: ${name}`, exact: true }) }).first();
}

async function editStoryCharacter(page, story, currentName, nextName) {
  const detail = await chooseStoryCharacter(story, currentName);
  await detail.getByLabel('表示名').fill(nextName);
  await detail.getByRole('button', { name: '編集案をプレビュー' }).click();
  await story.locator('section[aria-label="変更案プレビュー"]').waitFor({ state: 'visible' });
  await story.locator('section[aria-label="変更案プレビュー"]').getByRole('button', { name: 'HostのReviewへ変更案を提出' }).click();
  await story.getByRole('status').filter({ hasText: 'HostのReviewへ変更案を提出しました' }).waitFor({ state: 'visible' });
  await commitPending(page, nextName);
  await story.getByRole('option').filter({ hasText: nextName }).first().waitFor({ state: 'visible' });
}

async function deleteStoryCharacter(page, story, name) {
  await chooseStoryCharacter(story, name);
  const deletion = story.locator('article.card').filter({ has: story.getByRole('heading', { name: '削除', exact: true }) });
  await deletion.getByRole('button', { name: '削除案を確認' }).click();
  const preview = story.locator('section[aria-label="変更案プレビュー"]');
  await preview.waitFor({ state: 'visible' });
  await preview.getByRole('button', { name: 'HostのReviewへ変更案を提出' }).click();
  await story.getByRole('status').filter({ hasText: 'HostのReviewへ変更案を提出しました' }).waitFor({ state: 'visible' });
  await commitPending(page, name);
  await story.getByRole('option').filter({ hasText: name }).first().waitFor({ state: 'detached' });
}

async function downloadBoard(page, atlas) {
  const download = page.waitForEvent('download');
  await atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }).click();
  const path = await (await download).path();
  assert.ok(path, 'The board export should have a readable temporary path.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function addProviderNode(page, atlas, name) {
  const search = atlas.getByLabel('Providerスナップショットを検索');
  await search.fill(name);
  const hit = atlas.locator('.atlas-search-hit').filter({ hasText: name }).first();
  await hit.waitFor({ state: 'visible' });
  await hit.getByRole('button', { name: 'ノードを追加' }).click();
  await commitAtlasUntilClean(page, atlas);
}

async function run() {
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
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1200 } });
    const page = await context.newPage();
    const pageErrors = [];
    const dialogs = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('dialog', async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const workspaceName = `Atlas Provider refresh ${randomUUID()}`;
    await page.getByLabel('Workspace名').fill(workspaceName);
    await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
    await page.getByLabel('AtlasへStory ProviderとSourceの読取りを許可').check();
    const story = page.frameLocator('iframe[title="Story Knowledge"]');
    await story.getByRole('heading', { name: 'Story Knowledge', exact: true }).waitFor({ state: 'visible' });
    const originalName = `変更前${randomUUID().slice(0, 6)}`;
    const deletedName = `削除対象${randomUUID().slice(0, 6)}`;
    const updatedName = `${originalName} 改訂`;
    await createStoryCharacter(page, story, originalName);
    await createStoryCharacter(page, story, deletedName);

    const atlas = page.frameLocator('iframe[title="Atlas"]');
    await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByLabel('Providerを選択').selectOption('scriptorium.story-knowledge');
    await atlas.getByRole('button', { name: '選択したProviderを接続' }).click();
    await atlas.locator('.atlas-status-inline').filter({ hasText: 'ノード 2 件' }).waitFor({ state: 'visible', timeout: 30000 });
    await addProviderNode(page, atlas, originalName);
    await addProviderNode(page, atlas, deletedName);
    let board = await downloadBoard(page, atlas);
    const originalNode = board.nodes.find((node) => node.label === originalName);
    const deletedNode = board.nodes.find((node) => node.label === deletedName);
    assert.ok(originalNode?.ref && deletedNode?.ref, 'Both Story references should be saved on the Atlas board.');

    await atlas.getByRole('button', { name: '全体を表示' }).click();
    const flowNode = atlas.locator(`.react-flow__node[data-id="${originalNode.id}"]`);
    await flowNode.waitFor({ state: 'visible' });
    const nodeBox = await flowNode.boundingBox();
    const flowBox = await atlas.locator('.atlas-graph-flow').boundingBox();
    const iframeBox = await page.locator('iframe[title="Atlas"]').boundingBox();
    const viewport = page.viewportSize();
    assert.ok(nodeBox && flowBox && iframeBox && viewport, 'The graph node and visible canvas must have browser geometry.');
    const visible = {
      left: Math.max(0, flowBox.x, iframeBox.x), top: Math.max(0, flowBox.y, iframeBox.y),
      right: Math.min(viewport.width, flowBox.x + flowBox.width, iframeBox.x + iframeBox.width),
      bottom: Math.min(viewport.height, flowBox.y + flowBox.height, iframeBox.y + iframeBox.height),
    };
    const start = { x: nodeBox.x + nodeBox.width / 2, y: nodeBox.y + nodeBox.height / 2 };
    assert.ok(start.x >= visible.left && start.x <= visible.right && start.y >= visible.top && start.y <= visible.bottom, `Pin drag must start inside the visible graph: ${JSON.stringify({ start, visible, nodeBox, flowBox, iframeBox })}`);
    const end = { x: Math.min(visible.right - 8, start.x + 45), y: Math.min(visible.bottom - 8, start.y + 35) };
    assert.ok(end.x !== start.x || end.y !== start.y, 'The visible graph must have room to move a node and pin it.');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    const nodeBeforeRefresh = board.nodes.find((node) => node.id === originalNode.id);
    const graphViewBeforeRefresh = board.views.find((view) => view.kind === 'graph');
    assert.ok(nodeBeforeRefresh && graphViewBeforeRefresh?.pins?.some((pin) => pin.nodeId === originalNode.id && pin.mode === 'manual'), 'The browser drag should create a persisted manual pin.');
    const positionBeforeRefresh = { ...nodeBeforeRefresh.position };
    report.cases.push('story-provider-connected-and-reference-pinned-through-physical-drag');

    await editStoryCharacter(page, story, originalName, updatedName);
    await atlas.locator('.atlas-status-inline').filter({ hasText: '接続中Providerを更新してください' }).waitFor({ state: 'visible', timeout: 20000 });
    await atlas.getByRole('button', { name: '接続中Providerを更新' }).click();
    await atlas.locator('.atlas-status-inline').filter({ hasText: '差分適用' }).waitFor({ state: 'visible', timeout: 30000 });
    await flowNode.getByText(updatedName, { exact: true }).waitFor({ state: 'visible' });
    board = await downloadBoard(page, atlas);
    const preservedNode = board.nodes.find((node) => node.id === originalNode.id);
    const graphViewAfterEdit = board.views.find((view) => view.kind === 'graph');
    assert.deepEqual(preservedNode?.position, positionBeforeRefresh, 'Refreshing provider values should not move the pinned Board node.');
    assert.ok(graphViewAfterEdit?.pins?.some((pin) => pin.nodeId === originalNode.id && pin.mode === 'manual'), 'Provider refresh should preserve the saved manual pin.');
    assert.equal(preservedNode?.label, originalName, 'Refreshing provider data must not rewrite Atlas-owned saved labels.');
    await atlas.getByLabel('Providerスナップショットを検索').fill(updatedName);
    await atlas.locator('.atlas-search-hit').filter({ hasText: updatedName }).waitFor({ state: 'visible' });
    report.cases.push('story-edit-diff-refresh-updates-current-flow-label-and-preserves-board-pin');

    await deleteStoryCharacter(page, story, deletedName);
    await atlas.locator('.atlas-status-inline').filter({ hasText: '接続中Providerを更新してください' }).waitFor({ state: 'visible', timeout: 20000 });
    await atlas.getByRole('button', { name: '接続中Providerを更新' }).click();
    await atlas.locator('.atlas-status-inline').filter({ hasText: '差分適用' }).waitFor({ state: 'visible', timeout: 30000 });
    const unresolvedNode = atlas.locator(`.react-flow__node[data-id="${deletedNode.id}"]`);
    await unresolvedNode.waitFor({ state: 'visible' });
    await unresolvedNode.getByText(`${deletedName}（未解決）`, { exact: true }).waitFor({ state: 'visible' });
    board = await downloadBoard(page, atlas);
    const retainedRef = board.nodes.find((node) => node.id === deletedNode.id);
    assert.deepEqual(retainedRef?.ref, deletedNode.ref, 'A deleted provider entity should remain on the Board as its original unresolved reference.');
    assert.equal(retainedRef?.label, deletedName, 'An unresolved provider reference should retain its saved Board label.');
    await atlas.getByLabel('Providerスナップショットを検索').fill(deletedName);
    await atlas.locator('.atlas-search-hit').waitFor({ state: 'detached' });
    report.cases.push('story-delete-diff-refresh-retains-stable-reference-as-unresolved');

    assert.deepEqual(dialogs, [], 'Provider refresh should not require native dialogs.');
    assert.deepEqual(pageErrors, [], 'Provider refresh should not cause uncaught page errors.');
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
  process.stdout.write(`${JSON.stringify({ status, ...report, error: detail }, null, 2)}\n`);
  process.exitCode = status === 'NOT_CHECKED' ? 2 : 1;
}
