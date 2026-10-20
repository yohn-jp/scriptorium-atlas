import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const STORY_PROVIDER_ID = 'scriptorium.story-knowledge';

function instrumentWorkers() {
  const send = (metric) => {
    try { window.top.postMessage({ tag: 'atlas-perf/v1', metric }, '*'); } catch { /* closing frame */ }
  };
  if (window === window.top) {
    window.__atlasPerfStore = [];
    window.addEventListener('message', (event) => {
      if (event.data?.tag === 'atlas-perf/v1') window.__atlasPerfStore.push(event.data.metric);
    });
    return;
  }
  const frameId = crypto.randomUUID();
  let workerNumber = 0;
  const workerIds = [];
  const NativeWorker = window.Worker;
  window.Worker = class MeasuredWorker extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.__atlasId = `${frameId}:${++workerNumber}`;
      this.__atlasUrl = String(url);
      this.__atlasStarts = new Map();
      this.__atlasTerminated = false;
      workerIds.push(this.__atlasId);
      send({ kind: 'created', workerId: this.__atlasId, workerUrl: this.__atlasUrl, origin: location.origin });
      this.addEventListener('message', (event) => {
        const message = event.data;
        const key = message?.id ?? message?.requestId;
        const start = this.__atlasStarts.get(key);
        if (!start) return;
        this.__atlasStarts.delete(key);
        send({ kind: 'response', workerId: this.__atlasId, workerUrl: this.__atlasUrl, origin: location.origin,
          operation: start.operation, durationMs: performance.now() - start.time,
          nodeCount: start.nodeCount, edgeCount: start.edgeCount });
      });
    }
    postMessage(message, ...transfer) {
      const operation = message?.type ?? (message?.input?.kind ? `layout-${message.input.kind}` : null);
      const key = message?.id ?? message?.requestId;
      if (operation && key !== undefined) {
        const nodeCount = Array.isArray(message.nodes) ? message.nodes.length : Array.isArray(message.input?.nodes) ? message.input.nodes.length : null;
        const edgeCount = Array.isArray(message.edges) ? message.edges.length : Array.isArray(message.input?.edges) ? message.input.edges.length : null;
        this.__atlasStarts.set(key, { operation, nodeCount, edgeCount, time: performance.now() });
        send({ kind: 'request', workerId: this.__atlasId, workerUrl: this.__atlasUrl, origin: location.origin, operation, nodeCount, edgeCount });
      }
      return super.postMessage(message, ...transfer);
    }
    terminate() {
      if (!this.__atlasTerminated) {
        this.__atlasTerminated = true;
        send({ kind: 'terminated', workerId: this.__atlasId, workerUrl: this.__atlasUrl, origin: location.origin });
      }
      return super.terminate();
    }
  };
  window.addEventListener('pagehide', () => {
    send({ kind: 'frame-closed', workerIds: [...workerIds], origin: location.origin });
  }, { once: true });
}

