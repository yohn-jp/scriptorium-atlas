import assert from 'node:assert/strict';

const CASES = {
  syntheticIme: 'Q13-atlas-synthetic-ime-enter-guard',
  chromiumIme: 'Q13-atlas-chromium-composition-enter-guard',
  keyboard: 'Q13-atlas-keyboard-only-undo-redo',
  appearance: 'Q13-atlas-theme-responsive-operations'
};

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

async function openAtlasWorkspace({ browser, baseUrl, profile, label, viewport = { width: 1440, height: 1000 } }) {
  assert.ok(profile === 'atlas' || profile === 'combined', 'Q13 Atlas applies only to atlas and combined profiles');
  const context = await browser.newContext({ locale: 'ja-JP', colorScheme: null, viewport });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Scriptorium Atlas' }).waitFor();
  await page.getByLabel('Workspace名').fill(`Q13 ${label} ${profile}`);
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
  await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).waitFor({ state: 'visible' });
  return { context, page, panel, atlas, frame, iframeSrc };
}

async function createBoardByPointer(atlas) {
  await atlas.getByRole('button', { name: 'ボードを作成', exact: true }).click();
  await atlas.getByLabel('ボード名', { exact: true }).waitFor({ state: 'visible' });
}

async function createBoardByKeyboard(page, frame) {
  const describeActive = () => frame.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? '',
      ariaLabel: element?.getAttribute('aria-label') ?? '',
      text: (element?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
      value: element instanceof HTMLInputElement ? element.value : ''
    };
  });
  const tabUntil = async predicate => {
    let active;
    for (let index = 0; index < 160; index += 1) {
      await page.keyboard.press('Tab');
      active = await describeActive();
      if (predicate(active)) return { active, tabs: index + 1 };
    }
    throw new Error(`Keyboard focus did not reach the requested Atlas control; last active element: ${JSON.stringify(active)}`);
  };

  const newBoardFocus = await tabUntil(active => active.tag === 'BUTTON' && active.text.includes('＋ 新しいボード'));
  await page.keyboard.press('Enter');
  await frame.getByLabel('ボード名', { exact: true }).waitFor({ state: 'visible' });

  const addNodeFocus = await tabUntil(active => active.tag === 'BUTTON' && active.text.includes('＋ 手動ノード'));
  await page.keyboard.press('Enter');
  const nodeInput = frame.getByLabel('手動ノード名', { exact: true });
  await nodeInput.waitFor({ state: 'visible' });
  await page.keyboard.insertText('キーボードノード');
  await page.keyboard.press('Enter');
  const node = frame.locator('.react-flow__node.atlas-flow-manual').filter({ hasText: 'キーボードノード' }).last();
  await node.waitFor({ state: 'visible' });

  await frame.evaluate(() => {
    window.__atlasQ13KeyboardEvents = [];
    document.addEventListener('keydown', event => {
      if (['Enter', 'z', 'Z', ' '].includes(event.key)) {
        window.__atlasQ13KeyboardEvents.push({ type: 'keydown', key: event.key, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
          targetTag: event.target instanceof HTMLElement ? event.target.tagName : '',
          targetText: (event.target instanceof HTMLElement ? event.target.textContent : '')?.trim().slice(0, 80), isTrusted: event.isTrusted });
      }
    }, true);
    document.addEventListener('click', event => {
      if (event.target instanceof HTMLElement && event.target.closest('button')) {
        window.__atlasQ13KeyboardEvents.push({ type: 'click', text: event.target.closest('button')?.textContent?.trim(), isTrusted: event.isTrusted });
      }
    }, true);
  });

  const undoFocus = await tabUntil(active => active.tag === 'BUTTON' && active.text.includes('元に戻す'));
  const undoTarget = await describeActive();
  assert.equal(undoTarget.tag, 'BUTTON', 'keyboard focus must rest on Undo before activation');
  let undoActions = 0;
  while (await node.count() > 0 && undoActions < 5) {
    await page.keyboard.press('Enter');
    undoActions += 1;
    await page.waitForTimeout(120);
  }
  if (await node.count() > 0) {
    const state = await frame.evaluate(() => ({
      active: { tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim(), disabled: document.activeElement instanceof HTMLButtonElement ? document.activeElement.disabled : null },
      nodeCount: document.querySelectorAll('.react-flow__node.atlas-flow-manual').length,
      undoDisabled: [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '元に戻す')?.disabled,
      redoDisabled: [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'やり直す')?.disabled,
      keyboardEvents: window.__atlasQ13KeyboardEvents
    }));
    throw new Error(`Keyboard Undo did not remove the Node within five actions; target=${JSON.stringify(undoTarget)} after=${JSON.stringify(state)}`);
  }
  const redoFocus = await tabUntil(active => active.tag === 'BUTTON' && active.text.includes('やり直す'));
  assert.equal((await describeActive()).tag, 'BUTTON', 'keyboard focus must rest on Redo before activation');
  let redoActions = 0;
  while (await node.count() === 0 && redoActions < 5) {
    await page.keyboard.press('Enter');
    redoActions += 1;
    await page.waitForTimeout(120);
  }
  assert.ok(await node.count() > 0, 'keyboard Redo must restore the Node within five actions');
  const boardNameFocus = await tabUntil(active => active.tag === 'INPUT' && active.ariaLabel === 'ボード名');
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('キーボード操作ボード');
  await page.keyboard.press('Enter');
  await frame.locator('.atlas-board-tab-title').filter({ hasText: 'キーボード操作ボード' }).waitFor({ state: 'visible' });
  assert.notEqual((await describeActive()).ariaLabel, 'ボード名', 'Enter commits the board name and moves focus away from its input');
  return {
    board: 'キーボード操作ボード',
    node: 'キーボードノード',
    boardCreateTabs: newBoardFocus.tabs,
    boardNameTabs: boardNameFocus.tabs,
    addNodeTabs: addNodeFocus.tabs,
    undoTabs: undoFocus.tabs,
    redoTabs: redoFocus.tabs,
    undoActions,
    redoActions,
    undoRedo: 'Tab focus and Enter on 元に戻す / やり直す',
    keyboardOnlyAtlasPointerDowns: 0
  };
}

