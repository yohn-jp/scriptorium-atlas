import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const hostRoot = process.env.ATLAS_HOST_ROOT;
if (!hostRoot) throw new Error("Set ATLAS_HOST_ROOT to the Host checkout with dist/atlas and its standalone server script.");
const browserPath = process.env.ATLAS_E2E_CHROMIUM;
const requireFromHost = createRequire(resolve(hostRoot, "package.json"));
const { chromium } = requireFromHost("@playwright/test");
const serverScript = resolve(hostRoot, "apps/standalone/scripts/serve.mjs");
await access(resolve(hostRoot, "dist/atlas"));
await access(serverScript);

async function reservePorts() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = 36000 + Math.floor(Math.random() * 24000);
    const servers = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = createServer();
        await new Promise((listen, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", listen);
        });
        servers.push(server);
      }
      await Promise.all(servers.map((server) => new Promise((close) => server.close(close))));
      return base;
    } catch {
      await Promise.all(servers.map((server) => new Promise((close) => server.close(close))));
    }
  }
  throw new Error("Could not reserve three loopback ports for the Atlas Host server.");
}

async function waitForServer(server, url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Atlas server exited with ${server.exitCode}.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      const ready = response.ok;
      await response.body?.cancel();
      if (ready) return;
    } catch {
      await new Promise((wait) => setTimeout(wait, 100));
    }
  }
  throw new Error("Atlas Host did not become ready within 15 seconds.");
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((exit) => server.once("exit", exit)),
    new Promise((timeout) => setTimeout(() => timeout(false), 5_000)),
  ]);
  if (stopped === false) {
    server.kill("SIGKILL");
    await new Promise((exit) => server.once("exit", exit));
  }
}

async function proposalAfterText(proposal) {
  return proposal.locator("details").evaluateAll((details) => details.map((detail) => ({
    path: detail.querySelector("summary")?.textContent?.trim() ?? "",
    beforeText: detail.querySelectorAll("pre")[0]?.textContent ?? null,
    afterText: detail.querySelectorAll("pre")[1]?.textContent ?? null,
  })));
}

