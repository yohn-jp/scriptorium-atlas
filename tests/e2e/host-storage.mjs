import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SOURCE_PATH = 'notes/scene.md';
const SOURCE_V1 = '# Scene\n\n保存した本文です。\n';
const SOURCE_V2 = '# Scene\n\n復旧後にCommitした本文です。\n';

async function newContext(browser) {
  return browser.newContext({
    acceptDownloads: true,
    locale: 'ja-JP',
    viewport: { width: 1440, height: 1000 }
  });
}

async function openHost(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Scriptorium Atlas' }).waitFor();
  await page.getByLabel('Workspace名').waitFor();
}

async function createEmptyWorkspace(page, name) {
  await page.getByLabel('Workspace名').fill(name);
  await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();
  const workspaceId = await page.getByLabel('開く').inputValue();
  assert.match(workspaceId, /^ws-/);
  return workspaceId;
}

async function openSourcePanel(page) {
  const summary = page.getByText('Workspaceのファイル・Source', { exact: true });
  const isOpen = await summary.evaluate(node => node.parentElement?.hasAttribute('open'));
  if (!isOpen) await summary.click();
}

async function fillSource(page, path, content) {
  await openSourcePanel(page);
  const pathInput = page.getByLabel('相対Path');
  if (await pathInput.inputValue() !== path) await pathInput.fill(path);
  await page.getByLabel('Source').fill(content);
}

async function prepareSource(page, path, content) {
  await fillSource(page, path, content);
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  const article = page.locator('section[aria-label="変更の承認"] article').last();
  await article.waitFor();
  await article.getByText(content, { exact: true }).waitFor();
  return article;
}

async function approveSource(page, article) {
  await article.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).waitFor();
}

async function reopenWorkspace(page, workspaceId) {
  await page.getByLabel('開く').selectOption(workspaceId);
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();
}

async function selectSource(page, path) {
  await openSourcePanel(page);
  await page.getByRole('button', { name: path, exact: true }).click();
}

async function revisionText(page, path) {
  await openSourcePanel(page);
  return page.locator('li').filter({ has: page.getByRole('button', { name: path, exact: true }) }).locator('span').innerText();
}

