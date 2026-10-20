import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const benchmarkDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkDir, '../../..');
const { chromium } = await import('playwright');
const executablePath = await findChromium(chromium);
const server = await createServer({
  configFile: false,
  root: repositoryRoot,
  logLevel: 'error',
  optimizeDeps: { include: ['d3-force', 'elkjs'] },
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;

try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind an HTTP port');
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(`browser page error: ${error.stack ?? error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`browser console error: ${message.text()}`);
  });
  const sizes = process.env.ATLAS_BENCH_SIZES ?? '1000,10000';
  const samples = process.env.ATLAS_BENCH_SAMPLES ?? '30';
  const url = `http://127.0.0.1:${address.port}/packages/graph/benchmark/perf.html?sizes=${encodeURIComponent(sizes)}&samples=${encodeURIComponent(samples)}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => ['complete', 'failed'].includes(document.body.dataset.status), undefined, { timeout: 300_000 });
  const result = await page.locator('#result').textContent();
  console.log(result);
  if (await page.locator('body').getAttribute('data-status') !== 'complete') process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
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
