import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const hostRoot = process.env.ATLAS_HOST_ROOT;
if (!hostRoot) throw new Error('Set ATLAS_HOST_ROOT to the Host checkout containing dist/atlas and apps/standalone/scripts/serve.mjs.');

const requireFromHost = createRequire(resolve(hostRoot, 'package.json'));
const { chromium } = requireFromHost('@playwright/test');
const serverScript = resolve(hostRoot, 'apps/standalone/scripts/serve.mjs');
const browserPath = process.env.ATLAS_E2E_CHROMIUM;
const profile = process.env.ATLAS_PROFILE ?? 'atlas';
const report = { artifactRoot: resolve(hostRoot, `dist/${profile}`), artifactHead: process.env.ATLAS_ARTIFACT_HEAD ?? null, profile, cases: [], browser: null };

function progress(message) {
  process.stderr.write(`[viewport-e2e] ${message}\n`);
}

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
  const previous = await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).allTextContents();
  await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await proposal.waitFor({ state: 'detached', timeout: 20000 });
  const status = page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).last();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = await status.textContent().catch(() => '');
    if (current && !previous.includes(current)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.fail('Host should publish a local commit receipt for each Atlas viewport change.');
}

async function commitAtlasUntilClean(page, atlas) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await atlas.locator('.atlas-save-indicator').textContent())?.includes('Hostの基準状態')) return;
    await commitPending(page);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await atlas.locator('.atlas-save-indicator').textContent())?.includes('Hostの基準状態')) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  assert.fail(`Atlas did not become clean: ${await atlas.locator('.atlas-save-indicator').textContent()}`);
}

async function commitAtlasUntilStable(page, atlas) {
  const proposalSelector = 'section[aria-label="変更の承認"] article';
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await page.locator(proposalSelector).count()) {
      await commitPending(page);
      continue;
    }
    const saveState = await atlas.locator('.atlas-save-indicator').textContent();
    if (!saveState?.includes('Hostの基準状態')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      continue;
    }
    const firstBoard = await downloadBoard(page, atlas);
    const firstScene = await downloadScene(page, atlas);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    if (await page.locator(proposalSelector).count()) continue;
    if (!(await atlas.locator('.atlas-save-indicator').textContent())?.includes('Hostの基準状態')) continue;
    const stableBoard = await downloadBoard(page, atlas);
    const stableScene = await downloadScene(page, atlas);
    if (!isDeepStrictEqual(firstBoard, stableBoard) || !firstScene.equals(stableScene)) continue;
    return { board: stableBoard, scene: stableScene };
  }
  assert.fail(`Atlas did not reach a stable Host-committed Board and scene: ${await atlas.locator('.atlas-save-indicator').textContent()}`);
}

async function downloadBoard(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }).click();
  const path = await (await downloadPromise).path();
  assert.ok(path, 'Board export should have a readable temporary path.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function downloadScene(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.getByRole('button', { name: '.excalidrawをエクスポート' }).click();
  const path = await (await downloadPromise).path();
  assert.ok(path, 'Excalidraw export should have a readable temporary path.');
  return readFile(path);
}

async function renameActiveView(atlas, name) {
  const input = atlas.getByLabel('ビュー名');
  await input.fill(name);
  await input.press('Enter');
  await atlas.getByRole('tab', { name: new RegExp(name, 'u') }).waitFor({ state: 'visible' });
}

async function renameActiveBoard(atlas, name) {
  const input = atlas.getByLabel('ボード名');
  await input.fill(name);
  await input.press('Enter');
  await atlas.getByRole('button', { name: new RegExp(name, 'u') }).waitFor({ state: 'visible' });
}

async function selectView(atlas, name) {
  await atlas.getByRole('tab', { name: new RegExp(name, 'u') }).click();
  await atlas.locator('.atlas-freeform-view').waitFor({ state: 'visible' });
  await atlas.locator('.atlas-canvas-card').first().waitFor({ state: 'visible' });
  await atlas.locator('.excalidraw__canvas').first().waitFor({ state: 'visible' });
}

async function closeCanvasKeyboardControls(atlas) {
  const summary = atlas.getByText('キーボード操作と要素一覧', { exact: true });
  const open = await summary.evaluate((element) => element.parentElement instanceof HTMLDetailsElement && element.parentElement.open);
  if (open) await summary.press('Enter');
}

