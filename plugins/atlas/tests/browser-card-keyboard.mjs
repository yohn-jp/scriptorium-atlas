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
  assert.fail('Host should publish a new local commit receipt for each Atlas card change.');
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

async function downloadBoard(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }).click();
  const path = await (await downloadPromise).path();
  assert.ok(path, 'Board export should have a readable temporary path.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function activeCard(atlas) {
  return atlas.locator('body').evaluate((body) => {
    const active = document.activeElement;
    const card = active instanceof HTMLElement ? active.closest('.atlas-canvas-card') : null;
    if (!(card instanceof HTMLElement)) return null;
    const cards = [...body.querySelectorAll('.atlas-canvas-card')];
    return {
      index: cards.indexOf(card),
      isCardRoot: active === card,
      selected: card.classList.contains('is-selected'),
      controlLabel: active instanceof HTMLElement ? active.getAttribute('aria-label') : null,
    };
  });
}

async function tabUntil(page, atlas, predicate, label) {
  for (let count = 0; count < 100; count += 1) {
    await page.keyboard.press('Tab');
    const state = await activeCard(atlas);
    if (predicate(state)) return state;
  }
  assert.fail(`Tab navigation did not reach ${label}; current focus=${JSON.stringify(await activeCard(atlas))}.`);
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
    const workspaceName = `Atlas card keyboard ${randomUUID()}`;
    await page.getByLabel('Workspace名').fill(workspaceName);
    await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
    const atlas = page.frameLocator('iframe[title="Atlas"]');

    await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByLabel('ビューを追加').selectOption('freeform');
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByRole('button', { name: '＋ テキストカード' }).click();
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByRole('button', { name: '＋ テキストカード' }).click();
    await commitAtlasUntilClean(page, atlas);
    let board = await downloadBoard(page, atlas);
    const initialCards = board.cards;
    assert.equal(initialCards.length, 2, 'The browser fixture should start with two Host-committed cards.');
    const initialById = new Map(initialCards.map((card) => [card.id, { ...card.position, width: card.width, height: card.height }]));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('開く').selectOption({ label: workspaceName });
    const reloadedAtlas = page.frameLocator('iframe[title="Atlas"]');
    await reloadedAtlas.getByRole('tab', { name: /キャンバス/u }).last().click();
    await reloadedAtlas.locator('.atlas-canvas-card').nth(0).waitFor({ state: 'visible' });
    await reloadedAtlas.getByRole('tab', { name: /キャンバス/u }).last().focus();
    const firstFocus = await tabUntil(page, reloadedAtlas, (state) => state?.index === 0 && state.isCardRoot, 'the first existing card');
    assert.equal(firstFocus.selected, true, 'Tab focus should select the first existing card after reload.');
    await page.keyboard.press('ArrowRight');
    await reloadedAtlas.locator('.atlas-save-indicator').filter({ hasText: '未保存の変更' }).waitFor({ state: 'visible' });
    const secondFocus = await tabUntil(page, reloadedAtlas, (state) => state?.index === 1 && state.isCardRoot, 'the second existing card');
    assert.equal(secondFocus.selected, true, 'Tab focus should select the second existing card after reload.');
    const resizeFocus = await tabUntil(page, reloadedAtlas, (state) => state?.index === 1 && state.controlLabel === 'カードのサイズを変更', 'the second card resize control');
    assert.equal(resizeFocus.selected, true, 'The resize control should belong to the selected second card.');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await commitAtlasUntilClean(page, reloadedAtlas);
    board = await downloadBoard(page, reloadedAtlas);
    const firstAfterKeyboard = board.cards.find((card) => card.id === initialCards[0]?.id);
    const secondAfterKeyboard = board.cards.find((card) => card.id === initialCards[1]?.id);
    const firstBefore = initialById.get(initialCards[0]?.id ?? '');
    const secondBefore = initialById.get(initialCards[1]?.id ?? '');
    assert.ok(firstAfterKeyboard && firstBefore && (firstAfterKeyboard.position.x === firstBefore.x + 10), 'ArrowRight on the first card should save a 10-unit move.');
    assert.ok(secondAfterKeyboard && secondBefore && secondAfterKeyboard.width === secondBefore.width + 10 && secondAfterKeyboard.height === secondBefore.height + 40,
      'ArrowRight and Shift+ArrowDown on the second resize control should save the requested width and height changes.');
    report.cases.push('tab-focus-selects-two-existing-cards-and-keyboard-move-resize-save');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('開く').selectOption({ label: workspaceName });
    const finalAtlas = page.frameLocator('iframe[title="Atlas"]');
    await finalAtlas.getByRole('tab', { name: /キャンバス/u }).last().click();
    await finalAtlas.locator('.atlas-canvas-card').nth(0).waitFor({ state: 'visible' });
    const finalBoard = await downloadBoard(page, finalAtlas);
    assert.deepEqual(finalBoard.cards.map((card) => ({ id: card.id, position: card.position, width: card.width, height: card.height })),
      board.cards.map((card) => ({ id: card.id, position: card.position, width: card.width, height: card.height })),
      'Host reload should restore the exact keyboard-moved and resized card geometry.');
    await finalAtlas.getByRole('tab', { name: /キャンバス/u }).last().focus();
    const finalFirstFocus = await tabUntil(page, finalAtlas, (state) => state?.index === 0 && state.isCardRoot, 'the first card after final reload');
    assert.equal(finalFirstFocus.selected, true, 'Existing cards should remain keyboard-selectable after saving and reloading.');
    report.cases.push('host-reload-restores-keyboard-edited-card-geometry');
    assert.deepEqual(dialogs, [], 'Card keyboard actions should not require native dialogs.');
    assert.deepEqual(pageErrors, [], 'Card keyboard actions must not throw uncaught page errors.');
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
