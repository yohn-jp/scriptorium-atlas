import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const storageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hostRoot = process.env.ATLAS_HOST_ROOT && resolve(process.env.ATLAS_HOST_ROOT);
if (!hostRoot) throw new Error('Set ATLAS_HOST_ROOT to a Host checkout containing dist/story and apps/standalone/scripts/serve.mjs.');
const { chromium } = await import(pathToFileURL(resolve(hostRoot, 'node_modules/@playwright/test/index.mjs')).href);
const profileRoot = resolve(hostRoot, 'dist/story');
const sourcePath = 'notes/q05-storage.md';
const sourceOne = '# Q05 source\n\nCommitted source before fault injection.\n';
const sourceTwo = '# Q05 source\n\nPrepared replacement survives transaction abort.\n';
const winnerText = '# Q05 race\n\nFirst tab wins the CAS.\n';
const loserText = '# Q05 race\n\nSecond tab remains a recoverable draft.\n';

async function treeDigest(directory) {
  const paths = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) paths.push(full);
    }
  }
  await visit(directory);
  paths.sort((a, b) => relative(directory, a).localeCompare(relative(directory, b)));
  const digest = createHash('sha256');
  let bytes = 0;
  for (const path of paths) {
    const name = relative(directory, path).split(sep).join('/');
    const body = await readFile(path);
    bytes += body.byteLength;
    digest.update(`${name}\0${body.byteLength}\0`);
    digest.update(body);
    digest.update('\0');
  }
  return { sha256: digest.digest('hex'), files: paths.length, bytes };
}

async function reservePorts() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = 36000 + Math.floor(Math.random() * 24000);
    const reservations = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = createServer();
        await new Promise((resolveListen, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolveListen);
        });
        reservations.push(server);
      }
      await Promise.all(reservations.map(server => new Promise(resolveClose => server.close(resolveClose))));
      return base;
    } catch {
      await Promise.all(reservations.map(server => new Promise(resolveClose => server.close(resolveClose))));
    }
  }
  throw new Error('Could not reserve three loopback ports for the production Host server.');
}

function startServer(port) {
  return spawn(process.execPath, [resolve(hostRoot, 'apps/standalone/scripts/serve.mjs'), 'story'], {
    cwd: hostRoot,
    env: { ...process.env, ATLAS_HOST_PORT: String(port) },
    stdio: 'ignore'
  });
}