async function installPointerCounter(target) {
  await target.evaluate(() => {
    window.__atlasQ13PointerDowns = 0;
    document.addEventListener('pointerdown', () => { window.__atlasQ13PointerDowns += 1; }, true);
  });
}

async function pointerCount(target) {
  return target.evaluate(() => window.__atlasQ13PointerDowns ?? 0);
}

async function verifySyntheticIme(atlas, frame) {
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
  assert.notEqual(await frame.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'ボード名',
    'normal Enter after compositionend must commit and move focus away');
  return { oldTitle: before, committedTitle: await title.innerText(), composingEnterKeptFocus: true, legacyImeEnterKeptFocus: true };
}

async function verifyChromiumComposition({ context, page, atlas, frame }) {
  const input = atlas.getByLabel('ボード名', { exact: true });
  const title = atlas.locator('.atlas-board-tab-title').last();
  const before = await title.innerText();
  await input.fill('');
  await input.click();
  await input.evaluate(element => {
    const events = [];
    const store = event => events.push({ type: event.type, key: event instanceof KeyboardEvent ? event.key : undefined,
      isComposing: event instanceof KeyboardEvent || event instanceof InputEvent ? event.isComposing : undefined,
      keyCode: event instanceof KeyboardEvent ? event.keyCode : undefined, data: 'data' in event ? event.data : undefined });
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'keydown', 'input', 'blur']) {
      element.addEventListener(type, store, true);
    }
    window.__atlasQ13CompositionEvents = events;
  });

  const cdp = await context.newCDPSession(page);
  try {
    const candidate = 'にほんご候補';
    await cdp.send('Input.imeSetComposition', {
      text: candidate,
      selectionStart: candidate.length,
      selectionEnd: candidate.length
    });
    await frame.waitForFunction(() => window.__atlasQ13CompositionEvents?.some(event => event.type === 'compositionupdate'), null, { timeout: 5_000 });
    await page.keyboard.press('Enter');
    const candidateInput = await input.inputValue();
    const events = await frame.evaluate(() => window.__atlasQ13CompositionEvents ?? []);
    assert.ok(events.some(event => event.type === 'compositionstart'),
      `Chromium must deliver an actual compositionstart event; observed ${JSON.stringify(events)}`);
    assert.ok(events.some(event => event.type === 'compositionupdate'),
      `Chromium must deliver an actual compositionupdate event; observed ${JSON.stringify(events)}`);
    const imeEnter = events.find(event => event.type === 'keydown' && event.key === 'Enter');
    assert.ok(imeEnter && (imeEnter.isComposing === true || imeEnter.keyCode === 229),
      `Enter during the Chromium composition must retain the IME state; observed ${JSON.stringify(events)}`);
    assert.equal(candidateInput, candidate, 'Chromium must commit the Japanese candidate into the focused input');
    assert.equal(await input.evaluate(element => document.activeElement === element), true,
      `Enter during Chromium composition must leave the board name input focused; observed ${JSON.stringify(events)}`);
    assert.equal(await title.innerText(), before, 'Enter during Chromium composition must not rename the Board');

    const committedName = '日本語入力済みのボード';
    await input.fill(committedName);
    await input.press('Enter');
    await atlas.locator('.atlas-board-tab-title').filter({ hasText: committedName }).waitFor({ state: 'visible' });
    assert.notEqual(await frame.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'ボード名',
      'ordinary Enter after the composition commits and moves focus');
    return { candidate, inputAfterCompositionEnter: candidateInput, observedCompositionEvents: events,
      finalTitle: committedName, compositionInputMethod: 'Chromium DevTools Input.imeSetComposition plus Playwright physical Enter' };
  } finally {
    await cdp.detach();
  }
}