export async function runHostStorageCases({ browser, baseUrl, profile, record }) {
  await record('Q02-empty-workspace-create-edit-reload', async () => {
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      await openHost(page, baseUrl);
      const workspaceId = await createEmptyWorkspace(page, `Q02 ${profile} empty workspace`);
      await openSourcePanel(page);
      assert.equal(await page.locator('details').filter({ hasText: 'Workspaceのファイル・Source' }).locator('li').count(), 0,
        'a newly created Workspace must not acquire a demo file');

      const proposal = await prepareSource(page, SOURCE_PATH, SOURCE_V1);
      await approveSource(page, proposal);
      const initialRevision = await revisionText(page, SOURCE_PATH);
      assert.match(initialRevision, /revision [a-f0-9]{12}/);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel('開く').waitFor();
      await reopenWorkspace(page, workspaceId);
      await selectSource(page, SOURCE_PATH);
      assert.equal(await page.getByLabel('Source').inputValue(), SOURCE_V1);
      assert.equal(await revisionText(page, SOURCE_PATH), initialRevision);
      return { workspaceId, path: SOURCE_PATH, revision: initialRevision, bytes: Buffer.byteLength(SOURCE_V1) };
    } finally {
      await context.close();
    }
  });

  await record('Q03-bundle-export-import-roundtrip-and-invalid-import-preserves-workspace', async () => {
    const sourceContext = await newContext(browser);
    let bundle;
    let revision;
    try {
      const page = await sourceContext.newPage();
      await openHost(page, baseUrl);
      await createEmptyWorkspace(page, `Q03 export ${profile}`);
      const proposal = await prepareSource(page, SOURCE_PATH, SOURCE_V1);
      await approveSource(page, proposal);
      revision = await revisionText(page, SOURCE_PATH);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Bundleをexport' }).click()
      ]);
      const downloadedPath = await download.path();
      assert.ok(downloadedPath, 'browser download must produce an artifact');
      bundle = await readFile(downloadedPath);
      assert.ok(bundle.byteLength > 0 && bundle.byteLength <= 256 * 1024 * 1024,
        'compressed ZIP artifact must fit the independent 256 MiB archive budget');
    } finally {
      await sourceContext.close();
    }

    const importContext = await newContext(browser);
    try {
      const page = await importContext.newPage();
      await openHost(page, baseUrl);
      const workspaceId = await createEmptyWorkspace(page, `Q03 existing ${profile}`);
      const baseline = await prepareSource(page, 'notes/preserve.md', '既存Workspaceを保持します。\n');
      await approveSource(page, baseline);

      await page.getByLabel('Bundleをimport').setInputFiles({
        name: 'atlas-workspace.zip',
        mimeType: 'application/zip',
        buffer: bundle
      });
      await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();
      await selectSource(page, SOURCE_PATH);
      assert.equal(await page.getByLabel('Source').inputValue(), SOURCE_V1);
      assert.equal(await revisionText(page, SOURCE_PATH), revision,
        'the source SHA-256 revision must survive the ZIP export/import roundtrip');

      await page.getByLabel('Bundleをimport').setInputFiles({
        name: 'invalid.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('not a ZIP archive')
      });
      await page.getByRole('alert').waitFor();
      await selectSource(page, SOURCE_PATH);
      assert.equal(await page.getByLabel('Source').inputValue(), SOURCE_V1,
        'a rejected import must leave the imported Workspace readable');
      await reopenWorkspace(page, workspaceId);
      await selectSource(page, 'notes/preserve.md');
      assert.equal(await page.getByLabel('Source').inputValue(), '既存Workspaceを保持します。\n',
        'a rejected import must preserve a pre-existing Workspace');

      return {
        archiveBytes: bundle.byteLength,
        archiveSha256: createHash('sha256').update(bundle).digest('hex'),
        sourceRevision: revision,
        invalidImportPreservedWorkspace: true
      };
    } finally {
      await importContext.close();
    }
  });

  await record('Q05-pending-draft-recovers-after-forced-page-reload', async () => {
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      await openHost(page, baseUrl);
      const workspaceId = await createEmptyWorkspace(page, `Q05 recovery ${profile}`);
      const proposal = await prepareSource(page, SOURCE_PATH, SOURCE_V1);
      assert.ok(await proposal.isVisible());
      assert.equal(await proposal.locator('details pre').nth(1).innerText(), SOURCE_V1);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel('開く').waitFor();
      await reopenWorkspace(page, workspaceId);
      await page.getByRole('status').filter({ hasText: '復旧した承認待ちDraft: 1件' }).waitFor();
      const recovered = page.locator('section[aria-label="変更の承認"] article').last();
      assert.equal(await recovered.locator('details pre').nth(1).innerText(), SOURCE_V1,
        'the durable prepared journal must restore the exact proposed UTF-8 content');
      await approveSource(page, recovered);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel('開く').waitFor();
      await reopenWorkspace(page, workspaceId);
      await selectSource(page, SOURCE_PATH);
      assert.equal(await page.getByLabel('Source').inputValue(), SOURCE_V1);
      return { workspaceId, recoveredDraftBytes: Buffer.byteLength(SOURCE_V1), committedAfterRecovery: true };
    } finally {
      await context.close();
    }
  });

  await record('Q01-profile-plugin-presence-and-host-origin-storage-isolation', async () => {
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      await openHost(page, baseUrl);
      await createEmptyWorkspace(page, `Q01 profile ${profile}`);

      const expected = {
        atlas: { atlas: true, story: false },
        story: { atlas: false, story: true },
        combined: { atlas: true, story: true }
      }[profile];
      for (const [plugin, present] of Object.entries(expected)) {
        const title = plugin === 'atlas' ? 'Atlas Plugin' : 'Story Knowledge Plugin';
        const panel = page.locator(`section[aria-label="${title}"]`);
        assert.equal(await panel.count(), present ? 1 : 0, `${profile} profile ${plugin} panel presence`);
        if (!present) continue;

        await panel.getByText('接続中', { exact: true }).waitFor();
        const iframe = panel.locator('iframe');
        const src = await iframe.getAttribute('src');
        assert.ok(src);
        const pluginOrigin = new URL(src, baseUrl).origin;
        assert.notEqual(pluginOrigin, new URL(baseUrl).origin, 'Plugin UI must run on a distinct origin');
        const pluginFrame = page.frames().find(frame => frame.url().startsWith(pluginOrigin));
        assert.ok(pluginFrame, `${plugin} frame must have loaded from ${pluginOrigin}`);
        await pluginFrame.waitForLoadState('domcontentloaded');
        const isolation = await pluginFrame.evaluate(async () => {
          let parentIndexedDb = 'readable';
          try { void window.parent.indexedDB; } catch (error) { parentIndexedDb = error instanceof Error ? error.name : String(error); }
          let databases = [];
          if (typeof indexedDB.databases === 'function') databases = (await indexedDB.databases()).flatMap(database => database.name ? [database.name] : []);
          return { parentIndexedDb, databases };
        });
        assert.equal(isolation.parentIndexedDb, 'SecurityError', 'a Plugin must not access the Host frame IndexedDB object');
        assert.ok(!isolation.databases.includes('scriptorium-atlas-v1'), 'Host database must not exist in the Plugin origin');
      }

      const hostDatabases = await page.evaluate(async () => {
        if (typeof indexedDB.databases !== 'function') return null;
        return (await indexedDB.databases()).flatMap(database => database.name ? [database.name] : []);
      });
      assert.ok(hostDatabases?.includes('scriptorium-atlas-v1'), 'Workspace IndexedDB must be owned by the Host origin');
      return { profile, expectedPanels: expected, hostDatabases };
    } finally {
      await context.close();
    }
  });

  await record('Q05-indexeddb-denial-fails-closed', async () => {
    const context = await newContext(browser);
    try {
      await context.addInitScript(() => {
        IDBFactory.prototype.open = function () {
          throw new DOMException('Injected E2E storage denial', 'SecurityError');
        };
      });
      const page = await context.newPage();
      await openHost(page, baseUrl);
      await page.getByRole('alert').filter({ hasText: '保存領域を開けません' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '空のWorkspaceを作成' }).isDisabled(), true,
        'Workspace creation must remain unavailable when IndexedDB cannot open');
      return { failure: 'IndexedDB SecurityError', creationDisabled: true };
    } finally {
      await context.close();
    }
  });

  await record('Q05-quota-aborted-commit-preserves-source-and-recoverable-draft', async () => {
    const context = await newContext(browser);
    try {
      const page = await context.newPage();
      await openHost(page, baseUrl);
      const workspaceId = await createEmptyWorkspace(page, `Q05 quota ${profile}`);
      let proposal = await prepareSource(page, SOURCE_PATH, SOURCE_V1);
      await approveSource(page, proposal);

      await selectSource(page, SOURCE_PATH);
      proposal = await prepareSource(page, SOURCE_PATH, SOURCE_V2);
      await page.evaluate(() => {
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'files' && this.transaction.mode === 'readwrite') {
            throw new DOMException('Injected E2E storage quota', 'QuotaExceededError');
          }
          return originalPut.apply(this, args);
        };
      });
      await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
      await page.getByRole('alert').filter({ hasText: 'Browser storage quota was exceeded.' }).waitFor();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel('開く').waitFor();
      await reopenWorkspace(page, workspaceId);
      await page.getByRole('status').filter({ hasText: '復旧した承認待ちDraft: 1件' }).waitFor();
      await selectSource(page, SOURCE_PATH);
      assert.equal(await page.getByLabel('Source').inputValue(), SOURCE_V1,
        'the atomic failure must preserve the previously committed source');
      const recovered = page.locator('section[aria-label="変更の承認"] article').last();
      assert.equal(await recovered.locator('details pre').nth(1).innerText(), SOURCE_V2,
        'the rejected commit must retain its prepared proposal for recovery');
      await approveSource(page, recovered);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByLabel('開く').waitFor();
      await reopenWorkspace(page, workspaceId);
      await selectSource(page, SOURCE_PATH);
      assert.equal(await page.getByLabel('Source').inputValue(), SOURCE_V2);
      return {
        workspaceId,
        failedCommit: 'QUOTA_EXCEEDED',
        oldSourcePreservedUntilRetry: true,
        preparedDraftRecoveredAndCommitted: true
      };
    } finally {
      await context.close();
    }
  });
}