async function waitForServer(child, url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      const ready = response.ok;
      await response.body?.cancel();
      if (ready) return true;
    } catch {
      // Wait for the three static production servers to bind.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return false;
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function openHost(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Scriptorium Atlas' }).waitFor();
  await page.getByLabel('Workspace名').waitFor();
}

async function createWorkspace(page, name) {
  await page.getByLabel('Workspace名').fill(name);
  await page.getByRole('button', { name: '空のWorkspaceを作成' }).click();
  await page.getByRole('status').filter({ hasText: 'Workspaceを開きました。' }).waitFor();
  return page.getByLabel('開く').inputValue();
}

async function selectWorkspace(page, workspaceId) {
  await page.waitForFunction(id => {
    const select = document.querySelector('section[aria-label="Workspace"] select');
    return select && [...select.options].some(option => option.value === id);
  }, workspaceId);
  await page.getByLabel('開く').selectOption(workspaceId);
  await page.waitForFunction(id => document.querySelector('section[aria-label="Workspace"] select')?.value === id, workspaceId);
  await page.getByRole('status').filter({ hasText: /(?:Workspaceを開きました。|復旧したJournal操作: \d+件。|COMMIT_UNKNOWN:)/ }).waitFor();
}

async function openSourcePanel(page) {
  const summary = page.getByText('Workspaceのファイル・Source', { exact: true });
  if (!(await summary.evaluate(node => node.parentElement?.hasAttribute('open')))) await summary.click();
}

async function prepareSource(page, path, content) {
  await openSourcePanel(page);
  await page.getByLabel('相対Path').fill(path);
  await page.getByLabel('Source').fill(content);
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.getByText(content, { exact: true }).waitFor();
  return proposal;
}

async function selectSource(page, path) {
  await openSourcePanel(page);
  await page.getByRole('button', { name: path, exact: true }).click();
}

async function approve(page, proposal) {
  await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
  await page.getByRole('status').filter({ hasText: 'ローカルCommit完了:' }).waitFor();
}

async function inspectDatabase(page, workspaceId) {
  return page.evaluate(async id => {
    const database = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open('scriptorium-atlas-v1');
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    try {
      return await new Promise((resolveRead, rejectRead) => {
        const transaction = database.transaction(['workspaces', 'files', 'journal', 'receipts'], 'readonly');
        const workspaceRequest = transaction.objectStore('workspaces').get(id);
        const filesRequest = transaction.objectStore('files').index('byWorkspace').getAll(id);
        const journalRequest = transaction.objectStore('journal').getAll();
        const receiptsRequest = transaction.objectStore('receipts').getAll();
        transaction.oncomplete = () => {
          resolveRead({
            workspace: workspaceRequest.result && { sourceRevision: workspaceRequest.result.sourceRevision },
            files: filesRequest.result.filter(file => file.workspaceId === id).map(file => ({
              path: file.path,
              revision: file.revision,
              content: new TextDecoder().decode(new Uint8Array(file.bytes))
            })),
            journal: journalRequest.result.filter(row => row.workspaceId === id).map(row => ({
              operationId: row.operationId,
              preparedId: row.preparedId,
              state: row.state
            })),
            receipts: receiptsRequest.result.filter(row => row.workspaceId === id).map(row => ({
              operationId: row.operationId,
              sourceRevision: row.sourceRevision,
              files: row.files
            }))
          });
        };
        transaction.onerror = () => rejectRead(transaction.error);
        transaction.onabort = () => rejectRead(transaction.error ?? new DOMException('Inspection transaction aborted.', 'AbortError'));
      });
    } finally {
      database.close();
    }
  }, workspaceId);
}

async function casRace(browser, baseUrl) {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
  try {
    const firstTab = await context.newPage();
    await openHost(firstTab, baseUrl);
    const workspaceId = await createWorkspace(firstTab, 'Q05 two-tab CAS race');
    const secondTab = await context.newPage();
    await openHost(secondTab, baseUrl);
    await selectWorkspace(secondTab, workspaceId);

    const winner = await prepareSource(firstTab, sourcePath, winnerText);
    const loser = await prepareSource(secondTab, sourcePath, loserText);
    const before = await inspectDatabase(firstTab, workspaceId);
    assert.equal(before.files.length, 0);
    assert.equal(before.journal.filter(row => row.state === 'prepared').length, 2);

    await approve(firstTab, winner);
    await loser.getByRole('button', { name: 'この変更を承認してCommit' }).click();
    const conflict = secondTab.getByRole('alert');
    await conflict.waitFor();
    assert.match(await conflict.innerText(), /Workspace changed after proposal review\./);

    await secondTab.reload({ waitUntil: 'domcontentloaded' });
    await openHost(secondTab, baseUrl);
    await selectWorkspace(secondTab, workspaceId);
    await secondTab.getByRole('status').filter({ hasText: '復旧したJournal操作: 1件' }).waitFor();
    await selectSource(secondTab, sourcePath);
    assert.equal(await secondTab.getByLabel('Source').inputValue(), winnerText);
    const recovered = secondTab.locator('section[aria-label="変更の承認"] article').last();
    assert.equal(await recovered.locator('details pre').nth(1).innerText(), loserText);
    const after = await inspectDatabase(secondTab, workspaceId);
    assert.equal(after.files.find(file => file.path === sourcePath)?.content, winnerText);
    assert.equal(after.journal.filter(row => row.state === 'prepared').length, 1);
    assert.equal(after.receipts.length, 1);
    return { workspaceId, twoTabsSameHostOrigin: new URL(firstTab.url()).origin === new URL(secondTab.url()).origin, staleCommitRejected: true, winningFilePreserved: true, losingDraftRecovered: true };
  } finally {
    await context.close();
  }
}

async function explicitAbort(browser, baseUrl) {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
  try {
    let page = await context.newPage();
    await openHost(page, baseUrl);
    const workspaceId = await createWorkspace(page, 'Q05 explicit IDB transaction abort');
    await approve(page, await prepareSource(page, sourcePath, sourceOne));
    await selectSource(page, sourcePath);
    const proposal = await prepareSource(page, sourcePath, sourceTwo);
    const prepared = await inspectDatabase(page, workspaceId);
    const operationId = prepared.journal.find(row => row.state === 'prepared')?.operationId;
    assert.ok(operationId);

    await page.evaluate(() => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'files' && this.transaction.mode === 'readwrite' && this.transaction.objectStoreNames.contains('receipts')) {
          window.__q05ExplicitAbortTriggered = true;
          this.transaction.abort();
          throw new DOMException('Injected explicit Q05 transaction abort.', 'AbortError');
        }
        return originalPut.apply(this, args);
      };
    });
    await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
    const failure = page.getByRole('alert').filter({ hasText: 'Commit outcome could not be confirmed' });
    await failure.waitFor();
    assert.match(await failure.innerText(), /Commit outcome could not be confirmed/);
    assert.equal(await page.evaluate(() => window.__q05ExplicitAbortTriggered), true);

    const aborted = await inspectDatabase(page, workspaceId);
    assert.equal(aborted.files.find(file => file.path === sourcePath)?.content, sourceOne);
    assert.equal(aborted.journal.find(row => row.operationId === operationId)?.state, 'prepared');
    assert.equal(aborted.receipts.some(row => row.operationId === operationId), false);

    await page.close();
    page = await context.newPage();
    await openHost(page, baseUrl);
    await selectWorkspace(page, workspaceId);
    await page.getByRole('status').filter({ hasText: '復旧したJournal操作: 1件' }).waitFor();
    await selectSource(page, sourcePath);
    assert.equal(await page.getByLabel('Source').inputValue(), sourceOne);
    const recovered = page.locator('section[aria-label="変更の承認"] article').last();
    assert.equal(await recovered.locator('details pre').nth(1).innerText(), sourceTwo);
    await approve(page, recovered);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openHost(page, baseUrl);
    await selectWorkspace(page, workspaceId);
    await selectSource(page, sourcePath);
    assert.equal(await page.getByLabel('Source').inputValue(), sourceTwo);
    const committed = await inspectDatabase(page, workspaceId);
    assert.ok(committed.receipts.some(row => row.operationId === operationId));
    return { workspaceId, operationId, actualTransactionAbort: true, priorBytesPreserved: true, preparedDraftRecovered: true, sameOperationCommittedAfterRecovery: true };
  } finally {
    await context.close();
  }
}

