import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
const DEFAULT_HOST_ROOT = existsSync(resolve(REPOSITORY_ROOT, "apps/standalone/scripts/serve.mjs"))
  ? REPOSITORY_ROOT
  : resolve(REPOSITORY_ROOT, "../scriptorium-atlas-host");
const HOST_ROOT = process.env.ATLAS_HOST_ROOT ?? DEFAULT_HOST_ROOT;
const HOST_SERVE_SCRIPT = resolve(HOST_ROOT, "apps/standalone/scripts/serve.mjs");
const PROFILE_ROOT = resolve(HOST_ROOT, "dist/story");
const BROWSER_PATH = process.env.ATLAS_E2E_CHROMIUM;
const { chromium } = createRequire(resolve(HOST_ROOT, "package.json"))("@playwright/test");

const CREATE_TYPES = [
  "character", "location", "faction", "item", "event", "lore", "thread", "arc", "volume", "chapter", "scene", "manuscript",
];

async function reserveBasePort() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = 36000 + Math.floor(Math.random() * 24000);
    const reservations = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = createServer();
        await new Promise((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolveListen);
        });
        reservations.push(server);
      }
      await Promise.all(reservations.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
      return base;
    } catch {
      await Promise.all(reservations.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
    }
  }
  throw new Error("Could not reserve three consecutive loopback ports for the Host static server.");
}

async function waitForServer(child, baseUrl) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Host static server exited early with status ${child.exitCode}.`);
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(500) });
      const ready = response.ok;
      await response.body?.cancel();
      if (ready) return;
    } catch {
      // The Host and Story ports may still be binding.
    }
    await delay(100);
  }
  throw new Error("Host static server did not become ready within 15 seconds.");
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(5000).then(() => false),
  ]);
  if (exited === false) {
    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

async function waitForValue(locator, predicate, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await locator.inputValue();
    if (predicate(lastValue)) return lastValue;
    await delay(100);
  }
  assert.fail(`${message}; last value was ${JSON.stringify(lastValue)}`);
}

async function openHostSourcePanel(page) {
  const summary = page.getByText("Workspaceのファイル・Source", { exact: true });
  const isOpen = await summary.evaluate((node) => node.parentElement?.hasAttribute("open"));
  if (!isOpen) await summary.click();
}

async function waitForEntity(story, name) {
  const item = story.getByRole("option").filter({ hasText: name }).first();
  await item.waitFor({ state: "visible" });
  return item;
}

async function waitForStoryReady(story) {
  await story.getByRole("heading", { name: "Story Knowledge", exact: true }).waitFor({ state: "visible" });
  await story.getByRole("heading", { name: "作成", exact: true }).waitFor({ state: "visible" });
}

function createCard(story) {
  return story.locator("article.card").filter({ has: story.getByRole("heading", { name: "作成", exact: true }) });
}

function deleteCard(story) {
  return story.locator("article.card").filter({ has: story.getByRole("heading", { name: "削除", exact: true }) });
}

function preview(story) {
  return story.locator('section[aria-label="変更案プレビュー"]');
}

async function hostCommit(page, story, expectedText) {
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.waitFor({ state: "visible" });
  if (expectedText) assert.ok((await proposal.innerText()).includes(expectedText), `Host durable proposal should contain ${expectedText}`);
  await proposal.getByRole("button", { name: "この変更を承認してCommit" }).click();
  await page.getByRole("status").filter({ hasText: "ローカルCommit完了:" }).waitFor({ state: "visible" });
  if (story) await waitForStoryReady(story);
}

async function submitPreview(page, story, expectedText) {
  const review = preview(story);
  await review.waitFor({ state: "visible" });
  if (expectedText) assert.ok((await review.innerText()).includes(expectedText), `Story preview should contain ${expectedText}`);
  await review.getByRole("button", { name: "HostのReviewへ変更案を提出" }).click();
  await story.getByRole("status").filter({ hasText: "HostのReviewへ変更案を提出しました" }).waitFor({ state: "visible" });
  await hostCommit(page, story);
}

async function createEntity(page, story, { type, name, volumeName, chapterName, manuscriptBody }) {
  const form = createCard(story);
  await form.getByLabel("種類").selectOption(type);
  await form.getByLabel("表示名").fill(name);
  await form.getByLabel("追加フィールド（JSON）").fill(JSON.stringify({ description: `Browser acceptance: ${type}` }));
  if (type === "chapter") {
    const select = form.getByLabel("親の巻");
    const value = await select.locator("option").filter({ hasText: volumeName }).getAttribute("value");
    assert.ok(value, `Volume option ${volumeName} must be available for a chapter.`);
    await select.selectOption(value);
  }
  if (type === "scene") {
    const select = form.getByLabel("親の章");
    const value = await select.locator("option").filter({ hasText: chapterName }).getAttribute("value");
    assert.ok(value, `Chapter option ${chapterName} must be available for a scene.`);
    await select.selectOption(value);
    await form.getByLabel("対応する原稿本文").fill(manuscriptBody ?? "受入テストの場面本文です。\n");
  }
  if (type === "manuscript") await form.getByLabel("原稿本文").fill(manuscriptBody ?? "受入テストの独立原稿です。\n");

  await form.getByRole("button", { name: "作成案をプレビュー" }).click();
  const changePreview = preview(story);
  try {
    await changePreview.waitFor({ state: "visible" });
  } catch (error) {
    const alerts = await story.getByRole("alert").allTextContents();
    const formText = await form.innerText();
    const invalidFields = await form.locator(":invalid").evaluateAll((nodes) => nodes.map((node) => ({
      label: node.getAttribute("aria-label"),
      value: node.value,
      validation: node.validationMessage,
    })));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; create alerts=${JSON.stringify(alerts)} invalid=${JSON.stringify(invalidFields)} form=${JSON.stringify(formText)}`);
  }
  assert.ok((await changePreview.innerText()).includes(name), `Create preview should describe ${name}.`);
  const paths = await changePreview.locator("tbody tr td:first-child").allTextContents();
  assert.ok(paths.length > 0, `${type} preview must contain at least one source write.`);
  if (type === "scene") assert.equal(paths.length, 2, "Scene creation must preview both the scene YAML and its manuscript.");
  assert.equal(paths.some((path) => path.endsWith(".md.md")), false, "Manuscript paths must have one Markdown extension.");
  await changePreview.getByRole("button", { name: "HostのReviewへ変更案を提出" }).click();
  await story.getByRole("status").filter({ hasText: "HostのReviewへ変更案を提出しました" }).waitFor({ state: "visible" });
  await hostCommit(page, story, name);
  await waitForEntity(story, name);
  return { type, name, previewPaths: paths };
}

