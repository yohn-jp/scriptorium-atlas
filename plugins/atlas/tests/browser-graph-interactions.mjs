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

async function commitPending(page, expectedText = '') {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.waitFor({ state: 'visible', timeout: 20000 });
  if (expectedText) assert.ok((await proposal.innerText()).includes(expectedText), `Host proposal should include ${expectedText}.`);
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
  assert.fail('Host should publish a new local commit receipt after each proposal.');
}

async function commitAtlasUntilClean(page, atlas) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const indicator = atlas.locator('.atlas-save-indicator');
    if ((await indicator.textContent())?.includes('Hostの基準状態')) return;
    await commitPending(page);
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await indicator.textContent())?.includes('Hostの基準状態')) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  assert.fail(`Atlas did not become clean after Host commits: ${await atlas.locator('.atlas-save-indicator').textContent()}`);
}

async function downloadBoard(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.getByRole('button', { name: '.atlas.jsonをエクスポート' }).click();
  const path = await (await downloadPromise).path();
  assert.ok(path, 'Board export should have a readable temporary path.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function createStoryEntity(page, story, { name, alias, tag }) {
  const create = story.locator('article.card').filter({ has: story.getByRole('heading', { name: '作成', exact: true }) });
  await create.getByLabel('種類').selectOption('character');
  await create.getByLabel('表示名').fill(name);
  await create.getByLabel('別名').fill(alias);
  await create.getByLabel('タグ').fill(tag);
  await create.getByLabel('追加フィールド（JSON）').fill(JSON.stringify({ description: `Atlas graph acceptance ${name}` }));
  await create.getByRole('button', { name: '作成案をプレビュー' }).click();
  const preview = story.locator('section[aria-label="変更案プレビュー"]');
  await preview.waitFor({ state: 'visible' });
  await preview.getByRole('button', { name: 'HostのReviewへ変更案を提出' }).click();
  await story.getByRole('status').filter({ hasText: 'HostのReviewへ変更案を提出しました' }).waitFor({ state: 'visible' });
  await commitPending(page, name);
  await story.getByRole('option').filter({ hasText: name }).first().waitFor({ state: 'visible' });
}

async function createStoryRelation(page, story, { from, to }) {
  const library = story.locator('aside[aria-label="Storyエンティティ一覧"]');
  await story.getByRole('button', { name: 'ライブラリ', exact: true }).click();
  await library.getByRole('option').filter({ hasText: from }).first().click();
  const relationCard = story.locator('article.card').filter({ has: story.getByRole('heading', { name: '関連する項目', exact: true }) });
  const form = relationCard.locator('form').filter({ has: story.getByRole('heading', { name: '関連を追加', exact: true }) });
  const target = form.getByRole('combobox').nth(0);
  const value = await target.locator('option').filter({ hasText: to }).first().getAttribute('value');
  assert.ok(value, `Story relation target ${to} should be available.`);
  await target.selectOption(value);
  await form.getByRole('combobox').nth(1).selectOption('related');
  await form.getByLabel('Note', { exact: true }).fill('Atlas graph path acceptance');
  await form.getByRole('button', { name: '関連追加案を作成' }).click();
  const preview = story.locator('section[aria-label="変更案プレビュー"]');
  await preview.waitFor({ state: 'visible' });
  await preview.getByRole('button', { name: 'HostのReviewへ変更案を提出' }).click();
  await story.getByRole('status').filter({ hasText: 'HostのReviewへ変更案を提出しました' }).waitFor({ state: 'visible' });
  await commitPending(page);
  await relationCard.locator('.relation').filter({ hasText: from }).filter({ hasText: to }).waitFor({ state: 'visible' });
}

async function searchProvider(atlas, query, matchedField) {
  const input = atlas.getByLabel('Providerスナップショットを検索');
  await input.fill(query);
  const hits = atlas.locator('.atlas-search-hit');
  await hits.first().waitFor({ state: 'visible', timeout: 10000 });
  await hits.locator('small').filter({ hasText: matchedField }).first().waitFor({ state: 'visible', timeout: 10000 });
  return hits;
}

async function marqueeSelect(page, flow, nodes) {
  const flowBox = await flow.boundingBox();
  const nodeBoxes = await Promise.all(nodes.map((node) => node.boundingBox()));
  assert.ok(flowBox && nodeBoxes.every(Boolean), 'Graph viewport and nodes should have measurable browser geometry.');
  const boxes = nodeBoxes;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const start = { x: Math.max(flowBox.x + 4, left - 18), y: Math.max(flowBox.y + 4, top - 18) };
  const end = { x: Math.min(flowBox.x + flowBox.width - 4, right + 18), y: Math.min(flowBox.y + flowBox.height - 4, bottom + 18) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
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
    const workspaceName = `Atlas graph interactions ${randomUUID()}`;
    await page.getByLabel('Workspace名').fill(workspaceName);
    await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
    await page.getByLabel('AtlasへStory ProviderとSourceの読取りを許可').check();

    const story = page.frameLocator('iframe[title="Story Knowledge"]');
    await story.getByRole('heading', { name: 'Story Knowledge', exact: true }).waitFor({ state: 'visible' });
    const firstName = `青木${randomUUID().slice(0, 5)}`;
    const secondName = `桜${randomUUID().slice(0, 5)}`;
    const alias = `atlas-alias-${randomUUID().slice(0, 5)}`;
    const tag = `atlas-tag-${randomUUID().slice(0, 5)}`;
    await createStoryEntity(page, story, { name: firstName, alias, tag });
    await createStoryEntity(page, story, { name: secondName, alias: `${alias}-two`, tag: `${tag}-two` });
    await createStoryRelation(page, story, { from: firstName, to: secondName });
    report.cases.push('real-story-provider-source-created-and-linked-through-host-review');

    const atlas = page.frameLocator('iframe[title="Atlas"]');
    await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await commitAtlasUntilClean(page, atlas);
    const provider = atlas.getByLabel('Providerを選択');
    await provider.waitFor({ state: 'visible' });
    await provider.selectOption('scriptorium.story-knowledge');
    await atlas.getByRole('button', { name: '選択したProviderを接続' }).click();
    await atlas.locator('.atlas-status-inline').filter({ hasText: 'ノード 2 件' }).waitFor({ state: 'visible', timeout: 30000 });
    report.cases.push('connect-real-story-provider-snapshot');

    for (const [query, field] of [[alias, '別名'], [tag, 'タグ'], ['story.character', '種類'], ['bible/characters', 'パス']]) {
      const hits = await searchProvider(atlas, query, field);
      assert.ok((await hits.first().locator('small').innerText()).includes(field), `Provider search for ${field} should identify the matched field.`);
    }
    await atlas.getByLabel('Providerスナップショットを検索').fill(firstName);
    const firstHit = atlas.locator('.atlas-search-hit').filter({ hasText: firstName }).first();
    await firstHit.waitFor({ state: 'visible' });
    await firstHit.getByRole('button', { name: 'ノードを追加' }).click();
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByLabel('Providerスナップショットを検索').fill(secondName);
    const secondHit = atlas.locator('.atlas-search-hit').filter({ hasText: secondName }).first();
    await secondHit.waitFor({ state: 'visible' });
    await secondHit.getByRole('button', { name: 'ノードを追加' }).click();
    await commitAtlasUntilClean(page, atlas);
    let board = await downloadBoard(page, atlas);
    const firstNode = board.nodes.find((node) => node.label === firstName);
    const secondNode = board.nodes.find((node) => node.label === secondName);
    assert.ok(firstNode?.ref && secondNode?.ref, 'Added Story nodes should keep their provider references.');
    assert.notEqual(firstNode.ref.localId, secondNode.ref.localId, 'Different Story entities should retain distinct local IDs.');
    report.cases.push('provider-search-alias-tag-type-path-and-add-reference-identity');

    await atlas.getByLabel('Providerスナップショットを検索').fill(firstName);
    const firstHitForCard = atlas.locator('.atlas-search-hit').filter({ hasText: firstName }).first();
    await firstHitForCard.getByRole('button', { name: 'カードを作成' }).click();
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByRole('tab', { name: /キャンバス/u }).last().click();
    await atlas.locator('.atlas-canvas-card.atlas-card-provider-node').waitFor({ state: 'visible', timeout: 30000 });
    await atlas.locator('.atlas-canvas-card.atlas-card-provider-node').getByRole('button', { name: 'グラフで表示' }).click();
    await atlas.getByRole('tab', { name: /グラフ/u }).last().waitFor({ state: 'visible' });
    await atlas.locator(`.react-flow__node[data-id="${firstNode.id}"]`).waitFor({ state: 'visible' });
    report.cases.push('provider-card-navigates-back-to-its-graph-node');

    const graphNodeOne = atlas.locator(`.react-flow__node[data-id="${firstNode.id}"]`);
    const graphNodeTwo = atlas.locator(`.react-flow__node[data-id="${secondNode.id}"]`);
    await graphNodeOne.click();
    await atlas.getByLabel('経路の始点').selectOption(firstNode.id);
    await atlas.getByLabel('経路の終点').selectOption(secondNode.id);
    await atlas.getByRole('button', { name: '最短経路を検索' }).click();
    await atlas.getByRole('status').filter({ hasText: '最短経路 1ホップ' }).waitFor({ state: 'visible' });
    await atlas.getByRole('button', { name: '双方向 3段' }).click();
    await atlas.getByRole('status').filter({ hasText: '近傍を表示しました' }).waitFor({ state: 'visible' });
    report.cases.push('provider-shortest-path-and-neighbor-focus');

    const idHits = await searchProvider(atlas, firstNode.ref.localId, 'ID');
    const idHit = idHits.filter({ hasText: firstName }).first();
    await idHit.waitFor({ state: 'visible' });
    assert.ok((await idHit.locator('small').innerText()).includes('ID'), 'Provider local ID should be searchable.');
    await atlas.getByLabel('Providerスナップショットを検索').fill('');
    const boardFilter = atlas.getByLabel('ボード内を絞り込む');
    await boardFilter.fill(firstName);
    await boardFilter.press('Tab');
    await atlas.locator('.react-flow__node').filter({ hasText: firstName }).waitFor({ state: 'visible' });
    assert.equal(await atlas.locator('.react-flow__node').count(), 1, 'Board text filtering should reveal the matching node only.');
    await boardFilter.fill('');
    await boardFilter.press('Tab');
    await commitAtlasUntilClean(page, atlas);
    report.cases.push('search-by-provider-id-and-filter-board-nodes');

    const flow = atlas.locator('.atlas-graph-flow');
    await marqueeSelect(page, flow, [graphNodeOne, graphNodeTwo]);
    const selectedNodes = atlas.locator('.react-flow__node.selected');
    await selectedNodes.first().waitFor({ state: 'visible' });
    assert.equal(await selectedNodes.count(), 2, 'Shift-drag selection should select both graph nodes.');
    await atlas.getByRole('button', { name: '選択項目をグループ化' }).click();
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    const groupedNodes = board.nodes.filter((node) => node.id === firstNode.id || node.id === secondNode.id);
    assert.equal(groupedNodes.length, 2);
    assert.ok(groupedNodes[0]?.groupId && groupedNodes[0].groupId === groupedNodes[1]?.groupId, 'Grouping should assign one saved group ID to both selected nodes.');
    report.cases.push('multi-select-and-group-provider-nodes');

    // Fit and scroll before measuring: a prior locator drag used coordinates
    // below the host iframe viewport and therefore never sent a physical drag.
    await atlas.getByRole('button', { name: '全体を表示' }).click();
    await graphNodeOne.scrollIntoViewIfNeeded();
    await graphNodeOne.waitFor({ state: 'visible' });
    const beforeMove = new Map(groupedNodes.map((node) => [node.id, node.position]));
    const nodeBox = await graphNodeOne.boundingBox();
    const flowBox = await flow.boundingBox();
    const iframeBox = await page.locator('iframe[title="Atlas"]').boundingBox();
    const viewport = page.viewportSize();
    assert.ok(nodeBox && flowBox && iframeBox && viewport, 'Selected nodes and their graph viewport should have measurable browser geometry.');
    const visible = {
      left: Math.max(0, flowBox.x, iframeBox.x),
      top: Math.max(0, flowBox.y, iframeBox.y),
      right: Math.min(viewport.width, flowBox.x + flowBox.width, iframeBox.x + iframeBox.width),
      bottom: Math.min(viewport.height, flowBox.y + flowBox.height, iframeBox.y + iframeBox.height),
    };
    const start = { x: nodeBox.x + nodeBox.width / 2, y: nodeBox.y + nodeBox.height / 2 };
    assert.ok(start.x >= visible.left && start.x <= visible.right && start.y >= visible.top && start.y <= visible.bottom,
      `The drag source should be inside the visible Atlas frame and graph viewport; start=${JSON.stringify(start)} visible=${JSON.stringify(visible)} node=${JSON.stringify(nodeBox)} flow=${JSON.stringify(flowBox)} iframe=${JSON.stringify(iframeBox)}.`);
    const moveToward = (coordinate, low, high) => {
      const negative = Math.min(70, coordinate - low - 8);
      if (negative >= 24) return coordinate - negative;
      const positive = Math.min(70, high - coordinate - 8);
      return positive >= 24 ? coordinate + positive : coordinate;
    };
    const target = { x: moveToward(start.x, visible.left, visible.right), y: moveToward(start.y, visible.top, visible.bottom) };
    assert.ok(target.x !== start.x || target.y !== start.y, `The visible graph viewport should have room for a physical drag; start=${JSON.stringify(start)} visible=${JSON.stringify(visible)}.`);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.mouse.up();
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    const movedNodes = board.nodes.filter((node) => node.id === firstNode.id || node.id === secondNode.id);
    for (const node of movedNodes) {
      const before = beforeMove.get(node.id);
      const domRect = await atlas.locator(`.react-flow__node[data-id="${node.id}"]`).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      assert.ok(before && (node.position.x !== before.x || node.position.y !== before.y), `Multi-drag should move ${node.label}; before=${JSON.stringify(before)} after=${JSON.stringify(node.position)} node=${JSON.stringify(nodeBox)} flow=${JSON.stringify(flowBox)} iframe=${JSON.stringify(iframeBox)} visible=${JSON.stringify(visible)} start=${JSON.stringify(start)} target=${JSON.stringify(target)} dom=${JSON.stringify(domRect)}.`);
      assert.ok(board.views.find((view) => view.kind === 'graph')?.pins?.some((pin) => pin.nodeId === node.id && pin.mode === 'manual'), `Dragging ${node.label} should persist a manual layout pin.`);
    }
    report.cases.push('multi-selected-drag-persists-both-positions-and-pins');

    await atlas.getByLabel('辺の始点').selectOption(firstNode.id);
    await atlas.getByLabel('辺の終点').selectOption(secondNode.id);
    const addVisualEdge = atlas.getByRole('button', { name: '視覚的な辺を追加' });
    await addVisualEdge.focus();
    await page.keyboard.press('Enter');
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    let visualEdges = board.edges.filter((edge) => edge.meaning === 'visual');
    assert.equal(visualEdges.length, 1, 'The keyboard-accessible inspector should create one visual edge.');
    const keyboardEdgeId = visualEdges[0]?.id;
    assert.ok(keyboardEdgeId);
    const keyboardEdgeLabel = atlas.getByLabel('エッジのラベル');
    await keyboardEdgeLabel.fill('Keyboard-created Atlas edge');
    await keyboardEdgeLabel.press('Tab');
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    assert.equal(board.edges.find((edge) => edge.id === keyboardEdgeId)?.label, 'Keyboard-created Atlas edge', 'Inspector keyboard edit should save a visual edge label.');
    const deleteSelection = atlas.getByRole('button', { name: '選択項目を削除' });
    await deleteSelection.focus();
    await page.keyboard.press('Enter');
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    visualEdges = board.edges.filter((edge) => edge.meaning === 'visual');
    assert.equal(visualEdges.length, 0, 'Keyboard deletion should remove the visual edge.');
    report.cases.push('keyboard-accessible-visual-edge-create-edit-delete');

    // Refit after the drag so the nodes stay in the usable canvas area and
    // outside the fixed MiniMap overlay before creating a visual edge.
    await atlas.getByRole('button', { name: '全体を表示' }).click();
    await commitAtlasUntilClean(page, atlas);
    await graphNodeOne.scrollIntoViewIfNeeded();
    await flow.click({ position: { x: 12, y: 12 } });
    const minimap = atlas.locator('.react-flow__minimap');
    const minimapBoxBeforePan = await minimap.boundingBox();
    assert.ok(minimapBoxBeforePan);
    const viewportBeforeMinimap = board.views.find((view) => view.kind === 'graph')?.viewport;
    await minimap.click({ position: { x: minimapBoxBeforePan.width * 0.7, y: minimapBoxBeforePan.height * 0.7 } });
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    const viewportAfterMinimap = board.views.find((view) => view.kind === 'graph')?.viewport;
    assert.ok(viewportAfterMinimap && viewportBeforeMinimap
      && (viewportAfterMinimap.x !== viewportBeforeMinimap.x || viewportAfterMinimap.y !== viewportBeforeMinimap.y), 'MiniMap pan should update the saved graph viewport.');
    report.cases.push('minimap-pan-persists-graph-viewport');

    const zoomIn = atlas.locator('.react-flow__controls button').first();
    const viewportBeforeZoom = board.views.find((view) => view.kind === 'graph')?.viewport;
    await zoomIn.click();
    await commitAtlasUntilClean(page, atlas);
    board = await downloadBoard(page, atlas);
    const viewportAfterZoom = board.views.find((view) => view.kind === 'graph')?.viewport;
    assert.ok(viewportAfterZoom && viewportBeforeZoom && viewportAfterZoom.zoom !== viewportBeforeZoom.zoom, 'Graph zoom should persist in the view viewport.');
    await atlas.getByRole('button', { name: '全体を表示' }).click();
    await commitAtlasUntilClean(page, atlas);
    report.cases.push('graph-zoom-fit-and-viewport-persistence');

    const layoutCases = [
      ['力学レイアウト', /力学レイアウトを1回のUndo操作として適用/u],
      ['階層レイアウト', /階層レイアウトを1回のUndo操作として適用/u],
      ['タイムライン配置', /タイムラインレイアウトを1回のUndo操作として適用/u],
      ['手動配置', /手動レイアウトを1回のUndo操作として適用/u],
    ];
    for (const [buttonName, statusPattern] of layoutCases) {
      await atlas.getByRole('button', { name: buttonName }).click();
      await atlas.locator('.atlas-notice').filter({ hasText: statusPattern }).waitFor({ state: 'visible', timeout: 20000 });
      await commitAtlasUntilClean(page, atlas);
    }
    board = await downloadBoard(page, atlas);
    const pinsAfterLayouts = board.views.find((view) => view.kind === 'graph')?.pins ?? [];
    for (const node of movedNodes) assert.ok(pinsAfterLayouts.some((pin) => pin.nodeId === node.id), `Every layout mode should preserve the pin for ${node.id}.`);
    report.cases.push('force-layered-timeline-manual-layouts-preserve-pins');

    const secondBoardName = `Secondary board ${randomUUID().slice(0, 5)}`;
    await atlas.getByRole('button', { name: '＋ 新しいボード' }).click();
    await atlas.getByLabel('ボード名').waitFor({ state: 'visible' });
    await atlas.getByLabel('ボード名').fill(secondBoardName);
    await atlas.getByLabel('ボード名').press('Tab');
    await commitAtlasUntilClean(page, atlas);
    await atlas.getByRole('button', { name: '＋ 手動ノード', exact: true }).click();
    await atlas.getByLabel('手動ノード名').fill('Secondary board node');
    await atlas.getByRole('button', { name: 'ノードを作成', exact: true }).click();
    await commitAtlasUntilClean(page, atlas);
    const nav = atlas.getByRole('navigation', { name: 'Atlasボード' });
    await nav.getByRole('button').filter({ hasText: secondBoardName }).click();
    assert.equal((await downloadBoard(page, atlas)).nodes.filter((node) => node.label === 'Secondary board node').length, 1);
    const firstBoardNav = nav.getByRole('button').first();
    await firstBoardNav.click();
    board = await downloadBoard(page, atlas);
    assert.ok(board.nodes.some((node) => node.id === firstNode.id), 'Switching back to the first board should retain its provider nodes.');
    assert.ok(board.cards.some((card) => card.nodeRef?.localId === firstNode.ref.localId), 'The first board should retain its linked provider card.');
    report.cases.push('multiple-board-files-retain-independent-graph-and-card-state');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('開く').selectOption({ label: workspaceName });
    const reloadedAtlas = page.frameLocator('iframe[title="Atlas"]');
    await reloadedAtlas.getByRole('tab', { name: /グラフ/u }).waitFor({ state: 'visible' });
    const reloadedBoard = await downloadBoard(page, reloadedAtlas);
    assert.ok(reloadedBoard.nodes.some((node) => node.id === firstNode.id), 'Host reload should retain provider node identities.');
    assert.ok(reloadedBoard.views.find((view) => view.kind === 'graph')?.pins?.length, 'Host reload should restore graph pins.');
    assert.ok(reloadedBoard.views.find((view) => view.kind === 'graph')?.viewport, 'Host reload should restore the graph viewport.');
    report.cases.push('host-reload-restores-graph-pin-viewport-and-provider-references');

    assert.deepEqual(dialogs, [], 'Graph flows should not depend on sandbox-blocked native dialogs.');
    assert.deepEqual(pageErrors, [], 'Graph interaction flow must not throw uncaught page errors.');
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