async function approveProposal(page, timeout = 20_000) {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.waitFor({ state: "visible", timeout });
  const files = await proposalAfterText(proposal);
  const priorReceipts = await page.getByRole("status").filter({ hasText: "ローカルCommit完了:" }).allTextContents();
  const approve = proposal.getByRole("button", { name: "この変更を承認してCommit" });
  await approve.focus();
  await page.keyboard.press("Enter");
  await proposal.waitFor({ state: "detached", timeout: 20_000 });
  const receipt = page.getByRole("status").filter({ hasText: "ローカルCommit完了:" }).last();
  const deadline = Date.now() + 20_000;
  let receiptText = "";
  while (Date.now() < deadline) {
    receiptText = await receipt.textContent().catch(() => "") ?? "";
    if (receiptText && !priorReceipts.includes(receiptText)) break;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  assert.ok(receiptText && !priorReceipts.includes(receiptText), "Host must publish a local commit receipt after keyboard approval.");
  return files;
}

async function noPendingProposal(page) {
  await page.waitForTimeout(900);
  assert.equal(await page.locator('section[aria-label="変更の承認"] article').count(), 0,
    "Selection-only changes must not prepare Host source writes.");
}

async function chooseSelectOptionWithKeys(page, select, wantedValue) {
  const options = await select.locator("option").evaluateAll((items) => items.map((item) => ({
    value: item.value,
    disabled: item.disabled,
  })));
  const target = options.findIndex((option) => option.value === wantedValue);
  assert.ok(target >= 0, `The select must offer option ${wantedValue}.`);
  const current = await select.evaluate((element) => element.selectedIndex);
  await select.focus();
  const key = target >= current ? "ArrowDown" : "ArrowUp";
  for (let index = 0; index < Math.abs(target - current); index += 1) await page.keyboard.press(key);
  await page.keyboard.press("Enter");
  assert.equal(await select.inputValue(), wantedValue);
}

async function setNumberWithKeys(page, input, value) {
  await input.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type(String(value));
  assert.equal(Number(await input.inputValue()), value);
}

const port = await reservePorts();
const baseUrl = `http://127.0.0.1:${port}/`;
const server = spawn(process.execPath, [serverScript, "atlas"], {
  cwd: hostRoot,
  env: {
    ...process.env,
    ATLAS_HOST_PORT: String(port),
    ATLAS_PLUGIN_PORT: String(port + 1),
    ATLAS_STORY_PORT: String(port + 2),
  },
  stdio: "ignore",
});

let browser;
let context;
try {
  await waitForServer(server, baseUrl);
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  context = await browser.newContext({ acceptDownloads: true, locale: "ja-JP", viewport: { width: 1600, height: 1200 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  await page.getByLabel("Workspace名").fill(`Canvas keyboard ${crypto.randomUUID()}`);
  const createWorkspace = page.getByRole("button", { name: "空のWorkspaceを作成" });
  await createWorkspace.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("status").filter({ hasText: "Workspaceを開きました。" }).waitFor();
  const workspaceId = await page.getByLabel("開く").inputValue();
  assert.ok(workspaceId, "The created test Workspace must have an ID.");

  const atlas = page.frameLocator('iframe[title="Atlas"]');
  const createBoard = atlas.getByRole("button", { name: "ボードを作成", exact: true });
  await createBoard.focus();
  await page.keyboard.press("Enter");
  await atlas.getByLabel("ボード名").waitFor({ state: "visible" });
  await approveProposal(page);

  const addView = atlas.getByLabel("ビューを追加");
  await chooseSelectOptionWithKeys(page, addView, "freeform");
  await atlas.getByText("Canvasの図形はExcalidrawシーンに、カードはAtlasボードに保存されます。", { exact: true }).waitFor();
  const emptySceneFiles = await approveProposal(page);
  const scenePath = emptySceneFiles.find(({ path }) => path.endsWith(".excalidraw"))?.path;
  assert.ok(scenePath, "Freeform setup must prepare a separate `.excalidraw` file.");

  const canvasTab = atlas.getByRole("tab", { name: /キャンバス/u }).last();
  await canvasTab.focus();
  await page.keyboard.press("Enter");
  const editor = atlas.locator(".excalidraw");
  await editor.waitFor({ state: "visible" });

  const frameElement = await page.locator('iframe[title="Atlas"]').elementHandle();
  assert.ok(frameElement);
  const atlasFrame = await frameElement.contentFrame();
  assert.ok(atlasFrame);
  const panelSummary = atlas.locator(".atlas-canvas-accessibility > summary");
  await panelSummary.focus();
  await page.keyboard.press("Enter");
  const addKind = atlas.getByLabel("追加する要素");
  await addKind.waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  assert.equal(await addKind.evaluate((element) => document.activeElement === element), true,
    "The accessible create control must participate in normal keyboard tab order.");

  const addKindByKeys = async (value, typedText) => {
    await chooseSelectOptionWithKeys(page, addKind, value);
    await page.keyboard.press("Tab");
    if (typedText !== undefined) {
      const textInput = atlas.getByLabel("追加する文字");
      await textInput.waitFor({ state: "visible" });
      await page.keyboard.press("Control+a");
      await page.keyboard.type(typedText);
      await page.keyboard.press("Tab");
    }
    const addButton = atlas.getByRole("button", { name: "要素を追加", exact: true });
    await addButton.focus();
    await page.keyboard.press("Enter");
    await atlas.getByRole("status").filter({ hasText: "を追加しました。" }).waitFor();
  };

  await addKindByKeys("rectangle");
  await addKindByKeys("arrow");
  await addKindByKeys("freedraw");
  await addKindByKeys("text", "Keyboard created text");
  assert.equal(await atlas.getByRole("checkbox").count(), 4,
    "Rectangle, arrow, freehand, and text must be created as native scene elements using keyboard controls.");

  const checkboxes = atlas.getByRole("checkbox");
  await checkboxes.nth(0).focus();
  await page.keyboard.press("Space");
  await checkboxes.nth(1).focus();
  await page.keyboard.press("Space");
  const groupButton = atlas.getByRole("button", { name: "選択をグループ化" });
  await groupButton.focus();
  await page.keyboard.press("Enter");
  const groupedFiles = await approveProposal(page);
  const groupedText = groupedFiles.find(({ path }) => path === scenePath)?.afterText;
  assert.ok(groupedText, `Keyboard group control must prepare the native scene ${scenePath}.`);
  const groupedData = JSON.parse(groupedText);
  const groupedElements = groupedData.elements.filter((element) => !element.isDeleted);
  assert.equal(groupedElements[0].groupIds.length, 1);
  assert.equal(groupedElements[0].groupIds[0], groupedElements[1].groupIds[0],
    "Keyboard grouping must write a shared native Excalidraw group ID.");

  const ungroupButton = atlas.getByRole("button", { name: "選択をグループ解除" });
  await ungroupButton.focus();
  await page.keyboard.press("Enter");
  const ungroupedFiles = await approveProposal(page);
  const baselineText = ungroupedFiles.find(({ path }) => path === scenePath)?.afterText;
  assert.ok(baselineText, "Keyboard ungroup must prepare the scene update.");
  const baseline = JSON.parse(baselineText);
  const baselineElements = baseline.elements.filter((element) => !element.isDeleted);
  assert.ok(baselineElements.every((element) => element.groupIds.length === 0),
    "Ungroup must remove native group IDs from the selected elements.");

  const deselectButton = atlas.getByRole("button", { name: "選択を解除" });
  await deselectButton.focus();
  await page.keyboard.press("Enter");
  await noPendingProposal(page);
  assert.equal(await checkboxes.nth(0).isChecked(), false, "The list must provide a keyboard deselect alternative.");

  const selectedTarget = checkboxes.nth(0);
  await selectedTarget.focus();
  await page.keyboard.press("Space");
  const originalElement = baselineElements[0];
  const nextGeometry = {
    x: originalElement.x + 17,
    y: originalElement.y + 13,
    width: originalElement.width + 35,
    height: originalElement.height + 25,
  };
  await setNumberWithKeys(page, atlas.getByLabel("選択要素のX座標"), nextGeometry.x);
  await setNumberWithKeys(page, atlas.getByLabel("選択要素のY座標"), nextGeometry.y);
  await setNumberWithKeys(page, atlas.getByLabel("選択要素の幅"), nextGeometry.width);
  await setNumberWithKeys(page, atlas.getByLabel("選択要素の高さ"), nextGeometry.height);
  const applyGeometry = atlas.getByRole("button", { name: "位置とサイズを適用" });
  await applyGeometry.focus();
  await page.keyboard.press("Enter");
  await atlas.getByRole("status").filter({ hasText: "位置とサイズを更新しました。" }).waitFor();
  const geometryFiles = await approveProposal(page);
  const changedText = geometryFiles.find(({ path }) => path === scenePath)?.afterText;
  assert.ok(changedText, "Keyboard geometry changes must be prepared as a normal Host scene write.");
  const changedData = JSON.parse(changedText);
  const changedElement = changedData.elements.find((element) => element.id === originalElement.id);
  assert.deepEqual({ x: changedElement.x, y: changedElement.y, width: changedElement.width, height: changedElement.height }, nextGeometry,
    "Keyboard geometry fields must move and resize the selected native element.");

  const undo = editor.getByRole("button", { name: "元に戻す" });
  assert.equal(await undo.isEnabled(), true, "Keyboard geometry update must enter official Excalidraw undo history.");
  await undo.focus();
  await page.keyboard.press("Enter");
  const undoneFiles = await approveProposal(page);
  const undoneText = undoneFiles.find(({ path }) => path === scenePath)?.afterText;
  assert.ok(undoneText, "Official keyboard undo must prepare the restored scene.");
  const undoneData = JSON.parse(undoneText);
  const undoneElement = undoneData.elements.find((element) => element.id === originalElement.id);
  assert.deepEqual({ x: undoneElement.x, y: undoneElement.y, width: undoneElement.width, height: undoneElement.height }, {
    x: originalElement.x,
    y: originalElement.y,
    width: originalElement.width,
    height: originalElement.height,
  }, "Official keyboard undo must restore the prior element geometry.");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("開く").waitFor({ state: "visible" });
  const workspaceSelect = page.getByLabel("開く");
  await chooseSelectOptionWithKeys(page, workspaceSelect, workspaceId);
  await page.getByRole("status").filter({ hasText: "Workspaceを開きました。" }).waitFor();
  const reloadedAtlas = page.frameLocator('iframe[title="Atlas"]');
  await reloadedAtlas.getByRole("tab", { name: /キャンバス/u }).last().waitFor({ state: "visible" });
  const reloadedCanvasTab = reloadedAtlas.getByRole("tab", { name: /キャンバス/u }).last();
  await reloadedCanvasTab.focus();
  await page.keyboard.press("Enter");
  const reloadedEditor = reloadedAtlas.locator(".excalidraw");
  await reloadedEditor.waitFor({ state: "visible" });
  const exportedScenePromise = page.waitForEvent("download");
  const exportScene = reloadedAtlas.getByRole("button", { name: ".excalidrawをエクスポート" });
  await exportScene.focus();
  await page.keyboard.press("Enter");
  const exportedScene = await exportedScenePromise;
  const exportedPath = await exportedScene.path();
  assert.ok(exportedPath);
  const exportedBytes = await readFile(exportedPath);
  assert.equal(exportedBytes.toString("utf8"), undoneText,
    "Host reload must restore the keyboard-created native scene after geometry undo byte-for-byte.");

  assert.deepEqual(pageErrors, [], `Keyboard UI and Host persistence must not throw browser errors: ${pageErrors.join("; ")}`);
  console.log(JSON.stringify({
    status: "PASS",
    case: "keyboard-only native creation, selection, grouping, geometry, undo, Host commit and reload",
    browser: browser.version(),
    scenePath,
    elements: baselineElements.map(({ id, type }) => ({ id, type })),
    geometryBefore: { x: originalElement.x, y: originalElement.y, width: originalElement.width, height: originalElement.height },
    geometryAfterKeyboardEdit: nextGeometry,
    geometryAfterUndo: { x: undoneElement.x, y: undoneElement.y, width: undoneElement.width, height: undoneElement.height },
    reloadedSceneBytes: exportedBytes.byteLength,
  }, null, 2));
} finally {
  await context?.close();
  if (browser) await browser.close();
  await stopServer(server);
}

