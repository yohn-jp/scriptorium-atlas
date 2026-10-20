import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build, preview } from 'vite';

const benchmarkDir = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import('playwright');
const executablePath = await findChromium(chromium);
const outputDir = await mkdtemp(join(tmpdir(), 'atlas-worker-benchmark-'));
let previewServer;
let proxyServer;
let browser;
let context;
let page;
let workerPoll;

try {
  const buildStarted = performance.now();
  await build({
    configFile: false,
    root: benchmarkDir,
    base: '/',
    logLevel: 'error',
    build: {
      outDir: outputDir,
      emptyOutDir: true,
      reportCompressedSize: false,
      rollupOptions: { input: resolve(benchmarkDir, 'perf.html') },
    },
  });
  const productionBuildMs = round(performance.now() - buildStarted);

  previewServer = await preview({
    configFile: false,
    root: benchmarkDir,
    base: '/',
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
    build: { outDir: outputDir },
  });
  const address = previewServer.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite preview did not bind an HTTP port');
  const scriptTransfers = [];
  proxyServer = createPreviewProxy(address.port, scriptTransfers);
  await new Promise((resolveListen, rejectListen) => {
    proxyServer.once('error', rejectListen);
    proxyServer.listen(0, '127.0.0.1', resolveListen);
  });
  const proxyAddress = proxyServer.address();
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Benchmark proxy did not bind an HTTP port');

  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  context = await browser.newContext({ serviceWorkers: 'block' });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  let createdWorkerCount = 0;
  let peakLiveWorkerCount = 0;
  const pageScriptRequests = [];
  const scriptRequests = new Map();
  const runtimeErrors = [];
  const origin = `http://127.0.0.1:${proxyAddress.port}`;
  page.on('worker', () => { createdWorkerCount += 1; });
  page.on('pageerror', (error) => runtimeErrors.push(error.stack ?? String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (request.resourceType() !== 'script' || !request.url().startsWith(`${origin}/`)) return;
    const scriptResponse = {
      path: new URL(request.url()).pathname,
      state: 'pending',
      requestStartMs: performance.now(),
    };
    pageScriptRequests.push(scriptResponse);
    scriptRequests.set(request, scriptResponse);
  });
  context.on('requestfinished', (request) => {
    const scriptResponse = scriptRequests.get(request);
    if (!scriptResponse) return;
    scriptResponse.state = 'complete';
    scriptResponse.requestEndMs = performance.now();
    scriptResponse.requestDurationMs = round(scriptResponse.requestEndMs - scriptResponse.requestStartMs);
  });
  context.on('requestfailed', (request) => {
    const scriptResponse = scriptRequests.get(request);
    if (!scriptResponse) return;
    scriptResponse.state = 'failed';
    scriptResponse.failure = request.failure()?.errorText ?? 'request failed';
    scriptResponse.requestEndMs = performance.now();
    scriptResponse.requestDurationMs = round(scriptResponse.requestEndMs - scriptResponse.requestStartMs);
  });
  workerPoll = setInterval(() => {
    peakLiveWorkerCount = Math.max(peakLiveWorkerCount, page.workers().length);
  }, 10);

  const sizes = process.env.ATLAS_BENCH_SIZES ?? '1000,10000';
  const samples = process.env.ATLAS_BENCH_SAMPLES ?? '30';
  const url = `${origin}/perf.html?sizes=${encodeURIComponent(sizes)}&samples=${encodeURIComponent(samples)}`;
  const navigationStarted = performance.now();
  await page.goto(url, { waitUntil: 'load' });
  const navigationLoadMs = round(performance.now() - navigationStarted);
  await page.waitForFunction(() => ['complete', 'failed'].includes(document.body.dataset.status), undefined, { timeout: 300_000 });
  const reportText = await page.locator('#result').textContent();
  const liveWorkerCount = await waitForWorkersToClose(page, 2_000);
  const pendingPageScriptRequests = await waitForScriptResponses(pageScriptRequests, 2_000);
  const pendingProxyScriptResponses = await waitForScriptResponses(scriptTransfers, 2_000);

  const coldBundle = summarizeColdBundle(scriptTransfers, navigationLoadMs, pageScriptRequests.length);
  const report = JSON.parse(reportText);
  const scriptCountMismatch = scriptTransfers.length !== pageScriptRequests.length;
  report.productionBrowserRun = {
    build: 'Vite production build served with Vite preview through a local byte-counting proxy; Chromium HTTP cache disabled',
    productionBuildMs,
    coldBundle,
    workerLifecycle: {
      createdWorkerCount,
      peakLiveWorkerCount,
      liveWorkersAfterClientsClose: liveWorkerCount,
    },
    pendingPageScriptRequests,
    pendingProxyScriptResponses,
  };
  console.log(JSON.stringify(report, null, 2));
  if (await page.locator('body').getAttribute('data-status') !== 'complete' || runtimeErrors.length > 0 || liveWorkerCount !== 0 || pendingPageScriptRequests !== 0 || pendingProxyScriptResponses !== 0 || scriptCountMismatch) {
    if (runtimeErrors.length > 0) console.error(`browser errors: ${runtimeErrors.join('\n')}`);
    if (liveWorkerCount !== 0) console.error(`browser retained ${liveWorkerCount} Worker(s) after clients closed`);
    if (pendingPageScriptRequests !== 0) console.error(`browser left ${pendingPageScriptRequests} script request(s) pending`);
    if (pendingProxyScriptResponses !== 0) console.error(`preview proxy left ${pendingProxyScriptResponses} script response(s) pending`);
    if (scriptCountMismatch) console.error(`browser observed ${pageScriptRequests.length} script requests but proxy counted ${scriptTransfers.length}`);
    process.exitCode = 1;
  }
} finally {
  clearInterval(workerPoll);
  await context?.close();
  await browser?.close();
  if (proxyServer?.listening) await new Promise((resolveClose, rejectClose) => {
    proxyServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (previewServer) await new Promise((resolveClose, rejectClose) => {
    previewServer.httpServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  await rm(outputDir, { recursive: true, force: true });
}

async function waitForWorkersToClose(targetPage, timeoutMs) {
  const started = performance.now();
  while (targetPage.workers().length > 0 && performance.now() - started < timeoutMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  return targetPage.workers().length;
}

async function waitForScriptResponses(responses, timeoutMs) {
  const started = performance.now();
  while (responses.some((entry) => entry.state === 'pending') && performance.now() - started < timeoutMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  return responses.filter((entry) => entry.state === 'pending').length;
}

function createPreviewProxy(previewPort, scriptTransfers) {
  return createHttpServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? '/', 'http://localhost').pathname;
    const isScript = /\.m?js$/i.test(path);
    const startedMs = performance.now();
    const transfer = isScript ? {
      path,
      state: 'pending',
      transferBodyBytes: 0,
      startedMs,
    } : undefined;
    if (transfer) scriptTransfers.push(transfer);

    const headers = { ...incoming.headers, host: `127.0.0.1:${previewPort}` };
    delete headers['proxy-connection'];
    const upstream = createHttpRequest({
      hostname: '127.0.0.1',
      port: previewPort,
      path: incoming.url,
      method: incoming.method,
      headers,
    }, (response) => {
      if (transfer) {
        transfer.statusCode = response.statusCode;
        transfer.contentEncoding = response.headers['content-encoding'] ?? 'none';
        response.on('data', (chunk) => { transfer.transferBodyBytes += chunk.byteLength; });
        response.on('aborted', () => failTransfer(transfer, 'preview response aborted'));
        response.on('error', (error) => failTransfer(transfer, String(error)));
        outgoing.once('finish', () => completeTransfer(transfer));
        outgoing.once('close', () => {
          if (!outgoing.writableFinished) failTransfer(transfer, 'browser closed response');
        });
      }

      const responseHeaders = { ...response.headers };
      delete responseHeaders.connection;
      delete responseHeaders['keep-alive'];
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders.upgrade;
      outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
      response.pipe(outgoing);
    });
    upstream.on('error', (error) => {
      if (transfer) failTransfer(transfer, String(error));
      if (outgoing.headersSent) outgoing.destroy(error);
      else outgoing.writeHead(502, { 'content-type': 'text/plain' }).end('Vite preview proxy error');
    });
    incoming.once('aborted', () => upstream.destroy());
    incoming.pipe(upstream);
  });
}

function completeTransfer(transfer) {
  if (transfer.state !== 'pending') return;
  transfer.state = 'complete';
  transfer.requestDurationMs = round(performance.now() - transfer.startedMs);
  delete transfer.startedMs;
}

function failTransfer(transfer, failure) {
  if (transfer.state !== 'pending') return;
  transfer.state = 'failed';
  transfer.failure = failure;
  transfer.requestDurationMs = round(performance.now() - transfer.startedMs);
  delete transfer.startedMs;
}

function summarizeColdBundle(responses, navigationLoadMs, pageScriptRequestCount) {
  const completed = responses.filter((entry) => entry.state === 'complete');
  const durations = completed.map((entry) => entry.requestDurationMs).filter(Number.isFinite);
  const uniquePaths = new Map(completed.map((entry) => [entry.path, entry.transferBodyBytes]));
  return {
    pageScriptRequestCount,
    proxyScriptResponseCount: responses.length,
    completedScriptResponseCount: completed.length,
    failedOrCancelledScriptResponseCount: responses.length - completed.length,
    completedScriptTransferBodyBytes: completed.reduce((total, entry) => total + entry.transferBodyBytes, 0),
    uniqueCompletedScriptTransferBodyBytes: [...uniquePaths.values()].reduce((total, bytes) => total + bytes, 0),
    maxRequestDurationMs: durations.length > 0 ? round(Math.max(...durations)) : null,
    summedRequestDurationMs: round(durations.reduce((total, duration) => total + duration, 0)),
    navigationLoadMs,
    scripts: responses.map(({ path, state, transferBodyBytes, contentEncoding, statusCode, failure, requestDurationMs }) => ({
      path, state, transferBodyBytes, contentEncoding, statusCode, failure, requestDurationMs,
    })),
  };
}

function round(value) {
  return Number(value.toFixed(2));
}

async function findChromium(playwrightChromium) {
  const candidates = [process.env.ATLAS_E2E_CHROMIUM, process.env.CHROMIUM_PATH, playwrightChromium.executablePath()];
  const cache = join(homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of await readdir(cache)) {
      if (!entry.startsWith('chromium-')) continue;
      const directory = join(cache, entry);
      candidates.push(join(directory, 'chrome-linux64', 'chrome'), join(directory, 'chrome-linux', 'chrome'));
    }
  } catch { /* No Playwright browser cache; use the default executable path. */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next installed Chromium path. */ }
  }
  throw new Error(`Chromium was not found. Set ATLAS_E2E_CHROMIUM or CHROMIUM_PATH, or install the browser at ${playwrightChromium.executablePath()}`);
}
