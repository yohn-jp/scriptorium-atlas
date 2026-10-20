import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const storagePackage = resolve(fileURLToPath(new URL('..', import.meta.url)));
const storageRoot = resolve(storagePackage, '../..');
const hostRoot = process.env.ATLAS_HOST_ROOT && resolve(process.env.ATLAS_HOST_ROOT);
const executablePath = process.env.ATLAS_E2E_CHROMIUM && resolve(process.env.ATLAS_E2E_CHROMIUM);
const baseUrl = process.env.ATLAS_Q05_BASE_URL ?? 'http://127.0.0.1:44990';
const profile = process.env.ATLAS_Q05_PROFILE;
if (!hostRoot) throw new Error('Set ATLAS_HOST_ROOT to the Host checkout that built the running production UI.');
if (!executablePath) throw new Error('Set ATLAS_E2E_CHROMIUM to the Chromium executable to launch.');
if (!isAbsolute(executablePath)) throw new Error('ATLAS_E2E_CHROMIUM must resolve to an absolute executable path.');
if (!['atlas', 'story', 'combined'].includes(profile)) throw new Error('Set ATLAS_Q05_PROFILE to atlas, story, or combined.');
const base = new URL(baseUrl);
if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('ATLAS_Q05_BASE_URL must be an HTTP(S) origin without a path, query, or fragment.');
}
const profileRoot = resolve(hostRoot, 'dist', profile);
if (!(await stat(resolve(profileRoot, 'index.html')).catch(() => undefined))?.isFile()) {
  throw new Error(`Production ${profile} Host build is missing under ${profileRoot}.`);
}
const artifact = await validateServedProfile(profileRoot, base.origin);
const { chromium } = await import(pathToFileURL(resolve(hostRoot, 'node_modules/@playwright/test/index.mjs')).href);

const sourcePath = 'notes/q05-process-crash.md';
const baselineText = '# Crash recovery fixture\n\nDurable baseline before the browser process crash.\n';
const draftText = '# Crash recovery fixture\n\nPrepared draft restored after the browser process crash.\n';
const expectedOrigin = base.origin;

function within(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function validateServedProfile(directory, origin) {
  const paths = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) paths.push(full);
    }
  }
  await visit(directory);
  const indexBytes = await readFile(resolve(directory, 'index.html'));
  const rootResponse = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(rootResponse.status, 200, `Host did not serve the ${profile} profile index at its root URL.`);
  assert.ok(Buffer.from(await rootResponse.arrayBuffer()).equals(indexBytes), `Host root URL does not match the ${profile} index.html artifact.`);
  const basePort = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
  const pluginPort = basePort + (profile === 'story' ? 2 : 1);
  if (pluginPort > 65_535) throw new Error('ATLAS_Q05_BASE_URL leaves no port for the selected plugin profile.');
  const pluginOrigin = `${base.protocol}//${base.hostname}:${pluginPort}`;
  paths.sort((left, right) => {
    const leftName = relative(directory, left).split(sep).join('/');
    const rightName = relative(directory, right).split(sep).join('/');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  const digest = createHash('sha256');
  let bytes = 0;
  for (const path of paths) {
    const relativePath = relative(directory, path).split(sep).join('/');
    const expected = await readFile(path);
    const urlPath = relativePath.split('/').map(encodeURIComponent).join('/');
    const artifactOrigin = relativePath === 'frame.html' ? pluginOrigin : origin;
    const response = await fetch(new URL(urlPath, `${artifactOrigin}/`), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `Host did not serve the expected ${relativePath} from ${profile} profile.`);
    const served = Buffer.from(await response.arrayBuffer());
    assert.ok(served.equals(expected), `Served ${relativePath} does not match the ${profile} build artifact.`);
    bytes += expected.byteLength;
    digest.update(`${relativePath}\0${expected.byteLength}\0`);
    digest.update(expected);
    digest.update('\0');
  }
  assert.ok(paths.some(path => relative(directory, path).split(sep).join('/') === 'index.html'));
  return { sha256: digest.digest('hex'), files: paths.length, bytes };
}

async function makeProfile() {
  const tempRoot = await realpath(process.env.ATLAS_Q05_TMPDIR ?? os.tmpdir());
  if (within(storageRoot, tempRoot) || within(hostRoot, tempRoot)) {
    throw new Error('Temporary Chromium profile directory must be outside both repositories.');
  }
  return mkdtemp(resolve(tempRoot, 'atlas-q05-owned-chromium-'));
}

function launchOwnedChromium(profileDir) {
  const child = spawn(executablePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=ja-JP',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: 'ignore' });
  child.on('error', () => {});
  return child;
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      rejectExit(new Error(`Owned Chromium PID ${child.pid} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function connectOwnedChromium(child, profileDir) {
  const activePortPath = resolve(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  let port;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Owned Chromium exited before CDP startup (code=${child.exitCode}, signal=${child.signalCode}).`);
    }
    try {
      const [portText] = (await readFile(activePortPath, 'utf8')).split('\n');
      const parsedPort = Number(portText);
      if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
        port = parsedPort;
        break;
      }
    } catch {
      // Chromium creates DevToolsActivePort after the browser process starts.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  if (!port) throw new Error('Owned Chromium did not publish DevToolsActivePort within 20 seconds.');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  return browser;
}

async function stopOwnedBrowser(browser, child) {
  if (browser) await browser.close().catch(() => {});
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 5000);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child).catch(() => {});
  }
}

