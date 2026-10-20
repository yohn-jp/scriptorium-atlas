import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const baseUrl = process.env.ATLAS_FAULT_BASE_URL;
if (!baseUrl) throw new Error('ATLAS_FAULT_BASE_URL must point to a built combined profile');
const browser = await chromium.launch({ headless: true, ...(process.env.ATLAS_E2E_CHROMIUM ? { executablePath: process.env.ATLAS_E2E_CHROMIUM } : {}) });
const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
try {
  await context.addInitScript(() => {
    const original = MessagePort.prototype.postMessage;
    const waiting = new Map();
    let hostPort;
    let epoch;
    globalThis.__providerDelayedOpens = 0;
    MessagePort.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'atlas.host.request') {
        epoch = message.epoch;
        if (!hostPort) {
          hostPort = this;
          hostPort.addEventListener('message', event => {
            const pending = waiting.get(event.data?.callId);
            if (pending) { waiting.delete(event.data.callId); clearTimeout(pending.timer); pending.resolve(event.data); }
          });
        }
      }
      if (message?.type === 'atlas.provider.response') {
        if (globalThis.__providerDropResponses) return;
        if (globalThis.__providerTamperSource && message.ok && message.method === 'listNodes' && message.result.items[0]) {
          message.result.items[0].source.path = '../private.yaml';
        }
        if (globalThis.__providerDelayOpen && message.method === 'open') {
          globalThis.__providerDelayedOpens++;
          setTimeout(() => original.call(this, message, ...args), 6000);
          return;
        }
      }
      return original.call(this, message, ...args);
    };
    globalThis.__providerHostCall = (method, params) => new Promise((resolve, reject) => {
      const callId = crypto.randomUUID();
      const timer = setTimeout(() => { waiting.delete(callId); reject(new Error(`Test RPC did not settle: ${method}`)); }, 14000);
      waiting.set(callId, { resolve, timer });
      original.call(hostPort, { type: 'atlas.host.request', protocolVersion: 'atlas.host/v1', callId, epoch, method, params });
    });
  });
  const page = await context.newPage();
  let createdWorkers = 0;
  page.on('worker', () => { createdWorkers++; });
  await page.goto(baseUrl);
  await page.getByLabel('Workspace名').fill('Provider deadline fault');
  await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();
  async function openSourcePanel() {
    const summary = page.getByText('Workspaceのファイル・Source', { exact: true });
    if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
  }
  await openSourcePanel();
  await page.getByLabel('相対Path').fill('bible/characters/provider.yaml');
  await page.getByLabel('Source', { exact: true }).fill('id: char-a\ntype: character\nname: 故障試験の人物\n');
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  await page.locator('section[aria-label="変更の承認"] article').getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).waitFor();
  const atlas = await (await page.locator('iframe[title="Atlas"]').elementHandle()).contentFrame();
  let story = await (await page.locator('iframe[title="Story Knowledge"]').elementHandle()).contentFrame();
  await atlas.waitForFunction(() => !!globalThis.__providerHostCall && document.body.innerText.length > 100);
  await story.waitForFunction(() => document.body.innerText.includes('ライブラリ'));
  const snapshot = await atlas.evaluate(() => globalThis.__providerHostCall('snapshot', {}));
  assert.equal(snapshot.ok, true);
  const sourceRevision = snapshot.result.workspace.sourceRevision;
  const openParams = { providerId: 'scriptorium.story-knowledge', sourceRevision };
  const denied = await atlas.evaluate(params => globalThis.__providerHostCall('acquireProvider', params), openParams);
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  const discovery = await atlas.evaluate(() => globalThis.__providerHostCall('describeProviders', {}));
  assert.equal(discovery.ok, true);
  assert.equal(createdWorkers, 0, 'metadata discovery and denied acquisition must not start a worker');
  await page.getByRole('checkbox', { name: 'AtlasへStory ProviderとSourceの読取りを許可', exact: true }).check();
  const initial = await atlas.evaluate(params => globalThis.__providerHostCall('acquireProvider', params), openParams);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const nodes = await atlas.evaluate(leaseId => globalThis.__providerHostCall('providerCall', {
    leaseId, request: { method: 'listNodes', params: { limit: 100 } }
  }), initial.result.leaseId);
  assert.equal(nodes.ok, true, JSON.stringify(nodes));
  assert.equal(nodes.result.items[0].ref.localId, 'char-a');
  assert.equal(nodes.result.items[0].source.path, 'bible/characters/provider.yaml');
  await story.evaluate(() => { globalThis.__providerDelayOpen = true; });
  await atlas.evaluate(params => {
    globalThis.__providerOpenResults = Promise.all(Array.from({ length: 4 }, () => globalThis.__providerHostCall('acquireProvider', params)));
  }, openParams);
  await story.waitForFunction(() => globalThis.__providerDelayedOpens === 4);
  const queueStart = Date.now();
  const queued = await atlas.evaluate(leaseId => Promise.all(Array.from({ length: 9 }, () => globalThis.__providerHostCall('providerCall', {
    leaseId, request: { method: 'listNodes', params: { limit: 1 } }
  }))), initial.result.leaseId);
  const queueDurationMs = Date.now() - queueStart;
  assert.ok(queued.every(reply => !reply.ok && reply.error.code === 'TIMEOUT'), JSON.stringify(queued));
  assert.ok(queueDurationMs < 6500, `queued interactive deadlines must settle without waiting for opens: ${queueDurationMs}ms`);
  const opens = await atlas.evaluate(() => globalThis.__providerOpenResults);
  assert.ok(opens.every(reply => reply.ok), JSON.stringify(opens));
  await story.evaluate(() => { globalThis.__providerDelayOpen = false; });
  const leaseIds = [initial, ...opens].map(reply => reply.result.leaseId);
  const releases = await atlas.evaluate(ids => Promise.all(ids.map(leaseId => globalThis.__providerHostCall('releaseProvider', { leaseId }))), leaseIds);
  assert.ok(releases.every(reply => reply.ok));
  const workerDeadline = Date.now() + 3000;
  while (page.workers().length && Date.now() < workerDeadline) await page.waitForTimeout(25);
  assert.ok(createdWorkers >= 1, 'real provider acquisition must exercise its actual Worker');
  assert.equal(page.workers().length, 0, 'last lease must terminate the provider Worker');

  await openSourcePanel();
  await page.getByLabel('相対Path').fill('notes/provider-fault.md');
  const draft = 'Provider停止中も保持するDraft\n';
  await page.getByLabel('Source', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  const proposal = page.locator('section[aria-label="変更の承認"] article');
  await proposal.waitFor();
  const scopeLease = await atlas.evaluate(params => globalThis.__providerHostCall('acquireProvider', params), openParams);
  assert.equal(scopeLease.ok, true);
  await story.evaluate(() => { globalThis.__providerTamperSource = true; });
  const spoofed = await atlas.evaluate(leaseId => globalThis.__providerHostCall('providerCall', {
    leaseId, request: { method: 'listNodes', params: { limit: 100 } }
  }), scopeLease.result.leaseId);
  assert.equal(spoofed.ok, false);
  await page.getByRole('region', { name: 'Story Knowledge Plugin', exact: true }).getByRole('alert').filter({ hasText: 'PROTOCOL_INVALID' }).waitFor();
  assert.equal(await proposal.count(), 1);
  await page.getByRole('region', { name: 'Story Knowledge Plugin', exact: true }).getByRole('button', { name: 'Pluginを再起動' }).click();
  story = await (await page.locator('iframe[title="Story Knowledge"]').elementHandle()).contentFrame();
  await story.waitForFunction(() => document.body.innerText.includes('ライブラリ'));
  await story.evaluate(() => { globalThis.__providerDropResponses = true; });
  const hung = await atlas.evaluate(params => globalThis.__providerHostCall('acquireProvider', params), openParams);
  assert.equal(hung.error.code, 'TIMEOUT');
  await page.getByRole('region', { name: 'Story Knowledge Plugin', exact: true }).getByRole('alert').filter({ hasText: 'TIMEOUT' }).waitFor();
  assert.equal(await page.locator('iframe[title="Story Knowledge"]').count(), 0);
  assert.equal(await page.locator('iframe[title="Atlas"]').count(), 1);
  assert.equal(await proposal.getByText(draft, { exact: true }).innerText(), draft);
  await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).waitFor();
  console.log(JSON.stringify({ status: 'PASS', browser: browser.version(), baseUrl, queuedCalls: 9, delayedOpens: 4,
    queueDurationMs, createdWorkers, workersAfterLastLease: 0,
    cases: ['grant denial without Worker', 'static discovery', 'bounded queued deadlines', 'last-lease Worker termination', 'out-of-scope Provider SourceRef isolates producer', 'hang and ignored cancel isolate provider and preserve Host draft'] }));
} finally { await context.close(); await browser.close(); }
