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

async function approveUntilScene(page, scenePath, matches, description) {
  const proposals = page.locator('section[aria-label="変更の承認"] article');
  let lastText = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await proposals.last().waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      const states = await page.getByRole("status").allTextContents();
      assert.fail(`No proposal for ${description} after ${attempt} approved proposals; latest scene was ${lastText.slice(0, 2_000)}; statuses=${JSON.stringify(states)}`);
    }
    const files = await approveProposal(page);
    const text = files.find(({ path }) => path === scenePath)?.afterText;
    if (text) {
      lastText = text;
      if (matches(JSON.parse(text))) return { files, text };
    }
    if (attempt < 7) {
      try {
        await proposals.last().waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        const states = await page.getByRole("status").allTextContents();
        assert.fail(`No follow-up proposal for ${description}; mismatch=${lastText.slice(0, 2_000)}; statuses=${JSON.stringify(states)}`);
      }
    }
  }
  assert.fail(`Host did not prepare the current ${description} scene after eight approved proposals; last JSON was ${lastText.slice(0, 1_000)}.`);
}

async function noPendingProposal(page) {
  await page.waitForTimeout(900);
  assert.equal(await page.locator('section[aria-label="変更の承認"] article').count(), 0,
    "Selection-only changes must not prepare Host source writes.");
}

async function downloadSceneText(page, atlas) {
  const downloadPromise = page.waitForEvent("download");
  const exportScene = atlas.getByRole("button", { name: ".excalidrawをエクスポート" });
  await exportScene.focus();
  await page.keyboard.press("Enter");
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, "The Host-owned scene export must produce a downloadable file.");
  return (await readFile(path)).toString("utf8");
}

async function downloadBoardData(page, atlas) {
  const downloadPromise = page.waitForEvent("download");
  const exportBoard = atlas.getByRole("button", { name: ".atlas.jsonをエクスポート" });
  await exportBoard.click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, "The Host-owned Board export must produce a downloadable file.");
  return JSON.parse(await readFile(path, "utf8"));
}

async function waitForBoardViewport(page, atlas, viewId, expectedViewport) {
  const deadline = Date.now() + 10_000;
  let latestBoard = null;
  while (Date.now() < deadline) {
    latestBoard = await downloadBoardData(page, atlas);
    const savedViewport = latestBoard.views.find((view) => view.id === viewId)?.viewport;
    if (JSON.stringify(savedViewport) === JSON.stringify(expectedViewport)) return latestBoard;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  assert.fail(`The live Board export did not reach the requested viewport ${JSON.stringify(expectedViewport)}; last Board was ${JSON.stringify(latestBoard)}.`);
}

async function approveUntilStableBoard(page, atlas, boardPath, expectedBoard, expectedSceneText) {
  const proposalSelector = 'section[aria-label="変更の承認"] article';
  let matchingBoardProposalApproved = false;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await page.locator(proposalSelector).count() > 0) {
      const files = await approveProposal(page);
      const boardFile = files.find(({ path }) => path === boardPath);
      if (boardFile?.afterText
        && JSON.stringify(JSON.parse(boardFile.afterText)) === JSON.stringify(expectedBoard)) {
        matchingBoardProposalApproved = true;
      }
      continue;
    }

    const saveState = await atlas.locator(".atlas-save-indicator").textContent();
    if (!saveState?.includes("Hostの基準状態")) {
      await page.waitForTimeout(250);
      continue;
    }
    const firstBoard = await downloadBoardData(page, atlas);
    const firstScene = await downloadSceneText(page, atlas);
    if (JSON.stringify(firstBoard) !== JSON.stringify(expectedBoard)
      || firstScene !== expectedSceneText) {
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(1_200);
    if (await page.locator(proposalSelector).count() > 0) continue;
    if (!(await atlas.locator(".atlas-save-indicator").textContent())?.includes("Hostの基準状態")) continue;
    const stableBoard = await downloadBoardData(page, atlas);
    const stableScene = await downloadSceneText(page, atlas);
    if (JSON.stringify(stableBoard) !== JSON.stringify(expectedBoard)
      || stableScene !== expectedSceneText) continue;
    assert.equal(matchingBoardProposalApproved, true,
      "A Host proposal whose Board bytes match the live camera state must be approved before the stable check.");
    return { board: stableBoard, sceneText: stableScene };
  }
  assert.fail(`Host did not reach a stable committed Board/scene pair for the current camera; expectedBoard=${JSON.stringify(expectedBoard)}; saveState=${await atlas.locator(".atlas-save-indicator").textContent()}`);
}