async function unknownReceiptRecovery(browser, baseUrl) {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
  try {
    let page = await context.newPage();
    await openHost(page, baseUrl);
    const workspaceId = await createWorkspace(page, 'Q05 COMMIT_UNKNOWN receipt recovery');
    const proposal = await prepareSource(page, sourcePath, sourceOne);
    const prepared = await inspectDatabase(page, workspaceId);
    const operationId = prepared.journal.find(row => row.state === 'prepared')?.operationId;
    assert.ok(operationId);

    await page.evaluate(() => {
      const originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = originalTransaction.apply(this, args);
        const names = Array.from(transaction.objectStoreNames);
        if (args[1] === 'readwrite' && names.length === 1 && names[0] === 'journal') {
          transaction.addEventListener('complete', event => {
            if (window.__q05LostCommitResponse) return;
            window.__q05LostCommitResponse = true;
            event.stopImmediatePropagation();
          }, { once: true });
        }
        return transaction;
      };
    });
    await proposal.getByRole('button', { name: 'この変更を承認してCommit' }).click();
    await page.waitForFunction(() => window.__q05LostCommitResponse === true);
    const interrupted = await inspectDatabase(page, workspaceId);
    assert.equal(interrupted.files.length, 0);
    assert.equal(interrupted.journal.find(row => row.operationId === operationId)?.state, 'committing');
    assert.equal(interrupted.receipts.some(row => row.operationId === operationId), false);

    await page.close();
    page = await context.newPage();
    await openHost(page, baseUrl);
    await selectWorkspace(page, workspaceId);
    const unknown = page.getByRole('status').filter({ hasText: 'COMMIT_UNKNOWN:' });
    await unknown.waitFor();
    assert.ok((await unknown.innerText()).includes(operationId));
    const recovered = page.locator('section[aria-label="変更の承認"] article').last();
    await recovered.getByText(sourceOne, { exact: true }).waitFor();
    await approve(page, recovered);

    const receiptState = await inspectDatabase(page, workspaceId);
    assert.equal(receiptState.journal.find(row => row.operationId === operationId)?.state, 'committed');
    assert.ok(receiptState.receipts.some(row => row.operationId === operationId));
    assert.equal(receiptState.files.find(file => file.path === sourcePath)?.content, sourceOne);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openHost(page, baseUrl);
    await selectWorkspace(page, workspaceId);
    assert.equal(await page.getByRole('status').filter({ hasText: 'COMMIT_UNKNOWN:' }).count(), 0);
    await selectSource(page, sourcePath);
    assert.equal(await page.getByLabel('Source').inputValue(), sourceOne);
    return { workspaceId, operationId, unresolvedOperationShown: true, sameOperationReceiptRecovered: true, exactSourcePreservedAfterReload: true };
  } finally {
    await context.close();
  }
}

