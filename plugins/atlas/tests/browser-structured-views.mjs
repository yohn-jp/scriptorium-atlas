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

async function commitUntilClean(page, atlas) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const indicator = atlas.locator('.atlas-save-indicator');
    if ((await indicator.textContent())?.includes('Hostの基準状態')) return;
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
    const cleanDeadline = Date.now() + 5000;
    while (Date.now() < cleanDeadline) {
      if ((await indicator.textContent())?.includes('Hostの基準状態')) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error('Atlas kept local changes after eight Host prepare/commit cycles.');
}

async function downloadBoard(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, 'Board export should have a readable temporary path.');
  return JSON.parse(await readFile(path, 'utf8'));
}

function laneLabelsInOrder(view) {
  const labelsById = new Map(view.lanes.map((lane) => [lane.id, lane.label]));
  return view.laneIds.map((id) => labelsById.get(id));
}

function makeViewFixture(board) {
  board.name = 'Q07 Structured Acceptance';
  const nodeId = 'q07-node-clock';
  const cardAId = 'q07-card-a';
  const cardBId = 'q07-card-b';
  board.nodes.push({ id: nodeId, origin: 'manual', kind: 'generic.note', label: '時刻付きノード', position: { x: 20, y: 30 } });
  board.cards.push(
    { id: cardAId, kind: 'text', position: { x: 40, y: 60 }, width: 240, height: 140, text: 'シーンA' },
    { id: cardBId, kind: 'text', position: { x: 80, y: 100 }, width: 240, height: 140, text: 'シーンB' },
  );
  const kanban = board.views.find((view) => view.kind === 'board');
  assert.ok(kanban?.lanes, 'Template board should contain explicit lanes.');
  kanban.lanes.find((lane) => lane.id === 'lane-unassigned').cardIds = [cardAId, cardBId];
  const timeline = board.views.find((view) => view.kind === 'timeline');
  assert.ok(timeline, 'Template board should contain a timeline view.');
  timeline.axis = 'generic.time';
  timeline.timeline = { range: { start: 0, end: 1000 }, entries: [
    { itemId: nodeId, value: 250 },
    { itemId: cardAId, value: 500 },
    { itemId: cardBId, value: null },
  ] };
  const storyboard = board.views.find((view) => view.kind === 'storyboard');
  assert.ok(storyboard, 'Template board should contain a storyboard view.');
  storyboard.cardOrder = [cardAId, cardBId];
  return { board, nodeId, cardAId, cardBId };
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
    const workspaceName = `Atlas views ${randomUUID()}`;
    await page.getByLabel('Workspace名').fill(workspaceName);
    await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();

    const atlas = page.frameLocator('iframe[title="Atlas"]');
    await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitUntilClean(page, atlas);
    const template = await downloadBoard(page, atlas);
    const fixture = makeViewFixture(template);
    await atlas.locator('input[type="file"][accept=".atlas.json,application/json"]').setInputFiles({
      name: 'q07-structured.atlas.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(fixture.board), 'utf8'),
    });
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitUntilClean(page, atlas);
    report.cases.push('import-and-commit-board-with-lanes-timeline-and-story-order');

    const boardViewTab = atlas.getByRole('tab', { name: /^ボード ボード$/u });
    await boardViewTab.click();
    const laneLabels = atlas.getByLabel('レーン名');
    await laneLabels.nth(1).fill('準備');
    await laneLabels.nth(1).press('Tab');
    await atlas.getByRole('region', { name: '準備' }).waitFor({ state: 'visible' });

    const unassignedLane = atlas.getByRole('region', { name: '未割り当て' });
    const unassignedCards = unassignedLane.locator('.atlas-structured-card');
    assert.deepEqual(await unassignedCards.locator('.atlas-card-title').allTextContents(), ['シーンA', 'シーンB']);
    await unassignedCards.nth(0).getByRole('button', { name: 'カードを下へ移動' }).click();
    assert.deepEqual(await unassignedCards.locator('.atlas-card-title').allTextContents(), ['シーンB', 'シーンA'], 'Kanban card reorder should change the saved lane order.');

    await atlas.getByRole('button', { name: '＋ レーンを追加' }).click();
    const allLaneLabels = atlas.getByLabel('レーン名');
    await allLaneLabels.last().fill('レビュー');
    await allLaneLabels.last().press('Tab');
    const reviewLane = atlas.getByRole('region', { name: 'レビュー' });
    await reviewLane.waitFor({ state: 'visible' });
    await reviewLane.getByRole('button', { name: 'レーンを左へ移動' }).click();
    const reorderedLaneLabels = await atlas.getByLabel('レーン名').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.deepEqual(reorderedLaneLabels, ['未割り当て', '準備', '進行中', 'レビュー', '完了']);

    const sceneA = unassignedLane.locator('.atlas-structured-card').filter({ hasText: 'シーンA' });
    await sceneA.getByLabel('移動先').selectOption({ label: '準備' });
    await atlas.getByRole('region', { name: '準備' }).locator('.atlas-structured-card').filter({ hasText: 'シーンA' }).waitFor({ state: 'visible' });
    assert.deepEqual(await unassignedLane.locator('.atlas-card-title').allTextContents(), ['シーンB']);
    await commitUntilClean(page, atlas);
    report.cases.push('kanban-lane-rename-add-reorder-card-order-and-assign');

    await atlas.getByRole('tab', { name: /^タイムライン タイムライン$/u }).click();
    const axis = atlas.getByLabel('軸');
    await axis.selectOption('story.scene-order');
    const axisConfirmation = atlas.getByRole('group', { name: 'タイムライン軸変更の確認' });
    await axisConfirmation.waitFor({ state: 'visible' });
    assert.equal(await axis.inputValue(), 'story.scene-order', 'Pending axis choice should be visible before confirmation.');
    await axisConfirmation.getByRole('button', { name: 'キャンセル' }).click();
    assert.equal(await axis.inputValue(), 'generic.time', 'Cancel should restore the saved axis.');
    assert.equal(await atlas.getByLabel('シーンA のタイムライン値').inputValue(), '500', 'Cancel must preserve existing timeline values.');

    await axis.selectOption('story.scene-order');
    await atlas.getByRole('group', { name: 'タイムライン軸変更の確認' }).getByRole('button', { name: '値を不明に戻して軸を変更' }).click();
    assert.equal(await axis.inputValue(), 'story.scene-order');
    assert.equal(await atlas.getByLabel('シーンA のタイムライン値').inputValue(), '', 'Confirmed axis change must reset existing values to unknown.');
    assert.equal(await atlas.getByLabel('時刻付きノード のタイムライン値').inputValue(), '', 'All node and card values should become unknown.');
    assert.equal(await atlas.locator('.atlas-timeline-marker.is-unknown').count(), 3, 'Null timeline values should render in the explicit unknown lane.');
    await commitUntilClean(page, atlas);
    report.cases.push('timeline-axis-confirm-cancel-and-explicit-unknown-values');

    await atlas.getByRole('tab', { name: /^ストーリーボード ストーリーボード$/u }).click();
    const storyRows = atlas.locator('.atlas-storyboard-card');
    assert.deepEqual(await storyRows.locator('strong').allTextContents(), ['シーンA', 'シーンB']);
    await storyRows.first().getByRole('button', { name: 'シーンを後ろへ移動' }).click();
    assert.deepEqual(await storyRows.locator('strong').allTextContents(), ['シーンB', 'シーンA'], 'Storyboard order should change without inferring timeline dates.');
    await commitUntilClean(page, atlas);
    report.cases.push('storyboard-order-reorder-and-commit');

    const committed = await downloadBoard(page, atlas);
    const committedBoard = committed.views.find((view) => view.kind === 'board');
    const committedTimeline = committed.views.find((view) => view.kind === 'timeline');
    const committedStory = committed.views.find((view) => view.kind === 'storyboard');
    assert.deepEqual(laneLabelsInOrder(committedBoard), ['未割り当て', '準備', '進行中', 'レビュー', '完了']);
    assert.deepEqual(committedBoard.lanes.find((lane) => lane.label === '未割り当て').cardIds, [fixture.cardBId]);
    assert.deepEqual(committedBoard.lanes.find((lane) => lane.label === '準備').cardIds, [fixture.cardAId]);
    assert.equal(committedTimeline.axis, 'story.scene-order');
    assert.ok(committedTimeline.timeline.entries.every((entry) => entry.value === null), 'Saved explicit axis change should retain null=unknown entries.');
    assert.deepEqual(committedStory.cardOrder, [fixture.cardBId, fixture.cardAId]);
    report.cases.push('exported-document-preserves-lanes-unknown-values-and-story-order');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('開く').selectOption({ label: workspaceName });
    const reloadedAtlas = page.frameLocator('iframe[title="Atlas"]');
    await reloadedAtlas.locator('.atlas-board-tab').filter({ hasText: 'Q07 Structured Acceptance' }).click();
    await reloadedAtlas.getByRole('tab', { name: /^タイムライン タイムライン$/u }).waitFor({ state: 'visible' });
    const reloadedBoard = await downloadBoard(page, reloadedAtlas);
    const reloadedTimeline = reloadedBoard.views.find((view) => view.kind === 'timeline');
    const reloadedStory = reloadedBoard.views.find((view) => view.kind === 'storyboard');
    const reloadedKanban = reloadedBoard.views.find((view) => view.kind === 'board');
    assert.equal(reloadedTimeline.axis, 'story.scene-order');
    assert.ok(reloadedTimeline.timeline.entries.every((entry) => entry.value === null));
    assert.deepEqual(reloadedStory.cardOrder, [fixture.cardBId, fixture.cardAId]);
    assert.deepEqual(laneLabelsInOrder(reloadedKanban), ['未割り当て', '準備', '進行中', 'レビュー', '完了']);
    report.cases.push('reload-restores-kanban-timeline-and-storyboard-state');

    assert.deepEqual(dialogs, [], 'Structured view operations should not request native modal dialogs in the sandbox.');
    assert.deepEqual(pageErrors, [], 'Structured view browser flow must not throw uncaught page errors.');
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