async function chooseEntity(story, name) {
  await story.getByRole("button", { name: "ライブラリ", exact: true }).click();
  const item = await waitForEntity(story, name);
  await item.click();
  return story.locator("article.card").filter({ has: story.getByRole("heading", { name: new RegExp(`: ${escapeRegExp(name)}$`, "u") }) }).first();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createHostSource(page, story, path, content) {
  await openHostSourcePanel(page);
  await page.getByLabel("相対Path").fill(path);
  await openHostSourcePanel(page);
  await page.getByLabel("Source").fill(content);
  await page.getByRole("button", { name: "変更案を耐久記録して確認" }).click();
  const proposal = page.locator('section[aria-label="変更の承認"] article').last();
  await proposal.waitFor({ state: "visible" });
  assert.ok((await proposal.innerText()).includes(path), `Host proposal must contain source path ${path}.`);
  await proposal.getByRole("button", { name: "この変更を承認してCommit" }).click();
  await page.getByRole("status").filter({ hasText: "ローカルCommit完了:" }).waitFor({ state: "visible" });
  await waitForStoryReady(story);
}

async function runAcceptance({ browser, baseUrl }) {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(`${error.name}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  const evidence = { cases: [], createdTypes: [], workspaceId: "" };
  const prefix = `Story Browser ${Date.now().toString(36)}`;
  const names = {
    character: `${prefix} 主人公`,
    target: `${prefix} 相手役`,
    normal: `${prefix} 通常人物`,
    location: `${prefix} 場所`,
    faction: `${prefix} 組織`,
    item: `${prefix} 小道具`,
    event: `${prefix} 出来事`,
    lore: `${prefix} 設定`,
    thread: `${prefix} 伏線`,
    arc: `${prefix} アーク`,
    volume: `${prefix} 第一巻`,
    chapter: `${prefix} 第一章`,
    scene: `${prefix} 第一場面`,
    manuscript: `${prefix} 独立原稿`,
  };

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Scriptorium Atlas", exact: true }).waitFor();
    await page.getByLabel("Workspace名").fill(`${prefix} workspace`);
    await page.getByRole("button", { name: "空のWorkspaceを作成" }).click();
    await page.getByRole("status").filter({ hasText: "Workspaceを開きました。" }).waitFor();
    evidence.workspaceId = await page.getByLabel("開く").inputValue();
    assert.ok(evidence.workspaceId, "An empty Host workspace must receive a persistent ID.");
    const storyPanel = page.locator('section[aria-label="Story Knowledge Plugin"]');
    await storyPanel.getByText("接続中", { exact: true }).waitFor();
    const story = page.frameLocator('section[aria-label="Story Knowledge Plugin"] iframe');
    await waitForStoryReady(story);
    assert.equal(await page.locator('section[aria-label="Atlas Plugin"]').count(), 0, "Story-only profile must not load Atlas.");
    evidence.cases.push({
      id: "empty-host-workspace-and-story-only-frame",
      status: "PASS",
      evidence: { workspaceId: evidence.workspaceId, atlasPanelPresent: false },
    });

    await createEntity(page, story, { type: "character", name: names.character });
    evidence.createdTypes.push("character");
    const beforeReload = await (await waitForEntity(story, names.character)).innerText();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("開く").waitFor();
    await page.getByLabel("開く").selectOption(evidence.workspaceId);
    await page.getByRole("status").filter({ hasText: "Workspaceを開きました。" }).waitFor();
    const reloadedStory = page.frameLocator('section[aria-label="Story Knowledge Plugin"] iframe');
    await waitForStoryReady(reloadedStory);
    await waitForEntity(reloadedStory, names.character);
    const reloadedDetail = await chooseEntity(reloadedStory, names.character);
    await reloadedDetail.getByRole("heading", { name: `人物: ${names.character}`, exact: true }).waitFor();
    evidence.cases.push({
      id: "story-create-preview-host-commit-and-reload-detail",
      status: "PASS",
      evidence: { workspaceId: evidence.workspaceId, row: beforeReload.trim(), detailReloaded: true },
    });

    const createRows = [];
    for (const type of CREATE_TYPES.filter((candidate) => candidate !== "character")) {
      const item = await createEntity(page, reloadedStory, {
        type,
        name: names[type],
        volumeName: names.volume,
        chapterName: names.chapter,
        manuscriptBody: `受入テスト本文: ${names.scene}\n`,
      });
      createRows.push(item);
      evidence.createdTypes.push(type);
    }
    const target = await createEntity(page, reloadedStory, { type: "character", name: names.target });
    const normal = await createEntity(page, reloadedStory, { type: "character", name: names.normal });
    evidence.createdTypes.push("character", "character");
    evidence.cases.push({
      id: "create-all-ui-supported-story-entity-types-through-host-review",
      status: "PASS",
      evidence: { supportedCreateTypes: [...new Set(evidence.createdTypes)], writes: createRows.map(({ type, previewPaths }) => ({ type, previewPaths })), target: target.name, normal: normal.name },
    });

    const characterDetail = await chooseEntity(reloadedStory, names.character);
    const editedName = `${names.character} 改訂`;
    await characterDetail.getByLabel("表示名").fill(editedName);
    await characterDetail.getByRole("button", { name: "編集案をプレビュー" }).click();
    await submitPreview(page, reloadedStory, "を編集");
    await waitForEntity(reloadedStory, editedName);

    const locationDetail = await chooseEntity(reloadedStory, names.location);
    await deleteCard(reloadedStory).getByRole("button", { name: "削除案を確認" }).click();
    await preview(reloadedStory).waitFor({ state: "visible" });
    await submitPreview(page, reloadedStory, names.location);
    await reloadedStory.getByRole("option").filter({ hasText: names.location }).first().waitFor({ state: "detached" });
    evidence.cases.push({
      id: "entity-edit-and-delete-through-review",
      status: "PASS",
      evidence: { editedName, deletedEntity: names.location },
    });

    await chooseEntity(reloadedStory, editedName);
    const relationCard = reloadedStory.locator("article.card").filter({ has: reloadedStory.getByRole("heading", { name: "関連する項目", exact: true }) });
    const relationForm = relationCard.locator("form").filter({ has: reloadedStory.getByRole("heading", { name: "関連を追加", exact: true }) });
    const relationSelects = relationForm.getByRole("combobox");
    const targetSelect = relationSelects.nth(0);
    const targetOption = targetSelect.locator("option").filter({ hasText: names.target }).first();
    const targetOptionCount = await targetOption.count();
    assert.equal(targetOptionCount, 1, `Relation target must be selectable; options: ${JSON.stringify(await targetSelect.locator("option").allTextContents())}`);
    const targetValue = await targetOption.getAttribute("value");
    assert.ok(targetValue, "Relation target must expose its stable source ID.");
    await targetSelect.selectOption(targetValue);
    await relationSelects.nth(1).selectOption("related");
    await relationForm.getByLabel("Note", { exact: true }).fill("初期関係ノート");
    await relationForm.getByRole("button", { name: "関連追加案を作成" }).click();
    await submitPreview(page, reloadedStory, "関連を追加");
    const relationRow = relationCard.locator(".relation").filter({ hasText: editedName }).filter({ hasText: names.target }).first();
    await relationRow.waitFor({ state: "visible" });
    await relationRow.getByRole("button", { name: "編集フォーム" }).click();
    const editForm = reloadedStory.locator("details[open]").filter({ hasText: "関連編集フォーム" });
    await editForm.getByLabel("Kind").fill("appears");
    await editForm.getByLabel("Note").fill("編集後の関係ノート");
    await editForm.getByRole("button", { name: "関連編集案を作成" }).click();
    const relationEditPreview = preview(reloadedStory);
    await relationEditPreview.locator("details summary").first().click();
    const relationEditSource = relationEditPreview.locator("pre").first();
    await relationEditSource.waitFor({ state: "visible" });
    assert.ok((await relationEditSource.innerText()).includes("編集後の関係ノート"), "Relation preview must show the edited note in its source YAML.");
    await submitPreview(page, reloadedStory, "関連を編集");
    await relationCard.locator(".relation").filter({ hasText: "appears" }).waitFor({ state: "visible" });

    const targetDetail = await chooseEntity(reloadedStory, names.target);
    await deleteCard(reloadedStory).getByRole("button", { name: "削除案を確認" }).click();
    const incomingAlert = reloadedStory.getByRole("alert").filter({ hasText: "Incoming references must be removed explicitly" });
    await incomingAlert.waitFor({ state: "visible" });
    assert.ok((await incomingAlert.innerText()).includes("→"), "Delete protection must identify the incoming reference.");
    assert.equal(await preview(reloadedStory).count(), 0, "A referenced entity must not produce a delete preview by default.");

    const editableRelationRow = relationCard.locator(".relation").filter({ hasText: "appears" }).filter({ hasText: names.target }).first();
    await editableRelationRow.getByRole("button", { name: "削除案" }).click();
    await submitPreview(page, reloadedStory, "関連を削除");
    assert.equal(await relationCard.locator(".relation").count(), 0, "Deleting the relation must remove its visible edge.");
    evidence.cases.push({
      id: "directed-relation-create-edit-delete-and-incoming-delete-protection",
      status: "PASS",
      evidence: { from: editedName, to: names.target, editedKind: "appears", incomingDeleteBlocked: true, relationDeleted: true },
    });

    await reloadedStory.getByRole("button", { name: "巻・章・場面", exact: true }).click();
    const hierarchyRow = reloadedStory.getByRole("row").filter({ hasText: names.volume }).filter({ hasText: names.chapter }).filter({ hasText: names.scene });
    await hierarchyRow.waitFor({ state: "visible" });
    await hierarchyRow.getByRole("button", { name: names.scene, exact: true }).click();
    const sceneDetail = reloadedStory.locator("article.card").filter({ has: reloadedStory.getByRole("heading", { name: `場面: ${names.scene}`, exact: true }) });
    await sceneDetail.waitFor({ state: "visible" });
    await sceneDetail.getByRole("button", { name: "Sourceを開く", exact: true }).click();
    const hostSource = page.getByLabel("Source");
    const sceneYaml = await waitForValue(hostSource, (value) => value.includes(names.scene), "Host should navigate to the scene YAML source.");
    const manuscriptPathMatch = /^manuscript:\s*(.+)$/mu.exec(sceneYaml);
    assert.ok(manuscriptPathMatch?.[1], "Scene YAML must identify its paired manuscript path.");
    const manuscriptPath = manuscriptPathMatch[1].trim().replace(/^['"]|['"]$/gu, "");
    await page.getByRole("button", { name: manuscriptPath, exact: true }).click();
    const manuscriptSource = await waitForValue(hostSource, (value) => value.includes(`受入テスト本文: ${names.scene}`), "Host should open the scene's paired manuscript.");
    evidence.cases.push({
      id: "scene-hierarchy-navigation-and-host-source-open",
      status: "PASS",
      evidence: { volume: names.volume, chapter: names.chapter, scene: names.scene, sceneSourcePath: sceneDetail ? (await sceneDetail.innerText()).match(/plot\/volumes\/[^\s]+/)?.[0] ?? "visible" : "visible", manuscriptPath, manuscriptBytes: Buffer.byteLength(manuscriptSource) },
    });

    const characterIdentity = (await (await chooseEntity(reloadedStory, editedName)).locator(".pill").innerText()).split(" · ")[0];
    await createHostSource(page, reloadedStory, "bible/characters/broken.yaml", "id: [unterminated\ntype: character\nname: broken\n");
    await createHostSource(page, reloadedStory, "bible/characters/duplicate.yaml", `id: ${characterIdentity}\ntype: character\nname: Duplicate acceptance fixture\n`);
    const diagnosticTab = reloadedStory.getByRole("button", { name: /^診断/ });
    await diagnosticTab.click();
    const diagnosticTable = reloadedStory.locator("table").filter({ has: reloadedStory.getByRole("columnheader", { name: "Code", exact: true }) });
    const malformedRow = diagnosticTable.getByRole("row").filter({ hasText: "broken.yaml" });
    await malformedRow.waitFor({ state: "visible" });
    assert.match(await malformedRow.innerText(), /yaml-/u, "Malformed YAML must be listed with a parser diagnostic.");
    const duplicateRows = diagnosticTable.getByRole("row").filter({ hasText: "duplicate-entity-id" });
    const duplicateDiagnosticRows = await duplicateRows.count();
    assert.ok(duplicateDiagnosticRows >= 2, "Both duplicate ID sources must receive diagnostics.");
    const normalDetail = await chooseEntity(reloadedStory, names.normal);
    const normalNameInput = normalDetail.getByLabel("表示名");
    await normalNameInput.waitFor({ state: "visible" });
    assert.equal(await normalNameInput.isEnabled(), true, "Healthy Story entities must remain editable when malformed/duplicate files exist.");
    assert.equal(browserErrors.some((message) => message.includes("Blocked form submission")), false,
      "Story button actions must not attempt native form navigation in the sandboxed Plugin frame.");
    evidence.cases.push({
      id: "sandbox-safe-button-actions",
      status: "PASS",
      evidence: { nativeFormSubmissionBlocked: false },
    });
    evidence.cases.push({
      id: "malformed-yaml-and-duplicate-id-diagnostics-preserve-normal-entities",
      status: "PASS",
      evidence: { malformedPath: "bible/characters/broken.yaml", duplicateId: characterIdentity, duplicateDiagnosticRows, normalEntityEditable: names.normal },
    });

    return evidence;
  } catch (error) {
    if (error && typeof error === "object") Object.assign(error, { acceptanceEvidence: { ...evidence, browserErrors } });
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  await stat(resolve(PROFILE_ROOT, "index.html"));
  const basePort = await reserveBasePort();
  const baseUrl = `http://127.0.0.1:${basePort}`;
  const server = spawn(process.execPath, [HOST_SERVE_SCRIPT, "story"], {
    cwd: HOST_ROOT,
    env: { ...process.env, ATLAS_HOST_PORT: String(basePort) },
    stdio: "ignore",
  });
  let browser;
  let report;
  try {
    await waitForServer(server, baseUrl);
    browser = await chromium.launch({ headless: true, ...(BROWSER_PATH ? { executablePath: BROWSER_PATH } : {}) });
    const evidence = await runAcceptance({ browser, baseUrl });
    report = {
      schemaVersion: "atlas.story-ui-browser-acceptance/v1",
      scope: "Story-only built Host artifact; public Japanese UI and Host author/commit workflow only.",
      artifact: PROFILE_ROOT,
      browser: { name: "Chromium", version: browser.version(), executablePath: BROWSER_PATH ?? "Playwright-managed Chromium" },
      baseUrl,
      ...evidence,
      status: "PASS",
      exitStatus: 0,
    };
  } catch (error) {
    report = {
      schemaVersion: "atlas.story-ui-browser-acceptance/v1",
      scope: "Story-only built Host artifact; public Japanese UI and Host author/commit workflow only.",
      artifact: PROFILE_ROOT,
      baseUrl,
      ...(error && typeof error === "object" && "acceptanceEvidence" in error ? error.acceptanceEvidence : {}),
      status: "FAIL",
      error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
      exitStatus: 1,
    };
  } finally {
    await browser?.close();
    await stopServer(server);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.exitStatus;
}

await main();