async function zoom(page, atlas, direction, count) {
  await closeCanvasKeyboardControls(atlas);
  const canvas = atlas.locator('.excalidraw__canvas.interactive').first();
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100, 'The official Canvas surface should be visible for native zoom shortcuts.');
  await page.mouse.click(box.x + box.width - 90, box.y + box.height - 90);
  const shortcut = direction === 'in' ? 'Control+Equal' : 'Control+Minus';
  for (let index = 0; index < count; index += 1) await page.keyboard.press(shortcut);
  await page.waitForTimeout(220);
}

async function overflowZoomUntilRejected(page, atlas) {
  await closeCanvasKeyboardControls(atlas);
  const canvas = atlas.locator('.excalidraw__canvas.interactive').first();
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100, 'The official Canvas surface should be visible for native zoom shortcuts.');
  const focusPoint = { x: box.x + box.width - 90, y: box.y + box.height - 90 };
  await page.mouse.click(focusPoint.x, focusPoint.y);
  const rejection = atlas.getByRole('status').filter({ hasText: '保存範囲外' });
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(220);
    if (await rejection.count()) return;
  }
  await rejection.waitFor({ state: 'visible', timeout: 10000 });
}

async function setCanvasPosition(atlas, x, y) {
  const summary = atlas.getByText('キーボード操作と要素一覧', { exact: true });
  const open = await summary.evaluate((element) => element.parentElement instanceof HTMLDetailsElement && element.parentElement.open);
  if (!open) await summary.press('Enter');
  await atlas.getByLabel('Canvas表示位置X').fill(String(x));
  await atlas.getByLabel('Canvas表示位置Y').fill(String(y));
  await atlas.getByRole('button', { name: '表示位置を適用' }).press('Enter');
}

async function pan(page, atlas, dx, dy) {
  await closeCanvasKeyboardControls(atlas);
  const canvas = atlas.locator('.excalidraw__canvas.interactive').first();
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100, 'The visible official Canvas surface should have usable geometry.');
  const start = { x: box.x + box.width - 90, y: box.y + box.height - 90 };
  const end = { x: start.x + dx, y: start.y + dy };
  const viewport = page.viewportSize();
  assert.ok(viewport && start.x > 0 && start.y > 0 && end.x < viewport.width && end.y < viewport.height,
    'The physical pan should remain inside the visible browser viewport.');
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(start.x, start.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  for (let step = 1; step <= 32; step += 1) {
    await page.mouse.move(start.x + dx * step / 32, start.y + dy * step / 32);
    await new Promise((resolveWait) => setTimeout(resolveWait, 16));
  }
  await page.mouse.up();
  await page.keyboard.up('Space');
}

