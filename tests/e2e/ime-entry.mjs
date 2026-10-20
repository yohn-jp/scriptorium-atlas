import assert from 'node:assert/strict';

const CASE_ID = 'Q13-atlas-ime-enter-waits-for-composition-end';

async function startComposition(input) {
  await input.evaluate(element => {
    element.focus();
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
  });
  assert.equal(await input.evaluate(element => document.activeElement === element), true,
    'Enter with isComposing=true must leave the input focused');
}

async function sendLegacyImeEnter(input) {
  await input.evaluate(element => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: false });
    Object.defineProperty(event, 'keyCode', { configurable: true, value: 229 });
    element.dispatchEvent(event);
  });
  assert.equal(await input.evaluate(element => document.activeElement === element), true,
    'legacy IME Enter (keyCode 229) must leave the input focused');
}

async function finishComposition(input) {
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
  });
}

async function verifyBoardName(atlas, frame) {
  const draft = '日本語入力中のボード';
  const input = atlas.getByLabel('ボード名', { exact: true });
  const title = atlas.locator('.atlas-board-tab-title').last();
  const before = await title.innerText();
  await input.fill(draft);
  await startComposition(input);
  assert.equal(await title.innerText(), before, 'composition Enter must not rename the Board');
  await sendLegacyImeEnter(input);
  assert.equal(await title.innerText(), before, 'legacy IME Enter must not rename the Board');
  await finishComposition(input);
  await input.press('Enter');
  await atlas.locator('.atlas-board-tab-title').filter({ hasText: draft }).waitFor({ state: 'visible' });
  assert.equal(await frame.evaluate(() => document.activeElement?.getAttribute('aria-label') !== 'ボード名'), true,
    'normal Enter after compositionend must commit and move focus away');
  return { oldTitle: before, committedTitle: await title.innerText(), composingEnterKeptFocus: true, legacyImeEnterKeptFocus: true };
}

async function verifyNodeLabel(atlas, frame) {
  await atlas.getByRole('button', { name: '＋ 手動ノード', exact: true }).click();
  await atlas.getByLabel('手動ノード名', { exact: true }).fill('手動ノード');
  await atlas.getByRole('button', { name: 'ノードを作成', exact: true }).click();
  const node = atlas.locator('.react-flow__node.atlas-flow-manual').last();
  await node.waitFor({ state: 'attached', timeout: 10_000 });
  await frame.waitForTimeout(250);
  const nodeState = await node.evaluate(element => {
    const rect = value => value?.getBoundingClientRect().toJSON() ?? null;
    const flow = element.closest('.react-flow__nodes');
    const viewport = element.closest('.react-flow__viewport');
    const canvas = element.closest('.react-flow__renderer');
    return {
      dataId: element.getAttribute('data-id'),
      label: element.innerText,
      className: element.className,
      inlineStyle: element.getAttribute('style'),
      computedVisibility: getComputedStyle(element).visibility,
      nodeRect: rect(element),
      nodesRect: rect(flow),
      viewportRect: rect(viewport),
      rendererRect: rect(canvas),
      expectedNodeData: { origin: 'manual', kind: 'generic.note', label: '手動ノード', position: { x: 80, y: 80 } }
    };
  });
  assert.equal(nodeState.computedVisibility, 'visible', `manual Node must render visibly before browser interaction: ${JSON.stringify(nodeState)}`);
  await node.click();
  const input = atlas.getByLabel('名前', { exact: true });
  await input.waitFor({ state: 'visible' });
  const draft = '日本語入力中のノード';
  const originalNodeText = await node.innerText();
  await input.fill(draft);
  await startComposition(input);
  assert.equal(await node.innerText(), originalNodeText, 'composition Enter must not commit the manual Node label');
  await sendLegacyImeEnter(input);
  assert.equal(await node.innerText(), originalNodeText, 'legacy IME Enter must not commit the manual Node label');
  await finishComposition(input);
  await input.press('Enter');
  await node.getByText(draft, { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await frame.evaluate(() => document.activeElement?.getAttribute('aria-label') !== '名前'), true,
    'normal Enter after compositionend must commit and move focus away');
  return { originalNodeText, committedLabel: await node.innerText(), composingEnterKeptFocus: true, legacyImeEnterKeptFocus: true };
}

export async function runImeEntryCases({ browser, baseUrl, profile, record }) {
  await record(CASE_ID, async () => {
    assert.ok(profile === 'atlas' || profile === 'combined', 'Q13 Atlas IME applies to atlas and combined profiles');
      const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Scriptorium Atlas' }).waitFor();
      await page.getByLabel('Workspace名').fill(`Q13 Atlas IME ${profile}`);
      await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
      await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();

      const panel = page.locator('section[aria-label="Atlas Plugin"]');
      await panel.getByText('接続中', { exact: true }).waitFor({ timeout: 60_000 });
      const atlas = page.frameLocator('section[aria-label="Atlas Plugin"] iframe');
      const iframeSrc = await panel.locator('iframe').getAttribute('src');
      assert.ok(iframeSrc, 'the Atlas iframe must expose its configured source');
      const atlasOrigin = new URL(iframeSrc, baseUrl).origin;
      const frame = page.frames().find(candidate => candidate.url().startsWith(`${atlasOrigin}/frame.html`));
      assert.ok(frame, 'the Atlas iframe must be loaded before its controls are tested');
      const emptyWorkspaceCreate = atlas.getByRole('button', { name: 'ボードを作成', exact: true });
      await emptyWorkspaceCreate.waitFor({ state: 'visible' });
      await emptyWorkspaceCreate.click();
      await atlas.getByLabel('ボード名', { exact: true }).waitFor({ state: 'visible' });

      const board = await verifyBoardName(atlas, frame);
      const node = await verifyNodeLabel(atlas, frame);
      return { profile, locale: 'ja-JP', board, node };
    } finally {
      await context.close();
    }
  });
}
