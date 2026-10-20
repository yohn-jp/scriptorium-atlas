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
  await page.getByLabel('Source', { exact: true }).fill('id: char-a\ntype: character\nname: 故障試験の人物\nappears: char-b\n');
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  await page.locator('section[aria-label="変更の承認"] article').getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).waitFor();
  await page.getByLabel('相対Path').fill('bible/characters/second.yaml');
  await page.getByLabel('Source', { exact: true }).fill('id: char-b\ntype: character\nname: 参照先の人物\n');
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  await page.locator('section[aria-label="変更の承認"] article').getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).waitFor();
  const atlas = await (await page.locator('iframe[title="Atlas"]').elementHandle()).contentFrame();
  let story = await (await page.locator('iframe[title="Story Knowledge"]').elementHandle()).contentFrame();
  await atlas.waitForFunction(() => !!globalThis.__providerHostCall && document.body.innerText.length > 100);
  await story.waitForFunction(() => document.body.innerText.includes('ライブラリ'));
  const fontPolicy = await atlas.evaluate(async hostOrigin => {
    async function read(url) {
      try { const response = await fetch(url); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }
      catch { return { blocked: true }; }
    }
    return {
      font: await read('/fonts/Cascadia/CascadiaCode-Regular.woff2'),
      staticFile: await read('/closure.json'),
      host: await read(`${hostOrigin}/closure.json`),
      external: await read('https://fonts.invalid/font.woff2'),
      traversal: await read('/fonts/%2e%2e%2fclosure.json'),
    };
  }, new URL(baseUrl).origin);
  assert.equal(fontPolicy.font.status, 200);
  assert.ok(fontPolicy.font.bytes > 0);
  for (const key of ['staticFile', 'host', 'external']) assert.equal(fontPolicy[key].blocked, true);
  assert.ok(fontPolicy.traversal.blocked || fontPolicy.traversal.status === 404);
  const snapshot = await atlas.evaluate(() => globalThis.__providerHostCall('snapshot', {}));
  assert.equal(snapshot.ok, true);
  const sourceRevision = snapshot.result.workspace.sourceRevision;
  const openParams = { providerId: 'scriptorium.story-knowledge', sourceRevision };
  const denied = await atlas.evaluate(params => globalThis.__providerHostCall('acquireProvider', params), openParams);
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  const discovery = await atlas.evaluate(() => globalThis.__providerHostCall('describeProviders', {}));
  assert.equal(discovery.ok, true);
  assert.equal(createdWorkers, 0, 'metadata discovery and denied acquisition must not start a worker');
  const scopedPages = await atlas.evaluate(async () => {
    const call = globalThis.__providerHostCall;
    const list = await call('list', {limit:1});
    const snapshot = await call('snapshot', {limit:1});
    const second = await call('list', {limit:1,cursor:list.result.nextCursor});
    const foreign = await call('snapshot', {limit:1,cursor:list.result.nextCursor});
    const forged = await call('list', {limit:1,cursor:encodeURIComponent('bible/characters/provider.yaml')});
    return {list,snapshot,second,foreign,forged};
  });
  for (const key of ['list','snapshot','second']) {
    assert.equal(scopedPages[key].ok,true);
    assert.deepEqual(scopedPages[key].result.files,[]);
    assert.ok(!JSON.stringify(scopedPages[key]).includes('bible'), 'ungranted paths must not leak through rows or cursors');
  }
  assert.ok(scopedPages.list.result.nextCursor);
  assert.equal(scopedPages.second.result.nextCursor,null);
  for (const key of ['foreign','forged']) assert.equal(scopedPages[key].error.code,'INVALID_INPUT');
  await page.getByRole('checkbox', { name: 'AtlasへStory ProviderとSourceの読取りを許可', exact: true }).check();
  const oldGrantCursor = await atlas.evaluate(cursor => globalThis.__providerHostCall('list',{limit:1,cursor}),scopedPages.list.result.nextCursor);
  assert.equal(oldGrantCursor.error.code,'INVALID_INPUT');
  let initial = await atlas.evaluate(params => globalThis.__providerHostCall('acquireProvider', params), openParams);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const nodes = await atlas.evaluate(leaseId => globalThis.__providerHostCall('providerCall', {
    leaseId, request: { method: 'listNodes', params: { limit: 100 } }
  }), initial.result.leaseId);
  assert.equal(nodes.ok, true, JSON.stringify(nodes));
  assert.equal(nodes.result.items[0].ref.localId, 'char-a');
  assert.equal(nodes.result.items[0].source.path, 'bible/characters/provider.yaml');
  const paging = await atlas.evaluate(async leaseId => {
    const call = (method, params) => globalThis.__providerHostCall('providerCall', { leaseId, request: { method, params } });
    const first = await call('listNodes', { limit: 1 });
    const second = await call('listNodes', { limit: 1, cursor: first.result.nextCursor });
    const refs = ['char-a', 'missing'].map(localId => ({ providerId: 'scriptorium.story-knowledge', localId }));
    const partial = await call('getNodes', { refs });
    const neighbors = await call('neighbors', { from: refs[0], depth: 1, direction: 'out', limit: 10 });
    return { first, second, partial, neighbors };
  }, initial.result.leaseId);
  for (const reply of Object.values(paging)) {
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.result.snapshot, initial.result.snapshot);
  }
  assert.equal(paging.first.result.complete, true, 'complete describes source coverage; nextCursor describes pagination');
  assert.ok(paging.first.result.nextCursor);
  assert.equal(paging.second.result.nextCursor, null);
  assert.equal(paging.second.result.complete, true);
  assert.deepEqual([...paging.first.result.items, ...paging.second.result.items].map(node => node.ref.localId), ['char-a', 'char-b']);
  assert.equal(paging.partial.result.complete, false);
  assert.deepEqual(paging.partial.result.items.map(node => node.ref.localId), ['char-a']);
  assert.equal(paging.neighbors.result.items[0].node.ref.localId, 'char-b');
  const producerWorker = page.workers().at(-1);
  assert.ok(producerWorker, 'the production Provider must own a real Worker before crash injection');
  await Promise.all([
    producerWorker.waitForEvent('close',{timeout:5000}),
    producerWorker.evaluate(() => { setTimeout(() => { throw new Error('Injected Provider Worker crash'); },0); }),
  ]);
  const afterCrash = await atlas.evaluate(leaseId => globalThis.__providerHostCall('providerCall',{
    leaseId,request:{method:'listNodes',params:{limit:10}},
  }),initial.result.leaseId);
  assert.equal(afterCrash.ok,false,'a crashed Worker must not return cached results as current');
  assert.equal(await page.locator('iframe[title="Atlas"]').count(),1);
  await page.getByRole('region',{name:'Story Knowledge Plugin',exact:true}).getByRole('button',{name:'Pluginを再起動',exact:true}).click();
  story = await (await page.locator('iframe[title="Story Knowledge"]').elementHandle()).contentFrame();
  await story.waitForFunction(() => document.body.innerText.includes('ライブラリ'));
  initial = await atlas.evaluate(params => globalThis.__providerHostCall('acquireProvider',params),openParams);
  assert.equal(initial.ok,true,JSON.stringify(initial));
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
  await page.getByRole('checkbox', { name: 'Atlasを有効化', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Story Knowledgeを有効化', exact: true }).uncheck();
  await page.waitForTimeout(100);
  let disabledRequests = 0;
  page.on('request', () => { disabledRequests++; });
  await page.waitForTimeout(5000);
  assert.equal(page.workers().length, 0);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(disabledRequests, 0, 'disabled Plugins must not fetch heavy code or poll the network');
  console.log(JSON.stringify({ status: 'PASS', browser: browser.version(), baseUrl, queuedCalls: 9, delayedOpens: 4,
    queueDurationMs, createdWorkers, workersAfterLastLease: 0, disabledObservationMs: 5000, disabledRequests, fontPolicy,
    scopedInventory: {restrictedRows:0,opaqueCursor:true,foreignMethodRejected:true,forgedCursorRejected:true,changedGrantRejected:true},
    crashedProviderWorker: {closed:true,errorCode:afterCrash.error.code,reopened:true},
    cases: ['grant denial without Worker', 'static discovery', 'real Provider page/cursor/getNodes partial/neighbors with exact snapshot', 'bounded queued deadlines', 'last-lease Worker termination', 'out-of-scope Provider SourceRef isolates producer', 'hang and ignored cancel isolate provider and preserve Host draft'] }));
} finally { await context.close(); await browser.close(); }