async function cardOffset(atlas) {
  return atlas.locator('.atlas-canvas-card').first().evaluate((card) => ({
    left: getComputedStyle(card).left,
    top: getComputedStyle(card).top,
  }));
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
    const dialogs = [];
    const pageErrors = [];
    page.on('dialog', async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const workspaceName = `Atlas freeform viewport ${randomUUID()}`;
    await page.getByLabel('Workspace名').fill(workspaceName);
    await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
    const atlas = page.frameLocator('iframe[title="Atlas"]');

    await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitAtlasUntilClean(page, atlas);
    await renameActiveBoard(atlas, 'Viewport Board A');
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByRole('button', { name: '＋ 新しいボード' }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await renameActiveBoard(atlas, 'Viewport Board B');
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByRole('button', { name: /Viewport Board A/u }).click();
    await atlas.getByLabel('ビューを追加').selectOption('freeform');
    await renameActiveView(atlas, 'Viewport B');
    const freeformTabs = atlas.getByRole('tab', { name: /キャンバス/u });
    await freeformTabs.first().click();
    await renameActiveView(atlas, 'Viewport A');
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByRole('tab', { name: /Viewport A/u }).click();
    await atlas.getByRole('button', { name: '＋ テキストカード' }).click();
    await atlas.locator('.atlas-canvas-card').waitFor({ state: 'visible' });
    await commitAtlasUntilClean(page, atlas);
    progress('two-board, two-view fixture committed');

    const initial = await downloadBoard(page, atlas);
    const viewAId = initial.views.find((view) => view.name === 'Viewport A')?.id;
    const viewBId = initial.views.find((view) => view.name === 'Viewport B')?.id;
    assert.ok(viewAId && viewBId && viewAId !== viewBId, 'The fixture must contain two independently identified Canvas views.');
    const initialViewports = new Map(initial.views.filter((view) => view.id === viewAId || view.id === viewBId).map((view) => [view.id, view.viewport]));
    const originalScene = await downloadScene(page, atlas);
    progress('Board and scene baselines captured');

    await selectView(atlas, 'Viewport A');
    const initialOffsetA = await cardOffset(atlas);
    await setCanvasPosition(atlas, 10000001, 80);
    await atlas.getByRole('status').filter({ hasText: '保存範囲外' }).waitFor({ state: 'visible' });
    const afterInvalidPan = await downloadBoard(page, atlas);
    assert.deepEqual(afterInvalidPan.views.find((view) => view.id === viewAId)?.viewport, initialViewports.get(viewAId),
      'An out-of-contract pan must not be persisted to the Board.');
    assert.deepEqual(await cardOffset(atlas), initialOffsetA,
      'An out-of-contract pan must remount Canvas at the last valid saved viewport.');
    assert.deepEqual(await downloadScene(page, atlas), originalScene,
      'Rejecting an out-of-contract pan must preserve the separate Excalidraw scene bytes.');
    report.cases.push('out-of-contract-pan-rejected-with-board-and-scene-preserved');
    progress('out-of-contract camera rejection verified');

    await setCanvasPosition(atlas, 10000001, 80);
    // The status remains visible from the first rejection; wait past Canvas's
    // 180ms settled-camera callback so this proves the repeated action ran.
    await page.waitForTimeout(250);
    assert.deepEqual(await cardOffset(atlas), initialOffsetA,
      'Repeating an identical invalid pan after Canvas remount must restore the last valid camera again.');
    assert.deepEqual((await downloadBoard(page, atlas)).views.find((view) => view.id === viewAId)?.viewport,
      initialViewports.get(viewAId), 'A repeated identical invalid pan must not change the persisted Board viewport.');
    assert.deepEqual(await downloadScene(page, atlas), originalScene,
      'A repeated identical invalid pan must preserve the separate Excalidraw scene bytes.');
    report.cases.push('repeated-identical-invalid-pan-restores-camera-and-preserves-data');

    await setCanvasPosition(atlas, -120, 80);
    await atlas.getByRole('status').filter({ hasText: '保存範囲外' }).waitFor({ state: 'detached' });
    progress('valid camera input clears the rejection status');
    await zoom(page, atlas, 'in', 2);
    await pan(page, atlas, 74, 46);
    await page.waitForTimeout(600);
    const changedA = await downloadBoard(page, atlas);
    let viewportA = changedA.views.find((view) => view.id === viewAId)?.viewport;
    assert.ok(viewportA && viewportA.zoom > (initialViewports.get(viewAId)?.zoom ?? 1), 'Canvas zoom should be saved to the active Atlas view.');
    assert.ok(viewportA && (viewportA.x !== initialViewports.get(viewAId)?.x || viewportA.y !== initialViewports.get(viewAId)?.y),
      'A physical Canvas pan should update the active Atlas view viewport.');
    let offsetA = await cardOffset(atlas);
    assert.deepEqual(await downloadScene(page, atlas), originalScene,
      'Pan and zoom should update only the Atlas Board viewport; the separate Excalidraw scene bytes must remain unchanged.');
    progress('native keyboard zoom and trusted physical pan updated the active view');
    await pan(page, atlas, -42, 34);
    await atlas.getByRole('button', { name: /Viewport Board B/u }).click();
    await atlas.getByRole('button', { name: /Viewport Board A/u }).click();
    await selectView(atlas, 'Viewport A');
    const afterBoardSwitch = await downloadBoard(page, atlas);
    const switchedViewportA = afterBoardSwitch.views.find((view) => view.id === viewAId)?.viewport;
    assert.ok(switchedViewportA && viewportA && (switchedViewportA.x !== viewportA.x || switchedViewportA.y !== viewportA.y),
      'A pending Canvas pan must flush into its original Board when switching to another Board.');
    viewportA = switchedViewportA;
    offsetA = await cardOffset(atlas);
    assert.deepEqual(await downloadScene(page, atlas), originalScene,
      'Switching Boards while a Canvas pan is pending must leave the original Excalidraw scene unchanged.');
    report.cases.push('pending-pan-flushes-to-original-board-on-board-switch');
    progress('pending camera callback flushed to its original Board');

    await selectView(atlas, 'Viewport B');
    const beforeB = await downloadBoard(page, atlas);
    assert.deepEqual(beforeB.views.find((view) => view.id === viewBId)?.viewport, initialViewports.get(viewBId),
      'A pan in one Canvas view must not alter another view’s saved viewport.');
    await overflowZoomUntilRejected(page, atlas);
    const afterInvalidZoom = await downloadBoard(page, atlas);
    const lastValidViewportB = afterInvalidZoom.views.find((view) => view.id === viewBId)?.viewport;
    assert.ok(lastValidViewportB && lastValidViewportB.zoom <= 8, 'An out-of-contract Canvas zoom must not be persisted.');
    assert.deepEqual(await downloadScene(page, atlas), originalScene,
      'Rejecting an out-of-contract zoom must preserve the separate Excalidraw scene bytes.');
    await setCanvasPosition(atlas, 180, -90);
    await zoom(page, atlas, 'out', 1);
    await pan(page, atlas, -53, 38);
    await page.waitForTimeout(600);
    const changedB = await downloadBoard(page, atlas);
    const viewportB = changedB.views.find((view) => view.id === viewBId)?.viewport;
    assert.ok(viewportB && lastValidViewportB && viewportB.zoom < lastValidViewportB.zoom, 'The second Canvas view should retain its own zoom state.');
    assert.ok(viewportB && lastValidViewportB && (viewportB.x !== lastValidViewportB.x || viewportB.y !== lastValidViewportB.y),
      'The second Canvas view should retain its own pan state.');
    const offsetB = await cardOffset(atlas);
    assert.notDeepEqual(offsetA, offsetB, 'Different saved viewports should place the same Atlas card at different visible coordinates.');
    assert.deepEqual(await downloadScene(page, atlas), originalScene,
      'Viewport state for a second Canvas view must not be written into the shared Excalidraw scene.');
    report.cases.push('physical-pan-and-zoom-persist-independently-per-freeform-view');
    progress('independent viewports and scene-byte stability verified');

    const { board: committed, scene: committedScene } = await commitAtlasUntilStable(page, atlas);
    progress('explicit Host approvals drained until Board and scene bytes were stable');
    const committedA = committed.views.find((view) => view.id === viewAId)?.viewport;
    const committedB = committed.views.find((view) => view.id === viewBId)?.viewport;
    assert.deepEqual(committedA, viewportA, 'The Host proposal must contain the exact first view viewport.');
    assert.deepEqual(committedB, viewportB, 'The Host proposal must contain the exact second view viewport.');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('開く').selectOption({ label: workspaceName });
    const reloadedAtlas = page.frameLocator('iframe[title="Atlas"]');
    await reloadedAtlas.getByRole('button', { name: /Viewport Board A/u }).click();
    await reloadedAtlas.getByRole('tab', { name: /Viewport A/u }).waitFor({ state: 'visible' });
    await selectView(reloadedAtlas, 'Viewport A');
    const restoredOffsetA = await cardOffset(reloadedAtlas);
    const reloadedBoardA = await downloadBoard(page, reloadedAtlas);
    assert.deepEqual(reloadedBoardA, committed, 'Reload should expose the exact Board content acknowledged by Host, including its latest viewport proposal.');
    assert.deepEqual(await downloadScene(page, reloadedAtlas), committedScene, 'Reload should retain the exact separately committed Excalidraw scene bytes.');
    assert.deepEqual(reloadedBoardA.views.find((view) => view.id === viewAId)?.viewport, committedA,
      'Host reload should restore the exact first Atlas viewport.');
    assert.deepEqual(restoredOffsetA, offsetA, 'Host reload should restore the first Canvas camera over the same card positions.');

    await selectView(reloadedAtlas, 'Viewport B');
    const restoredOffsetB = await cardOffset(reloadedAtlas);
    const reloadedBoardB = await downloadBoard(page, reloadedAtlas);
    assert.deepEqual(reloadedBoardB.views.find((view) => view.id === viewBId)?.viewport, committedB,
      'Host reload should restore the exact second Atlas viewport.');
    assert.deepEqual(restoredOffsetB, offsetB, 'Host reload should restore the second Canvas camera independently.');
    report.cases.push('host-commit-and-reload-restores-each-freeform-camera');
    progress('Host commit and reload restored both cameras');
    assert.deepEqual(dialogs, [], 'Viewport navigation should not require native dialogs.');
    assert.deepEqual(pageErrors, [], 'Canvas viewport interaction must not throw uncaught page errors.');
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