function percentile(values, fraction = 0.95) {
  if (!values.length) return null;
  assert.ok(fraction > 0 && fraction <= 1, 'percentile fraction must be greater than 0 and at most 1');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

const p95 = (values) => percentile(values, 0.95);

async function createPage(browser, baseUrl, archive) {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(instrumentWorkers);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Scriptorium Atlas' }).waitFor();
  await page.getByLabel('Bundleをimport').setInputFiles({ name: 'atlas-perf.zip', mimeType: 'application/zip', buffer: archive });
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor({ timeout: 120_000 });
  const workspaceId = await page.getByLabel('開く').inputValue();
  assert.ok(workspaceId);
  return { context, page, workspaceId };
}

async function atlasFrame(page) {
  const panel = page.locator('section[aria-label="Atlas Plugin"]');
  await panel.getByText('接続中', { exact: true }).waitFor({ timeout: 60_000 });
  const src = await panel.locator('iframe').getAttribute('src');
  assert.ok(src);
  const origin = new URL(src, page.url()).origin;
  const frame = page.frames().find((candidate) => candidate.url().startsWith(`${origin}/frame.html`));
  assert.ok(frame);
  return { locator: page.frameLocator('section[aria-label="Atlas Plugin"] iframe'), frame, origin };
}

async function coldReopen(context, page, workspaceId) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  const started = performance.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('開く').waitFor();
  await page.getByLabel('開く').selectOption(workspaceId);
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor({ timeout: 60_000 });
  const atlas = await atlasFrame(page);
  const firstNode = atlas.locator.locator('.react-flow__node').first();
  await firstNode.waitFor({ state: 'visible', timeout: 60_000 });
  const elapsedMs = performance.now() - started;
  const resources = await atlas.frame.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => /\.(?:js|css)(?:\?|$)/i.test(entry.name))
    .map((entry) => ({ asset: new URL(entry.name).pathname.split('/').at(-1), durationMs: entry.duration,
      transferBytes: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
      decodedBytes: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null })));
  await cdp.detach();
  return { atlas, elapsedMs, firstVisibleNode: await firstNode.innerText(), resources };
}

async function readMetrics(page) { return page.evaluate(() => window.__atlasPerfStore ?? []); }

async function readHeap(frame) {
  return frame.evaluate(() => {
    const memory = performance.memory;
    if (!memory) return { status: 'NOT_CHECKED', reason: 'Chromium did not expose performance.memory for this frame.' };
    return { status: 'MEASURED', usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize, limitBytes: memory.jsHeapSizeLimit };
  });
}

async function waitResponses(page, origin, operation, count) {
  await page.waitForFunction(({ origin, operation, count }) => (window.__atlasPerfStore ?? [])
    .filter((item) => item.kind === 'response' && item.origin === origin && item.operation === operation).length >= count,
  { origin, operation, count }, { timeout: 120_000 });
}

async function connectStory(page, atlas) {
  await page.getByLabel('AtlasへStory ProviderとSourceの読取りを許可').check();
  await atlas.locator.getByLabel('Providerを選択').selectOption(STORY_PROVIDER_ID);
  await atlas.locator.getByRole('button', { name: '選択したProviderを接続' }).click();
}

async function searchThirty(page, atlas, origin) {
  const before = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'search').length;
  const queries = Array.from({ length: 30 }, (_, index) => ['計測対象', 'benchmark', `group-${String(index % 100).padStart(2, '0')}`, 'character'][index % 4]);
  const search = atlas.locator.getByLabel('Providerスナップショットを検索');
  for (let index = 0; index < queries.length; index += 1) {
    await search.fill(queries[index]);
    await waitResponses(page, origin, 'search', before + index + 1);
  }
  const values = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'search').slice(before).map((item) => item.durationMs);
  return { queries, durationsMs: values, measured: values.length, p95Ms: p95(values) };
}

async function addProviderNode(atlas, id) {
  await atlas.locator.getByLabel('Providerスナップショットを検索').fill(id);
  const hit = atlas.locator.locator('.atlas-search-results .atlas-search-hit').first();
  await hit.waitFor({ state: 'visible', timeout: 30_000 });
  await hit.getByRole('button', { name: 'ノードを追加' }).click();
}

async function measureTraversal(page, atlas, origin) {
  await addProviderNode(atlas, 'perf-node-00000');
  await addProviderNode(atlas, 'perf-node-00001');
  const from = atlas.locator.getByLabel('経路の始点');
  const to = atlas.locator.getByLabel('経路の終点');
  const ids = await from.locator('option').evaluateAll((items) => items.slice(1).map((option) => option.value));
  assert.equal(ids.length, 2);
  await from.selectOption(ids[0]);
  await to.selectOption(ids[1]);
  const before = await readMetrics(page);
  const startNeighbors = before.filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'neighbors').length;
  const startPaths = before.filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'shortestPath').length;
  for (let index = 0; index < 30; index += 1) {
    await atlas.locator.getByRole('button', { name: '双方向 3段', exact: true }).click();
    await waitResponses(page, origin, 'neighbors', startNeighbors + index + 1);
    await atlas.locator.getByRole('button', { name: '最短経路を検索', exact: true }).click();
    await waitResponses(page, origin, 'shortestPath', startPaths + index + 1);
  }
  const after = await readMetrics(page);
  const neighbors = after.filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'neighbors').slice(startNeighbors).map((item) => item.durationMs);
  const paths = after.filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'shortestPath').slice(startPaths).map((item) => item.durationMs);
  return { neighbors: { measured: neighbors.length, durationsMs: neighbors, p95Ms: p95(neighbors) }, shortestPath: { measured: paths.length, durationsMs: paths, p95Ms: p95(paths) } };
}