if (!(await stat(profileRoot).catch(() => undefined))?.isDirectory()) throw new Error(`Production Host profile is missing: ${profileRoot}`);
const artifact = await treeDigest(profileRoot);
const report = {
  schemaVersion: 'atlas.persistence.q05-browser-evidence/v1',
  purpose: 'Real Chromium and Host-origin IndexedDB acceptance for Q05 multi-tab CAS, explicit transaction abort, and COMMIT_UNKNOWN receipt recovery.',
  status: 'NOT_CHECKED',
  environment: { node: process.version, platform: os.platform(), release: os.release(), architecture: os.arch(), browser: null },
  host: { head: execFileSync('git', ['-C', hostRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), profile: 'story', artifact },
  persistenceHead: execFileSync('git', ['-C', storageRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  exactCli: process.env.ATLAS_Q05_EXACT_CLI ?? process.argv.join(' '),
  cases: []
};

let browser;
let server;
let baseUrl;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.ATLAS_E2E_CHROMIUM ? { executablePath: process.env.ATLAS_E2E_CHROMIUM } : {}) });
  report.environment.browser = { name: 'Chromium', version: browser.version(), executablePath: process.env.ATLAS_E2E_CHROMIUM ?? 'Playwright bundled Chromium' };
  const port = await reservePorts();
  baseUrl = `http://127.0.0.1:${port}`;
  server = startServer(port);
  if (!(await waitForServer(server, baseUrl))) throw new Error('Production story Host did not become ready within 15 seconds.');
  for (const [id, run] of [
    ['Q05-two-tab-cas-race-preserves-winner-and-recoverable-loser', casRace],
    ['Q05-explicit-idb-write-transaction-abort-preserves-source-and-recovers-draft', explicitAbort],
    ['Q05-commit-unknown-reload-recovery-resolves-same-operation-receipt', unknownReceiptRecovery]
  ]) {
    try {
      const evidence = await run(browser, baseUrl);
      report.cases.push({ id, status: 'PASS', evidence });
      process.stderr.write(`[Persistence Q05 Browser] ${id}: PASS\n`);
    } catch (error) {
      report.cases.push({ id, status: 'FAIL', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      process.stderr.write(`[Persistence Q05 Browser] ${id}: FAIL\n`);
    }
  }
} catch (error) {
  report.cases.push({ id: 'q05-browser-harness', status: 'FAIL', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
} finally {
  await browser?.close();
  if (server) await stopServer(server);
}

report.status = report.cases.length === 3 && report.cases.every(test => test.status === 'PASS') ? 'PASS' : 'FAIL';
report.exitStatus = report.status === 'PASS' ? 0 : 1;
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.ATLAS_Q05_REPORT) await writeFile(resolve(process.env.ATLAS_Q05_REPORT), serialized, 'utf8');
process.stdout.write(serialized);
process.exitCode = report.exitStatus;