async function chooseSelectOptionWithKeys(page, select, wantedValue, retainValue = true) {
  const options = await select.locator("option").evaluateAll((items) => items.map((item) => ({
    value: item.value,
    disabled: item.disabled,
  })));
  const target = options.findIndex((option) => option.value === wantedValue);
  assert.ok(target >= 0, `The select must offer option ${wantedValue}.`);
  const current = await select.evaluate((element) => element.selectedIndex);
  await select.focus();
  await page.keyboard.press("Space");
  const key = target >= current ? "ArrowDown" : "ArrowUp";
  for (let index = 0; index < Math.abs(target - current); index += 1) await page.keyboard.press(key);
  await page.keyboard.press("Enter");
  if (retainValue) assert.equal(await select.inputValue(), wantedValue);
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
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const fontRequests = [];
  const fontRequestsById = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, request, initiator }) => {
    if (!request.url.includes("/fonts/")) return;
    const entry = {
      url: request.url,
      initiator: {
        type: initiator.type,
        url: initiator.url,
        frames: initiator.stack?.callFrames?.slice(0, 3).map(({ url, lineNumber, columnNumber, functionName }) => ({
          url, lineNumber, columnNumber, functionName,
        })),
      },
    };
    fontRequests.push(entry);
    fontRequestsById.set(requestId, entry);
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const entry = fontRequestsById.get(requestId);
    if (entry) entry.status = response.status;
  });
  cdp.on("Network.loadingFailed", ({ requestId, errorText }) => {
    const entry = fontRequestsById.get(requestId);
    if (entry) entry.error = errorText;
  });
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  const failedRequests = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push({ message: error.message, stack: error.stack }));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.addInitScript(() => {
    const errors = [];
    Object.defineProperty(window, "__atlasBrowserErrors", { value: errors });
    window.addEventListener("error", (event) => errors.push({
      type: "error",
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack,
    }));
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      errors.push({ type: "unhandledrejection", message: String(reason), stack: reason?.stack });
    });
  });
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
  await chooseSelectOptionWithKeys(page, addView, "freeform", false);
  await atlas.getByText("Canvasの図形はExcalidrawシーンに、カードはAtlasボードに保存されます。", { exact: true }).waitFor();
  const emptySceneFiles = await approveProposal(page);
  const scenePath = emptySceneFiles.find(({ path }) => path.endsWith(".excalidraw"))?.path;
  assert.ok(scenePath, "Freeform setup must prepare a separate `.excalidraw` file.");
  const emptySceneText = emptySceneFiles.find(({ path }) => path === scenePath)?.afterText;
  const emptyBoardFile = emptySceneFiles.find(({ path }) => path.endsWith(".atlas.json"));
  assert.ok(emptySceneText && emptyBoardFile?.afterText,
    "The Host must prepare both the raw scene and the Atlas Board before camera editing.");
  const emptyBoard = JSON.parse(emptyBoardFile.afterText);
  const freeformView = emptyBoard.views.filter((view) => view.kind === "freeform").at(-1);
  assert.ok(freeformView?.id && freeformView.viewport,
    "The created Freeform view must have its own persisted Atlas viewport.");
  const originalViewport = freeformView.viewport;

  const canvasTab = atlas.getByRole("tab", { name: /キャンバス/u }).last();
  await canvasTab.focus();
  await page.keyboard.press("Enter");
  const editor = atlas.locator(".excalidraw");
  await editor.waitFor({ state: "visible" });

  const frameElement = await page.locator('iframe[title="Atlas"]').elementHandle();
  assert.ok(frameElement);
  const atlasFrame = await frameElement.contentFrame();
  assert.ok(atlasFrame);
  const fontAssetPath = await atlasFrame.evaluate(() => globalThis.EXCALIDRAW_ASSET_PATH ?? null);
  const panelSummary = atlas.locator(".atlas-canvas-accessibility > summary");
  await panelSummary.focus();
  await page.keyboard.press("Enter");
  const addKind = atlas.getByLabel("追加する要素");
  await addKind.waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  const panX = atlas.getByLabel("Canvas表示位置X");
  const panY = atlas.getByLabel("Canvas表示位置Y");
  const applyPan = atlas.getByRole("button", { name: "表示位置を適用", exact: true });
  assert.equal(await panX.evaluate((element) => document.activeElement === element), true,
    "The first keyboard stop after the controls summary must be the viewport X input.");
  await page.keyboard.press("Tab");
  assert.equal(await panY.evaluate((element) => document.activeElement === element), true,
    "The second keyboard stop must be the viewport Y input.");
  await page.keyboard.press("Tab");
  assert.equal(await applyPan.evaluate((element) => document.activeElement === element), true,
    "The third keyboard stop must apply the viewport position.");

  const sceneBeforeViewport = await downloadSceneText(page, atlas);
  assert.equal(sceneBeforeViewport, emptySceneText,
    "The initial Host scene export must match the prepared raw `.excalidraw` text byte-for-byte.");
  const applyViewportByKeys = async (scrollX, scrollY) => {
    await setNumberWithKeys(page, panX, scrollX);
    await setNumberWithKeys(page, panY, scrollY);
    await page.keyboard.press("Tab");
    assert.equal(await applyPan.evaluate((element) => document.activeElement === element), true,
      "Tab from viewport Y must reach the Apply control.");
    await page.keyboard.press("Enter");
    await atlas.getByRole("status").filter({ hasText: "表示位置を更新しました。" }).waitFor();
  };

  const assertLiveCanvasViewport = async (scrollX, scrollY) => {
    await panelSummary.focus();
    assert.equal(await atlas.locator(".atlas-canvas-accessibility").evaluate((element) => element.open), true);
    await page.keyboard.press("Enter");
    assert.equal(await atlas.locator(".atlas-canvas-accessibility").evaluate((element) => element.open), false,
      "The Canvas accessibility panel must collapse before checking the official current camera.");
    await panelSummary.focus();
    await page.keyboard.press("Enter");
    await panX.waitFor({ state: "visible" });
    await atlasFrame.waitForFunction(({ x, y }) => {
      const currentX = document.querySelector('[aria-label="Canvas表示位置X"]');
      const currentY = document.querySelector('[aria-label="Canvas表示位置Y"]');
      return currentX?.value === x && currentY?.value === y;
    }, { x: String(scrollX), y: String(scrollY) }, { timeout: 5_000 });
  };

  const requestedViewport = { scrollX: 123, scrollY: -67 };
  await applyViewportByKeys(requestedViewport.scrollX, requestedViewport.scrollY);
  await page.waitForTimeout(220);
  const expectedViewport = {
    x: requestedViewport.scrollX * originalViewport.zoom,
    y: requestedViewport.scrollY * originalViewport.zoom,
    zoom: originalViewport.zoom,
  };
  const cameraBoard = await waitForBoardViewport(page, atlas, freeformView.id, expectedViewport);
  await assertLiveCanvasViewport(requestedViewport.scrollX, requestedViewport.scrollY);
  const committedCamera = await approveUntilStableBoard(page, atlas, emptyBoardFile.path, cameraBoard, sceneBeforeViewport);
  assert.deepEqual(committedCamera.board.views.find((view) => view.id === freeformView.id)?.viewport, expectedViewport,
    "The stable Host-committed Board must retain the keyboard camera position in the matching view.");
  const sceneAfterViewport = await downloadSceneText(page, atlas);
  assert.equal(sceneAfterViewport, sceneBeforeViewport,
    "Keyboard pan must preserve the exact Host-owned raw `.excalidraw` scene text.");

  await applyViewportByKeys(originalViewport.x / originalViewport.zoom, originalViewport.y / originalViewport.zoom);
  await page.waitForTimeout(220);
  const restoredCameraBoard = await waitForBoardViewport(page, atlas, freeformView.id, originalViewport);
  await assertLiveCanvasViewport(originalViewport.x / originalViewport.zoom, originalViewport.y / originalViewport.zoom);
  const committedRestoredCamera = await approveUntilStableBoard(page, atlas, emptyBoardFile.path,
    restoredCameraBoard, sceneBeforeViewport);
  assert.deepEqual(committedRestoredCamera.board.views.find((view) => view.id === freeformView.id)?.viewport, originalViewport,
    "Keyboard camera controls must restore the original saved view position before drawing checks.");
  assert.equal(committedRestoredCamera.sceneText, sceneBeforeViewport,
    "Restoring the camera must leave raw scene bytes unchanged.");

  await panelSummary.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await addKind.evaluate((element) => document.activeElement === element), true,
    "The element create select must remain keyboard reachable after the viewport controls in normal tab order.");

  const addKindByKeys = async (value, typedText, freehandPointText) => {
    await chooseSelectOptionWithKeys(page, addKind, value);
    await page.keyboard.press("Tab");
    if (typedText !== undefined) {
      const textInput = atlas.getByLabel("追加する文字");
      await textInput.waitFor({ state: "visible" });
      await page.keyboard.press("Control+a");
      await page.keyboard.type(typedText);
      await page.keyboard.press("Tab");
    }
    if (freehandPointText !== undefined) {
      const pointsInput = atlas.getByLabel("追加するフリーハンド点");
      await pointsInput.waitFor({ state: "visible" });
      await pointsInput.focus();
      await page.keyboard.press("Control+a");
      await page.keyboard.type(freehandPointText);
      await page.keyboard.press("Tab");
    }
    const addButton = atlas.getByRole("button", { name: "要素を追加", exact: true });
    await addButton.focus();
    await page.keyboard.press("Enter");
    await atlas.getByRole("status").filter({ hasText: "を追加しました。" }).waitFor();
  };

  await addKindByKeys("rectangle");
  await addKindByKeys("arrow");
  const createdFreehandPoints = "0,0\n35,48\n90,8\n140,60\n220,30";
  await addKindByKeys("freedraw", undefined, createdFreehandPoints);
  await addKindByKeys("text", "Keyboard created text");
  const checkboxes = atlas.locator(".atlas-canvas-accessibility-list input[type=checkbox]");
  assert.equal(await checkboxes.count(), 4,
    "Rectangle, arrow, freehand, and text must be created as native scene elements using keyboard controls.");
  const created = await approveUntilScene(page, scenePath, (data) => {
    const elements = data.elements.filter((element) => !element.isDeleted);
    return ["arrow", "freedraw", "rectangle", "text"].every((type) => elements.some((element) => element.type === type)) &&
      elements.some((element) => element.type === "text" && element.text === "Keyboard created text");
  }, "keyboard-created");
  const createdElements = JSON.parse(created.text).elements.filter((element) => !element.isDeleted);
  const freehandElement = createdElements.find((element) => element.type === "freedraw");
  assert.deepEqual(freehandElement.points, [[0, 0], [35, 48], [90, 8], [140, 60], [220, 30]],
    "Keyboard freehand creation must persist user-authored points instead of a fixed sample stroke.");

  await atlas.getByRole("button", { name: "選択を解除" }).focus();
  await page.keyboard.press("Enter");
  await noPendingProposal(page);
  await checkboxes.nth(2).focus();
  await page.keyboard.press("Space");
  const editedFreehandPoints = "0,0\n80,100\n200,20";
  const selectedFreehandInput = atlas.getByLabel("選択フリーハンドの点");
  await selectedFreehandInput.waitFor({ state: "visible" });
  await selectedFreehandInput.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type(editedFreehandPoints);
  const applyPoints = atlas.getByRole("button", { name: "点を適用", exact: true });
  await applyPoints.focus();
  await page.keyboard.press("Enter");
  const editedFreehand = await approveUntilScene(page, scenePath, (data) => {
    const element = data.elements.find((item) => item.id === freehandElement.id);
    return element?.width === 200 && element?.height === 100 &&
      JSON.stringify(element.points) === JSON.stringify([[0, 0], [80, 100], [200, 20]]);
  }, "freehand-points-edited");
  const savedFreehand = JSON.parse(editedFreehand.text).elements.find((element) => element.id === freehandElement.id);
  assert.deepEqual(savedFreehand.points, [[0, 0], [80, 100], [200, 20]],
    "Editing a selected freehand stroke must preserve its native element ID and save the requested points.");
  assert.equal(savedFreehand.id, freehandElement.id);

  const deselectButton = atlas.getByRole("button", { name: "選択を解除" });
  await deselectButton.focus();
  await page.keyboard.press("Enter");
  await noPendingProposal(page);
  await checkboxes.nth(3).focus();
  await page.keyboard.press("Space");
  const textElement = createdElements.find((element) => element.type === "text");
  const nextTextGeometry = {
    x: textElement.x + 12,
    y: textElement.y + 9,
    width: textElement.width + 120,
    height: textElement.height + 40,
  };
  await setNumberWithKeys(page, atlas.getByLabel("選択要素のX座標"), nextTextGeometry.x);
  await setNumberWithKeys(page, atlas.getByLabel("選択要素のY座標"), nextTextGeometry.y);
  await setNumberWithKeys(page, atlas.getByLabel("選択要素の幅"), nextTextGeometry.width);
  await setNumberWithKeys(page, atlas.getByLabel("選択要素の高さ"), nextTextGeometry.height);
  const applyTextGeometry = atlas.getByRole("button", { name: "位置とサイズを適用" });
  await applyTextGeometry.focus();
  await page.keyboard.press("Enter");
  const resizedText = await approveUntilScene(page, scenePath, (data) => {
    const element = data.elements.find((item) => item.id === textElement.id);
    return element?.x === nextTextGeometry.x && element?.y === nextTextGeometry.y &&
      element?.width === nextTextGeometry.width && element?.height === nextTextGeometry.height &&
      element?.autoResize === false;
  }, "text-geometry-edited");
  const resizedTextElement = JSON.parse(resizedText.text).elements.find((element) => element.id === textElement.id);
  assert.deepEqual({ x: resizedTextElement.x, y: resizedTextElement.y,
    width: resizedTextElement.width, height: resizedTextElement.height }, nextTextGeometry,
  "Text geometry controls must update Excalidraw bounds while keeping the same native text element.");
  assert.equal(resizedTextElement.text, "Keyboard created text");
  assert.equal(resizedTextElement.autoResize, false,
    "Manual text dimensions must disable native auto-resize so serialization and SVG export use the chosen width.");

  await panelSummary.focus();
  await page.keyboard.press("Enter");
  const mainMenu = editor.getByTestId("main-menu-trigger");
  await mainMenu.click();
  const imageExport = editor.getByTestId("image-export-button");
  await imageExport.waitFor({ state: "visible" });
  await imageExport.click();
  const exportDialog = atlas.locator(".ImageExportModal");
  await exportDialog.waitFor({ state: "visible" });
  const svgDownloadPromise = page.waitForEvent("download");
  await exportDialog.getByRole("button", { name: /SVG/u }).click();
  const svgDownload = await svgDownloadPromise;
  const svgPath = await svgDownload.path();
  assert.ok(svgPath);
  const svgText = (await readFile(svgPath)).toString("utf8");
  const embeddedFontCount = (svgText.match(/data:font\/woff2;base64,/gu) ?? []).length;
  const externalFontCount = (svgText.match(/https:\/\/esm\.sh\/@excalidraw\/excalidraw@0\.18\.1\/dist\/prod\/fonts\//gu) ?? []).length;
  const svgInfo = await atlasFrame.evaluate((markup) => {
    const document = new DOMParser().parseFromString(markup, "image/svg+xml");
    const svg = document.documentElement;
    return {
      valid: svg.localName === "svg" && document.querySelector("parsererror") === null,
      viewBox: svg.getAttribute("viewBox"),
      text: svg.textContent ?? "",
    };
  }, svgText);
  assert.equal(svgInfo.valid, true, "Excalidraw's official SVG export must produce a valid SVG document.");
  assert.ok(embeddedFontCount > 0, "CSP-safe SVG export must embed the self-hosted font as data instead of using a remote font URL.");
  assert.equal(externalFontCount, 0, "SVG export must not refer to the external Excalidraw font CDN.");
  assert.match(svgInfo.text, /Keyboard created text/u,
    "The official SVG export must contain the keyboard-created and resized native text element.");
  const svgViewBox = svgInfo.viewBox?.trim().split(/[ ,]+/u).map(Number) ?? [];
  assert.equal(svgViewBox.length, 4, `SVG export must include a four-value viewBox, received ${svgInfo.viewBox}.`);
  // Excalidraw crops the SVG to exported element bounds and translates the top-left to zero.
  // Compare dimensions, since absolute scene x/y are intentionally not SVG viewBox offsets.
  assert.ok(svgViewBox[2] >= nextTextGeometry.width - 1,
    `SVG viewBox must include the resized text width ${nextTextGeometry.width}; received ${svgInfo.viewBox}.`);
  assert.ok(svgViewBox[3] >= nextTextGeometry.height - 1,
    `SVG viewBox must include the resized text height ${nextTextGeometry.height}; received ${svgInfo.viewBox}.`);

  const exportUi = await atlasFrame.evaluate(() => ({
    title: document.title,
    bodyText: document.body.innerText.slice(0, 1_500),
    panelCount: document.querySelectorAll(".atlas-canvas-accessibility").length,
    editorCount: document.querySelectorAll(".excalidraw").length,
    exportDialogCount: document.querySelectorAll(".ImageExportModal").length,
    alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent?.slice(0, 300)),
    activeTabs: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((element) => element.textContent),
    buttons: [...document.querySelectorAll(".Modal button")].map((element) => ({
      text: element.textContent?.trim(),
      label: element.getAttribute("aria-label"),
      testId: element.getAttribute("data-testid"),
    })),
  }));
  const excalidrawDialog = atlas.locator('.Modal[role="dialog"]').filter({ has: exportDialog });
  await excalidrawDialog.locator(".Modal__content").press("Escape");
  await excalidrawDialog.waitFor({ state: "detached" });
  const postExportUi = await atlasFrame.evaluate(() => ({
    href: location.href,
    panelCount: document.querySelectorAll(".atlas-canvas-accessibility").length,
    summaryCount: document.querySelectorAll(".atlas-canvas-accessibility > summary").length,
    panelOpen: document.querySelector(".atlas-canvas-accessibility")?.open,
    editorCount: document.querySelectorAll(".excalidraw").length,
    alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent?.slice(0, 300)),
    activeTabs: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((element) => element.textContent),
    bodyText: document.body.innerText.slice(0, 1_500),
  }));
  const browserEvents = await Promise.all(page.frames().map(async (frame) => ({
    url: frame.url(),
    errors: await frame.evaluate(() => window.__atlasBrowserErrors ?? []).catch((error) => [{ readError: error.message }]),
  })));
  const fontConsoleErrors = consoleErrors.filter((message) => /font-src/u.test(message));
  const relevantConsoleErrors = consoleErrors.filter((message) => /subset|ReferenceError|document is not defined/u.test(message));
  const localFontRequests = fontRequests.filter(({ url }) => new URL(url).origin === new URL(atlasFrame.url()).origin);
  const remoteFontRequests = fontRequests.filter(({ url }) => new URL(url).origin !== new URL(atlasFrame.url()).origin);
  const localStatusCounts = {};
  for (const request of localFontRequests) {
    const status = request.error ?? String(request.status ?? "pending");
    localStatusCounts[status] = (localStatusCounts[status] ?? 0) + 1;
  }
  const svgDiagnostics = {
    fontAssetPath,
    exportUi,
    postExportUi,
    pageErrors,
    browserEvents,
    consoleErrors: {
      fontCspCount: fontConsoleErrors.length,
      firstFontCsp: fontConsoleErrors[0]?.slice(0, 1_000),
      other: relevantConsoleErrors.map((message) => message.slice(0, 1_500)),
    },
    fontRequests: {
      total: fontRequests.length,
      local: localFontRequests.length,
      localStatusCounts,
      remote: remoteFontRequests.length,
      remoteSamples: remoteFontRequests.slice(0, 3),
      remoteResponseCount: remoteFontRequests.filter(({ status }) => status !== undefined).length,
      remoteFailureSamples: failedRequests.filter(({ url }) =>
        url.includes("/fonts/") && new URL(url).origin !== new URL(atlasFrame.url()).origin,
      ).slice(0, 3),
    },
    embeddedFontCount,
    externalFontCount,
    failedRequests: { count: failedRequests.length, remoteFontRequests: failedRequests.filter((request) => request.url.includes("/fonts/")).length },
  };
  console.log("svg-export-diagnostics", JSON.stringify(svgDiagnostics));
  assert.ok(localFontRequests.length > 0, "The Canvas editor must request its self-hosted fonts.");
  assert.equal(localFontRequests.filter(({ status }) => status !== 200).length, 0,
    `Every same-origin font response must succeed: ${JSON.stringify(svgDiagnostics.fontRequests)}`);
  assert.equal(svgDiagnostics.fontRequests.remoteResponseCount, 0,
    `External Excalidraw fallback URLs must stay blocked by the host CSP: ${JSON.stringify(svgDiagnostics.fontRequests)}`);
  if (browserEvents.some(({ errors }) => errors.some((error) => error.type === "error"))) {
    throw new Error("Captured the real Canvas export error; stopping before later UI assertions.");
  }
  assert.equal(postExportUi.editorCount, 1, `Canvas editor must remain mounted after SVG export: ${JSON.stringify(svgDiagnostics)}`);
  assert.equal(postExportUi.alerts.length, 0, `SVG export must not trigger a Plugin error boundary: ${JSON.stringify(svgDiagnostics)}`);
  await panelSummary.focus();
  await page.keyboard.press("Enter");
  await checkboxes.nth(0).waitFor({ state: "visible" });
  await checkboxes.nth(0).focus();
  await page.keyboard.press("Space");
  assert.equal(await checkboxes.nth(0).isChecked(), true, "The element list checkbox must select an individual element.");
  await checkboxes.nth(1).focus();
  await page.keyboard.press("Space");
  const groupButton = atlas.getByRole("button", { name: "選択をグループ化" });
  assert.equal(await groupButton.isEnabled(), true, "Two individually selected elements must enable keyboard grouping.");
  await groupButton.focus();
  await page.keyboard.press("Enter");
  const grouped = await approveUntilScene(page, scenePath, (data) => {
    const elements = data.elements.filter((element) => !element.isDeleted);
    return elements.length >= 2 && elements[0].groupIds.length > 0 &&
      elements[0].groupIds.at(-1) === elements[1].groupIds.at(-1);
  }, "grouped");
  const groupedText = grouped.text;
  const groupedData = JSON.parse(groupedText);
  const groupedElements = groupedData.elements.filter((element) => !element.isDeleted);
  assert.equal(groupedElements[0].groupIds.length, 1);
  assert.equal(groupedElements[0].groupIds[0], groupedElements[1].groupIds[0],
    "Keyboard grouping must write a shared native Excalidraw group ID.");

  const ungroupButton = atlas.getByRole("button", { name: "選択をグループ解除" });
  await ungroupButton.focus();
  await page.keyboard.press("Enter");
  const ungrouped = await approveUntilScene(page, scenePath, (data) =>
    data.elements.filter((element) => !element.isDeleted).every((element) => element.groupIds.length === 0), "ungrouped");
  const baselineText = ungrouped.text;
  const baseline = JSON.parse(baselineText);
  const baselineElements = baseline.elements.filter((element) => !element.isDeleted);
  assert.ok(baselineElements.every((element) => element.groupIds.length === 0),
    "Ungroup must remove native group IDs from the selected elements.");

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
  const geometry = await approveUntilScene(page, scenePath, (data) => {
    const element = data.elements.find((item) => item.id === originalElement.id);
    return element?.x === nextGeometry.x && element?.y === nextGeometry.y &&
      element?.width === nextGeometry.width && element?.height === nextGeometry.height;
  }, "geometry-edited");
  const changedText = geometry.text;
  const changedData = JSON.parse(changedText);
  const changedElement = changedData.elements.find((element) => element.id === originalElement.id);
  assert.deepEqual({ x: changedElement.x, y: changedElement.y, width: changedElement.width, height: changedElement.height }, nextGeometry,
    "Keyboard geometry fields must move and resize the selected native element.");

  const undo = editor.getByRole("button", { name: "元に戻す" });
  assert.equal(await undo.isEnabled(), true, "Keyboard geometry update must enter official Excalidraw undo history.");
  await panelSummary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await atlas.locator(".atlas-canvas-accessibility").evaluate((element) => element.open), false,
    "The keyboard controls panel must be collapsible before returning to native canvas shortcuts.");
  await undo.focus();
  await page.keyboard.press("Enter");
  const undone = await approveUntilScene(page, scenePath, (data) => {
    const element = data.elements.find((item) => item.id === originalElement.id);
    return element?.x === originalElement.x && element?.y === originalElement.y &&
      element?.width === originalElement.width && element?.height === originalElement.height;
  }, "undo-restored");
  const undoneText = undone.text;
  const undoneData = JSON.parse(undoneText);
  const undoneElement = undoneData.elements.find((element) => element.id === originalElement.id);
  assert.deepEqual({ x: undoneElement.x, y: undoneElement.y, width: undoneElement.width, height: undoneElement.height }, {
    x: originalElement.x,
    y: originalElement.y,
    width: originalElement.width,
    height: originalElement.height,
  }, "Official keyboard undo must restore the prior element geometry.");

  const redo = editor.getByRole("button", { name: "やり直し" });
  assert.equal(await redo.isEnabled(), true, "Keyboard undo must enable the official Excalidraw redo button.");
  await redo.focus();
  await page.keyboard.press("Space");
  const redone = await approveUntilScene(page, scenePath, (data) => {
    const element = data.elements.find((item) => item.id === originalElement.id);
    return element?.x === nextGeometry.x && element?.y === nextGeometry.y &&
      element?.width === nextGeometry.width && element?.height === nextGeometry.height;
  }, "redo-restored");
  const redoneElement = JSON.parse(redone.text).elements.find((element) => element.id === originalElement.id);
  assert.deepEqual({ x: redoneElement.x, y: redoneElement.y, width: redoneElement.width, height: redoneElement.height },
    nextGeometry, "Keyboard Space on the official redo button must restore the keyboard-authored geometry.");

  await undo.focus();
  await page.keyboard.press("Space");
  const finalUndone = await approveUntilScene(page, scenePath, (data) => {
    const element = data.elements.find((item) => item.id === originalElement.id);
    return element?.x === originalElement.x && element?.y === originalElement.y &&
      element?.width === originalElement.width && element?.height === originalElement.height;
  }, "space-undo-restored");
  const finalUndoneElement = JSON.parse(finalUndone.text).elements.find((element) => element.id === originalElement.id);
  assert.deepEqual({ x: finalUndoneElement.x, y: finalUndoneElement.y, width: finalUndoneElement.width, height: finalUndoneElement.height }, {
    x: originalElement.x,
    y: originalElement.y,
    width: originalElement.width,
    height: originalElement.height,
  }, "Keyboard Space on the official undo button must restore the original geometry after redo.");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("開く").waitFor({ state: "visible" });
  const workspaceSelect = page.getByLabel("開く");
  await chooseSelectOptionWithKeys(page, workspaceSelect, workspaceId, false);
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
  assert.equal(exportedBytes.toString("utf8"), finalUndone.text,
    "Host reload must restore the keyboard-created native scene after geometry undo byte-for-byte.");

  assert.deepEqual(pageErrors, [], `Keyboard UI and Host persistence must not throw browser errors: ${pageErrors.join("; ")}`);
  console.log(JSON.stringify({
    status: "PASS",
    case: "keyboard-only viewport, native creation, selection, grouping, geometry, undo, redo, Host commit and reload",
    browser: browser.version(),
    scenePath,
    viewId: freeformView.id,
    initialViewport: originalViewport,
    keyboardViewport: committedCamera.board.views.find((view) => view.id === freeformView.id)?.viewport,
    restoredViewport: committedRestoredCamera.board.views.find((view) => view.id === freeformView.id)?.viewport,
    cameraOnlySceneBytesUnchanged: sceneBeforeViewport === committedCamera.sceneText
      && sceneBeforeViewport === committedRestoredCamera.sceneText,
    elements: baselineElements.map(({ id, type }) => ({ id, type })),
    geometryBefore: { x: originalElement.x, y: originalElement.y, width: originalElement.width, height: originalElement.height },
    geometryAfterKeyboardEdit: nextGeometry,
    geometryAfterUndo: { x: finalUndoneElement.x, y: finalUndoneElement.y, width: finalUndoneElement.width, height: finalUndoneElement.height },
    textSvgBytes: Buffer.byteLength(svgText),
    textSvgViewBox: svgInfo.viewBox,
    fontAssetPath,
    reloadedSceneBytes: exportedBytes.byteLength,
  }, null, 2));
} finally {
  await context?.close();
  if (browser) await browser.close();
  await stopServer(server);
}
