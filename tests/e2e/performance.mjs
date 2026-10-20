import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const STORY_PROVIDER_ID = 'scriptorium.story-knowledge';

function instrumentWorkers() {
  const send = (metric) => {
    try { window.top.postMessage({ tag: 'atlas-perf/v1', metric: { ...metric, frameNow: performance.now() } }, '*'); } catch { /* closing frame */ }
  };
  if (window === window.top) {
    window.__atlasPerfStore = [];
    window.addEventListener('message', (event) => {
      if (event.data?.tag === 'atlas-perf/v1') window.__atlasPerfStore.push({ ...event.data.metric, receivedAt: performance.now() });
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
    const measurement = 'Chromium performance.memory exposed in the Atlas frame';
    const scope = 'Approximate/shared renderer JavaScript heap; same-site frames may share a renderer or isolate across separate ports. This is not isolated Plugin or Worker heap usage.';
    if (!memory) return { status: 'NOT_CHECKED', measurement, scope, reason: 'Chromium did not expose performance.memory for the Atlas frame.' };
    return { status: 'MEASURED', measurement, scope, usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize, limitBytes: memory.jsHeapSizeLimit };
  });
}

async function waitResponses(page, origin, operation, count) {
  await page.waitForFunction(({ origin, operation, count }) => (window.__atlasPerfStore ?? [])
    .filter((item) => item.kind === 'response' && item.origin === origin && item.operation === operation).length >= count,
  { origin, operation, count }, { timeout: 120_000 });
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function downloadScene(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.locator.getByRole('button', { name: '.excalidrawをエクスポート', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `Excalidraw export ${download.suggestedFilename()} must produce a readable file.`);
  const bytes = await readFile(path);
  return { bytes, text: bytes.toString('utf8'), data: JSON.parse(bytes.toString('utf8')) };
}

async function exportBundle(page, unzipSync) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Bundleをexport', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, 'Host Bundle export must produce a readable ZIP.');
  const archive = await readFile(path);
  const entries = unzipSync(archive);
  const manifestBytes = Buffer.from(entries['manifest.json'] ?? []);
  assert.ok(manifestBytes.byteLength, 'Export ZIP must contain manifest.json.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const inventory = manifest.files.map((file) => {
    const bytes = Buffer.from(entries[`workspace/${file.path}`] ?? []);
    assert.equal(bytes.byteLength, file.bytes, `Manifest byte count must match actual serialized bytes at ${file.path}.`);
    assert.equal(sha256(bytes), file.sha256, `Manifest SHA-256 must match the exported bytes at ${file.path}.`);
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  const expandedBytes = manifestBytes.byteLength + inventory.reduce((total, file) => total + file.bytes, 0);
  assert.equal(Object.keys(entries).length, manifest.files.length + 1, 'ZIP must contain exactly one manifest entry plus the declared Workspace files.');
  assert.ok(Object.keys(entries).length <= 100_000, 'Manifest entry must be included within the 100,000-file Workspace cap.');
  assert.ok(expandedBytes <= 256 * 1024 * 1024, 'Manifest serialized bytes must be included within the 256 MiB expanded Workspace cap.');
  assert.ok(archive.byteLength <= 512 * 1024 * 1024, 'Compressed ZIP size must satisfy its separate 512 MiB limit.');
  const canonicalInventory = [...manifest.files]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((file) => [file.path, file.sha256]);
  assert.equal(manifest.sourceRevision, sha256(Buffer.from(JSON.stringify(canonicalInventory))), 'Manifest sourceRevision must hash the exported sorted Workspace revisions.');
  return {
    archiveBytes: archive.byteLength,
    archiveSha256: sha256(archive),
    manifestBytes: manifestBytes.byteLength,
    manifestSha256: sha256(manifestBytes),
    expandedBytesIncludingManifest: expandedBytes,
    manifest,
    inventory,
    zipEntryCount: Object.keys(entries).length,
  };
}

async function runSampledGesture(page, frame, editor, start, end, { pan = false } = {}) {
  await frame.evaluate(() => {
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
  const bounds = await editor.boundingBox();
  assert.ok(bounds && bounds.width >= 300 && bounds.height >= 300, `Freeform editor must have a usable viewport: ${JSON.stringify(bounds)}.`);
  const startPoint = { x: bounds.x + start.x, y: bounds.y + start.y };
  const endPoint = { x: bounds.x + end.x, y: bounds.y + end.y };
  const dragStarted = performance.now();
  if (pan) await page.mouse.click(startPoint.x, startPoint.y);
  await page.mouse.move(startPoint.x, startPoint.y);
  if (pan) await page.keyboard.down('Space');
  await page.mouse.down();
  for (let step = 1; step <= 32; step += 1) {
    await page.mouse.move(startPoint.x + (endPoint.x - startPoint.x) * step / 32,
      startPoint.y + (endPoint.y - startPoint.y) * step / 32);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  if (pan) await page.keyboard.up('Space');
  const gestureMs = performance.now() - dragStarted;
  await frame.evaluate(() => window.__atlasCanvasSample.stopFrames());
  await page.waitForTimeout(100);
  const frameSample = await frame.evaluate(() => window.__atlasCanvasSample.finish());
  const intervalP50Ms = percentile(frameSample.intervals, 0.5);
  const fpsP50 = intervalP50Ms ? 1_000 / intervalP50Ms : null;
  const supported = await frame.evaluate(() => 'PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes.includes('longtask'));
  const longTasks = frameSample.longTasks.filter((item) => item.durationMs > 50).sort((left, right) => left.startTime - right.startTime);
  let maxStreak = longTasks.length ? 1 : 0;
  let streak = maxStreak;
  for (let index = 1; index < longTasks.length; index += 1) {
    streak = longTasks[index].startTime - longTasks[index - 1].startTime <= 150 ? streak + 1 : 1;
    maxStreak = Math.max(maxStreak, streak);
  }
  assert.ok(fpsP50 >= 30, `${pan ? 'Freeform pan' : 'Freeform object drag'} p50 ${fpsP50}fps is below 30fps.`);
  if (supported) assert.ok(maxStreak <= 1, `Freeform ${pan ? 'pan' : 'drag'} produced ${maxStreak} consecutive Long Tasks over 50ms.`);
  return {
    gestureMs,
    animationFrameSamples: frameSample.intervals.length,
    frameIntervalP50Ms: intervalP50Ms,
    fpsP50,
    longTaskEvidence: { status: supported ? 'MEASURED' : 'NOT_CHECKED', supported,
      ...(supported ? { longTasksOver50Ms: longTasks, maxConsecutiveLongTasks: maxStreak }
        : { reason: 'This browser frame does not support PerformanceObserver longtask entries.' }) },
    notCheckedReasons: supported ? [] : ['This browser frame does not support PerformanceObserver longtask entries.'],
  };
}

async function exportInventoryFromCurrentHost(page, unzipSync) {
  return exportBundle(page, unzipSync);
}

async function reopenWorkspace(page, workspaceId) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const selector = page.getByLabel('開く');
  await selector.waitFor();
  await selector.selectOption(workspaceId);
  await page.waitForFunction((id) => document.querySelector('section[aria-label="Workspace"] select')?.value === id, workspaceId);
  await page.getByRole('status').filter({ hasText: /(?:Workspaceを開きました。|復旧したJournal操作: \d+件。|COMMIT_UNKNOWN:)/ }).waitFor();
  assert.equal(await selector.inputValue(), workspaceId);
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

export async function runPerformanceCases({ browser, baseUrl, unzipSync, archives, datasets, record }) {
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

  await record('Q12-1k-force-layout-cancel-ack', async () => {
    const { context, page } = await createPage(browser, baseUrl, archives.oneK);
    try {
      const atlas = await atlasFrame(page);
      const before = await readMetrics(page);
      const priorRequests = before.filter((item) => item.kind === 'request' && item.origin === atlas.origin && item.operation === 'layout-force').length;
      await atlas.locator.getByRole('button', { name: '力学レイアウト', exact: true }).click();
      await page.waitForFunction(({ origin, count }) => (window.__atlasPerfStore ?? [])
        .filter((item) => item.kind === 'request' && item.origin === origin && item.operation === 'layout-force').length > count,
      { origin: atlas.origin, count: priorRequests }, { timeout: 30_000, polling: 5 });
      const requested = (await readMetrics(page)).filter((item) => item.kind === 'request' && item.origin === atlas.origin && item.operation === 'layout-force').at(-1);
      assert.ok(requested?.workerId, 'The real Layout Worker must start the in-flight Force calculation.');
      assert.equal(requested.nodeCount, 1_000, 'Cancellation must be measured on the deterministic 1k-node Force workload.');
      assert.equal(requested.edgeCount, 2_000, 'Cancellation must use the same 2k-edge Force workload.');
      const beforeCancel = await readMetrics(page);
      assert.equal(beforeCancel.some((item) => item.kind === 'response' && item.workerId === requested.workerId), false,
        'Force calculation must still be in flight when cancellation is requested.');
      const cancelStartedAt = await page.evaluate(() => performance.now());
      await atlas.locator.getByRole('button', { name: 'レイアウトを中止', exact: true }).click();
      await page.waitForFunction((workerId) => (window.__atlasPerfStore ?? [])
        .some((item) => item.kind === 'terminated' && item.workerId === workerId), requested.workerId,
      { timeout: 2_000, polling: 5 });
      const afterCancel = await readMetrics(page);
      const termination = afterCancel.find((item) => item.kind === 'terminated' && item.workerId === requested.workerId);
      assert.ok(termination);
      const cancellationAckMs = termination.receivedAt - cancelStartedAt;
      assert.ok(cancellationAckMs >= 0 && cancellationAckMs <= 500,
        `Production Force cancellation took ${cancellationAckMs}ms to terminate its Worker; limit is 500ms.`);
      assert.equal(afterCancel.some((item) => item.kind === 'response' && item.workerId === requested.workerId), false,
        'The cancelled Force Worker must not return a stale layout result.');
      await atlas.locator.getByText('レイアウト計算を中止しました。', { exact: true }).waitFor();
      return { dataset: datasets.oneK, nodes: requested.nodeCount, edges: requested.edgeCount,
        cancellationAckMs, cancellationAckLimitMs: 500, workerTerminated: true, staleResponseReceived: false };
    } finally { await context.close(); }
  });

  await record('Q12-10k-worker-index-search-traversal-and-disable', async () => {
    const { context, page, workspaceId } = await createPage(browser, baseUrl, archives.tenK);
    try {
      const atlas = await atlasFrame(page);
      const atlasRequests = [];
      page.on('request', (request) => {
        try {
          const url = new URL(request.url());
          if (url.origin === atlas.origin) atlasRequests.push({ at: Date.now(), path: url.pathname, resourceType: request.resourceType() });
        } catch { /* Ignore data and blob URLs. */ }
      });
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
      const disabledAt = Date.now();
      await page.getByLabel('Atlasを有効化').uncheck();
      await page.locator('section[aria-label="Atlas Plugin"]').waitFor({ state: 'detached' });
      await page.waitForTimeout(5_000);
      const postDisableRequests = atlasRequests.filter((item) => item.at >= disabledAt);
      assert.deepEqual(postDisableRequests, [], 'Disabling Atlas must stop plugin-origin polling and any subsequent heavy JavaScript imports for five seconds.');
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
        disabledAtlasWorkers: { created: created.length, explicitlyTerminated: terminated.size, owningFrameClosed: frameClosed.size, active: active.length },
        disabledAtlasNetwork: { observationMs: 5_000, pluginOriginRequestsAfterDisable: postDisableRequests } };
    } finally { await context.close(); }
  });

  const measureFreeform = async ({ archive, dataset, expectedObjects, verifyCommitReload }) => {
    const { context, page, workspaceId } = await createPage(browser, baseUrl, archive);
    try {
      const atlas = await atlasFrame(page);
      await atlas.locator.getByRole('tab', { name: /キャンバス/u }).last().click();
      const editor = atlas.locator.locator('.excalidraw');
      await editor.waitFor({ state: 'visible', timeout: 60_000 });
      const initialScene = await downloadScene(page, atlas);
      const visibleElements = initialScene.data.elements.filter((element) => !element.isDeleted);
      assert.equal(visibleElements.length, expectedObjects, 'The benchmark must use the real Excalidraw scene, not Atlas cards.');
      const first = visibleElements[0];
      assert.equal(first.type, 'rectangle');
      const drag = await runSampledGesture(page, atlas.frame, editor,
        { x: first.x + first.width / 2, y: first.y + first.height / 2 },
        { x: first.x + first.width / 2 + 28, y: first.y + first.height / 2 + 18 });
      const afterDrag = await downloadScene(page, atlas);
      const dragged = afterDrag.data.elements.find((element) => element.id === first.id && !element.isDeleted);
      assert.ok(dragged && (dragged.x !== first.x || dragged.y !== first.y), 'A real Excalidraw object must move through the pointer drag.');

      const bounds = await editor.boundingBox();
      assert.ok(bounds);
      const pan = await runSampledGesture(page, atlas.frame, editor,
        { x: bounds.width - 45, y: bounds.height - 55 },
        { x: bounds.width - 165, y: bounds.height - 105 }, { pan: true });
      const afterPan = await downloadScene(page, atlas);
      assert.notDeepEqual(
        [afterPan.data.appState?.scrollX, afterPan.data.appState?.scrollY],
        [afterDrag.data.appState?.scrollX, afterDrag.data.appState?.scrollY],
        'Space+drag must pan the official Excalidraw viewport.',
      );
      assert.equal(afterPan.data.elements.filter((element) => !element.isDeleted).length, expectedObjects,
        'Pan and drag must preserve every benchmark scene object.');

      let commitEvidence = null;
      let notCheckedReasons = [...drag.notCheckedReasons, ...pan.notCheckedReasons];
      if (verifyCommitReload) {
        const prepare = atlas.locator.getByRole('button', { name: 'Hostレビュー用に準備', exact: true });
        await prepare.waitFor({ state: 'visible' });
        await atlas.frame.waitForFunction(() => [...document.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === 'Hostレビュー用に準備' && !button.disabled), null,
        { timeout: 30_000 });
        assert.equal(await prepare.isEnabled(), true, 'Canvas pointer edits must be available for explicit Host review.');
        await prepare.click();
        const proposal = page.locator('section[aria-label="変更の承認"] article').last();
        await proposal.waitFor({ state: 'visible', timeout: 30_000 });
        const proposedFiles = await proposal.locator('details').evaluateAll((details) => details.map((detail) => {
          const blocks = [...detail.querySelectorAll('pre')];
          return { path: detail.querySelector('summary')?.textContent?.trim() ?? '', afterText: blocks[1]?.textContent ?? null };
        }));
        const sceneProposal = proposedFiles.find((file) => file.path.endsWith('.excalidraw'));
        assert.equal(sceneProposal?.afterText, afterPan.text, 'Host proposal must contain the exact measured Excalidraw scene bytes.');
        const proposalSha256 = sha256(Buffer.from(sceneProposal.afterText, 'utf8'));
        await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
        await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).last().waitFor({ timeout: 30_000 });

        const exportedBeforeReload = await exportInventoryFromCurrentHost(page, unzipSync);
        await reopenWorkspace(page, workspaceId);
        const reloadedAtlas = await atlasFrame(page);
        await reloadedAtlas.locator.getByRole('tab', { name: /キャンバス/u }).last().click();
        const reloadedScene = await downloadScene(page, reloadedAtlas);
        assert.deepEqual(reloadedScene.bytes, Buffer.from(sceneProposal.afterText, 'utf8'),
          'The approved scene must survive an IndexedDB page reload byte for byte.');
        const exportedAfterReload = await exportInventoryFromCurrentHost(page, unzipSync);
        assert.deepEqual(exportedAfterReload.manifest, exportedBeforeReload.manifest,
          'The exported manifest and source revision must be identical before and after reload.');
        assert.deepEqual(exportedAfterReload.inventory, exportedBeforeReload.inventory,
          'Every exported path, byte count and SHA-256 revision must be identical before and after reload.');
        commitEvidence = {
          workspaceId,
          proposedSceneSha256: proposalSha256,
          sceneBytes: Buffer.byteLength(sceneProposal.afterText, 'utf8'),
          beforeReload: { archiveBytes: exportedBeforeReload.archiveBytes, archiveSha256: exportedBeforeReload.archiveSha256,
            manifestBytes: exportedBeforeReload.manifestBytes, manifestSha256: exportedBeforeReload.manifestSha256,
            sourceRevision: exportedBeforeReload.manifest.sourceRevision,
            fileCount: exportedBeforeReload.manifest.files.length,
            entriesIncludingManifest: exportedBeforeReload.zipEntryCount,
            expandedBytesIncludingManifest: exportedBeforeReload.expandedBytesIncludingManifest },
          afterReload: { archiveBytes: exportedAfterReload.archiveBytes, archiveSha256: exportedAfterReload.archiveSha256,
            manifestBytes: exportedAfterReload.manifestBytes, manifestSha256: exportedAfterReload.manifestSha256,
            sourceRevision: exportedAfterReload.manifest.sourceRevision,
            fileCount: exportedAfterReload.manifest.files.length,
            entriesIncludingManifest: exportedAfterReload.zipEntryCount,
            expandedBytesIncludingManifest: exportedAfterReload.expandedBytesIncludingManifest },
          manifestAndInventoryIdenticalAfterReload: true,
        };
      }
      return {
        dataset, activeSceneObjects: visibleElements.length,
        objectDrag: { ...drag, objectId: first.id, from: { x: first.x, y: first.y }, to: { x: dragged.x, y: dragged.y } },
        normalPan: { ...pan, scrollBefore: [afterDrag.data.appState?.scrollX, afterDrag.data.appState?.scrollY],
          scrollAfter: [afterPan.data.appState?.scrollX, afterPan.data.appState?.scrollY] },
        ...(commitEvidence ? { commitReloadManifestRevisionEquality: commitEvidence } : {}),
        notCheckedReasons,
        thresholds: { fpsP50AtLeast: 30, longTaskMs: 50, maximumConsecutive: 1 },
      };
    } finally { await context.close(); }
  };

  await record('Q12-freeform-100-object-pan-drag-frame-rate-and-long-tasks', () => measureFreeform({
    archive: archives.canvas100, dataset: datasets.canvas100, expectedObjects: 100, verifyCommitReload: false,
  }));
  await record('Q12-freeform-500-object-pan-drag-frame-rate-and-long-tasks-and-commit-reload', () => measureFreeform({
    archive: archives.canvas500, dataset: datasets.canvas500, expectedObjects: 500, verifyCommitReload: true,
  }));
}

export { p95, percentile };