async function openHost(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(page.url()).origin, expectedOrigin);
  await page.getByRole('heading', { name: 'Scriptorium Atlas' }).waitFor();
  await page.getByLabel('Workspace名').waitFor();
}

async function createWorkspace(page) {
  await page.getByLabel('Workspace名').fill('Q05 owned Chromium process crash');
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

async function prepareSource(page, content) {
  await openSourcePanel(page);
  await page.getByLabel('相対Path').fill(sourcePath);
  await page.getByRole('textbox', { name: 'Source' }).fill(content);
  await page.getByRole('button', { name: '変更案を耐久記録して確認' }).click();
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.getByText(content, { exact: true }).waitFor();
  return proposal;
}

async function selectSource(page) {
  await openSourcePanel(page);
  await page.getByRole('button', { name: sourcePath, exact: true }).click();
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
        transaction.oncomplete = () => resolveRead({
          workspace: workspaceRequest.result && { sourceRevision: workspaceRequest.result.sourceRevision },
          files: filesRequest.result.filter(file => file.workspaceId === id).map(file => ({
            path: file.path,
            revision: file.revision,
            content: new TextDecoder().decode(new Uint8Array(file.bytes))
          })),
          journal: journalRequest.result.filter(row => row.workspaceId === id).map(row => ({
            operationId: row.operationId,
            preparedId: row.preparedId,
            state: row.state,
            prepared: row.prepared,
            writes: row.writes?.map(write => ({
              path: write.path,
              content: write.bytes ? new TextDecoder().decode(new Uint8Array(write.bytes)) : null,
              beforeContent: write.beforeBytes ? new TextDecoder().decode(new Uint8Array(write.beforeBytes)) : null
            }))
          })),
          receipts: receiptsRequest.result.filter(row => row.workspaceId === id).map(row => ({
            operationId: row.operationId,
            sourceRevision: row.sourceRevision
          }))
        });
        transaction.onerror = () => rejectRead(transaction.error);
        transaction.onabort = () => rejectRead(transaction.error ?? new DOMException('Inspection transaction aborted.', 'AbortError'));
      });
    } finally {
      database.close();
    }
  }, workspaceId);
}

async function pageFor(browser) {
  const context = browser.contexts()[0];
  assert.ok(context, 'Chromium should expose its persistent default browser context over CDP.');
  return { context, page: context.pages()[0] ?? await context.newPage() };
}

async function removeStaleDevToolsPort(profileDir) {
  await rm(resolve(profileDir, 'DevToolsActivePort'), { force: true });
}

