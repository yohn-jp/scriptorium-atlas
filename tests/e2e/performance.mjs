import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const STORY_PROVIDER_ID = 'scriptorium.story-knowledge';
let activeScenarioTrace = null;

function compactMetric(metric) {
  const keys = ['kind', 'origin', 'workerId', 'workerUrl', 'operation', 'nodeCount', 'edgeCount', 'ok', 'errorCode',
    'requestId', 'clickId', 'trusted', 'targetText', 'buttonVisible', 'buttonEnabled', 'frameNow', 'frameEpochMs', 'durationMs',
    'receivedAt', 'receivedEpochMs', 'query', 'totalMatches', 'resultCount', 'positionCount', 'finitePositionCount',
    'fromLocalId', 'toLocalId', 'depth', 'direction', 'status', 'hops', 'cancelDispatchToTerminationMs'];
  return Object.fromEntries(keys.filter((key) => metric[key] !== undefined).map((key) => [key, metric[key]]));
}

async function captureContextTrace(page, trace) {
  const metrics = await page.evaluate(() => window.__atlasPerfStore ?? []);
  const counts = {};
  for (const metric of metrics) {
    const key = `${metric.kind ?? 'unknown'}:${metric.operation ?? ''}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const frames = await Promise.all(page.frames().map(async (frame) => {
    let state;
    try {
      state = await frame.evaluate(() => ({
        title: document.title,
        visibleAlerts: [...document.querySelectorAll('[role="alert"]')].filter((item) => item.getClientRects().length)
          .map((item) => item.textContent?.trim() ?? '').filter(Boolean).slice(0, 8),
        visibleStatuses: [...document.querySelectorAll('[role="status"], .atlas-status-inline')].filter((item) => item.getClientRects().length)
          .map((item) => item.textContent?.trim() ?? '').filter(Boolean).slice(0, 12),
        providerSelects: [...document.querySelectorAll('select')].map((select) => ({
          label: [...(select.labels ?? [])].map((label) => label.textContent?.trim() ?? '').join(' '),
          value: select.value,
          disabled: select.disabled,
          options: [...select.options].slice(0, 8).map((option) => ({ value: option.value, label: option.textContent?.trim() ?? '' })),
        })).slice(0, 8),
        graphNodeCount: document.querySelectorAll('.react-flow__node').length,
        bodyTail: document.body?.innerText?.slice(-1_200) ?? '',
      }));
    } catch (error) {
      state = { captureError: error instanceof Error ? error.message : String(error) };
    }
    return { url: frame.url(), state };
  }));
  trace.snapshots.push({
    capturedAt: new Date().toISOString(),
    metricCount: metrics.length,
    metricCounts: counts,
    recentMetrics: metrics.slice(-120).map(compactMetric),
    frames,
  });
}

function markScenarioFailure(page, error) {
  if (!activeScenarioTrace) return;
  activeScenarioTrace.failureRequested = true;
  activeScenarioTrace.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  activeScenarioTrace.failurePage = page;
}

function instrumentWorkers() {
  const summarizeResponse = (operation, value) => {
    if (operation === 'search') {
      const items = Array.isArray(value?.items) ? value.items : [];
      return {
        totalMatches: value?.totalMatches ?? null,
        resultCount: items.length,
        complete: value?.complete ?? null,
        firstMatches: items.slice(0, 3).map((item) => ({
          localId: item?.node?.ref?.localId ?? null,
          label: item?.node?.label ?? null,
          kind: item?.node?.kind ?? null,
          matchedFields: Array.isArray(item?.matchedFields) ? item.matchedFields : [],
        })),
      };
    }
    if (operation === 'neighbors') {
      const nodes = Array.isArray(value?.nodes) ? value.nodes : [];
      return {
        fromLocalId: value?.from?.localId ?? null,
        depth: value?.depth ?? null,
        direction: value?.direction ?? null,
        nodeCount: nodes.length,
        nodeLocalIds: nodes.slice(0, 32).map((item) => item?.ref?.localId ?? null),
        nodeDepths: nodes.slice(0, 32).map((item) => ({ localId: item?.ref?.localId ?? null, depth: item?.depth ?? null })),
        edgeCount: Array.isArray(value?.edges) ? value.edges.length : null,
        unresolvedCount: Array.isArray(value?.unresolved) ? value.unresolved.length : null,
        complete: value?.complete ?? null,
      };
    }
    if (operation === 'shortestPath') {
      const refs = Array.isArray(value?.refs) ? value.refs : [];
      const nodes = Array.isArray(value?.nodes) ? value.nodes : [];
      return {
        status: value?.status ?? null,
        fromLocalId: refs[0]?.localId ?? null,
        toLocalId: refs.at(-1)?.localId ?? null,
        pathLocalIds: refs.map((ref) => ref?.localId ?? null),
        pathLabels: nodes.map((node) => node?.label ?? null),
        hops: value?.hops ?? null,
        edgeCount: Array.isArray(value?.edges) ? value.edges.length : null,
        complete: value?.complete ?? null,
      };
    }
    if (operation === 'layout-force') {
      const positions = Array.isArray(value?.positions) ? value.positions : [];
      const finitePositionCount = positions.filter((item) => Number.isFinite(item?.position?.x) && Number.isFinite(item?.position?.y)).length;
      return {
        positionCount: positions.length,
        finitePositionCount,
      };
    }
    return {};
  };
  const send = (metric) => {
    try { window.top.postMessage({ tag: 'atlas-perf/v1', metric: { ...metric, frameNow: performance.now(),
      frameEpochMs: performance.timeOrigin + performance.now() } }, '*'); } catch { /* closing frame */ }
  };
  if (window === window.top) {
    window.__atlasPerfStore = [];
    window.addEventListener('message', (event) => {
      if (event.data?.tag === 'atlas-perf/v1') window.__atlasPerfStore.push({ ...event.data.metric,
        receivedAt: performance.now(), receivedEpochMs: performance.timeOrigin + performance.now() });
    });
    return;
  }
  const frameId = crypto.randomUUID();
  let workerNumber = 0;
  const workerIds = [];
  let activeForceWorkerId = null;
  let activeForceRequestId = null;
  let activeForceStartedAt = null;
  let cancelClick = null;
  let cancelClickSequence = 0;
  const NativeWorker = window.Worker;
  window.addEventListener('click', (event) => {
    const target = event.target;
    const button = target instanceof Element ? target.closest('button') : null;
    if (button?.textContent?.trim() !== 'レイアウトを中止') return;
    const at = performance.now();
    cancelClick = { id: ++cancelClickSequence, at, workerId: activeForceWorkerId,
      requestId: activeForceRequestId, requestStartedAt: activeForceStartedAt };
    send({ kind: 'cancel-click-dispatched', clickId: cancelClick.id, workerId: cancelClick.workerId,
      requestId: cancelClick.requestId, trusted: event.isTrusted,
      targetText: button.textContent?.trim() ?? '',
      buttonVisible: button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden'
        && getComputedStyle(button).display !== 'none',
      buttonEnabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true', origin: location.origin });
  }, true);
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
          requestId: key, operation: start.operation, durationMs: performance.now() - start.time,
          nodeCount: start.nodeCount, edgeCount: start.edgeCount,
          ...start.details, ok: message?.ok ?? null, errorCode: message?.error?.code ?? null,
          ...summarizeResponse(start.operation, message?.value ?? message?.result) });
        if (start.operation === 'layout-force' && activeForceWorkerId === this.__atlasId && activeForceRequestId === key) {
          activeForceWorkerId = null;
          activeForceRequestId = null;
          activeForceStartedAt = null;
          if (cancelClick?.workerId === this.__atlasId && cancelClick.requestId === key) cancelClick = null;
        }
      });
    }
    postMessage(message, ...transfer) {
      const operation = message?.type ?? (message?.input?.kind ? `layout-${message.input.kind}` : null);
      const key = message?.id ?? message?.requestId;
      if (operation && key !== undefined) {
        const requestStartedAt = performance.now();
        if (operation === 'layout-force') {
          activeForceWorkerId = this.__atlasId;
          activeForceRequestId = key;
          activeForceStartedAt = requestStartedAt;
        }
        const nodeCount = Array.isArray(message.nodes) ? message.nodes.length : Array.isArray(message.input?.nodes) ? message.input.nodes.length : null;
        const edgeCount = Array.isArray(message.edges) ? message.edges.length : Array.isArray(message.input?.edges) ? message.input.edges.length : null;
        const details = operation === 'search' ? { query: message.options?.query ?? null }
          : operation === 'neighbors' ? { fromLocalId: message.from?.localId ?? null, depth: message.depth ?? null,
            direction: message.direction ?? null, limit: message.limit ?? null }
            : operation === 'shortestPath' ? { fromLocalId: message.options?.from?.localId ?? null,
              toLocalId: message.options?.to?.localId ?? null, direction: message.options?.direction ?? 'both',
              maxHops: message.options?.maxHops ?? null, maxVisited: message.options?.maxVisited ?? null } : {};
        this.__atlasStarts.set(key, { operation, nodeCount, edgeCount, details, time: requestStartedAt });
        send({ kind: 'request', workerId: this.__atlasId, workerUrl: this.__atlasUrl, origin: location.origin,
          requestId: key, operation, nodeCount, edgeCount, ...details });
      }
      return super.postMessage(message, ...transfer);
    }
    terminate() {
      if (this.__atlasTerminated) return this.__atlasTerminateResult;
      const result = super.terminate();
      const terminatedAt = performance.now();
      this.__atlasTerminated = true;
      this.__atlasTerminateResult = result;
      const isForceCancel = cancelClick?.workerId === this.__atlasId
        && cancelClick.requestId === activeForceRequestId
        && activeForceWorkerId === this.__atlasId
        && activeForceStartedAt !== null
        && cancelClick.at >= activeForceStartedAt
        && terminatedAt >= cancelClick.at;
      send({ kind: 'terminated', workerId: this.__atlasId, workerUrl: this.__atlasUrl, origin: location.origin,
        requestId: isForceCancel ? cancelClick.requestId : null,
        clickId: isForceCancel ? cancelClick.id : null,
        cancelDispatchToTerminationMs: isForceCancel ? terminatedAt - cancelClick.at : null });
      if (activeForceWorkerId === this.__atlasId) {
        activeForceWorkerId = null;
        activeForceRequestId = null;
        activeForceStartedAt = null;
      }
      if (cancelClick?.workerId === this.__atlasId) cancelClick = null;
      return result;
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
  const originalClose = context.close.bind(context);
  let capturedOnClose = false;
  context.close = async (...args) => {
    if (!capturedOnClose && activeScenarioTrace?.failureRequested && activeScenarioTrace.failurePage === page) {
      capturedOnClose = true;
      try {
        await captureContextTrace(page, activeScenarioTrace);
      } catch (error) {
        activeScenarioTrace.captureErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return originalClose(...args);
  };
  try {
    await page.addInitScript(instrumentWorkers);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Scriptorium Atlas' }).waitFor();
    await page.getByLabel('Bundleをimport').setInputFiles({ name: 'atlas-perf.zip', mimeType: 'application/zip', buffer: archive });
    await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor({ timeout: 120_000 });
    const workspaceId = await page.getByLabel('開く').inputValue();
    assert.ok(workspaceId);
    return { context, page, workspaceId };
  } catch (error) {
    markScenarioFailure(page, error);
    await context.close().catch(() => undefined);
    throw error;
  }
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
    .map((entry) => ({ asset: new URL(entry.name).pathname.split('/').at(-1), startTimeMs: entry.startTime,
      responseEndMs: entry.responseEnd, durationMs: entry.duration,
      transferBytes: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
      decodedBytes: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null })));
  assert.ok(resources.length > 0, 'Cold first-visible samples must separately record the loaded Atlas JavaScript and CSS resources.');
  const resourceStarts = resources.map((entry) => entry.startTimeMs);
  const resourceEnds = resources.map((entry) => entry.responseEndMs);
  const resourceTiming = {
    scriptAndStyleAssetCount: resources.length,
    scriptStyleRequestWindowMs: resourceStarts.length && resourceEnds.length
      ? Math.max(...resourceEnds) - Math.min(...resourceStarts) : null,
    summedRequestDurationMs: resources.reduce((total, entry) => total + entry.durationMs, 0),
    transferredBytes: resources.every((entry) => entry.transferBytes !== null)
      ? resources.reduce((total, entry) => total + entry.transferBytes, 0) : null,
    decodedBytes: resources.every((entry) => entry.decodedBytes !== null)
      ? resources.reduce((total, entry) => total + entry.decodedBytes, 0) : null,
    durationNote: 'Per-resource Resource Timing values are reported separately; their sum is not wall time and is not subtracted from the cold first-visible measurement.',
  };
  await cdp.detach();
  return { atlas, elapsedMs, firstVisibleNode: await firstNode.innerText(), browserCacheClearedBeforeReload: true, resources, resourceTiming };
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

async function positionCanvasWithinHostViewport(page, frame, editor) {
  const atlasFrame = page.locator('iframe[title="Atlas"]');
  await atlasFrame.evaluate((element) => element.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }));
  await editor.scrollIntoViewIfNeeded();
  await Promise.all([
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
    frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
  ]);
}

function readExcalidrawAppStateFromPage() {
  const canvas = document.querySelector('canvas.excalidraw__canvas.interactive');
  if (!canvas) return null;
  const fiberKey = Object.keys(canvas).find((key) => key.startsWith('__reactFiber$'));
  if (!fiberKey) return null;
  let api = null;
  for (let fiber = canvas[fiberKey]; fiber && !api; fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const candidate = hook.memoizedState?.current;
      if (candidate && typeof candidate.getAppState === 'function') {
        api = candidate;
        break;
      }
    }
  }
  if (!api) return null;
  const appState = api.getAppState();
  const container = document.querySelector('.excalidraw-container');
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  return {
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: { value: appState.zoom.value },
    selectedElementIds: Object.keys(appState.selectedElementIds ?? {}).filter((id) => appState.selectedElementIds[id]),
    offsetLeft: appState.offsetLeft,
    offsetTop: appState.offsetTop,
    width: appState.width,
    height: appState.height,
    containerBounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  };
}

async function readLiveCanvasAppState(frame) {
  const deadline = Date.now() + 5_000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await frame.evaluate(readExcalidrawAppStateFromPage);
    if (lastState
      && Number.isFinite(lastState.scrollX) && Number.isFinite(lastState.scrollY)
      && Number.isFinite(lastState.zoom?.value) && lastState.zoom.value > 0
      && Number.isFinite(lastState.offsetLeft) && Number.isFinite(lastState.offsetTop)
      && lastState.containerBounds
      && Math.abs(lastState.offsetLeft - lastState.containerBounds.x) <= 0.5
      && Math.abs(lastState.offsetTop - lastState.containerBounds.y) <= 0.5) {
      return lastState;
    }
    await frame.waitForTimeout(50);
  }
  assert.fail(`The official Excalidraw live appState/API offset did not become available and aligned after viewport settling: ${JSON.stringify(lastState)}.`);
}

async function canvasViewportEvidence(page, frame, editor) {
  const atlasFrame = page.locator('iframe[title="Atlas"]');
  const interactiveCanvas = frame.locator('canvas.excalidraw__canvas.interactive');
  await interactiveCanvas.waitFor({ state: 'visible' });
  const liveAppState = await readLiveCanvasAppState(frame);
  const [editorBounds, canvasBounds, canvasFrameRect, iframeBounds, iframeClip, hostScroll] = await Promise.all([
    editor.boundingBox(),
    interactiveCanvas.boundingBox(),
    interactiveCanvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
    atlasFrame.boundingBox(),
    atlasFrame.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x + element.clientLeft, y: rect.y + element.clientTop,
        width: element.clientWidth, height: element.clientHeight };
    }),
    page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY,
      documentScrollWidth: document.documentElement.scrollWidth, documentScrollHeight: document.documentElement.scrollHeight })),
  ]);
  const hostViewport = page.viewportSize();
  assert.ok(hostViewport, 'The Host browser viewport must be available for Freeform gesture validation.');
  assert.ok(editorBounds && editorBounds.width >= 300 && editorBounds.height >= 300,
    `Freeform editor must have a usable viewport: ${JSON.stringify(editorBounds)}.`);
  assert.ok(canvasBounds && canvasBounds.width >= 300 && canvasBounds.height >= 300,
    `Freeform interactive canvas must have a usable viewport: ${JSON.stringify(canvasBounds)}.`);
  assert.ok(iframeBounds && iframeClip && iframeClip.width >= 300 && iframeClip.height >= 300,
    `Atlas iframe must expose a usable clipped viewport: ${JSON.stringify({ iframeBounds, iframeClip })}.`);
  return { hostViewport, hostScroll, editorRoot: editorBounds, interactiveCanvas: canvasBounds,
    interactiveCanvasFrameRect: canvasFrameRect, atlasIframe: iframeBounds, atlasIframeContentClip: iframeClip, liveAppState };
}

async function selectCanvasObjectWithPhysicalInput(page, frame, viewport, point, expectedElementId) {
  const pagePoint = { x: viewport.interactiveCanvas.x + point.x, y: viewport.interactiveCanvas.y + point.y };
  const framePoint = { x: viewport.interactiveCanvasFrameRect.x + point.x,
    y: viewport.interactiveCanvasFrameRect.y + point.y };
  const canvasBounds = viewport.interactiveCanvas;
  const frameClip = viewport.atlasIframeContentClip;
  assert.ok(pagePoint.x >= 0 && pagePoint.x < viewport.hostViewport.width
    && pagePoint.y >= 0 && pagePoint.y < viewport.hostViewport.height,
  `Freeform selection point must be inside the top-level Host viewport: ${JSON.stringify({ pagePoint, viewport })}.`);
  assert.ok(pagePoint.x >= frameClip.x && pagePoint.x < frameClip.x + frameClip.width
    && pagePoint.y >= frameClip.y && pagePoint.y < frameClip.y + frameClip.height,
  `Freeform selection point must be inside the Atlas iframe clipping rectangle: ${JSON.stringify({ pagePoint, frameClip })}.`);
  assert.ok(pagePoint.x >= canvasBounds.x && pagePoint.x <= canvasBounds.x + canvasBounds.width
    && pagePoint.y >= canvasBounds.y && pagePoint.y <= canvasBounds.y + canvasBounds.height,
  `Freeform selection point must be inside the visible interactive canvas: ${JSON.stringify({ pagePoint, canvasBounds })}.`);
  const hitTest = await frame.evaluate((pointInFrame) => {
    const canvas = document.querySelector('canvas.excalidraw__canvas.interactive');
    const target = document.elementFromPoint(pointInFrame.x, pointInFrame.y);
    return { hitsInteractiveCanvas: Boolean(canvas && target === canvas),
      target: target instanceof Element ? { tagName: target.tagName, className: typeof target.className === 'string' ? target.className : String(target.className ?? '') } : null };
  }, framePoint);
  assert.ok(hitTest.hitsInteractiveCanvas,
    `The physical preselection point must hit the actual Excalidraw canvas: ${JSON.stringify({ pagePoint, framePoint, hitTest })}.`);
  await frame.evaluate(() => {
    const events = [];
    const listener = (event) => events.push({ type: event.type, isTrusted: event.isTrusted,
      pointerType: event.pointerType, button: event.button, buttons: event.buttons,
      targetIsInteractiveCanvas: event.target === document.querySelector('canvas.excalidraw__canvas.interactive'),
      hitTargetIsInteractiveCanvas: document.elementFromPoint(event.clientX, event.clientY) === document.querySelector('canvas.excalidraw__canvas.interactive') });
    document.addEventListener('pointerdown', listener, true);
    window.__atlasQ12PreselectionInput = { events, listener };
  });
  await page.mouse.click(pagePoint.x, pagePoint.y);
  const input = await frame.evaluate(() => {
    const evidence = window.__atlasQ12PreselectionInput;
    if (!evidence) return null;
    document.removeEventListener('pointerdown', evidence.listener, true);
    delete window.__atlasQ12PreselectionInput;
    return evidence.events;
  });
  assert.ok(input?.some((event) => event.type === 'pointerdown' && event.isTrusted && event.button === 0
    && event.targetIsInteractiveCanvas && event.hitTargetIsInteractiveCanvas),
  `Canvas object preselection must use a trusted physical primary pointer input: ${JSON.stringify(input)}.`);
  let liveAppState = await readLiveCanvasAppState(frame);
  const deadline = Date.now() + 5_000;
  while (!liveAppState.selectedElementIds.includes(expectedElementId) && Date.now() < deadline) {
    await frame.waitForTimeout(50);
    liveAppState = await readLiveCanvasAppState(frame);
  }
  assert.ok(liveAppState.selectedElementIds.includes(expectedElementId),
    `A physical click at the rectangle's filled center must select its exact scene ID ${expectedElementId}; selected=${JSON.stringify(liveAppState.selectedElementIds)}.`);
  return { pagePoint, framePoint, hitTest, input, selectedElementId: expectedElementId, liveAppState };
}

async function runSampledGesture(page, frame, editor, start, end, { pan = false, expectedViewport = null } = {}) {
  await positionCanvasWithinHostViewport(page, frame, editor);
  const viewport = await canvasViewportEvidence(page, frame, editor);
  if (expectedViewport) {
    const near = (left, right) => Math.abs(left - right) <= 0.5;
    for (const key of ['editorRoot', 'interactiveCanvas', 'interactiveCanvasFrameRect', 'atlasIframeContentClip']) {
      for (const dimension of ['x', 'y', 'width', 'height']) {
        assert.ok(near(viewport[key][dimension], expectedViewport[key][dimension]),
          `Freeform object drag ${key}.${dimension} changed after selection and before measurement: ${JSON.stringify({ expected: expectedViewport[key], actual: viewport[key] })}.`);
      }
    }
    assert.equal(viewport.hostScroll.scrollX, expectedViewport.hostScroll.scrollX, 'Host horizontal scroll must remain stable between selection and measured drag.');
    assert.equal(viewport.hostScroll.scrollY, expectedViewport.hostScroll.scrollY, 'Host vertical scroll must remain stable between selection and measured drag.');
    assert.ok(near(viewport.liveAppState.scrollX, expectedViewport.liveAppState.scrollX)
      && near(viewport.liveAppState.scrollY, expectedViewport.liveAppState.scrollY)
      && near(viewport.liveAppState.zoom.value, expectedViewport.liveAppState.zoom.value),
    `Freeform live viewport must remain stable between selection and measured drag: ${JSON.stringify({ expected: expectedViewport.liveAppState, actual: viewport.liveAppState })}.`);
  }
  const bounds = viewport.interactiveCanvas;
  for (const point of [start, end]) {
    assert.ok(point.x >= 0 && point.x <= bounds.width && point.y >= 0 && point.y <= bounds.height,
      `Freeform ${pan ? 'pan' : 'object drag'} point must be inside the interactive canvas viewport: ${JSON.stringify({ point, bounds })}.`);
  }
  const startPoint = { x: bounds.x + start.x, y: bounds.y + start.y };
  const endPoint = { x: bounds.x + end.x, y: bounds.y + end.y };
  for (const [label, point] of [['start', startPoint], ['end', endPoint]]) {
    assert.ok(point.x >= 0 && point.x < viewport.hostViewport.width && point.y >= 0 && point.y < viewport.hostViewport.height,
      `Freeform ${pan ? 'pan' : 'object drag'} ${label} must be inside the top-level Host viewport: ${JSON.stringify({ point, viewport })}.`);
    const frameClip = viewport.atlasIframeContentClip;
    assert.ok(point.x >= frameClip.x && point.x < frameClip.x + frameClip.width
      && point.y >= frameClip.y && point.y < frameClip.y + frameClip.height,
    `Freeform ${pan ? 'pan' : 'object drag'} ${label} must be inside the Atlas iframe clipping rectangle: ${JSON.stringify({ point, frameClip, viewport })}.`);
    assert.ok(point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y && point.y <= bounds.y + bounds.height,
    `Freeform ${pan ? 'pan' : 'object drag'} ${label} must target the visible interactive canvas: ${JSON.stringify({ point, bounds })}.`);
  }
  const framePoints = [start, end].map((point) => ({ x: viewport.interactiveCanvasFrameRect.x + point.x,
    y: viewport.interactiveCanvasFrameRect.y + point.y }));
  const hitTestEvidence = await frame.evaluate((points) => {
    const canvas = document.querySelector('canvas.excalidraw__canvas.interactive');
    const describe = (element) => element instanceof Element ? {
      tagName: element.tagName,
      id: element.id || null,
      className: typeof element.className === 'string' ? element.className : String(element.className ?? ''),
      ariaLabel: element.getAttribute('aria-label'),
      role: element.getAttribute('role'),
      text: element.textContent?.trim().slice(0, 100) ?? '',
    } : null;
    return {
      activeElementBeforeGesture: describe(document.activeElement),
      documentHasFocus: document.hasFocus(),
      points: points.map((point) => {
        const element = document.elementFromPoint(point.x, point.y);
        return { point, target: describe(element), hitsInteractiveCanvas: element === canvas };
      }),
    };
  }, framePoints);
  activeScenarioTrace?.gestures?.push({ type: pan ? 'pan' : 'object-drag', stage: 'hit-test', hitTestEvidence });
  assert.ok(hitTestEvidence.points.every((item) => item.hitsInteractiveCanvas),
    `Freeform ${pan ? 'pan' : 'object drag'} points must hit the actual interactive canvas after layout/scroll: ${JSON.stringify(hitTestEvidence)}.`);
  if (pan) {
    await frame.evaluate(() => {
      const events = [];
      const describe = (element) => element instanceof Element ? {
        tagName: element.tagName,
        id: element.id || null,
        className: typeof element.className === 'string' ? element.className : String(element.className ?? ''),
        ariaLabel: element.getAttribute('aria-label'),
        role: element.getAttribute('role'),
        text: element.textContent?.trim().slice(0, 100) ?? '',
      } : null;
      const pointer = (event) => events.push({ type: event.type, isTrusted: event.isTrusted,
        pointerType: event.pointerType, isPrimary: event.isPrimary, button: event.button, buttons: event.buttons,
        clientX: event.clientX, clientY: event.clientY, target: describe(event.target),
        hitTarget: describe(document.elementFromPoint(event.clientX, event.clientY)),
        activeElement: describe(document.activeElement), time: performance.now() });
      const keyboard = (event) => {
        if (event.code === 'Space') events.push({ type: event.type, key: event.key, code: event.code,
          isTrusted: event.isTrusted, repeat: event.repeat, target: describe(event.target),
          activeElement: describe(document.activeElement), time: performance.now() });
      };
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.addEventListener(type, pointer, true);
      for (const type of ['keydown', 'keyup']) document.addEventListener(type, keyboard, true);
      window.__atlasQ12PanInputEvidence = { events, listeners: { pointer, keyboard }, activeElementAfterGesture: null };
    });
  }
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
  const inputEvidence = pan ? await frame.evaluate(() => {
    const evidence = window.__atlasQ12PanInputEvidence;
    if (!evidence) return null;
    const describe = (element) => element instanceof Element ? {
      tagName: element.tagName,
      id: element.id || null,
      className: typeof element.className === 'string' ? element.className : String(element.className ?? ''),
      ariaLabel: element.getAttribute('aria-label'),
      role: element.getAttribute('role'),
      text: element.textContent?.trim().slice(0, 100) ?? '',
    } : null;
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.removeEventListener(type, evidence.listeners.pointer, true);
    for (const type of ['keydown', 'keyup']) document.removeEventListener(type, evidence.listeners.keyboard, true);
    evidence.activeElementAfterGesture = describe(document.activeElement);
    evidence.documentHasFocusAfterGesture = document.hasFocus();
    delete evidence.listeners;
    delete window.__atlasQ12PanInputEvidence;
    return evidence;
  }) : null;
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
  const gestureEvidence = {
    gestureMs,
    viewportEvidence: viewport,
    hitTestEvidence,
    ...(inputEvidence ? { inputEvidence } : {}),
    pointerPageFrom: startPoint,
    pointerPageTo: endPoint,
    animationFrameSamples: frameSample.intervals.length,
    frameIntervalP50Ms: intervalP50Ms,
    fpsP50,
    longTaskEvidence: { status: supported ? 'MEASURED' : 'NOT_CHECKED', supported,
      ...(supported ? { longTasksOver50Ms: longTasks, maxConsecutiveLongTasks: maxStreak }
        : { reason: 'This browser frame does not support PerformanceObserver longtask entries.' }) },
    notCheckedReasons: supported ? [] : ['This browser frame does not support PerformanceObserver longtask entries.'],
  };
  activeScenarioTrace?.gestures?.push({ type: pan ? 'pan' : 'object-drag', stage: 'measured', evidence: gestureEvidence });
  assert.ok(fpsP50 >= 30, `${pan ? 'Freeform pan' : 'Freeform object drag'} p50 ${fpsP50}fps is below 30fps.`);
  if (supported) assert.ok(maxStreak <= 1, `Freeform ${pan ? 'pan' : 'drag'} produced ${maxStreak} consecutive Long Tasks over 50ms.`);
  return gestureEvidence;
}

function scenePointToCanvasViewportPoint(scenePoint, appState) {
  const zoom = appState?.zoom?.value;
  const scrollX = appState?.scrollX;
  const scrollY = appState?.scrollY;
  assert.ok(Number.isFinite(zoom) && zoom > 0, `Excalidraw scene must expose a positive zoom: ${JSON.stringify(appState?.zoom)}.`);
  assert.ok(Number.isFinite(scrollX) && Number.isFinite(scrollY), 'Excalidraw scene must expose finite viewport scroll coordinates.');
  // Excalidraw maps scene coordinates to its container viewport as
  // (scene + scroll) * zoom + offset. The offset is the interactive canvas
  // origin, which cancels when coordinates are expressed relative to that canvas.
  return { x: (scenePoint.x + scrollX) * zoom, y: (scenePoint.y + scrollY) * zoom };
}

async function exportInventoryFromCurrentHost(page, unzipSync) {
  return exportBundle(page, unzipSync);
}

async function waitForQ12Proposal(page, timeoutMs = 30_000) {
  const proposals = page.locator('section[aria-label="変更の承認"] article');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await proposals.count()) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Host did not publish a review proposal within ${timeoutMs} ms.`);
}

async function downloadAtlasBoard(page, atlas) {
  const downloadPromise = page.waitForEvent('download');
  await atlas.locator.getByRole('button', { name: '.atlas.jsonをエクスポート', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `Atlas board export ${download.suggestedFilename()} must produce a readable file.`);
  const bytes = await readFile(path);
  return { bytes, text: bytes.toString('utf8'), data: JSON.parse(bytes.toString('utf8')) };
}

function onlyFreeformView(board) {
  const views = board?.views?.filter((view) => view.kind === 'freeform') ?? [];
  assert.equal(views.length, 1, `The deterministic Canvas Workspace must expose exactly one freeform view; found ${views.length}.`);
  return views[0];
}

function expectedBoardViewport(liveAppState) {
  return { x: liveAppState.scrollX * liveAppState.zoom.value,
    y: liveAppState.scrollY * liveAppState.zoom.value,
    zoom: liveAppState.zoom.value };
}

function assertBoardViewport(board, viewId, expectedViewport, message) {
  const view = board?.views?.find((candidate) => candidate.id === viewId && candidate.kind === 'freeform');
  assert.ok(view, `${message}: freeform view ${viewId} must exist in exported Board JSON.`);
  for (const key of ['x', 'y', 'zoom']) {
    assert.ok(Number.isFinite(view.viewport?.[key])
      && Math.abs(view.viewport[key] - expectedViewport[key]) <= 1e-9,
    `${message}: persisted ${key}=${view.viewport?.[key]} must match the live Excalidraw viewport ${expectedViewport[key]}.`);
  }
  return view;
}

async function approveQ12Proposal(page) {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.waitFor({ state: 'visible', timeout: 30_000 });
  const priorReceipts = await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).allTextContents();
  const proposedFiles = await proposal.locator('details').evaluateAll((details) => details.map((detail) => {
    const blocks = [...detail.querySelectorAll('pre')];
    return {
      path: detail.querySelector('summary')?.textContent?.trim() ?? '',
      beforeText: blocks[0]?.textContent ?? null,
      afterText: blocks[1]?.textContent ?? null,
    };
  }));
  await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await proposal.waitFor({ state: 'detached', timeout: 30_000 });
  const receipt = page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).last();
  const deadline = Date.now() + 30_000;
  let receiptText = '';
  while (Date.now() < deadline) {
    receiptText = await receipt.textContent().catch(() => '') ?? '';
    if (receiptText && !priorReceipts.includes(receiptText)) break;
    await page.waitForTimeout(100);
  }
  assert.ok(receiptText && !priorReceipts.includes(receiptText), 'Each Q12 Canvas proposal must produce a new local Host Commit receipt.');
  return { receiptText, proposedFiles };
}

function viewportMatchesExpected(boardText, expectedViewId, expectedViewport) {
  if (typeof boardText !== 'string') return false;
  try {
    const board = JSON.parse(boardText);
    const view = board.views?.find((candidate) => candidate.id === expectedViewId && candidate.kind === 'freeform');
    return Boolean(view && view.viewport
      && ['x', 'y', 'zoom'].every((key) => Number.isFinite(view.viewport[key])
        && Math.abs(view.viewport[key] - expectedViewport[key]) <= 1e-9));
  } catch { return false; }
}

async function commitQ12SceneUntilCurrent(page, expectedSceneBytes, expectedViewId, expectedViewport, maxAttempts = 8) {
  const expectedSceneText = expectedSceneBytes.toString('utf8');
  const committed = [];
  let finalScenePath = '';
  let sceneMatchesExpected = false;
  let boardViewportMatchesExpected = false;
  let matchingSceneProposal = null;
  let matchingBoardProposal = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await waitForQ12Proposal(page);
    const result = await approveQ12Proposal(page);
    committed.push(result);
    activeScenarioTrace?.approvedProposals?.push({
      attempt: attempt + 1,
      receiptText: result.receiptText,
      files: result.proposedFiles.map((file) => ({
        path: file.path,
        beforeBytes: file.beforeText === null ? null : Buffer.byteLength(file.beforeText, 'utf8'),
        beforeSha256: file.beforeText === null ? null : sha256(Buffer.from(file.beforeText, 'utf8')),
        afterBytes: file.afterText === null ? null : Buffer.byteLength(file.afterText, 'utf8'),
        afterSha256: file.afterText === null ? null : sha256(Buffer.from(file.afterText, 'utf8')),
      })),
    });
    const scene = result.proposedFiles.find(({ path }) => path.endsWith('.excalidraw'));
    if (scene) {
      sceneMatchesExpected = scene.afterText === expectedSceneText;
      matchingSceneProposal = sceneMatchesExpected ? scene : null;
      finalScenePath = sceneMatchesExpected ? scene.path : '';
    }
    const board = result.proposedFiles.find(({ path }) => path.endsWith('.atlas.json'));
    if (board) {
      boardViewportMatchesExpected = viewportMatchesExpected(board.afterText, expectedViewId, expectedViewport);
      matchingBoardProposal = boardViewportMatchesExpected ? board : null;
    }
    if (sceneMatchesExpected && boardViewportMatchesExpected) {
      const followUpDeadline = Date.now() + 1_200;
      const proposals = page.locator('section[aria-label="変更の承認"] article');
      let hasFollowUpProposal = false;
      while (Date.now() < followUpDeadline) {
        if (await proposals.count()) { hasFollowUpProposal = true; break; }
        await page.waitForTimeout(100);
      }
      if (!hasFollowUpProposal) return { committed, scenePath: finalScenePath,
        sceneProposal: matchingSceneProposal, boardProposal: matchingBoardProposal };
    }
  }
  const last = committed.at(-1);
  const lastScene = last?.proposedFiles.find(({ path }) => path.endsWith('.excalidraw'));
  const lastBoard = last?.proposedFiles.find(({ path }) => path.endsWith('.atlas.json'));
  throw new Error(`Host did not commit the latest measured Canvas scene and viewport after ${committed.length} explicitly approved proposal(s). `
    + `Expected ${expectedSceneBytes.byteLength} bytes / sha256 ${sha256(expectedSceneBytes)}; `
    + `sceneMatch=${sceneMatchesExpected}; boardViewportMatch=${boardViewportMatchesExpected}; expectedViewport=${JSON.stringify(expectedViewport)}; `
    + `last proposal scene ${lastScene?.path ?? 'missing'} had ${lastScene?.afterText === null || lastScene?.afterText === undefined ? 'no text' : Buffer.byteLength(lastScene.afterText, 'utf8') + ' bytes / sha256 ' + sha256(Buffer.from(lastScene.afterText, 'utf8'))}; `
    + `last proposal board ${lastBoard?.path ?? 'missing'} matched=${viewportMatchesExpected(lastBoard?.afterText, expectedViewId, expectedViewport)}.`);
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

async function connectStory(page, atlas, { uiReadyTimeoutMs = 30_000 } = {}) {
  await page.getByLabel('AtlasへStory ProviderとSourceの読取りを許可').check();
  const providerSelect = atlas.locator.getByLabel('Providerを選択');
  await providerSelect.waitFor({ state: 'visible', timeout: uiReadyTimeoutMs });
  await providerSelect.selectOption(STORY_PROVIDER_ID);
  await atlas.locator.getByRole('button', { name: '選択したProviderを接続' }).click();
}

async function searchThirty(page, atlas, origin, nodeCount) {
  const search = atlas.locator.getByLabel('Providerスナップショットを検索');
  const classes = [
    { id: 'japaneseNameSubstring', field: 'name', queryAt: (index) => ['計測対象', '計測', '対象'][index % 3], expectedMatches: () => nodeCount },
    { id: 'tag', field: 'tag', queryAt: (index) => index % 2 === 0 ? 'benchmark' : `group-${String(Math.floor(index / 2) % 100).padStart(2, '0')}`,
      expectedMatches: (query) => query === 'benchmark' ? nodeCount : nodeCount / 100 },
    { id: 'type', field: 'type', queryAt: (index) => index % 2 === 0 ? 'character' : 'story.character', expectedMatches: () => nodeCount },
  ];
  const byClass = {};
  const allDurations = [];
  for (const queryClass of classes) {
    const before = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'search').length;
    const samples = [];
    for (let index = 0; index < 30; index += 1) {
      const query = queryClass.queryAt(index);
      await search.fill(query);
      await waitResponses(page, origin, 'search', before + index + 1);
      const response = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'search').slice(before + index, before + index + 1)[0];
      const expectedMatches = queryClass.expectedMatches(query);
      assert.ok(response, `${queryClass.id} query ${query} must produce a measured Worker response.`);
      assert.equal(response.ok, true, `${queryClass.id} query ${query} must succeed in the Graph Worker.`);
      assert.equal(response.query, query, 'The measured Worker response must correspond to the submitted search query.');
      assert.equal(response.totalMatches, expectedMatches, `${queryClass.id} query ${query} must return the deterministic match count.`);
      assert.equal(response.resultCount, Math.min(expectedMatches, 1_000), `${queryClass.id} query ${query} must return the expected capped result page.`);
      assert.equal(response.complete, expectedMatches <= 1_000, `${queryClass.id} query ${query} must report whether its result page is complete.`);
      assert.ok(response.firstMatches?.some((item) => item.matchedFields.includes(queryClass.field)),
        `${queryClass.id} query ${query} must identify the expected indexed field (${queryClass.field}).`);
      samples.push({ query, durationMs: response.durationMs, totalMatches: response.totalMatches,
        resultCount: response.resultCount, complete: response.complete, firstMatch: response.firstMatches[0] ?? null });
    }
    const durationsMs = samples.map((sample) => sample.durationMs);
    assert.equal(durationsMs.length, 30, `${queryClass.id} must provide 30 warmed samples.`);
    allDurations.push(...durationsMs);
    byClass[queryClass.id] = { field: queryClass.field, samples, measured: durationsMs.length, durationsMs, p95Ms: p95(durationsMs) };
  }
  return { byClass, durationsMs: allDurations, measured: allDurations.length, p95Ms: p95(allDurations), samplesPerClass: 30 };
}

async function addProviderNode(atlas, id) {
  await atlas.locator.getByLabel('Providerスナップショットを検索').fill(id);
  const hit = atlas.locator.locator('.atlas-search-results .atlas-search-hit').first();
  await hit.waitFor({ state: 'visible', timeout: 30_000 });
  await hit.getByRole('button', { name: 'ノードを追加' }).click();
}

async function measureTraversal(page, atlas, origin) {
  await addProviderNode(atlas, 'perf-node-00000');
  await addProviderNode(atlas, 'perf-node-00010');
  await atlas.frame.waitForFunction(() => [...document.querySelectorAll('button')]
    .some((button) => button.textContent?.trim() === '入力方向 1段' && !button.disabled), null,
  { timeout: 30_000 });
  const from = atlas.locator.getByLabel('経路の始点');
  const to = atlas.locator.getByLabel('経路の終点');
  const pathOptions = await from.locator('option').evaluateAll((items) => items.map((option) => ({ value: option.value, label: option.textContent?.trim() ?? '' })));
  const fromOption = pathOptions.find((option) => option.label === '計測対象 00000');
  const toOption = pathOptions.find((option) => option.label === '計測対象 00010');
  assert.ok(fromOption && toOption, 'The nontrivial path endpoints must both be present in the real board UI.');
  await from.selectOption(fromOption.value);
  await to.selectOption(toOption.value);

  const neighborWorkloads = [
    { id: 'depth1-in', depth: 1, direction: 'in', button: '入力方向 1段',
      expectedNodeDepths: [['perf-node-00008', 1], ['perf-node-00009', 1]] },
    { id: 'depth2-out', depth: 2, direction: 'out', button: '出力方向 2段',
      expectedNodeDepths: [['perf-node-00011', 1], ['perf-node-00012', 1], ['perf-node-00013', 2], ['perf-node-00014', 2]] },
    { id: 'depth3-both', depth: 3, direction: 'both', button: '双方向 3段',
      expectedNodeDepths: [['perf-node-00004', 3], ['perf-node-00005', 3], ['perf-node-00006', 2], ['perf-node-00007', 2],
        ['perf-node-00008', 1], ['perf-node-00009', 1], ['perf-node-00011', 1], ['perf-node-00012', 1], ['perf-node-00013', 2],
        ['perf-node-00014', 2], ['perf-node-00015', 3], ['perf-node-00016', 3]] },
  ];
  const beforeNeighbors = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'neighbors').length;
  const neighborEvidence = {};
  let nextNeighbor = 0;
  for (const workload of neighborWorkloads) {
    const durationsMs = [];
    const samples = [];
    for (let index = 0; index < 30; index += 1) {
      await atlas.locator.getByRole('button', { name: workload.button, exact: true }).click();
      nextNeighbor += 1;
      await waitResponses(page, origin, 'neighbors', beforeNeighbors + nextNeighbor);
      const response = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'neighbors').slice(beforeNeighbors + nextNeighbor - 1, beforeNeighbors + nextNeighbor)[0];
      assert.ok(response, `${workload.id} must produce a measured Graph Worker response.`);
      assert.equal(response.ok, true, `${workload.id} must succeed in the Graph Worker.`);
      assert.equal(response.fromLocalId, 'perf-node-00010', `${workload.id} must traverse from the deterministic center node.`);
      assert.equal(response.depth, workload.depth);
      assert.equal(response.direction, workload.direction);
      assert.equal(response.limit, 5_000, `${workload.id} must retain the production bounded-result limit.`);
      assert.ok(response.nodeCount <= response.limit, `${workload.id} must not exceed the Worker result bound.`);
      assert.equal(response.complete, true, `${workload.id} must report the bounded result as complete.`);
      assert.equal(response.unresolvedCount, 0, `${workload.id} must return resolved deterministic nodes.`);
      assert.ok(response.nodeDepths.every((item) => item.depth >= 1 && item.depth <= workload.depth), `${workload.id} must respect its hop depth.`);
      const actualNodeDepths = response.nodeDepths.map((item) => [item.localId, item.depth]).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      assert.deepEqual(actualNodeDepths, workload.expectedNodeDepths, `${workload.id} must return the expected bounded ring neighbors at their shortest depths.`);
      durationsMs.push(response.durationMs);
      samples.push({ durationMs: response.durationMs, nodeCount: response.nodeCount, complete: response.complete,
        nodeLocalIds: response.nodeLocalIds, nodeDepths: response.nodeDepths });
    }
    assert.equal(durationsMs.length, 30, `${workload.id} must provide 30 warmed samples.`);
    neighborEvidence[workload.id] = { direction: workload.direction, depth: workload.depth, resultLimit: 5_000,
      expectedNodeCount: workload.expectedNodeDepths.length, expectedNodeDepths: workload.expectedNodeDepths,
      measured: durationsMs.length, durationsMs, p95Ms: p95(durationsMs), samples };
  }

  const beforePaths = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'shortestPath').length;
  const expectedPath = ['perf-node-00000', 'perf-node-00002', 'perf-node-00004', 'perf-node-00006', 'perf-node-00008', 'perf-node-00010'];
  const expectedLabels = ['計測対象 00000', '計測対象 00002', '計測対象 00004', '計測対象 00006', '計測対象 00008', '計測対象 00010'];
  const pathDurations = [];
  const pathSamples = [];
  for (let index = 0; index < 30; index += 1) {
    await atlas.locator.getByRole('button', { name: '最短経路を検索', exact: true }).click();
    await waitResponses(page, origin, 'shortestPath', beforePaths + index + 1);
    const response = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === origin && item.operation === 'shortestPath').slice(beforePaths + index, beforePaths + index + 1)[0];
    assert.ok(response, 'The bounded shortest-path workload must produce a measured Graph Worker response.');
    assert.equal(response.ok, true, 'The shortest-path workload must succeed in the Graph Worker.');
    assert.equal(response.fromLocalId, 'perf-node-00000');
    assert.equal(response.toLocalId, 'perf-node-00010');
    assert.equal(response.direction, 'both');
    assert.equal(response.maxHops, 64);
    assert.equal(response.maxVisited, 10_000);
    assert.equal(response.status, 'found');
    assert.equal(response.complete, true);
    assert.equal(response.hops, 5, 'The selected endpoints must require a nontrivial five-hop path.');
    assert.equal(response.edgeCount, 5);
    assert.deepEqual(response.pathLocalIds, expectedPath, 'Shortest path must traverse the deterministic ring content.');
    assert.deepEqual(response.pathLabels, expectedLabels, 'Shortest path must contain the expected Story node labels.');
    pathDurations.push(response.durationMs);
    pathSamples.push({ durationMs: response.durationMs, status: response.status, hops: response.hops,
      pathLocalIds: response.pathLocalIds, pathLabels: response.pathLabels });
  }
  assert.equal(pathDurations.length, 30, 'Shortest path must provide 30 warmed samples.');
  const allNeighborDurations = Object.values(neighborEvidence).flatMap((workload) => workload.durationsMs);
  return {
    neighbors: { measured: allNeighborDurations.length, durationsMs: allNeighborDurations, p95Ms: p95(allNeighborDurations), samplesPerDepth: 30, byDepth: neighborEvidence },
    shortestPath: { measured: pathDurations.length, durationsMs: pathDurations, p95Ms: p95(pathDurations), maxHops: 64, maxVisited: 10_000, samples: pathSamples },
  };
}

export async function runPerformanceCases({ browser, baseUrl, unzipSync, archives, datasets, record }) {
  const recordWithTrace = (id, run) => record(id, async () => {
    const trace = { startedAt: new Date().toISOString(), snapshots: [], captureErrors: [], gestures: [], approvedProposals: [] };
    activeScenarioTrace = trace;
    try {
      return await run();
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      delete trace.failureRequested;
      delete trace.failurePage;
      wrapped.partialTrace = trace;
      throw wrapped;
    } finally {
      activeScenarioTrace = null;
    }
  });

  await recordWithTrace('Q12-cold-1k-first-visible-and-force-layout', async () => {
    const samples = [];
    let queryEvidence = null;
    for (let index = 0; index < 5; index += 1) {
      const { context, page, workspaceId } = await createPage(browser, baseUrl, archives.oneK);
      try {
        const cold = await coldReopen(context, page, workspaceId);
        samples.push({ elapsedMs: cold.elapsedMs, firstVisibleNode: cold.firstVisibleNode,
          browserCacheClearedBeforeReload: cold.browserCacheClearedBeforeReload,
          resourceTiming: cold.resourceTiming, resources: cold.resources });
        if (index === 0) {
          await connectStory(page, cold.atlas);
          await cold.atlas.locator.locator('.atlas-status-inline').filter({ hasText: 'ノード 1000 件、エッジ 2000 件' }).waitFor({ timeout: 120_000 });
          const metrics = await readMetrics(page);
          const indexResult = metrics.find((item) => item.kind === 'response' && item.origin === cold.atlas.origin && item.operation === 'replace');
          assert.ok(indexResult, 'the real Graph Worker must build the 1k/2k snapshot');
          assert.equal(indexResult.nodeCount, 1_000);
          assert.equal(indexResult.edgeCount, 2_000);
          assert.ok(indexResult.durationMs <= 10_000, `1k Graph Worker index took ${indexResult.durationMs}ms`);
          const searches = await searchThirty(page, cold.atlas, cold.atlas.origin, 1_000);
          assert.equal(searches.measured, 90, 'the 1k Japanese, tag and type search classes must each complete 30 queries');
          for (const [searchClass, evidence] of Object.entries(searches.byClass)) {
            assert.equal(evidence.measured, 30, `the 1k ${searchClass} search class must provide 30 measurements`);
            assert.ok(evidence.p95Ms <= 100, `1k ${searchClass} search p95 ${evidence.p95Ms}ms exceeds 100ms`);
          }
          const before = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === cold.atlas.origin && item.operation === 'layout-force').length;
          await cold.atlas.locator.getByRole('button', { name: '力学レイアウト', exact: true }).click();
          await waitResponses(page, cold.atlas.origin, 'layout-force', before + 1);
          const layout = (await readMetrics(page)).filter((item) => item.kind === 'response' && item.origin === cold.atlas.origin && item.operation === 'layout-force')[before];
          assert.ok(layout, 'the production Layout Worker must complete the 1k Force request');
          assert.equal(layout.ok, true, 'the production Layout Worker must return a successful 1k Force result');
          assert.equal(layout.nodeCount, 1_000);
          assert.equal(layout.edgeCount, 2_000);
          assert.equal(layout.positionCount, 1_000, 'the 1k Force result must contain one position per node');
          assert.equal(layout.finitePositionCount, 1_000, 'all 1k Force result positions must have finite x/y coordinates');
          const heap = await readHeap(cold.atlas.frame);
          queryEvidence = { graphIndex: indexResult ? { durationMs: indexResult.durationMs, nodes: indexResult.nodeCount, edges: indexResult.edgeCount } : null,
            search: searches, forceLayout: layout ? { durationMs: layout.durationMs, nodes: layout.nodeCount, edges: layout.edgeCount,
              positions: layout.positionCount, finitePositions: layout.finitePositionCount } : null, heap,
            notCheckedReasons: heap.status === 'NOT_CHECKED' ? [heap.reason] : [] };
        }
      } catch (error) {
        markScenarioFailure(page, error);
        throw error;
      } finally { await context.close(); }
    }
    const times = samples.map((sample) => sample.elapsedMs);
    const coldP95Ms = p95(times);
    assert.equal(samples.length, 5);
    assert.ok(coldP95Ms <= 3_000, `1k cold first-visible p95 ${coldP95Ms}ms exceeds 3000ms`);
    assert.equal(queryEvidence?.search?.measured, 90, 'the 1k search benchmark must provide 30 measurements per indexed field class');
    assert.ok(queryEvidence.search.p95Ms <= 100, `1k search p95 ${queryEvidence.search.p95Ms}ms exceeds 100ms`);
    assert.ok(queryEvidence?.forceLayout, 'the 1k Force layout benchmark must provide a Worker response');
    assert.ok(queryEvidence.forceLayout.durationMs <= 2_000, `1k Force layout took ${queryEvidence.forceLayout.durationMs}ms`);
    return { dataset: datasets.oneK, samples, coldFirstVisibleP95Ms: coldP95Ms, coldFirstVisibleLimitMs: 3_000,
      coldFirstVisibleTimingScope: 'Host reload/open plus Atlas first-visible node, including JS/CSS transfer; per-resource timings are reported separately without subtracting them from this target.',
      ...queryEvidence };
  });

  await recordWithTrace('Q12-1k-force-layout-cancel-ack', async () => {
    const { context, page } = await createPage(browser, baseUrl, archives.oneK);
    try {
      const atlas = await atlasFrame(page);
      const before = await readMetrics(page);
      const priorRequests = before.filter((item) => item.kind === 'request' && item.origin === atlas.origin && item.operation === 'layout-force').length;
      const cancelClickCount = before.filter((item) => item.kind === 'cancel-click-dispatched' && item.origin === atlas.origin).length;
      const cancelButton = atlas.locator.getByRole('button', { name: 'レイアウトを中止', exact: true });
      await cancelButton.scrollIntoViewIfNeeded();
      assert.equal(await cancelButton.isVisible(), true, 'The real Cancel button must be visible before starting Force.');
      assert.equal(await cancelButton.isEnabled(), true, 'The real Cancel button must be enabled before starting Force.');
      const viewport = page.viewportSize();
      const assertCancelButtonInViewport = async () => {
        const bounds = await cancelButton.boundingBox();
        assert.ok(bounds, 'The actual Cancel button must have a visible pointer target.');
        assert.ok(viewport && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width
          && bounds.y + bounds.height <= viewport.height,
        `The actual Cancel button must be inside the browser viewport: ${JSON.stringify({ bounds, viewport })}.`);
        return bounds;
      };
      const cancelBounds = await assertCancelButtonInViewport();
      await atlas.locator.getByRole('button', { name: '力学レイアウト', exact: true }).click();
      const requestHandle = await page.waitForFunction(({ origin, count }) => (window.__atlasPerfStore ?? [])
        .filter((item) => item.kind === 'request' && item.origin === origin && item.operation === 'layout-force').length > count
        ? (window.__atlasPerfStore ?? []).filter((item) => item.kind === 'request' && item.origin === origin && item.operation === 'layout-force').at(-1)
        : false,
      { origin: atlas.origin, count: priorRequests }, { timeout: 30_000, polling: 5 });
      const requested = await requestHandle.jsonValue();
      await requestHandle.dispose();
      assert.ok(requested?.workerId, 'The real Layout Worker must start the in-flight Force calculation.');
      assert.equal(requested.nodeCount, 1_000, 'Cancellation must be measured on the deterministic 1k-node Force workload.');
      assert.equal(requested.edgeCount, 2_000, 'Cancellation must use the same 2k-edge Force workload.');
      const automationClickStartedAt = Date.now();
      await page.mouse.click(cancelBounds.x + cancelBounds.width / 2, cancelBounds.y + cancelBounds.height / 2);
      const clickHandle = await page.waitForFunction(({ origin, count }) => {
        const clicks = (window.__atlasPerfStore ?? []).filter((item) => item.kind === 'cancel-click-dispatched' && item.origin === origin);
        return clicks.length > count ? clicks.at(-1) : false;
      }, { origin: atlas.origin, count: cancelClickCount }, { timeout: 5_000, polling: 5 });
      const cancelClick = await clickHandle.jsonValue();
      await clickHandle.dispose();
      assert.equal(cancelClick?.trusted, true, 'Cancel must be delivered as a trusted physical browser click.');
      assert.equal(cancelClick?.targetText, 'レイアウトを中止', 'The trusted click must hit the actual Cancel button.');
      assert.equal(cancelClick?.buttonVisible, true, 'The actual Cancel button must be visible at pointer dispatch.');
      assert.equal(cancelClick?.buttonEnabled, true, 'The actual Cancel button must be enabled at pointer dispatch.');
      assert.equal(cancelClick?.workerId, requested.workerId, 'The physical Cancel click must target the in-flight Force Worker.');
      assert.equal(cancelClick?.requestId, requested.requestId, 'The physical Cancel click must target the still-active Force request.');
      const afterClickDispatch = await readMetrics(page);
      const forceResponseBeforeDispatch = afterClickDispatch.find((item) => item.kind === 'response'
        && item.workerId === requested.workerId && item.requestId === requested.requestId
        && (!Number.isFinite(item.frameNow) || item.frameNow <= cancelClick.frameNow));
      assert.equal(forceResponseBeforeDispatch, undefined,
        'The Force Worker must not respond before the actual Cancel click is dispatched.');
      await page.waitForFunction(({ workerId, requestId, clickId }) => (window.__atlasPerfStore ?? []).some((item) =>
        (item.kind === 'response' && item.workerId === workerId && item.requestId === requestId)
        || (item.kind === 'terminated' && item.workerId === workerId && item.requestId === requestId && item.clickId === clickId)),
      { workerId: requested.workerId, requestId: requested.requestId, clickId: cancelClick.clickId },
      { timeout: 2_000, polling: 5 });
      const afterCancel = await readMetrics(page);
      const completedBeforeCancel = afterCancel.find((item) => item.kind === 'response'
        && item.workerId === requested.workerId && item.requestId === requested.requestId);
      assert.equal(completedBeforeCancel, undefined,
        'The Force Worker completed instead of being terminated by the actual Cancel click.');
      const termination = afterCancel.find((item) => item.kind === 'terminated' && item.workerId === requested.workerId
        && item.requestId === requested.requestId && item.clickId === cancelClick.clickId
        && Number.isFinite(item.cancelDispatchToTerminationMs) && item.frameNow >= cancelClick.frameNow);
      assert.ok(termination);
      assert.ok(Number.isFinite(termination.cancelDispatchToTerminationMs), 'Force termination must be timed from the real frame click event to Worker.terminate().');
      assert.ok(termination.cancelDispatchToTerminationMs >= 0 && termination.cancelDispatchToTerminationMs <= 500,
        `Production Force cancellation took ${termination.cancelDispatchToTerminationMs}ms from the dispatched click to Worker.terminate(); limit is 500ms.`);
      const automationClickStartToDispatchMs = cancelClick.frameEpochMs - automationClickStartedAt;
      const clickDispatchToTerminationObservedMs = termination.frameNow - cancelClick.frameNow;
      const automationClickStartToTerminationMs = termination.frameEpochMs - automationClickStartedAt;
      assert.equal(afterCancel.some((item) => item.kind === 'response'
        && item.workerId === requested.workerId && item.requestId === requested.requestId), false,
        'The cancelled Force Worker must not return a stale layout result.');
      await atlas.locator.getByText('レイアウト計算を中止しました。', { exact: true }).waitFor();
      return { dataset: datasets.oneK, nodes: requested.nodeCount, edges: requested.edgeCount,
        cancelDispatchToTerminationMs: termination.cancelDispatchToTerminationMs, cancelDispatchToTerminationLimitMs: 500,
        clickDispatchToTerminationObservedMs, automationClickStartToDispatchMs, automationClickStartToTerminationMs,
        cancelClickVisible: cancelClick.buttonVisible, cancelClickEnabled: cancelClick.buttonEnabled,
        cancelClickTrusted: cancelClick.trusted, cancelClickTarget: cancelClick.targetText,
        workerTerminated: true, staleResponseReceived: false };
    } catch (error) {
      markScenarioFailure(page, error);
      throw error;
    } finally { await context.close(); }
  });

  await recordWithTrace('Q12-10k-worker-index-search-traversal-and-disable', async () => {
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
      await connectStory(page, atlas, { uiReadyTimeoutMs: 120_000 });
      await atlas.locator.locator('.atlas-status-inline').filter({ hasText: 'ノード 10000 件、エッジ 20000 件' }).waitFor({ timeout: 120_000 });
      const metrics = await readMetrics(page);
      const indexResult = metrics.find((item) => item.kind === 'response' && item.origin === atlas.origin && item.operation === 'replace');
      assert.ok(indexResult, 'the production Graph Worker must index the imported snapshot');
      assert.equal(indexResult.nodeCount, 10_000);
      assert.equal(indexResult.edgeCount, 20_000);
      assert.ok(indexResult.durationMs <= 10_000, `10k index took ${indexResult.durationMs}ms`);
      const searches = await searchThirty(page, atlas, atlas.origin, 10_000);
      const traversal = await measureTraversal(page, atlas, atlas.origin);
      assert.equal(searches.measured, 90, 'the 10k Japanese, tag and type search classes must each complete 30 queries');
      for (const [searchClass, evidence] of Object.entries(searches.byClass)) {
        assert.equal(evidence.measured, 30, `the 10k ${searchClass} search class must provide 30 measurements`);
        assert.ok(evidence.p95Ms <= 250, `10k ${searchClass} search p95 ${evidence.p95Ms}ms exceeds 250ms`);
      }
      assert.ok(searches.p95Ms <= 250, `10k search p95 ${searches.p95Ms}ms exceeds 250ms`);
      assert.ok(traversal.neighbors.p95Ms <= 500, `10k neighbors p95 ${traversal.neighbors.p95Ms}ms exceeds 500ms`);
      for (const [depth, evidence] of Object.entries(traversal.neighbors.byDepth)) {
        assert.equal(evidence.measured, 30, `10k neighbor ${depth} must provide 30 measurements`);
        assert.ok(evidence.p95Ms <= 500, `10k neighbor ${depth} p95 ${evidence.p95Ms}ms exceeds 500ms`);
      }
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
    } catch (error) {
      markScenarioFailure(page, error);
      throw error;
    } finally { await context.close(); }
  });

  const measureFreeform = async ({ archive, dataset, expectedObjects, verifyCommitReload }) => {
    const { context, page, workspaceId } = await createPage(browser, baseUrl, archive);
    try {
      const atlas = await atlasFrame(page);
      await atlas.locator.getByRole('tab', { name: /キャンバス/u }).last().click();
      const editor = atlas.locator.locator('.excalidraw');
      await editor.waitFor({ state: 'visible', timeout: 60_000 });
      await positionCanvasWithinHostViewport(page, atlas.frame, editor);
      const initialScene = await downloadScene(page, atlas);
      await positionCanvasWithinHostViewport(page, atlas.frame, editor);
      const viewportBeforeScene = await canvasViewportEvidence(page, atlas.frame, editor);
      const visibleElements = initialScene.data.elements.filter((element) => !element.isDeleted);
      assert.equal(visibleElements.length, expectedObjects, 'The benchmark must use the real Excalidraw scene, not Atlas cards.');
      const first = visibleElements[0];
      assert.equal(first.type, 'rectangle');
      activeScenarioTrace.freeformPartial = { stage: 'scene-loaded', activeSceneObjects: visibleElements.length,
        sceneBytes: initialScene.bytes.byteLength, sceneSha256: sha256(initialScene.bytes),
        firstObject: { id: first.id, type: first.type, x: first.x, y: first.y, width: first.width, height: first.height } };
      const initialAppState = viewportBeforeScene.liveAppState;
      const objectCenter = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
      const selectionPoint = scenePointToCanvasViewportPoint(objectCenter, initialAppState);
      const preselection = await selectCanvasObjectWithPhysicalInput(page, atlas.frame, viewportBeforeScene,
        selectionPoint, first.id);
      activeScenarioTrace.freeformPartial = { ...activeScenarioTrace.freeformPartial, stage: 'object-selected',
        viewportBeforeScene, objectPreselection: preselection };
      await positionCanvasWithinHostViewport(page, atlas.frame, editor);
      const viewportBeforeDrag = await canvasViewportEvidence(page, atlas.frame, editor);
      assert.ok(viewportBeforeDrag.liveAppState.selectedElementIds.includes(first.id),
        `The exact first rectangle ID must remain selected before the measured drag: ${JSON.stringify(viewportBeforeDrag.liveAppState.selectedElementIds)}.`);
      const dragStart = scenePointToCanvasViewportPoint(objectCenter, viewportBeforeDrag.liveAppState);
      const dragEnd = scenePointToCanvasViewportPoint({ x: objectCenter.x + 28, y: objectCenter.y + 18 }, viewportBeforeDrag.liveAppState);
      const drag = await runSampledGesture(page, atlas.frame, editor,
        dragStart, dragEnd, { expectedViewport: viewportBeforeDrag });
      const viewportAfterDrag = await canvasViewportEvidence(page, atlas.frame, editor);
      for (const key of ['editorRoot', 'interactiveCanvas', 'interactiveCanvasFrameRect', 'atlasIframeContentClip']) {
        for (const dimension of ['x', 'y', 'width', 'height']) {
          assert.ok(Math.abs(viewportAfterDrag[key][dimension] - viewportBeforeDrag[key][dimension]) <= 0.5,
            `Freeform layout ${key}.${dimension} must remain aligned during the measured object drag: ${JSON.stringify({ before: viewportBeforeDrag[key], after: viewportAfterDrag[key] })}.`);
        }
      }
      assert.ok(Math.abs(viewportAfterDrag.liveAppState.scrollX - viewportBeforeDrag.liveAppState.scrollX) <= 0.5
        && Math.abs(viewportAfterDrag.liveAppState.scrollY - viewportBeforeDrag.liveAppState.scrollY) <= 0.5
        && Math.abs(viewportAfterDrag.liveAppState.zoom.value - viewportBeforeDrag.liveAppState.zoom.value) <= 0.000001,
      `Canvas pan/zoom must stay fixed during the measured object drag: ${JSON.stringify({ before: viewportBeforeDrag.liveAppState, after: viewportAfterDrag.liveAppState })}.`);
      const afterDrag = await downloadScene(page, atlas);
      const dragged = afterDrag.data.elements.find((element) => element.id === first.id && !element.isDeleted);
      const expectedScenePosition = { x: first.x + 28, y: first.y + 18 };
      activeScenarioTrace.freeformPartial = { ...activeScenarioTrace.freeformPartial, stage: 'object-dragged',
        objectDrag: { objectId: first.id, sceneFrom: { x: first.x, y: first.y },
          sceneTo: dragged && { x: dragged.x, y: dragged.y }, sceneExpectedTo: expectedScenePosition,
          sceneBytes: afterDrag.bytes.byteLength, sceneSha256: sha256(afterDrag.bytes),
          viewportBefore: viewportBeforeDrag, viewportAfter: viewportAfterDrag } };
      assert.ok(dragged && Math.abs(dragged.x - expectedScenePosition.x) <= 1
        && Math.abs(dragged.y - expectedScenePosition.y) <= 1,
      `The selected Excalidraw rectangle must move by the measured scene delta (+28,+18), independent of page/container layout: ${JSON.stringify({ id: first.id, before: { x: first.x, y: first.y }, expected: expectedScenePosition, actual: dragged && { x: dragged.x, y: dragged.y }, containerBefore: viewportBeforeDrag.liveAppState.containerBounds, containerAfter: viewportAfterDrag.liveAppState.containerBounds, canvasBoundsBefore: viewportBeforeDrag.interactiveCanvas, canvasBoundsAfter: viewportAfterDrag.interactiveCanvas })}.`);

      const canvasBounds = (await canvasViewportEvidence(page, atlas.frame, editor)).interactiveCanvas;
      const pan = await runSampledGesture(page, atlas.frame, editor,
        { x: canvasBounds.width - 50, y: canvasBounds.height - 60 },
        { x: canvasBounds.width - 170, y: canvasBounds.height - 110 }, { pan: true });
      const panAppStateAfterGesture = await readLiveCanvasAppState(atlas.frame);
      const panAppStateBefore = pan.viewportEvidence.liveAppState;
      const panChanged = panAppStateAfterGesture.scrollX !== panAppStateBefore.scrollX
        || panAppStateAfterGesture.scrollY !== panAppStateBefore.scrollY;
      assert.ok(panChanged,
        `A real Space+drag must change the official live Excalidraw viewport scroll state; before=${JSON.stringify({ scrollX: panAppStateBefore.scrollX, scrollY: panAppStateBefore.scrollY })}, after=${JSON.stringify({ scrollX: panAppStateAfterGesture.scrollX, scrollY: panAppStateAfterGesture.scrollY })}, hitTests=${JSON.stringify(pan.hitTestEvidence)}, input=${JSON.stringify(pan.inputEvidence)}.`);
      const afterPan = await downloadScene(page, atlas);
      assert.equal(afterPan.data.elements.filter((element) => !element.isDeleted).length, expectedObjects,
        'Pan and drag must preserve every benchmark scene object.');
      await page.waitForTimeout(250);
      const panAppStateAfter = await readLiveCanvasAppState(atlas.frame);
      assert.ok(Math.abs(panAppStateAfter.scrollX - panAppStateAfterGesture.scrollX) <= 0.5
        && Math.abs(panAppStateAfter.scrollY - panAppStateAfterGesture.scrollY) <= 0.5
        && Math.abs(panAppStateAfter.zoom.value - panAppStateAfterGesture.zoom.value) <= 0.000001,
      `Scene export and the viewport persistence debounce must preserve the actual pan state: ${JSON.stringify({ afterGesture: panAppStateAfterGesture, settled: panAppStateAfter })}.`);
      const boardAfterPan = await downloadAtlasBoard(page, atlas);
      const freeformView = onlyFreeformView(boardAfterPan.data);
      const boardViewport = expectedBoardViewport(panAppStateAfter);
      assertBoardViewport(boardAfterPan.data, freeformView.id, boardViewport,
        'The Atlas Board export after Space+drag must persist the live Freeform viewport');
      const viewportAfterBoardExport = await readLiveCanvasAppState(atlas.frame);
      assert.ok(Math.abs(viewportAfterBoardExport.scrollX - panAppStateAfter.scrollX) <= 0.5
        && Math.abs(viewportAfterBoardExport.scrollY - panAppStateAfter.scrollY) <= 0.5
        && Math.abs(viewportAfterBoardExport.zoom.value - panAppStateAfter.zoom.value) <= 0.000001,
      `Board export must not change the measured runtime viewport: ${JSON.stringify({ beforeExport: panAppStateAfter, afterExport: viewportAfterBoardExport })}.`);
      activeScenarioTrace.freeformPartial = {
        activeSceneObjects: visibleElements.length,
        viewportBeforeScene,
        objectPreselection: preselection,
        objectDrag: { ...drag, objectId: first.id, sceneFrom: { x: first.x, y: first.y }, sceneTo: { x: dragged.x, y: dragged.y },
          sceneExpectedTo: expectedScenePosition, sceneDelta: { x: dragged.x - first.x, y: dragged.y - first.y },
          scenePointerFrom: dragStart, scenePointerTo: dragEnd,
          viewportBefore: viewportBeforeDrag, viewportAfter: viewportAfterDrag,
          containerBoundsBefore: viewportBeforeDrag.liveAppState.containerBounds,
          containerBoundsAfter: viewportAfterDrag.liveAppState.containerBounds,
          canvasBoundsBefore: viewportBeforeDrag.interactiveCanvas, canvasBoundsAfter: viewportAfterDrag.interactiveCanvas },
        normalPan: { ...pan, stateSource: 'read-only ExcalidrawImperativeAPI.getAppState()',
          scrollBefore: [panAppStateBefore.scrollX, panAppStateBefore.scrollY],
          scrollAfter: [panAppStateAfter.scrollX, panAppStateAfter.scrollY],
          persistedBoardViewport: boardViewport, boardViewId: freeformView.id,
          boardExportBytes: boardAfterPan.bytes.byteLength, boardExportSha256: sha256(boardAfterPan.bytes),
          changed: panChanged,
          serializedSceneViewportNote: 'The official local scene serializer omits transient viewport scroll; the Atlas Board view stores x/y/zoom and is checked against the live Excalidraw API.' },
      };

      let commitEvidence = null;
      let notCheckedReasons = [...drag.notCheckedReasons, ...pan.notCheckedReasons];
      if (verifyCommitReload) {
        const prepared = atlas.frame.getByRole('status').filter({ hasText: '準備済み・Hostコミット待ち' });
        await prepared.waitFor({ state: 'visible', timeout: 30_000 });
        const durableDraft = page.getByRole('status').filter({ hasText: 'Draftを耐久記録しました。確定には内容の確認と承認が必要です。' });
        await durableDraft.waitFor({ state: 'visible', timeout: 30_000 });
        assert.equal(await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).count(), 0,
          'The prepared Canvas draft must wait for explicit Host review and approval; preparing must not commit automatically.');
        const commitChain = await commitQ12SceneUntilCurrent(page, afterPan.bytes, freeformView.id, boardViewport);
        const sceneProposal = commitChain.sceneProposal;
        assert.equal(sceneProposal.afterText, afterPan.text, 'The final explicitly approved Host proposal must contain the exact measured Excalidraw scene bytes.');
        const boardProposal = commitChain.boardProposal;
        assert.ok(boardProposal?.afterText, 'The final explicitly approved Host proposal must contain the measured Atlas Board viewport.');
        const proposedBoard = JSON.parse(boardProposal.afterText);
        assertBoardViewport(proposedBoard, freeformView.id, boardViewport,
          'The final Host Commit proposal must preserve the measured Freeform viewport');
        const proposalSha256 = sha256(Buffer.from(sceneProposal.afterText, 'utf8'));

        const boardBeforeReload = await downloadAtlasBoard(page, atlas);
        assertBoardViewport(boardBeforeReload.data, freeformView.id, boardViewport,
          'The committed Atlas Board export before reload must preserve the measured Freeform viewport');
        assert.deepEqual(boardBeforeReload.data, proposedBoard,
          'The Host committed Board document must equal the Board state exported before reload.');
        const exportedBeforeReload = await exportInventoryFromCurrentHost(page, unzipSync);
        await reopenWorkspace(page, workspaceId);
        const reloadedAtlas = await atlasFrame(page);
        await reloadedAtlas.locator.getByRole('tab', { name: /キャンバス/u }).last().click();
        const boardAfterReload = await downloadAtlasBoard(page, reloadedAtlas);
        assertBoardViewport(boardAfterReload.data, freeformView.id, boardViewport,
          'The Atlas Board export after reload must preserve the measured Freeform viewport');
        assert.deepEqual(boardAfterReload.data, boardBeforeReload.data,
          'The exact committed Board document and Freeform viewport must survive reload.');
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
          draftPreparation: 'Atlas durable draft observed before explicit Host review and approval; no automatic Commit',
          proposedSceneSha256: proposalSha256,
          sceneBytes: Buffer.byteLength(sceneProposal.afterText, 'utf8'),
          boardViewId: freeformView.id,
          expectedRuntimeBoardViewport: boardViewport,
          committedBoardSha256: sha256(boardBeforeReload.bytes),
          reloadedBoardSha256: sha256(boardAfterReload.bytes),
          boardViewportAndDocumentIdenticalAfterReload: true,
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
          explicitlyApprovedProposalCount: commitChain.committed.length,
          explicitHostCommitReceipts: commitChain.committed.map(({ receiptText, proposedFiles }) => ({
            receiptText,
            files: proposedFiles.map((file) => ({
              path: file.path,
              beforeBytes: file.beforeText === null ? null : Buffer.byteLength(file.beforeText, 'utf8'),
              beforeSha256: file.beforeText === null ? null : sha256(Buffer.from(file.beforeText, 'utf8')),
              afterBytes: file.afterText === null ? null : Buffer.byteLength(file.afterText, 'utf8'),
              afterSha256: file.afterText === null ? null : sha256(Buffer.from(file.afterText, 'utf8')),
            })),
          })),
          finalScenePath: commitChain.scenePath,
        };
      }
      return {
        dataset, activeSceneObjects: visibleElements.length,
        viewportBeforeScene,
        objectPreselection: preselection,
        objectDrag: { ...drag, objectId: first.id, sceneFrom: { x: first.x, y: first.y }, sceneTo: { x: dragged.x, y: dragged.y },
          sceneExpectedTo: expectedScenePosition, sceneDelta: { x: dragged.x - first.x, y: dragged.y - first.y },
          scenePointerFrom: dragStart, scenePointerTo: dragEnd, sceneZoom: viewportBeforeDrag.liveAppState.zoom.value,
          sceneScroll: [viewportBeforeDrag.liveAppState.scrollX, viewportBeforeDrag.liveAppState.scrollY],
          viewportBefore: viewportBeforeDrag, viewportAfter: viewportAfterDrag,
          containerBoundsBefore: viewportBeforeDrag.liveAppState.containerBounds,
          containerBoundsAfter: viewportAfterDrag.liveAppState.containerBounds,
          hitTarget: 'selected rectangle filled center' },
        normalPan: { ...pan, stateSource: 'read-only ExcalidrawImperativeAPI.getAppState()',
          scrollBefore: [panAppStateBefore.scrollX, panAppStateBefore.scrollY],
          scrollAfter: [panAppStateAfter.scrollX, panAppStateAfter.scrollY],
          persistedBoardViewport: boardViewport, boardViewId: freeformView.id,
          serializedSceneViewportNote: 'The official local scene serializer omits transient viewport scroll; the Atlas Board view stores x/y/zoom and is checked against the live Excalidraw API.' },
        ...(commitEvidence ? { commitReloadManifestRevisionEquality: commitEvidence } : {}),
        notCheckedReasons,
        thresholds: { fpsP50AtLeast: 30, longTaskMs: 50, maximumConsecutive: 1 },
      };
    } catch (error) {
      markScenarioFailure(page, error);
      throw error;
    } finally { await context.close(); }
  };

  await recordWithTrace('Q12-freeform-100-object-pan-drag-frame-rate-and-long-tasks', () => measureFreeform({
    archive: archives.canvas100, dataset: datasets.canvas100, expectedObjects: 100, verifyCommitReload: false,
  }));
  await recordWithTrace('Q12-freeform-500-object-pan-drag-frame-rate-and-long-tasks-and-commit-reload', () => measureFreeform({
    archive: archives.canvas500, dataset: datasets.canvas500, expectedObjects: 500, verifyCommitReload: true,
  }));
}

export { p95, percentile };
