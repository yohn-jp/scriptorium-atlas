import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const hostRoot = process.env.ATLAS_HOST_ROOT;
if (!hostRoot) {
  throw new Error("Set ATLAS_HOST_ROOT to the Host checkout with dist/atlas and its standalone server script.");
}

const browserPath = process.env.ATLAS_E2E_CHROMIUM;
const requireFromHost = createRequire(resolve(hostRoot, "package.json"));
const { chromium } = requireFromHost("@playwright/test");
const serverScript = resolve(hostRoot, "apps/standalone/scripts/serve.mjs");
const atlasArtifact = resolve(hostRoot, "dist/atlas");
await access(atlasArtifact);
await access(serverScript);

const testPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/az8AAAAASUVORK5CYII=",
  "base64",
);

async function reservePorts() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = 36000 + Math.floor(Math.random() * 24000);
    const servers = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = createServer();
        await new Promise((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolveListen);
        });
        servers.push(server);
      }
      await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
      return base;
    } catch {
      await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
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
      // The Host and Atlas frame listeners can take a moment to bind.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Atlas Host did not become ready within 15 seconds.");
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (stopped === false) {
    server.kill("SIGKILL");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  }
}

async function commitPending(page, atlas) {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  try {
    await proposal.waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    const hostText = await page.locator("body").innerText();
    const atlasText = await atlas.locator("body").innerText();
    throw new Error(
      `Host did not receive the prepared Canvas change. Host: ${hostText.slice(-1_000)}. ` +
      `Atlas: ${atlasText.slice(-1_200)}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const priorReceipts = await page.getByRole("status").filter({ hasText: "ローカルCommit完了:" }).allTextContents();
  const proposedFiles = await proposal.locator("details").evaluateAll((details) => details.map((detail) => {
    const blocks = [...detail.querySelectorAll("pre")];
    return {
      path: detail.querySelector("summary")?.textContent?.trim() ?? "",
      beforeText: blocks[0]?.textContent ?? null,
      afterText: blocks[1]?.textContent ?? null,
    };
  }));
  await proposal.getByRole("button", { name: "この変更を承認してCommit" }).click();
  await proposal.waitFor({ state: "detached", timeout: 20_000 });

  const receipt = page.getByRole("status").filter({ hasText: "ローカルCommit完了:" }).last();
  const deadline = Date.now() + 20_000;
  let receiptText = "";
  while (Date.now() < deadline) {
    receiptText = await receipt.textContent().catch(() => "") ?? "";
    if (receiptText && !priorReceipts.includes(receiptText)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(receiptText && !priorReceipts.includes(receiptText), "Host must publish a new local commit receipt for each Canvas proposal.");
  return { receiptText, proposedFiles };
}

async function waitForPendingProposal(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  const proposals = page.locator('section[aria-label="変更の承認"] article');
  while (Date.now() < deadline) {
    if (await proposals.count()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`No Host proposal appeared within ${timeout} ms.`);
}

async function commitSceneUntilCurrent(page, atlas, expectedSceneBytes) {
  const expectedText = expectedSceneBytes.toString("utf8");
  const committed = [];
  let finalScenePath = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await waitForPendingProposal(page);
    const result = await commitPending(page, atlas);
    committed.push(result);
    const scene = result.proposedFiles.find(({ path }) => path.endsWith(".excalidraw"));
    if (scene?.afterText === expectedText) {
      finalScenePath = scene.path;
      const anotherProposalDeadline = Date.now() + 1_200;
      const proposals = page.locator('section[aria-label="変更の承認"] article');
      let anotherProposal = false;
      while (Date.now() < anotherProposalDeadline) {
        if (await proposals.count()) {
          anotherProposal = true;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      if (!anotherProposal) return { committed, scenePath: finalScenePath };
    }
  }
  const last = committed.at(-1);
  const lastScene = last?.proposedFiles.find(({ path }) => path.endsWith(".excalidraw"));
  throw new Error(
    `Host did not commit the current Canvas scene after ${committed.length} approved proposals. ` +
    `Expected ${expectedSceneBytes.byteLength} bytes / sha256 ${createHash("sha256").update(expectedSceneBytes).digest("hex")}; ` +
    `last scene ${lastScene?.path ?? "missing"} had ${lastScene?.afterText?.length ?? 0} characters.`,
  );
}

async function downloadScene(page, atlas) {
  const downloadPromise = page.waitForEvent("download");
  await atlas.getByRole("button", { name: ".excalidrawをエクスポート" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `Scene download ${download.suggestedFilename()} must have a readable temporary path.`);
  const bytes = await readFile(path);
  return { name: download.suggestedFilename(), bytes, text: bytes.toString("utf8"), data: JSON.parse(bytes.toString("utf8")) };
}

async function chooseTool(page, editor, name) {
  const radio = editor.getByRole("radio", { name, exact: true });
  // Excalidraw visually renders its accessible radio inside a label; clicking
  // that visible label is the same pointer flow a user uses on the toolbar.
  await radio.locator("xpath=..").click();
  await radio.waitFor({ state: "visible" });
}

async function dragInEditor(page, editor, start, end, steps = 8) {
  const bounds = await editor.boundingBox();
  assert.ok(bounds && bounds.width > 240 && bounds.height > 240, "Excalidraw must have a usable drawing area.");
  await page.mouse.move(bounds.x + start.x, bounds.y + start.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + end.x, bounds.y + end.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

function geometry(elements) {
  return elements.map((element) => ({
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    groupIds: element.groupIds,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

const basePort = await reservePorts();
const baseUrl = `http://127.0.0.1:${basePort}/`;
const server = spawn(process.execPath, [serverScript, "atlas"], {
  cwd: hostRoot,
  env: {
    ...process.env,
    ATLAS_HOST_PORT: String(basePort),
    ATLAS_PLUGIN_PORT: String(basePort + 1),
    ATLAS_STORY_PORT: String(basePort + 2),
  },
  stdio: "ignore",
});

let browser;
let context;
try {
  await waitForServer(server, baseUrl);
  browser = await chromium.launch({
    headless: true,
    ...(browserPath ? { executablePath: browserPath } : {}),
  });
  context = await browser.newContext({
    acceptDownloads: true,
    locale: "ja-JP",
    viewport: { width: 1600, height: 1200 },
  });

  const fontRequests = [];
  const fontResponses = [];
  const fontFailures = [];
  context.on("request", (request) => {
    if (/\.(?:woff2?|ttf|otf)(?:$|[?#])/iu.test(request.url())) {
      fontRequests.push({ url: request.url(), resourceType: request.resourceType() });
    }
  });
  context.on("response", (response) => {
    if (/\.(?:woff2?|ttf|otf)(?:$|[?#])/iu.test(response.url())) {
      fontResponses.push({ url: response.url(), status: response.status() });
    }
  });
  context.on("requestfailed", (request) => {
    if (/\.(?:woff2?|ttf|otf)(?:$|[?#])/iu.test(request.url())) {
      fontFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" });
    }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Workspace名").fill(`Canvas browser ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "空のWorkspaceを作成" }).click();
  await page.getByRole("status").filter({ hasText: "Workspaceを開きました。" }).waitFor();
  const workspaceId = await page.getByLabel("開く").inputValue();

  const atlas = page.frameLocator('iframe[title="Atlas"]');
  await atlas.getByRole("button", { name: "ボードを作成", exact: true }).click();
  const boardNameInput = atlas.getByLabel("ボード名");
  await boardNameInput.waitFor({ state: "visible" });
  const boardName = await boardNameInput.inputValue();
  const boardCommit = await commitPending(page, atlas);
  assert.ok(boardCommit.proposedFiles.some(({ path }) => path.endsWith(".atlas.json")),
    "The initial board must be prepared through Host review.");

  await atlas.getByLabel("ビューを追加").selectOption("freeform");
  await atlas.getByText("Canvasの図形はExcalidrawシーンに、カードはAtlasボードに保存されます。", { exact: true }).waitFor();
  const sceneCommit = await commitPending(page, atlas);
  assert.ok(sceneCommit.proposedFiles.some(({ path }) => path.endsWith(".excalidraw")),
    "An empty freeform view must create a separate Excalidraw scene file.");

  await atlas.getByRole("tab", { name: /キャンバス/u }).last().click();
  const editor = atlas.locator(".excalidraw");
  await editor.waitFor({ state: "visible" });
  const frame = await page.locator('iframe[title="Atlas"]').elementHandle().then((handle) => handle.contentFrame());
  assert.ok(frame, "Atlas must run in its Host-owned frame.");
  const initialLayout = await editor.boundingBox();
  assert.ok(initialLayout && initialLayout.width >= 240 && initialLayout.height >= 240,
    `The real Excalidraw surface must be visible; received ${JSON.stringify(initialLayout)}.`);

  const assetPath = await frame.evaluate(() => globalThis.EXCALIDRAW_ASSET_PATH);
  assert.equal(new URL(assetPath).origin, new URL(frame.url()).origin, "Canvas fonts must use the Atlas frame's own origin.");
  assert.ok(assetPath.endsWith("/"), "The Excalidraw asset path must be a directory URL.");

  await chooseTool(page, editor, "矩形");
  await dragInEditor(page, editor, { x: 300, y: 170 }, { x: 380, y: 230 });
  await chooseTool(page, editor, "矩形");
  await dragInEditor(page, editor, { x: 420, y: 170 }, { x: 500, y: 230 });

  await chooseTool(page, editor, "選択");
  await dragInEditor(page, editor, { x: 280, y: 145 }, { x: 530, y: 260 });
  await page.keyboard.press("Control+g");
  await page.waitForTimeout(500);

  await chooseTool(page, editor, "矢印");
  await dragInEditor(page, editor, { x: 560, y: 180 }, { x: 650, y: 230 });
  await chooseTool(page, editor, "描画");
  await dragInEditor(page, editor, { x: 680, y: 180 }, { x: 760, y: 230 }, 12);

  await chooseTool(page, editor, "テキスト");
  let bounds = await editor.boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + 800, bounds.y + 180);
  const textEditor = editor.locator("textarea.excalidraw-wysiwyg");
  await textEditor.waitFor({ state: "visible" });
  await page.keyboard.type("Canvas browser text");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(500);

  const imageChooserPromise = page.waitForEvent("filechooser");
  await chooseTool(page, editor, "画像を挿入");
  const imageChooser = await imageChooserPromise;
  await imageChooser.setFiles({ name: "canvas-browser.png", mimeType: "image/png", buffer: testPng });
  bounds = await editor.boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + 800, bounds.y + 300);
  await page.waitForTimeout(700);

  const initialScene = await downloadScene(page, atlas);
  const initialElements = initialScene.data.elements.filter((element) => !element.isDeleted);
  const elementsByType = (type) => initialElements.filter((element) => element.type === type);
  assert.equal(elementsByType("rectangle").length, 2, "Two user-drawn rectangles must remain in the scene.");
  assert.equal(elementsByType("arrow").length, 1, "A user-drawn arrow must be present.");
  assert.equal(elementsByType("freedraw").length, 1, "A user-drawn freehand stroke must be present.");
  assert.equal(elementsByType("text").length, 1, "The text tool must persist its typed content.");
  assert.equal(elementsByType("text")[0].text, "Canvas browser text");
  assert.equal(elementsByType("image").length, 1, "The UI image chooser must create an image element.");

  const groupedRects = elementsByType("rectangle").filter((element) => element.groupIds?.length);
  assert.equal(groupedRects.length, 2, "The UI selection marquee and Ctrl+G must group both rectangles.");
  assert.equal(groupedRects[0].groupIds[0], groupedRects[1].groupIds[0], "Grouped rectangles must share an Excalidraw group ID.");

  const image = elementsByType("image")[0];
  const imageFile = initialScene.data.files?.[image.fileId];
  assert.ok(imageFile, "The image element must retain its official BinaryFileData entry.");
  assert.equal(imageFile.mimeType, "image/png");
  assert.match(imageFile.dataURL, /^data:image\/png;base64,/u);
  const embeddedPng = Buffer.from(imageFile.dataURL.slice(imageFile.dataURL.indexOf(",") + 1), "base64");
  assert.deepEqual(embeddedPng.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "The official Excalidraw image file data must contain a valid PNG.");
  assert.equal(embeddedPng.readUInt32BE(16), 1, "The embedded image must retain its one-pixel width.");
  assert.equal(embeddedPng.readUInt32BE(20), 1, "The embedded image must retain its one-pixel height.");

  const undo = editor.getByRole("button", { name: "元に戻す" });
  const redo = editor.getByRole("button", { name: "やり直し" });
  assert.equal(await undo.isEnabled(), true, "Excalidraw undo must be enabled after real drawing gestures.");
  await undo.click();
  const undoneScene = await downloadScene(page, atlas);
  assert.equal(undoneScene.data.elements.filter((element) => !element.isDeleted && element.type === "image").length, 0,
    "Undo must remove the most recently placed image from the active scene.");
  assert.equal(await redo.isEnabled(), true, "Redo must become available after undo.");
  await redo.click();
  const redoneScene = await downloadScene(page, atlas);
  const restoredImage = redoneScene.data.elements.find((element) => !element.isDeleted && element.type === "image");
  assert.ok(restoredImage, "Redo must restore the image element.");
  assert.equal(restoredImage.id, image.id, "Undo/redo must preserve the image element ID.");
  assert.deepEqual(geometry(redoneScene.data.elements.filter((element) => !element.isDeleted)), geometry(initialElements),
    "Undo/redo must restore the same element IDs, group IDs, and scene positions.");

  const importInput = atlas.locator('input[type="file"][accept=".excalidraw,application/json"]');
  await importInput.setInputFiles({
    name: "canvas-roundtrip.excalidraw",
    mimeType: "application/json",
    buffer: redoneScene.bytes,
  });
  await atlas.getByText(/シーンを.*ローカル下書きにインポートしました/u).waitFor();
  await editor.waitFor({ state: "visible" });
  const reimportedScene = await downloadScene(page, atlas);
  assert.deepEqual(reimportedScene.bytes, redoneScene.bytes,
    "Importing and exporting the unchanged scene must preserve every original JSON byte.");

  const expectedSceneBytes = reimportedScene.bytes;
  const drawingChanges = await commitSceneUntilCurrent(page, atlas, expectedSceneBytes);
  const drawingScenePath = drawingChanges.scenePath;
  const drawingSceneFile = drawingChanges.committed.flatMap(({ proposedFiles }) => proposedFiles)
    .find(({ path, afterText }) => path === drawingScenePath && afterText === expectedSceneBytes.toString("utf8"));
  assert.ok(drawingSceneFile, `The current scene must be prepared as a separate Host file at ${drawingScenePath}.`);
  const proposedSceneBytes = Buffer.from(drawingSceneFile.afterText, "utf8");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("開く").waitFor({ state: "visible" });
  await page.getByLabel("開く").selectOption(workspaceId);
  await page.getByRole("status").filter({ hasText: "Workspaceを開きました。" }).waitFor();
  await page.locator('details').filter({ has: page.getByText("Workspaceのファイル・Source", { exact: true }) }).locator("summary").click();
  await page.getByRole("button", { name: drawingScenePath, exact: true }).click();
  const sourceDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "原文をダウンロード", exact: true }).click();
  const sourceFile = await sourceDownload;
  const sourceFilePath = await sourceFile.path();
  assert.ok(sourceFilePath, `Host stored scene ${drawingScenePath} must be downloadable.`);
  const storedSceneBytes = await readFile(sourceFilePath);
  assert.deepEqual(storedSceneBytes, proposedSceneBytes,
    `Host stored bytes at ${drawingScenePath} must equal the approved scene proposal.`);
  const reloadedAtlas = page.frameLocator('iframe[title="Atlas"]');
  await reloadedAtlas.locator(".atlas-board-tab-title").filter({ hasText: boardName }).waitFor({ state: "visible" });
  await reloadedAtlas.getByRole("tab", { name: /キャンバス/u }).last().click();
  const reloadedEditor = reloadedAtlas.locator(".excalidraw");
  await reloadedEditor.waitFor({ state: "visible" });
  const reloadedLayout = await reloadedEditor.boundingBox();
  assert.ok(reloadedLayout && reloadedLayout.width >= 240 && reloadedLayout.height >= 240,
    "The committed Canvas must be visible after a Host page reload.");
  const reloadedScene = await downloadScene(page, reloadedAtlas);
  assert.deepEqual(reloadedScene.bytes, storedSceneBytes,
    `Atlas reload of ${drawingScenePath} must preserve the Host-stored scene bytes (Host ${storedSceneBytes.byteLength}, Atlas ${reloadedScene.bytes.byteLength}).`);

  const reloadedElements = reloadedScene.data.elements.filter((element) => !element.isDeleted);
  assert.deepEqual(geometry(reloadedElements), geometry(initialElements),
    "Host reload must preserve scene element IDs, positions, and group membership.");

  const reloadedFrame = await page.locator('iframe[title="Atlas"]').elementHandle().then((handle) => handle.contentFrame());
  assert.ok(reloadedFrame);
  const fontProbe = await reloadedFrame.evaluate(async () => {
    const font = [...document.fonts].find((candidate) => candidate.family === "Cascadia");
    if (!font) return { missing: true };
    try {
      await font.load();
      return { family: font.family, status: font.status };
    } catch (error) {
      return { family: font.family, status: font.status, error: String(error) };
    }
  });
  assert.equal(fontProbe.status, "loaded", `The official Canvas font face must load: ${JSON.stringify(fontProbe)}.`);
  const atlasOrigin = new URL(await reloadedFrame.evaluate(() => location.href)).origin;
  const localFont = fontResponses.find((response) => response.url === `${atlasOrigin}/fonts/Cascadia/CascadiaCode-Regular.woff2`);
  assert.equal(localFont?.status, 200, "The bundled Excalidraw font must be fetched from same-origin /fonts/ with HTTP 200.");
  const remoteFontResponses = fontResponses.filter((response) => new URL(response.url).origin !== atlasOrigin);
  assert.deepEqual(remoteFontResponses, [], "Excalidraw fonts must not load from an external origin.");
  const externalFontFailures = fontFailures.filter((failure) => new URL(failure.url).origin !== atlasOrigin);
  assert.ok(externalFontFailures.length > 0,
    "Excalidraw's official remote fallback attempts must be blocked by the Host's restrictive CSP.");
  assert.ok(externalFontFailures.every(({ error }) => /csp/iu.test(error)),
    `Every external font fallback must be CSP-blocked: ${JSON.stringify([...new Set(externalFontFailures.map(({ error }) => error))])}.`);

  assert.deepEqual(pageErrors, [], `The Host or Canvas frame must not throw browser errors: ${pageErrors.join("; ")}`);
  console.log(JSON.stringify({
    status: "PASS",
    case: "real Excalidraw drawing, grouping, image embed, undo/redo, scene roundtrip, Host commit and reload",
    browser: browser.version(),
    artifact: atlasArtifact,
    workspaceId,
    boardName,
    sceneBytes: reloadedScene.bytes.byteLength,
    elements: reloadedElements.map(({ id, type, x, y, width, height }) => ({ id, type, x, y, width, height })),
    groupId: groupedRects[0].groupIds[0],
    fontAssetPath: assetPath,
    fontProbe,
    localFontResponse: localFont,
    externalFontFallbackAttemptsBlocked: externalFontFailures.length,
    hostCommits: 2 + drawingChanges.committed.length,
    drawingProposalsApproved: drawingChanges.committed.length,
    hostScenePath: drawingScenePath,
    sceneSha256: createHash("sha256").update(reloadedScene.bytes).digest("hex"),
  }, null, 2));
} finally {
  await context?.close();
  await browser?.close();
  await stopServer(server);
}