async function atlasAppearance(frame) {
  return frame.evaluate(() => {
    const root = document.querySelector('.atlas-plugin');
    const style = root ? getComputedStyle(root) : null;
    return {
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      canvas: style?.getPropertyValue('--atlas-canvas').trim() ?? null,
      panel: style?.getPropertyValue('--atlas-panel').trim() ?? null,
      background: root ? getComputedStyle(root).backgroundColor : null,
      innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      pluginWidth: root?.getBoundingClientRect().width ?? null
    };
  });
}

async function verifyThemeAndResponsiveOperations({ page, panel, atlas, frame, iframeSrc }) {
  const desktopBefore = await atlasAppearance(frame);
  assert.equal(desktopBefore.prefersDark, false, 'the initial Host light scheme must reach Atlas');
  assert.ok(desktopBefore.documentWidth <= desktopBefore.documentClientWidth,
    `Desktop Atlas layout must fit its viewport: ${JSON.stringify(desktopBefore)}`);
  await createBoardByPointer(atlas);

  await page.getByRole('button', { name: 'ダーク表示', exact: true }).click();
  await page.locator('main[data-theme="dark"]').waitFor();
  try {
    await frame.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches, null, { timeout: 5_000 });
  } catch {
    const diagnostic = {
      hostTheme: await page.locator('main').getAttribute('data-theme'),
      iframeScheme: await panel.locator('iframe').evaluate(element => ({ inline: element.style.colorScheme, computed: getComputedStyle(element).colorScheme })),
      atlas: await atlasAppearance(frame)
    };
    throw new Error(`Atlas did not receive the Host dark color scheme: ${JSON.stringify(diagnostic)}`);
  }
  const dark = await atlasAppearance(frame);
  assert.equal(dark.prefersDark, true, 'Host dark mode must reach the embedded Atlas color scheme');
  assert.notEqual(dark.canvas, desktopBefore.canvas, 'Atlas canvas color must change with the Host theme');
  assert.equal(await panel.locator('iframe').getAttribute('src'), iframeSrc,
    'a theme switch must not reload the Plugin iframe or change its nonce');

  await page.getByRole('button', { name: 'ライト表示', exact: true }).click();
  await page.locator('main[data-theme="light"]').waitFor();
  try {
    await frame.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches, null, { timeout: 5_000 });
  } catch {
    const diagnostic = {
      hostTheme: await page.locator('main').getAttribute('data-theme'),
      iframeScheme: await panel.locator('iframe').evaluate(element => ({ inline: element.style.colorScheme, computed: getComputedStyle(element).colorScheme })),
      atlas: await atlasAppearance(frame)
    };
    throw new Error(`Atlas did not receive the Host light color scheme: ${JSON.stringify(diagnostic)}`);
  }
  const lightAgain = await atlasAppearance(frame);
  assert.equal(lightAgain.prefersDark, false, 'Host light mode must be restored inside Atlas');
  assert.equal(lightAgain.canvas, desktopBefore.canvas, 'Atlas light colors must return without iframe reload');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const mobileHost = await page.evaluate(() => ({
    innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth
  }));
  const mobileAtlasBefore = await atlasAppearance(frame);
  assert.equal(mobileHost.innerWidth, 390);
  assert.ok(mobileHost.documentWidth <= mobileHost.documentClientWidth,
    `Host must fit a 390px viewport: ${JSON.stringify(mobileHost)}`);
  await atlas.getByRole('button', { name: '＋ 手動ノード', exact: true }).click();
  const mobileNodeInput = atlas.getByLabel('手動ノード名', { exact: true });
  await mobileNodeInput.fill('390px 幅のノード');
  await mobileNodeInput.press('Enter');
  const mobileNode = atlas.locator('.react-flow__node.atlas-flow-manual').filter({ hasText: '390px 幅のノード' }).last();
  await mobileNode.waitFor({ state: 'visible' });
  const mobileNodeBounds = await mobileNode.boundingBox();
  assert.ok(mobileNodeBounds && mobileNodeBounds.width > 0 && mobileNodeBounds.height > 0,
    'a created Atlas Node must remain rendered at a 390px viewport');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(100);
  const desktopHost = await page.evaluate(() => ({
    innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth
  }));
  const desktopAtlasAfter = await atlasAppearance(frame);
  assert.ok(desktopHost.documentWidth <= desktopHost.documentClientWidth,
    `Host must fit a Desktop viewport: ${JSON.stringify(desktopHost)}`);
  assert.ok(desktopAtlasAfter.documentWidth <= desktopAtlasAfter.documentClientWidth,
    `Atlas must fit a Desktop viewport: ${JSON.stringify(desktopAtlasAfter)}`);
  await atlas.getByRole('button', { name: '元に戻す', exact: true }).click();
  await mobileNode.waitFor({ state: 'detached' });
  const redo = atlas.locator('.atlas-board-toolbar button').nth(1);
  try {
    await redo.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal((await redo.innerText()).trim(), 'やり直す', 'the second board toolbar action must remain the accessible Redo button');
    assert.equal(await redo.isEnabled(), true, 'Redo must become enabled immediately after Undo');
    await redo.click({ timeout: 5_000 });
  } catch (error) {
    const state = await atlas.locator('.atlas-board-toolbar button').evaluateAll(buttons => buttons.map(button => ({
      text: button.textContent?.trim(), disabled: button.disabled, visible: Boolean(button.getClientRects().length)
    })));
    throw new Error(`Redo was unavailable after Undo: toolbar=${JSON.stringify(state)}; cause=${error instanceof Error ? error.message : String(error)}`);
  }
  await mobileNode.waitFor({ state: 'visible' });
  return {
    iframeReloaded: false,
    light: desktopBefore,
    dark,
    restoredLight: lightAgain,
    mobileHost,
    mobileAtlasBefore,
    mobileNodeBounds,
    desktopHost,
    desktopAtlasAfter,
    undoRedoAtDesktop: true
  };
}