export async function runPerformanceCases({ browser, baseUrl, archives, datasets, record }) {
  await record('Q12-cold-1k-first-visible-and-force-layout', async () => {
    const samples = [];
    let queryEvidence = null;
    for (let index = 0; index < 5; index += 1) {
      const { context, page, workspaceId } = await createPage(browser, baseUrl, archives.oneK);
      try {
        const cold = await coldReopen(context, page, workspaceId);
        samples.push({ elapsedMs: cold.elapsedMs, firstVisibleNode: cold.firstVisibleNode, resources: cold.resources });
        if (index === 0) {
          await connectStory(page, cold.atlas);
          await cold.atlas.locator.locator('.atlas-status-inline').filter({ hasText: 'ノード 1000 件、エッジ 2000 件' }).waitFor({ timeout: 120_000 });
          const metrics = await readMetrics(page);
          const indexResult = metrics.find((item) => item.kind === 'response' && item.origin === cold.atlas.origin && item.operation === 'replace');
          assert.ok(indexResult, 'the real Graph Worker must build the 1k/2k snapshot');
          assert.equal(indexResult.nodeCount, 1_000);
          assert.equal(indexResult.edgeCount, 2_000);
          assert.ok(indexResult.durationMs <= 10_000, `1k Graph Worker index took ${indexResult.durationMs}ms`);
          const searches = await searchThirty(page, cold.atlas, cold.atlas.origin);
          assert.equal(searches.measured, 30, 'the 1k search benchmark must complete all 30 queries');
          const before = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === cold.atlas.origin && item.operation === 'layout-force').length;
          await cold.atlas.locator.getByRole('button', { name: '力学レイアウト', exact: true }).click();
          await waitResponses(page, cold.atlas.origin, 'layout-force', before + 1);
          const layout = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === cold.atlas.origin && item.operation === 'layout-force')[before];
          assert.ok(layout, 'the production Layout Worker must complete the 1k Force request');
          assert.equal(layout.nodeCount, 1_000);
          assert.equal(layout.edgeCount, 2_000);
          const heap = await readHeap(cold.atlas.frame);
          queryEvidence = { graphIndex: indexResult ? { durationMs: indexResult.durationMs, nodes: indexResult.nodeCount, edges: indexResult.edgeCount } : null,
            search: searches, forceLayout: layout ? { durationMs: layout.durationMs, nodes: layout.nodeCount, edges: layout.edgeCount } : null, heap,
            notCheckedReasons: heap.status === 'NOT_CHECKED' ? [heap.reason] : [] };
        }
      } finally { await context.close(); }
    }
    const times = samples.map((sample) => sample.elapsedMs);
    const coldP95Ms = p95(times);
    assert.equal(samples.length, 5);
    assert.ok(coldP95Ms <= 3_000, `1k cold first-visible p95 ${coldP95Ms}ms exceeds 3000ms`);
    assert.equal(queryEvidence?.search?.measured, 30, 'the 1k search benchmark must provide 30 measurements');
    assert.ok(queryEvidence.search.p95Ms <= 100, `1k search p95 ${queryEvidence.search.p95Ms}ms exceeds 100ms`);
    assert.ok(queryEvidence?.forceLayout, 'the 1k Force layout benchmark must provide a Worker response');
    assert.ok(queryEvidence.forceLayout.durationMs <= 2_000, `1k Force layout took ${queryEvidence.forceLayout.durationMs}ms`);
    return { dataset: datasets.oneK, samples, coldFirstVisibleP95Ms: coldP95Ms, coldFirstVisibleLimitMs: 3_000, ...queryEvidence };
  });

  await record('Q12-10k-worker-index-search-traversal-and-disable', async () => {
    const { context, page, workspaceId } = await createPage(browser, baseUrl, archives.tenK);
    try {
      const atlas = await atlasFrame(page);
      await connectStory(page, atlas);
      await atlas.locator.locator('.atlas-status-inline').filter({ hasText: 'ノード 10000 件、エッジ 20000 件' }).waitFor({ timeout: 120_000 });
      const metrics = await readMetrics(page);
      const indexResult = metrics.find((item) => item.kind === 'response' && item.origin === atlas.origin && item.operation === 'replace');
      assert.ok(indexResult, 'the production Graph Worker must index the imported snapshot');
      assert.equal(indexResult.nodeCount, 10_000);
      assert.equal(indexResult.edgeCount, 20_000);
      assert.ok(indexResult.durationMs <= 10_000, `10k index took ${indexResult.durationMs}ms`);
      const searches = await searchThirty(page, atlas, atlas.origin);
      const traversal = await measureTraversal(page, atlas, atlas.origin);
      assert.equal(searches.measured, 30);
      assert.ok(searches.p95Ms <= 250, `10k search p95 ${searches.p95Ms}ms exceeds 250ms`);
      assert.ok(traversal.neighbors.p95Ms <= 500, `10k neighbors p95 ${traversal.neighbors.p95Ms}ms exceeds 500ms`);
      assert.ok(traversal.shortestPath.p95Ms <= 500, `10k path p95 ${traversal.shortestPath.p95Ms}ms exceeds 500ms`);
      const heap = await readHeap(atlas.frame);
      await page.getByLabel('Atlasを有効化').uncheck();
      await page.locator('section[aria-label="Atlas Plugin"]').waitFor({ state: 'detached' });
      await page.waitForTimeout(500);
      const afterDisable = await readMetrics(page);
      const created = afterDisable.filter((item) => item.kind === 'created' && item.origin === atlas.origin);
      const terminated = new Set(afterDisable.filter((item) => item.kind === 'terminated' && item.origin === atlas.origin).map((item) => item.workerId));
      const frameClosed = new Set(afterDisable.filter((item) => item.kind === 'frame-closed' && item.origin === atlas.origin).flatMap((item) => item.workerIds));
      const active = created.filter((item) => !terminated.has(item.workerId) && !frameClosed.has(item.workerId));
      assert.equal(active.length, 0, 'disabling Atlas must terminate its dedicated Workers');
      return { dataset: datasets.tenK,
        graphIndex: { durationMs: indexResult.durationMs, nodes: indexResult.nodeCount, edges: indexResult.edgeCount, limitMs: 10_000 },
        search: { ...searches, limitP95Ms: 250 }, neighbors: { ...traversal.neighbors, limitP95Ms: 500 },
        shortestPath: { ...traversal.shortestPath, limitP95Ms: 500 }, heap,
        notCheckedReasons: heap.status === 'NOT_CHECKED' ? [heap.reason] : [],
        disabledAtlasWorkers: { created: created.length, explicitlyTerminated: terminated.size, owningFrameClosed: frameClosed.size, active: active.length } };
    } finally { await context.close(); }
  });

  const measureCanvasDrag = async ({ archive, dataset, expectedCards }) => {
    const { context, page } = await createPage(browser, baseUrl, archive);
    try {
      const atlas = await atlasFrame(page);
      await atlas.locator.getByRole('tab', { name: 'キャンバス', exact: true }).click();
      const cards = atlas.locator.locator('.atlas-canvas-card');
      assert.equal(await cards.count(), expectedCards);
      const card = cards.first();
      const move = card.getByRole('button', { name: 'カードを移動', exact: true });
      await move.scrollIntoViewIfNeeded();
      const box = await move.boundingBox();
      assert.ok(box);
      const beforeStyle = await card.getAttribute('style');
      const longTaskSupported = await atlas.frame.evaluate(() => 'PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes.includes('longtask'));
      await atlas.frame.evaluate(() => {
        const intervals = [];
        const longTasks = [];
        let previous = null;
        let running = true;
        const observer = 'PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes.includes('longtask')
          ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((item) => ({ startTime: item.startTime, durationMs: item.duration }))))
          : null;
        observer?.observe({ type: 'longtask' });
        const tick = (time) => { if (!running) return; if (previous !== null) intervals.push(time - previous); previous = time; requestAnimationFrame(tick); };
        window.__atlasCanvasSample = {
          intervals, longTasks, observer, start: performance.now(),
          stopFrames() { running = false; },
          finish() { this.observer?.disconnect(); return { intervals, longTasks, elapsedMs: performance.now() - this.start }; },
        };
        requestAnimationFrame(tick);
      });
      const dragStarted = performance.now();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 32; step += 1) {
        await page.mouse.move(box.x + box.width / 2 + step * 4, box.y + box.height / 2 + step * 2);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      const dragMs = performance.now() - dragStarted;
      await atlas.frame.evaluate(() => window.__atlasCanvasSample.stopFrames());
      await page.waitForTimeout(100);
      const frame = await atlas.frame.evaluate(() => window.__atlasCanvasSample.finish());
      const intervalP50Ms = percentile(frame.intervals, 0.5);
      const fpsP50 = intervalP50Ms ? 1_000 / intervalP50Ms : null;
      const longTasks = frame.longTasks.filter((item) => item.durationMs > 50).sort((a, b) => a.startTime - b.startTime);
      let maxStreak = longTasks.length ? 1 : 0;
      let streak = maxStreak;
      for (let index = 1; index < longTasks.length; index += 1) {
        streak = longTasks[index].startTime - longTasks[index - 1].startTime <= 150 ? streak + 1 : 1;
        maxStreak = Math.max(maxStreak, streak);
      }
      const afterStyle = await card.getAttribute('style');
      assert.notEqual(afterStyle, beforeStyle, 'the pointer drag must move a real Canvas card');
      assert.ok(fpsP50 >= 30, `${expectedCards}-card Canvas drag p50 ${fpsP50}fps is below 30fps`);
      if (longTaskSupported) assert.ok(maxStreak <= 1, `Canvas produced ${maxStreak} consecutive Long Tasks over 50ms`);
      return { dataset, renderedCards: await cards.count(), dragMs, animationFrameSamples: frame.intervals.length,
        frameIntervalP50Ms: intervalP50Ms, fpsP50,
        longTaskEvidence: { status: longTaskSupported ? 'MEASURED' : 'NOT_CHECKED', supported: longTaskSupported,
          ...(longTaskSupported ? { longTasksOver50Ms: longTasks, maxConsecutiveLongTasks: maxStreak } : { reason: 'This browser frame does not support PerformanceObserver longtask entries.' }) },
        notCheckedReasons: longTaskSupported ? [] : ['This browser frame does not support PerformanceObserver longtask entries.'],
        thresholds: { fpsP50AtLeast: 30, longTaskMs: 50, maximumConsecutive: 1 } };
    } finally { await context.close(); }
  };

  await record('Q12-canvas-100-pointer-drag-frame-rate-and-long-tasks', () => measureCanvasDrag({
    archive: archives.canvas100, dataset: datasets.canvas100, expectedCards: 100,
  }));
  await record('Q12-canvas-500-pointer-drag-frame-rate-and-long-tasks', () => measureCanvasDrag({
    archive: archives.canvas500, dataset: datasets.canvas500, expectedCards: 500,
  }));
}

export { p95, percentile };
