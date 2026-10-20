import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Run against the built static Host; fault injection touches the real frame port.
const baseUrl = process.env.ATLAS_FAULT_BASE_URL;
if (!baseUrl) throw new Error('ATLAS_FAULT_BASE_URL must point to a served production profile');
const profile = process.env.ATLAS_FAULT_PROFILE ?? 'story';
const plugin = profile === 'atlas' ? 'Atlas' : 'Story Knowledge';
const browser = await chromium.launch({ headless: true, ...(process.env.ATLAS_E2E_CHROMIUM ? { executablePath: process.env.ATLAS_E2E_CHROMIUM } : {}) });
const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
try {
  await context.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'atlas.host.request') {
        globalThis.__atlasFaultPort = this;
        globalThis.__atlasFaultEpoch = message.epoch;
      }
      return send.call(this, message, ...args);
    };
  });
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.getByLabel('Workspace名').fill('Frame fault recovery');
  await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();
  const workspaceId = await page.getByLabel('開く').inputValue();
  const summary = page.getByText('Workspaceのファイル・Source', { exact: true });
  await summary.click();
  await page.getByLabel('相対Path').fill('notes/frame-draft.md');
  const source = '障害注入前に耐久記録したDraft\n';
  await page.getByLabel('Source', { exact: true }).fill(source);
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  const pending = page.locator('section[aria-label="変更の承認"] article');
  await pending.getByText(source, { exact: true }).waitFor();
  const panel = page.getByRole('region', { name: `${plugin} Plugin`, exact: true });
  async function connectedFrame() {
    const iframe = await page.locator(`iframe[title="${plugin}"]`).elementHandle();
    const frame = await iframe.contentFrame();
    await frame.waitForFunction(() => !!globalThis.__atlasFaultPort);
    return frame;
  }
  const faults = ['stale-epoch', 'malformed', 'oversized', 'cyclic', 'bigint'];
  for (const fault of faults) {
    const frame = await connectedFrame();
    const epoch = await frame.evaluate(() => globalThis.__atlasFaultEpoch);
    await frame.evaluate(kind => {
      const message = {
        type: 'atlas.host.request', protocolVersion: 'atlas.host/v1', callId: crypto.randomUUID(),
        epoch: globalThis.__atlasFaultEpoch, method: 'snapshot', params: {}
      };
      if (kind === 'stale-epoch') message.epoch -= 1;
      if (kind === 'malformed') message.method = 'commit';
      if (kind === 'oversized') message.params.extra = 'x'.repeat(8 * 1024 * 1024);
      if (kind === 'cyclic') message.params.extra = message;
      if (kind === 'bigint') message.params.extra = 1n;
      globalThis.__atlasFaultPort.postMessage(message);
    }, fault);
    await panel.getByRole('alert').filter({ hasText: 'PROTOCOL_INVALID' }).waitFor();
    assert.equal(await page.locator(`iframe[title="${plugin}"]`).count(), 0);
    assert.equal(await pending.count(), 1);
    assert.equal(await pending.getByText(source, { exact: true }).innerText(), source);
    if (profile === 'combined') {
      await page.frameLocator('iframe[title="Atlas"]').locator('body').waitFor();
      assert.equal(await page.getByRole('region', { name: 'Atlas Plugin', exact: true }).getByRole('alert').count(), 0);
    }
    await panel.getByRole('button', { name: 'Pluginを再起動' }).click();
    const restarted = await connectedFrame();
    assert.ok(await restarted.evaluate(() => globalThis.__atlasFaultEpoch) > epoch);
  }
  for (const fault of ['uncaught-exception','unhandled-rejection']) {
    const frame = await connectedFrame();
    const epoch = await frame.evaluate(() => globalThis.__atlasFaultEpoch);
    await frame.evaluate(kind => {
      setTimeout(() => {
        if (kind === 'uncaught-exception') throw new Error('Injected frame exception');
        void Promise.reject(new Error('Injected frame rejection'));
      },0);
    },fault);
    await frame.getByRole('alert').filter({hasText:'Pluginでエラーが発生しました'}).waitFor();
    assert.equal(await pending.getByText(source,{exact:true}).innerText(),source);
    if (profile === 'combined') {
      await page.frameLocator('iframe[title="Atlas"]').locator('body').waitFor();
      assert.equal(await page.getByRole('region',{name:'Atlas Plugin',exact:true}).getByRole('alert').count(),0);
    }
    await frame.getByRole('button',{name:'Pluginを再読込',exact:true}).click();
    const restarted = await connectedFrame();
    assert.ok(await restarted.evaluate(() => globalThis.__atlasFaultEpoch) > epoch);
    faults.push(fault);
  }
  const beforeReload = await connectedFrame();
  const previousEpoch = await beforeReload.evaluate(() => globalThis.__atlasFaultEpoch);
  await beforeReload.evaluate(() => location.reload());
  await page.waitForFunction(({ title, epoch }) => {
    const iframe = document.querySelector(`iframe[title="${title}"]`);
    return iframe && new URL(iframe.src).searchParams.get('nonce') !== epoch;
  }, { title: plugin, epoch: new URL(beforeReload.url()).searchParams.get('nonce') });
  const reloaded = await connectedFrame();
  assert.ok(await reloaded.evaluate(() => globalThis.__atlasFaultEpoch) > previousEpoch);
  await pending.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).waitFor();
  await page.reload();
  await page.getByLabel('開く').selectOption(workspaceId);
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();
  await page.getByText('Workspaceのファイル・Source', { exact: true }).click();
  await page.getByRole('button', { name: 'notes/frame-draft.md', exact: true }).click();
  assert.equal(await page.getByLabel('Source', { exact: true }).inputValue(), source);
  console.log(JSON.stringify({ status: 'PASS', profile, browser: browser.version(), baseUrl, workspaceId,
    faults, case: 'real invalid frame RPC rejects only the target; independent frame reload renews epoch; journal commits exact bytes through Host reload' }));
} finally {
  await context.close();
  await browser.close();
}