export async function runImeEntryCases({ browser, baseUrl, profile, record }) {
  await record(CASES.syntheticIme, async () => {
    const session = await openAtlasWorkspace({ browser, baseUrl, profile, label: 'Atlas synthetic IME' });
    try {
      await createBoardByPointer(session.atlas);
      return { profile, locale: 'ja-JP', ...(await verifySyntheticIme(session.atlas, session.frame)) };
    } finally {
      await session.context.close();
    }
  });

  await record(CASES.chromiumIme, async () => {
    const session = await openAtlasWorkspace({ browser, baseUrl, profile, label: 'Atlas Chromium IME' });
    try {
      await createBoardByPointer(session.atlas);
      return { profile, ...(await verifyChromiumComposition(session)) };
    } finally {
      await session.context.close();
    }
  });

  await record(CASES.keyboard, async () => {
    const session = await openAtlasWorkspace({ browser, baseUrl, profile, label: 'Atlas keyboard only' });
    try {
      await installPointerCounter(session.page.mainFrame());
      await installPointerCounter(session.frame);
      const actions = await createBoardByKeyboard(session.page, session.frame);
      const pointerDowns = {
        host: await pointerCount(session.page.mainFrame()),
        atlas: await pointerCount(session.frame)
      };
      assert.deepEqual(pointerDowns, { host: 0, atlas: 0 },
        'Atlas Board creation, rename, Node creation, Undo, and Redo must work without pointer input');
      return { profile, actions, pointerDowns };
    } finally {
      await session.context.close();
    }
  });

  await record(CASES.appearance, async () => {
    const session = await openAtlasWorkspace({ browser, baseUrl, profile, label: 'Atlas theme responsive' });
    try {
      return { profile, ...(await verifyThemeAndResponsiveOperations(session)) };
    } finally {
      await session.context.close();
    }
  });
}
