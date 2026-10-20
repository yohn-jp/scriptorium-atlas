import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));
const hostRoot = process.env.ATLAS_HOST_ROOT;
if (!hostRoot) throw new Error('Set ATLAS_HOST_ROOT to the Host checkout containing dist/atlas and apps/standalone/scripts/serve.mjs.');

const requireFromHost = createRequire(resolve(hostRoot, 'package.json'));
const { chromium } = requireFromHost('@playwright/test');
const serverScript = resolve(hostRoot, 'apps/standalone/scripts/serve.mjs');
const browserPath = process.env.ATLAS_E2E_CHROMIUM;
const report = { artifactRoot: resolve(hostRoot, 'dist/atlas'), cases: [], browser: null };

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
  await proposal.waitFor({ state: 'visible', timeout: 20000 });
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

async function downloadText(page, button) {
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `Download ${download.suggestedFilename()} should have a readable temporary path.`);
  return { name: download.suggestedFilename(), content: await readFile(path, 'utf8') };
}

function readPngDimensions(bytes) {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', 'Export must be a PNG image.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function run() {
  const basePort = await reservePorts();
  const baseUrl = `http://127.0.0.1:${basePort}`;
  const server = spawn(process.execPath, [serverScript, 'atlas'], {
    cwd: hostRoot,
    env: { ...process.env, ATLAS_HOST_PORT: String(basePort), ATLAS_PLUGIN_PORT: String(basePort + 1), ATLAS_STORY_PORT: String(basePort + 2) },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(server, baseUrl);
    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
    report.browser = { name: 'Chromium', version: browser.version(), executablePath: browserPath ?? 'Playwright bundled Chromium' };
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Workspace名').fill(`Atlas export ${crypto.randomUUID()}`);
    await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();

    const atlas = page.frameLocator('iframe[title="Atlas"]');
    await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitPending(page, atlas);
    report.cases.push('create-and-commit-board');

    await atlas.getByLabel('ビューを追加').selectOption('freeform');
    await atlas.getByText('Canvasの図形はExcalidrawシーンに、カードはAtlasボードに保存されます。').waitFor({ state: 'visible' });
    await commitPending(page, atlas);
    report.cases.push('create-and-commit-freeform-scene');

    await atlas.getByRole('button', { name: '＋ テキストカード' }).click();
    await commitPending(page, atlas);
    report.cases.push('create-and-commit-text-card');

    await atlas.getByRole('button', { name: '＋ 画像カード' }).waitFor({ state: 'visible' });
    await atlas.locator('input[type="file"][accept="image/png,image/jpeg,image/webp,image/svg+xml"]').setInputFiles({
      name: 'export-fixture.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/az8AAAAASUVORK5CYII=', 'base64'),
    });
    await atlas.getByRole('group', { name: '画像カード' }).waitFor({ state: 'visible' });
    await commitPending(page, atlas);
    report.cases.push('create-and-commit-image-card');

    const boardDownload = await downloadText(page, atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }));
    const board = JSON.parse(boardDownload.content);
    const imageCard = board.cards.find((card) => card.kind === 'image');
    assert.ok(imageCard?.assetId, 'Committed image card must reference an asset.');
    const textCard = board.cards.find((card) => card.kind === 'text');
    assert.ok(textCard, 'Committed board should contain its text card.');
    textCard.text = 'ATLAS_EXPORT_TEXT_MARKER';
    textCard.annotation = 'Atlas card export browser acceptance';
    const providerRef = { providerId: 'browser.fixture-provider', localId: 'provider-export-node' };
    const sourceRef = {
      workspaceId: 'browser-export-workspace',
      path: 'documents/export-source.md',
      revision: 'a'.repeat(64),
    };
    imageCard.annotation = 'ATLAS_EXPORT_IMAGE_MARKER';
    imageCard.source = sourceRef;
    board.nodes.push({
      id: 'browser-export-provider-node',
      origin: 'provider',
      kind: 'story.character',
      label: 'ATLAS_EXPORT_PROVIDER_LABEL',
      position: { x: 820, y: 460 },
      ref: providerRef,
      source: sourceRef,
    });
    board.cards.push(
      {
        id: 'browser-export-source-card', kind: 'source', text: 'ATLAS_EXPORT_SOURCE_MARKER', annotation: 'Pinned source metadata',
        position: { x: 780, y: 80 }, width: 320, height: 180, source: sourceRef,
      },
      {
        id: 'browser-export-provider-card', kind: 'provider-node', text: 'ATLAS_EXPORT_PROVIDER_MARKER', annotation: 'Provider card metadata',
        position: { x: 780, y: 560 }, width: 320, height: 150, nodeRef: providerRef, source: sourceRef,
      },
    );

    await atlas.locator('input[type="file"][accept=".atlas.json,application/json"]').setInputFiles({
      name: 'card-export-fixture.atlas.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(board), 'utf8'),
    });
    await atlas.getByRole('tab', { name: /キャンバス/ }).last().click();
    const canvasConfigurationError = await atlas.getByText(/configureExcalidrawAssets/u).textContent().catch(() => null);
    assert.equal(canvasConfigurationError, null,
      `Freeform CanvasEditor must mount before card visibility/export acceptance. ${canvasConfigurationError ?? ''}`);
    const cards = atlas.getByRole('group', { name: /カード$/ });
    await cards.first().waitFor({ state: 'visible' });
    await atlas.getByRole('group', { name: 'テキストカード' }).getByLabel('カードのMarkdown本文').waitFor({ state: 'visible' });
    await atlas.getByRole('group', { name: 'ソースカード' }).getByLabel('カードのMarkdown本文').waitFor({ state: 'visible' });
    await atlas.getByRole('group', { name: 'Providerノードカード' }).getByText('ATLAS_EXPORT_PROVIDER_LABEL', { exact: true }).waitFor({ state: 'visible' });
    await atlas.getByRole('group', { name: '画像カード' }).locator('img.atlas-card-image').waitFor({ state: 'visible' });
    assert.equal(await cards.count(), 4, 'All four Atlas card kinds should be visible in the Canvas overlay.');
    assert.equal(await atlas.getByRole('group', { name: 'テキストカード' }).getByLabel('カードのMarkdown本文').inputValue(), 'ATLAS_EXPORT_TEXT_MARKER');
    assert.equal(await atlas.getByRole('group', { name: 'ソースカード' }).getByLabel('カードのMarkdown本文').inputValue(), 'ATLAS_EXPORT_SOURCE_MARKER');
    report.cases.push('render-all-four-card-kinds-and-content');

    const importedBoard = JSON.parse((await downloadText(page, atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }))).content);
    assert.deepEqual(importedBoard.cards.map((card) => card.kind).sort(), ['image', 'provider-node', 'source', 'text']);
    report.cases.push('import-four-card-kinds-for-export');

    const svgDownload = await downloadText(page, atlas.getByRole('button', { name: 'SVG', exact: true }));
    assert.match(svgDownload.content, /<svg\b/u, 'SVG export should contain an SVG document.');
    for (const marker of ['ATLAS_EXPORT_TEXT_MARKER', 'ATLAS_EXPORT_SOURCE_MARKER', 'ATLAS_EXPORT_PROVIDER_MARKER', 'ATLAS_EXPORT_IMAGE_MARKER', 'documents/export-source.md']) {
      assert.ok(svgDownload.content.includes(marker), `SVG export should include visible card text or source metadata: ${marker}`);
    }
    assert.match(svgDownload.content, /<image\b/u, 'SVG export should include the embedded image card.');
    report.cases.push({ id: 'svg-includes-canvas-and-card-content', filename: svgDownload.name, bytes: Buffer.byteLength(svgDownload.content) });

    const pngPromise = page.waitForEvent('download');
    await atlas.getByRole('button', { name: 'PNG', exact: true }).click();
    const pngDownload = await pngPromise;
    const pngPath = await pngDownload.path();
    assert.ok(pngPath, 'PNG export should have a readable temporary path.');
    const pngBytes = await readFile(pngPath);
    const dimensions = readPngDimensions(pngBytes);
    assert.ok(dimensions.width >= 1100 && dimensions.height >= 700,
      `PNG bounds ${dimensions.width}x${dimensions.height} should include cards positioned across the Atlas scene.`);
    assert.ok(pngBytes.byteLength > 10000, 'PNG export should contain rendered card and image content, not an empty scene.');
    report.cases.push({ id: 'png-includes-card-bounds-and-image', filename: pngDownload.suggestedFilename(), bytes: pngBytes.byteLength, ...dimensions });

    assert.deepEqual(pageErrors, [], 'Atlas browser flow must not throw uncaught page errors.');
    report.cases.push('no-uncaught-page-errors');
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