const profileDir = await makeProfile();
let child;
let browser;
let secondChild;
let secondBrowser;
let report;
let profileCleanup;
try {
  child = launchOwnedChromium(profileDir);
  browser = await connectOwnedChromium(child, profileDir);
  const { page } = await pageFor(browser);
  await openHost(page);
  const workspaceId = await createWorkspace(page);
  await approve(page, await prepareSource(page, baselineText));
  await selectSource(page);
  const baseline = await inspectDatabase(page, workspaceId);
  assert.equal(baseline.files.find(file => file.path === sourcePath)?.content, baselineText);
  assert.equal(baseline.receipts.length, 1);
  const baselineRevision = baseline.workspace.sourceRevision;

  const proposal = await prepareSource(page, draftText);
  const beforeCrash = await inspectDatabase(page, workspaceId);
  const pendingJournal = beforeCrash.journal.find(row => row.state === 'prepared');
  assert.ok(pendingJournal, 'Draft must be journaled as prepared before terminating the process.');
  assert.ok(pendingJournal.prepared?.durableAck, 'Prepared journal row must carry its durable acknowledgement.');
  assert.equal(pendingJournal.writes?.find(write => write.path === sourcePath)?.content, draftText);
  assert.equal(pendingJournal.writes?.find(write => write.path === sourcePath)?.beforeContent, baselineText);
  assert.equal(beforeCrash.workspace.sourceRevision, baselineRevision);
  assert.equal(beforeCrash.files.find(file => file.path === sourcePath)?.content, baselineText);
  const operationId = pendingJournal.operationId;
  const disconnected = new Promise(resolveDisconnect => browser.once('disconnected', resolveDisconnect));

  assert.equal(child.kill('SIGKILL'), true, 'The runner must signal its own Chromium child.');
  const firstExit = await waitForExit(child);
  await disconnected;
  assert.equal(firstExit.signal, 'SIGKILL');
  await removeStaleDevToolsPort(profileDir);

  secondChild = launchOwnedChromium(profileDir);
  secondBrowser = await connectOwnedChromium(secondChild, profileDir);
  const secondPageContext = await pageFor(secondBrowser);
  const recoveredPage = secondPageContext.page;
  await openHost(recoveredPage);
  await selectWorkspace(recoveredPage, workspaceId);

  const afterRestart = await inspectDatabase(recoveredPage, workspaceId);
  const recoveredJournal = afterRestart.journal.find(row => row.operationId === operationId);
  assert.ok(recoveredJournal, 'Exact prepared journal operation must survive the browser process crash.');
  assert.equal(recoveredJournal.state, 'prepared');
  assert.equal(recoveredJournal.writes?.find(write => write.path === sourcePath)?.content, draftText);
  assert.equal(afterRestart.workspace.sourceRevision, baselineRevision, 'Unapproved draft must not replace the committed baseline.');
  assert.equal(afterRestart.files.find(file => file.path === sourcePath)?.content, baselineText);
  assert.equal(afterRestart.receipts.length, 1, 'The pending draft must not have a commit receipt.');
  await selectSource(recoveredPage);
  assert.equal(await recoveredPage.getByRole('textbox', { name: 'Source' }).inputValue(), baselineText);
  const recoveredProposal = recoveredPage.locator('section[aria-label="変更の承認"] article').last();
  await recoveredProposal.getByText(draftText, { exact: true }).waitFor();
  assert.equal(await recoveredProposal.locator('details pre').nth(1).innerText(), draftText);
  await approve(recoveredPage, recoveredProposal);

  await recoveredPage.reload({ waitUntil: 'domcontentloaded' });
  await openHost(recoveredPage);
  await selectWorkspace(recoveredPage, workspaceId);
  await selectSource(recoveredPage);
  assert.equal(await recoveredPage.getByRole('textbox', { name: 'Source' }).inputValue(), draftText);
  const afterCommit = await inspectDatabase(recoveredPage, workspaceId);
  assert.equal(afterCommit.files.find(file => file.path === sourcePath)?.content, draftText);
  assert.equal(afterCommit.journal.find(row => row.operationId === operationId)?.state, 'committed');
  assert.ok(afterCommit.receipts.some(row => row.operationId === operationId));

  report = {
    schemaVersion: 'atlas.persistence.q05-browser-process-crash/v1',
    status: 'PASS',
    host: {
      origin: expectedOrigin,
      head: execFileSync('git', ['-C', hostRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      profile,
      artifact
    },
    persistenceHead: execFileSync('git', ['-C', storageRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    browser: { name: 'Chromium', version: secondBrowser.version(), executablePath },
    fixture: {
      syntheticPersistentProfile: true,
      workspaceId,
      operationId,
      baselineSourceRevision: baselineRevision,
      pendingDraftSha256: createHash('sha256').update(draftText, 'utf8').digest('hex')
    },
    evidence: {
      durablePreparedDraftBeforeCrash: true,
      ownedChildKilledWithSIGKILL: firstExit.signal === 'SIGKILL',
      baselineCurrentAfterRestart: afterRestart.workspace.sourceRevision === baselineRevision && afterRestart.files.find(file => file.path === sourcePath)?.content === baselineText,
      exactDraftBytesRecovered: recoveredJournal.writes?.find(write => write.path === sourcePath)?.content === draftText,
      explicitHostApprovalCommittedSameOperation: afterCommit.journal.find(row => row.operationId === operationId)?.state === 'committed',
      receiptAndExactBytesSurvivedReload: afterCommit.receipts.some(row => row.operationId === operationId) && afterCommit.files.find(file => file.path === sourcePath)?.content === draftText
    }
  };
} catch (error) {
  report = {
    schemaVersion: 'atlas.persistence.q05-browser-process-crash/v1',
    status: 'FAIL',
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    host: { origin: expectedOrigin, profile, artifact }
  };
} finally {
  await stopOwnedBrowser(secondBrowser, secondChild);
  await stopOwnedBrowser(browser, child);
  let removalError;
  try {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    removalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const profileStillExists = await stat(profileDir).then(() => true, error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  profileCleanup = {
    removed: !profileStillExists,
    ...(removalError ? { removalError } : {})
  };
}

report.profileCleanup = profileCleanup;
if (!profileCleanup?.removed) report.status = 'FAIL';
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'PASS') process.exitCode = 1;
