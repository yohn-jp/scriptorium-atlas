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
const EXTERNAL_BASE_URL = process.env.ATLAS_E2E_URL;
const PROFILE_NAME = process.env.ATLAS_E2E_PROFILE ?? (EXTERNAL_BASE_URL ? "combined" : "story");
const PROFILE_ROOT = resolve(HOST_ROOT, `dist/${PROFILE_NAME}`);
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
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
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

async function waitForText(locator, predicate, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await locator.innerText();
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
  const listbox = story.getByRole("listbox", { name: "Story項目" });
  const item = listbox.getByRole("option").filter({ hasText: name }).first();
  try {
    await item.waitFor({ state: "visible" });
  } catch (error) {
    const currentOptions = await listbox.getByRole("option").allInnerTexts().catch(() => []);
    const type = await story.locator('aside[aria-label="Storyエンティティ一覧"]').getByLabel("種類").inputValue().catch(() => "unavailable");
    const query = await story.locator('aside[aria-label="Storyエンティティ一覧"]').getByLabel("検索").inputValue().catch(() => "unavailable");
    throw new Error(`Story entity '${name}' was not visible. Filter=${type}, query=${JSON.stringify(query)}, options=${JSON.stringify(currentOptions)}`, { cause: error });
  }
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

async function createEntity(page, story, { type, name, volumeName, chapterName, manuscriptBody, fields }) {
  const form = createCard(story);
  await form.getByLabel("種類").selectOption(type);
  await form.getByLabel("表示名").fill(name);
  await form.getByLabel("追加フィールド（JSON）").fill(JSON.stringify({ description: `Browser acceptance: ${type}`, ...fields }));
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

async function chooseEntity(story, name, type) {
  await story.getByRole("button", { name: "ライブラリ", exact: true }).click();
  const library = story.locator('aside[aria-label="Storyエンティティ一覧"]');
  await library.getByLabel("検索").fill("");
  await library.getByLabel("種類").selectOption(type ?? "all");
  const item = await waitForEntity(story, name);
  await item.click();
  return story.locator("article.card").filter({ has: story.getByRole("heading", { name: new RegExp(`: ${escapeRegExp(name)}$`, "u") }) }).first();
}

const TYPE_LABELS = { character: "人物", location: "場所", thread: "伏線", scene: "場面" };

async function createRelation(page, story, { from, fromType, to, toType, kind, note }) {
  await chooseEntity(story, from, fromType);
  const relationCard = story.locator("article.card").filter({ has: story.getByRole("heading", { name: "関連する項目", exact: true }) });
  const relationForm = relationCard.locator("form").filter({ has: story.getByRole("heading", { name: "関連を追加", exact: true }) });
  const targetSelect = relationForm.getByRole("combobox").nth(0);
  const targetOption = targetSelect.locator("option").filter({ hasText: to }).filter({ hasText: TYPE_LABELS[toType] }).first();
  const targetValue = await targetOption.getAttribute("value");
  assert.ok(targetValue, `Relation target '${to}' must be selectable.`);
  await targetSelect.selectOption(targetValue);
  await relationForm.getByRole("combobox").nth(1).selectOption(kind);
  if (note) await relationForm.getByLabel("Note", { exact: true }).fill(note);
  await relationForm.getByRole("button", { name: "関連追加案を作成" }).click();
  await submitPreview(page, story, "関連を追加");
  const row = relationCard.locator(".relation").filter({ hasText: from }).filter({ hasText: to }).filter({ hasText: kind }).first();
  await row.waitFor({ state: "visible" });
  const text = await row.innerText();
  assert.ok(text.includes(`${from} → ${to}`), `Story relation must retain the source direction: ${text}`);
  return text;
}

async function editTimelineField(page, story, entityName, field, value) {
  const detail = await chooseEntity(story, entityName, "event");
  const additionalFields = detail.locator("details").filter({ hasText: "Sourceのその他のフィールド" });
  await additionalFields.locator("summary").click();
  await additionalFields.getByLabel("Field名").fill(field);
  await additionalFields.getByLabel("JSON値").fill(JSON.stringify(value));
  await additionalFields.getByRole("button", { name: "Field編集案を作成" }).click();
  await submitPreview(page, story, `「${field}」を編集`);
}

async function deleteRelation(page, story, { from, fromType, to, kind }) {
  await chooseEntity(story, from, fromType);
  const relationCard = story.locator("article.card").filter({ has: story.getByRole("heading", { name: "関連する項目", exact: true }) });
  const row = relationCard.locator(".relation").filter({ hasText: from }).filter({ hasText: to }).filter({ hasText: kind }).first();
  await row.getByRole("button", { name: "削除案" }).click();
  await submitPreview(page, story, "関連を削除");
  await row.waitFor({ state: "detached" });
}

async function deleteEntity(page, story, entityName, type) {
  await chooseEntity(story, entityName, type);
  await deleteCard(story).getByRole("button", { name: "削除案を確認" }).click();
  const alert = story.getByRole("alert");
  if (await alert.count()) assert.equal(await alert.count(), 0, `Unexpected delete protection for '${entityName}'.`);
  await preview(story).waitFor({ state: "visible" });
  await submitPreview(page, story, entityName);
  const library = story.locator('aside[aria-label="Storyエンティティ一覧"]');
  await library.getByRole("listbox", { name: "Story項目" }).getByRole("option").filter({ hasText: entityName }).first().waitFor({ state: "detached" });
}

async function editEntityName(page, story, entityName, nextName, type) {
  const detail = await chooseEntity(story, entityName, type);
  await detail.getByLabel("表示名").fill(nextName);
  await detail.getByRole("button", { name: "編集案をプレビュー" }).click();
  await submitPreview(page, story, "を編集");
  await waitForEntity(story, nextName);
  return nextName;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createHostSource(page, story, path, content) {
  await openHostSourcePanel(page);
  await page.getByLabel("相対Path").fill(path);
  await openHostSourcePanel(page);
  await page.getByLabel("Source", { exact: true }).fill(content);
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
    sceneManuscript: `${prefix} 第一場面`,
    manuscript: `${prefix} 独立原稿`,
    laterEvent: `${prefix} 後の出来事`,
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
    const atlasPanel = page.locator('section[aria-label="Atlas Plugin"]');
    const atlasPresent = await atlasPanel.count() > 0;
    assert.equal(atlasPresent, PROFILE_NAME === "combined", `${PROFILE_NAME} profile plugin closure does not match its expected Atlas presence.`);
    const atlas = atlasPresent ? page.frameLocator('section[aria-label="Atlas Plugin"] iframe') : undefined;
    const initialSourceRevision = atlas ? await waitForText(atlas.locator("body"), (text) => /ソースリビジョン:\s*[a-f0-9]{64}/iu.test(text), "Atlas must show its initial Host source revision.").then((text) => /ソースリビジョン:\s*([a-f0-9]{64})/iu.exec(text)?.[1]) : undefined;
    if (atlas) {
      assert.ok(initialSourceRevision, "Combined Atlas must expose a complete initial source revision.");
      const storyRevision = story.locator(".topline .badge").filter({ hasText: "revision" });
      await storyRevision.waitFor({ state: "visible" });
      assert.equal(await storyRevision.getAttribute("title"), initialSourceRevision, "Combined Story and Atlas must begin from the same Host source revision.");
    }
    evidence.cases.push({
      id: PROFILE_NAME === "combined" ? "empty-host-workspace-and-combined-plugin-frames" : "empty-host-workspace-and-story-only-frame",
      status: "PASS",
      evidence: { workspaceId: evidence.workspaceId, atlasPanelPresent: atlasPresent },
    });

    await createEntity(page, story, { type: "character", name: names.character });
    evidence.createdTypes.push("character");
    if (atlas && initialSourceRevision) {
      const nextRevision = await waitForText(atlas.locator("body"), (text) => {
        const revision = /ソースリビジョン:\s*([a-f0-9]{64})/iu.exec(text)?.[1];
        return !!revision && revision !== initialSourceRevision;
      }, "Atlas must observe the Host source revision after Story commits a new entity.").then((text) => /ソースリビジョン:\s*([a-f0-9]{64})/iu.exec(text)?.[1]);
      assert.ok(nextRevision, "Atlas must expose the updated full source revision.");
      const storyRevisionBadge = story.locator(".topline .badge").filter({ hasText: "revision" });
      const storyRevision = await storyRevisionBadge.getAttribute("title");
      assert.equal(storyRevision, nextRevision, "Story and Atlas must report the same post-commit Host source revision.");
      evidence.cases.push({
        id: "combined-story-and-atlas-observe-one-source-revision",
        status: "PASS",
        evidence: { previousRevision: initialSourceRevision, sourceRevision: nextRevision, storyRevision },
      });
    }
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
        ...(type === "event" ? { fields: { date: "2042-05-10", time: "09:00" } } : {}),
      });
      createRows.push(item);
      evidence.createdTypes.push(type);
    }
    const laterEvent = await createEntity(page, reloadedStory, {
      type: "event",
      name: names.laterEvent,
      fields: { date: "2042-05-20", time: "14:30" },
    });
    const target = await createEntity(page, reloadedStory, { type: "character", name: names.target });
    const normal = await createEntity(page, reloadedStory, { type: "character", name: names.normal });
    evidence.createdTypes.push("event", "character", "character");
    evidence.cases.push({
      id: "create-all-ui-supported-story-entity-types-through-host-review",
      status: "PASS",
      evidence: { supportedCreateTypes: [...new Set(evidence.createdTypes)], writes: createRows.map(({ type, previewPaths }) => ({ type, previewPaths })), target: target.name, normal: normal.name, laterEvent: laterEvent.name },
    });

    const characterDetail = await chooseEntity(reloadedStory, names.character);
    const editedName = `${names.character} 改訂`;
    await characterDetail.getByLabel("表示名").fill(editedName);
    await characterDetail.getByRole("button", { name: "編集案をプレビュー" }).click();
    await submitPreview(page, reloadedStory, "を編集");
    await waitForEntity(reloadedStory, editedName);
    names.character = editedName;

    const editedEntityNames = { character: editedName };
    for (const type of CREATE_TYPES.filter((candidate) => candidate !== "character")) {
      const entityName = names[type];
      const nextName = `${entityName} 編集`;
      editedEntityNames[type] = await editEntityName(page, reloadedStory, entityName, nextName, type);
      names[type] = nextName;
    }
    evidence.cases.push({
      id: "edit-every-ui-supported-story-entity-type-through-host-review",
      status: "PASS",
      evidence: { editedTypes: Object.keys(editedEntityNames), names: editedEntityNames },
    });

    await chooseEntity(reloadedStory, names.location);
    await deleteCard(reloadedStory).getByRole("button", { name: "削除案を確認" }).click();
    await preview(reloadedStory).waitFor({ state: "visible" });
    await submitPreview(page, reloadedStory, names.location);
    await reloadedStory.getByRole("option").filter({ hasText: names.location }).first().waitFor({ state: "detached" });
    const storyLocation = await createEntity(page, reloadedStory, { type: "location", name: `${prefix} 伏線の場所` });
    names.storyLocation = storyLocation.name;
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

    await chooseEntity(reloadedStory, names.target);
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

    const sceneAppearance = await createRelation(page, reloadedStory, { from: names.scene, fromType: "scene", to: names.target, toType: "character", kind: "appears", note: "場面に人物が登場" });
    const scenePov = await createRelation(page, reloadedStory, { from: names.scene, fromType: "scene", to: names.target, toType: "character", kind: "pov", note: "視点人物" });
    const sceneLocation = await createRelation(page, reloadedStory, { from: names.scene, fromType: "scene", to: names.storyLocation, toType: "location", kind: "location", note: "舞台" });
    const threadPlanted = await createRelation(page, reloadedStory, { from: names.thread, fromType: "thread", to: names.scene, toType: "scene", kind: "planted", note: "伏線提示" });
    const threadAdvanced = await createRelation(page, reloadedStory, { from: names.thread, fromType: "thread", to: names.scene, toType: "scene", kind: "advances", note: "伏線進行" });
    const threadPayoff = await createRelation(page, reloadedStory, { from: names.thread, fromType: "thread", to: names.scene, toType: "scene", kind: "payoff", note: "明示された回収" });
    const scenePlantsThread = await createRelation(page, reloadedStory, { from: names.scene, fromType: "scene", to: names.thread, toType: "thread", kind: "plants", note: "Scene側の伏線記述" });
    evidence.cases.push({
      id: "scene-appearance-pov-location-and-directed-thread-lifecycle",
      status: "PASS",
      evidence: { sceneAppearance, scenePov, sceneLocation, threadPlanted, threadAdvanced, threadPayoff, scenePlantsThread },
    });

    await reloadedStory.getByRole("button", { name: "巻・章・場面", exact: true }).click();
    const hierarchyRow = reloadedStory.getByRole("row").filter({ hasText: names.volume }).filter({ hasText: names.chapter }).filter({ hasText: names.scene });
    await hierarchyRow.waitFor({ state: "visible" });
    await hierarchyRow.getByRole("button", { name: names.scene, exact: true }).click();
    const sceneDetail = reloadedStory.locator("article.card").filter({ has: reloadedStory.getByRole("heading", { name: `場面: ${names.scene}`, exact: true }) });
    await sceneDetail.waitFor({ state: "visible" });
    await sceneDetail.getByRole("button", { name: "Sourceを開く", exact: true }).click();
    const hostSource = page.getByLabel("Source", { exact: true });
    const sceneYaml = await waitForValue(hostSource, (value) => value.includes(names.scene), "Host should navigate to the scene YAML source.");
    const manuscriptPathMatch = /^manuscript:\s*(.+)$/mu.exec(sceneYaml);
    assert.ok(manuscriptPathMatch?.[1], "Scene YAML must identify its paired manuscript path.");
    const manuscriptPath = manuscriptPathMatch[1].trim().replace(/^['"]|['"]$/gu, "");
    await page.getByRole("button", { name: manuscriptPath, exact: true }).click();
    const originalSceneName = names.scene.replace(/ 編集$/u, "");
    const manuscriptSource = await waitForValue(
      hostSource,
      (value) => value.includes("type: manuscript") && value.includes(`受入テスト本文: ${originalSceneName}`),
      "Host should open the scene's paired manuscript.",
    );
    evidence.cases.push({
      id: "scene-hierarchy-navigation-and-host-source-open",
      status: "PASS",
      evidence: { volume: names.volume, chapter: names.chapter, scene: names.scene, sceneSourcePath: sceneDetail ? (await sceneDetail.innerText()).match(/plot\/volumes\/[^\s]+/)?.[0] ?? "visible" : "visible", manuscriptPath, manuscriptBytes: Buffer.byteLength(manuscriptSource) },
    });

    await reloadedStory.getByRole("button", { name: "タイムライン", exact: true }).click();
    const timeline = reloadedStory.locator('[aria-label="Storyタイムライン"]');
    const timelineLabels = async () => (await timeline.locator("tbody tr").allInnerTexts()).join("\n");
    const firstTimeline = await timelineLabels();
    assert.ok(firstTimeline.indexOf(names.event) >= 0 && firstTimeline.indexOf(names.laterEvent) >= 0, "Timeline must list both explicitly dated Events.");
    assert.ok(firstTimeline.indexOf(names.event) < firstTimeline.indexOf(names.laterEvent), "Timeline must sort explicit Event dates in ascending order.");
    assert.match(firstTimeline, /2042-05-10.*09:00/su, "Timeline must display the explicit date and time from Source.");
    await editTimelineField(page, reloadedStory, names.event, "date", "2042-05-30");
    await reloadedStory.getByRole("button", { name: "タイムライン", exact: true }).click();
    const updatedTimeline = await timelineLabels();
    assert.ok(updatedTimeline.indexOf(names.laterEvent) < updatedTimeline.indexOf(names.event), "Editing an explicit Event date must update timeline order after Host commit.");
    assert.match(updatedTimeline, /2042-05-30.*09:00/su, "The committed explicit date and time must be visible in Timeline.");
    const updatedEventRow = timeline.locator("tbody tr").filter({ hasText: names.event });
    await openHostSourcePanel(page);
    await updatedEventRow.getByRole("button", { name: /bible\/timeline\/events\//u }).click();
    const updatedEventSource = await waitForValue(page.getByLabel("Source", { exact: true }), (value) => value.includes("2042-05-30"), "Timeline Source navigation must open the committed Event YAML.");
    evidence.cases.push({
      id: "explicit-timeline-date-order-edit-and-reload",
      status: "PASS",
      evidence: { beforeOrder: [names.event, names.laterEvent], afterOrder: [names.laterEvent, names.event], updatedDate: "2042-05-30", time: "09:00", sourceOpened: /date: 2042-05-30/u.test(updatedEventSource) },
    });

    await reloadedStory.getByRole("button", { name: "ライブラリ", exact: true }).click();
    const library = reloadedStory.locator('aside[aria-label="Storyエンティティ一覧"]');
    const entityOptions = library.getByRole("listbox", { name: "Story項目" }).getByRole("option");
    const searchInput = library.getByLabel("検索");
    const typeFilter = library.getByLabel("種類");
    const searchableTypes = [];
    for (const type of CREATE_TYPES) {
      const query = type === "location" ? names.storyLocation : names[type];
      await typeFilter.selectOption(type);
      await searchInput.fill(query);
      const matches = entityOptions.filter({ hasText: query });
      await matches.first().waitFor({ state: "visible" });
      assert.equal(await entityOptions.count(), 1, `Search by display name and ${type} type should return exactly one match.`);
      searchableTypes.push(type);
    }
    await typeFilter.selectOption("all");
    await searchInput.fill("");
    evidence.cases.push({
      id: "search-every-ui-supported-story-entity-type",
      status: "PASS",
      evidence: { searchedTypes: searchableTypes, displayNameSearch: true, typeFilter: true },
    });

    const characterIdentity = (await (await chooseEntity(reloadedStory, editedName)).locator(".pill").innerText()).split(" · ")[0];
    await deleteRelation(page, reloadedStory, { from: names.scene, fromType: "scene", to: names.thread, kind: "plants" });
    const removedEntities = [];
    for (const [type, entityName] of [
      ["thread", names.thread],
      ["scene", names.scene],
      ["manuscript", names.sceneManuscript],
      ["manuscript", names.manuscript],
      ["chapter", names.chapter],
      ["volume", names.volume],
      ["faction", names.faction],
      ["item", names.item],
      ["event", names.event],
      ["event", names.laterEvent],
      ["lore", names.lore],
      ["arc", names.arc],
      ["location", names.storyLocation],
      ["character", names.target],
    ]) {
      await deleteEntity(page, reloadedStory, entityName, type);
      removedEntities.push({ type, name: entityName });
    }
    evidence.cases.push({
      id: "delete-every-ui-supported-story-entity-type-through-host-review",
      status: "PASS",
      evidence: { removedEntities, retainedForDiagnostics: names.character },
    });
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

    const storyMain = reloadedStory.locator("main.story-knowledge");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileSearch = reloadedStory.locator('aside[aria-label="Storyエンティティ一覧"]').getByLabel("検索");
    const mobileDetail = await chooseEntity(reloadedStory, names.normal);
    const mobileNameInput = mobileDetail.getByLabel("表示名");
    await mobileNameInput.waitFor({ state: "visible" });
    const mobileLayout = await storyMain.evaluate((element) => ({
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      mainWidth: element.clientWidth,
      mainScrollWidth: element.scrollWidth,
    }));
    assert.ok(mobileLayout.documentWidth <= mobileLayout.viewport, `Story must not create horizontal overflow at 390px: ${JSON.stringify(mobileLayout)}`);
    await mobileSearch.fill("");
    await page.emulateMedia({ colorScheme: "light" });
    const lightBackground = await storyMain.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    const darkBackground = await storyMain.evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(darkBackground, lightBackground, "Story must apply a distinct dark color scheme.");
    assert.equal(darkBackground, "rgb(21, 27, 34)");
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    evidence.cases.push({
      id: "story-mobile-layout-and-light-dark-theme",
      status: "PASS",
      evidence: { mobileLayout, lightBackground, darkBackground, desktopViewport: 1440 },
    });

    return evidence;
  } catch (error) {
    if (error && typeof error === "object") Object.assign(error, { acceptanceEvidence: { ...evidence, browserErrors } });
    throw error;
  } finally {
    await context.close();
  }
}

async function tabUntilFocused(page, locator, description, maxTabs = 220) {
  for (let tabCount = 0; tabCount <= maxTabs; tabCount += 1) {
    const focused = await locator.evaluate((element) => element === document.activeElement).catch(() => false);
    if (focused) return tabCount;
    await page.keyboard.press("Tab");
  }
  assert.fail(`Keyboard Tab navigation could not focus ${description} within ${maxTabs} steps.`);
}

async function runKeyboardAcceptance(browser, baseUrl) {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.addInitScript(() => {
    window.__storyAcceptancePointerEvents = 0;
    for (const eventName of ["pointerdown", "mousedown", "touchstart"]) {
      window.addEventListener(eventName, () => { window.__storyAcceptancePointerEvents += 1; }, true);
    }
  });
  const prefix = `Story Keyboard ${Date.now().toString(36)}`;
  const entityName = `${prefix} 日本語入力の人物`;
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Scriptorium Atlas", exact: true }).waitFor();
    const workspaceName = page.getByLabel("Workspace名");
    await tabUntilFocused(page, workspaceName, "Host Workspace名");
    await page.keyboard.insertText(`${prefix} workspace`);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: "Workspaceを開きました。" }).waitFor();

    const story = page.frameLocator('section[aria-label="Story Knowledge Plugin"] iframe');
    await waitForStoryReady(story);
    const createName = createCard(story).getByLabel("表示名");
    const tabsToName = await tabUntilFocused(page, createName, "Story create name input");
    const focusStyle = await createName.evaluate((element) => {
      const style = getComputedStyle(element);
      return { focused: element === document.activeElement, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    assert.equal(focusStyle.focused, true);
    assert.equal(focusStyle.outlineStyle, "solid", "Keyboard focus must have a visible outline.");
    assert.equal(focusStyle.outlineWidth, "3px");

    await page.keyboard.insertText(entityName);
    assert.equal(await createName.inputValue(), entityName, "Japanese text must enter the controlled Story field.");
    await page.keyboard.press("Control+z");
    assert.equal(await createName.inputValue(), "", "Keyboard Undo must revert the latest Japanese text entry.");
    await page.keyboard.insertText(entityName);
    const createButton = createCard(story).getByRole("button", { name: "作成案をプレビュー" });
    const tabsToPreview = await tabUntilFocused(page, createButton, "Story create preview button");
    await page.keyboard.press("Enter");
    await preview(story).waitFor({ state: "visible" });
    const submitButton = preview(story).getByRole("button", { name: "HostのReviewへ変更案を提出" });
    const tabsToSubmit = await tabUntilFocused(page, submitButton, "Story Host Review submission button");
    await page.keyboard.press("Enter");
    await story.getByRole("status").filter({ hasText: "HostのReviewへ変更案を提出しました" }).waitFor({ state: "visible" });
    const proposalButton = page.locator('section[aria-label="変更の承認"] article').last().getByRole("button", { name: "この変更を承認してCommit" });
    const tabsToCommit = await tabUntilFocused(page, proposalButton, "Host author Commit button");
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: "ローカルCommit完了:" }).waitFor({ state: "visible" });
    await waitForEntity(story, entityName);
    const pointerEvents = await page.evaluate(() => window.__storyAcceptancePointerEvents);
    const framePointerEvents = await story.locator("body").evaluate(() => window.__storyAcceptancePointerEvents);
    assert.equal(pointerEvents, 0, "The Host part of this scenario must use keyboard input only.");
    assert.equal(framePointerEvents, 0, "The Story part of this scenario must use keyboard input only.");
    return {
      id: "story-keyboard-only-japanese-entry-undo-focus-and-host-commit",
      status: "PASS",
      evidence: {
        viewport: 390,
        entityName,
        japaneseTextEntry: true,
        ctrlZUndo: true,
        focusStyle,
        tabsToName,
        tabsToPreview,
        tabsToSubmit,
        tabsToCommit,
        pointerEvents: 0,
        nativeImeComposition: "NOT_CHECKED: Chromium keyboard input does not exercise an operating-system Japanese IME.",
      },
    };
  } finally {
    await context.close();
  }
}

async function main() {
  await stat(resolve(PROFILE_ROOT, "index.html"));
  const basePort = EXTERNAL_BASE_URL ? undefined : await reserveBasePort();
  const baseUrl = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${basePort}`;
  const server = basePort === undefined ? undefined : spawn(process.execPath, [HOST_SERVE_SCRIPT, PROFILE_NAME], {
    cwd: HOST_ROOT,
    env: { ...process.env, ATLAS_HOST_PORT: String(basePort) },
    stdio: "ignore",
  });
  let browser;
  let report;
  let evidence;
  try {
    if (server) await waitForServer(server, baseUrl);
    else {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      assert.equal(response.ok, true, `Combined Host at ${baseUrl} must be reachable.`);
    }
    browser = await chromium.launch({ headless: true, ...(BROWSER_PATH ? { executablePath: BROWSER_PATH } : {}) });
    evidence = await runAcceptance({ browser, baseUrl });
    evidence.cases.push(await runKeyboardAcceptance(browser, baseUrl));
    report = {
      schemaVersion: "atlas.story-ui-browser-acceptance/v1",
      profile: PROFILE_NAME,
      scope: `${PROFILE_NAME} built Host artifact; public Japanese UI and Host author/commit workflow only.`,
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
      profile: PROFILE_NAME,
      scope: `${PROFILE_NAME} built Host artifact; public Japanese UI and Host author/commit workflow only.`,
      artifact: PROFILE_ROOT,
      baseUrl,
      ...(evidence ?? {}),
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
