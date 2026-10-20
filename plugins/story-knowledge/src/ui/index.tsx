import { useEffect, useMemo, useRef, useState } from "react";
import type { PluginHostClient } from "@scriptorium-atlas/contracts";
import { STORY_ENTITY_TYPES, type EditableStoryEntityType, type StoryEntity, type StoryIndex, type StoryRelation } from "../domain/types.js";
import { buildStoryIndex, incomingStoryReferences, searchStory } from "../domain/index.js";
import {
  planCreateStoryEntity,
  planCreateStoryRelation,
  planDeleteStoryEntity,
  planDeleteStoryRelation,
  planUpdateStoryEntity,
  planUpdateStoryRelation,
  type ChangeIntent,
  type CreateStoryInput,
  type StoryDeletePlan,
} from "../domain/operations.js";
import { loadStorySnapshot } from "../workspace.js";

const TYPE_LABELS: Record<string, string> = {
  character: "人物", location: "場所", faction: "組織", item: "アイテム", event: "出来事", lore: "設定",
  thread: "伏線", arc: "アーク", volume: "巻", chapter: "章", scene: "場面", manuscript: "原稿", dialogue_sketch: "会話スケッチ",
};
const CREATE_TYPES: EditableStoryEntityType[] = ["character", "location", "faction", "item", "event", "lore", "thread", "arc", "volume", "chapter", "scene", "manuscript"];
const RELATION_KINDS = ["related", "appears", "mentions", "pov", "location", "affiliated", "plants", "advances", "payoff", "first_appears", "planted", "target"];

type StoryDraft = { name: string; aliases: string; tags: string; description: string; body: string };
type Preview = { change: ChangeIntent; title: string; impact: string[] };
type Panel = "library" | "hierarchy" | "timeline" | "relations" | "diagnostics";

function createDraft(entity: StoryEntity): StoryDraft {
  return {
    name: entity.name,
    aliases: entity.aliases.join(", "),
    tags: entity.tags.join(", "),
    description: typeof entity.properties["description"] === "string" ? entity.properties["description"] as string : "",
    body: entity.type === "manuscript" ? entity.body ?? "" : "",
  };
}

function splitTags(value: string): string[] {
  return value.split(/[，,\n]/u).map((item) => item.trim()).filter(Boolean);
}

function shortRevision(value: string | null | undefined): string {
  if (!value) return "新規";
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-7)}` : value;
}

function relationLabel(index: StoryIndex, relation: StoryRelation): string {
  const from = index.entitiesById.get(relation.fromId);
  const to = index.entitiesById.get(relation.toId);
  return `${from?.name ?? relation.fromId} → ${to?.name ?? relation.toId}（${relation.kind}）`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function timelineDetails(entity: StoryEntity): string {
  const date = entity.properties["date"];
  const time = entity.properties["time"];
  const order = entity.properties["order"];
  const details = [
    typeof date === "string" && date.trim() ? `日付: ${date}` : "",
    typeof time === "string" && time.trim() ? `時刻: ${time}` : "",
    typeof order === "number" && Number.isFinite(order) ? `順序: ${order}` : "",
  ].filter(Boolean);
  return details.length > 0 ? details.join(" · ") : "日付・時刻・順序は未設定";
}

function timelineCoordinate(entity: StoryEntity): { group: number; value: string | number } {
  const date = entity.properties["date"];
  const time = entity.properties["time"];
  const order = entity.properties["order"];
  if (typeof date === "string" && date.trim()) return { group: 0, value: `${date.trim()} ${typeof time === "string" ? time.trim() : ""}` };
  if (typeof order === "number" && Number.isFinite(order)) return { group: 1, value: order };
  return { group: 2, value: entity.name };
}

export function StoryKnowledge({ host }: { host: PluginHostClient }) {
  const [index, setIndex] = useState<StoryIndex>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [panel, setPanel] = useState<Panel>("library");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<StoryDraft>();
  const [draftDirty, setDraftDirty] = useState(false);
  const drafts = useRef(new Map<string, StoryDraft>());
  const [draftMessage, setDraftMessage] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);

  const [createType, setCreateType] = useState<EditableStoryEntityType>("character");
  const [createName, setCreateName] = useState("");
  const [createAliases, setCreateAliases] = useState("");
  const [createTags, setCreateTags] = useState("");
  const [createFields, setCreateFields] = useState("{}");
  const [createBody, setCreateBody] = useState("");
  const [createVolumeId, setCreateVolumeId] = useState("");
  const [createChapterId, setCreateChapterId] = useState("");
  const [createError, setCreateError] = useState("");
  const [cascade, setCascade] = useState(false);
  const [deletePlan, setDeletePlan] = useState<StoryDeletePlan>();
  const [relationTarget, setRelationTarget] = useState("");
  const [relationKind, setRelationKind] = useState("related");
  const [relationNote, setRelationNote] = useState("");
  const [editRelationTarget, setEditRelationTarget] = useState("");
  const [editRelationKind, setEditRelationKind] = useState("related");
  const [editRelationNote, setEditRelationNote] = useState("");
  const [editingRelationId, setEditingRelationId] = useState("");
  const [relationError, setRelationError] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [fieldJson, setFieldJson] = useState("\"\"");

  useEffect(() => {
    const unsubscribe = host.subscribeWorkspace(() => setRefreshVersion((value) => value + 1));
    return unsubscribe;
  }, [host]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void loadStorySnapshot(host, undefined, controller.signal)
      .then((snapshot) => buildStoryIndex(snapshot))
      .then((nextIndex) => {
        if (controller.signal.aborted) return;
        setIndex(nextIndex);
        setSelectedId((current) => current && nextIndex.entities.some((entity) => entity.id === current) ? current : nextIndex.entities[0]?.id ?? "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [host, refreshVersion]);

  const selected = index?.entities.find((entity) => entity.id === selectedId);

  useEffect(() => {
    if (!selected) {
      setDraft(undefined);
      setDraftDirty(false);
      return;
    }
    const savedDraft = drafts.current.get(selected.id);
    if (savedDraft) {
      setDraft(savedDraft);
      setDraftDirty(true);
      setDraftMessage("未提出の編集案を保持しています。");
    } else {
      setDraft(createDraft(selected));
      setDraftDirty(false);
      setDraftMessage("");
    }
  }, [selected?.id, index?.sourceRevision]);

  const entities = useMemo(() => {
    if (!index) return [];
    const matching = searchStory(index, search, typeFilter === "all" ? undefined : new Set([typeFilter]));
    return [...matching].sort((left, right) => left.type.localeCompare(right.type, "ja") || left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id));
  }, [index, search, typeFilter]);

  const timelineEntities = useMemo(() => {
    if (!index) return [];
    return index.entities
      .filter((entity) => entity.type === "event" || entity.type === "scene")
      .sort((left, right) => {
        const leftCoordinate = timelineCoordinate(left);
        const rightCoordinate = timelineCoordinate(right);
        if (leftCoordinate.group !== rightCoordinate.group) return leftCoordinate.group - rightCoordinate.group;
        if (typeof leftCoordinate.value === "number" && typeof rightCoordinate.value === "number") return leftCoordinate.value - rightCoordinate.value;
        return String(leftCoordinate.value).localeCompare(String(rightCoordinate.value), "ja", { numeric: true })
          || left.name.localeCompare(right.name, "ja");
      });
  }, [index]);

  const selectedRelations = useMemo(() => index?.relations.filter((relation) => relation.fromId === selectedId || relation.toId === selectedId) ?? [], [index, selectedId]);
  const editingRelation = index?.relations.find((relation) => relation.id === editingRelationId);
  const selectedReferences = useMemo(() => index ? incomingStoryReferences(index, selectedId) : [], [index, selectedId]);
  const chapters = index?.entities.filter((entity) => entity.type === "chapter") ?? [];
  const volumes = index?.entities.filter((entity) => entity.type === "volume") ?? [];

  function updateDraft(field: keyof StoryDraft, value: string): void {
    if (!selected || !draft) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    drafts.current.set(selected.id, next);
    setDraftDirty(true);
    setDraftMessage("このフォームの編集内容はまだSourceへ提出されていません。");
  }

  function makePreview(change: ChangeIntent | null, title: string, impact: string[] = []): void {
    if (!change) {
      setMessage("変更はありません。Sourceの原文はそのままです。");
      return;
    }
    setMessage("");
    setPreview({ change, title, impact });
  }

  function saveSelected(): void {
    if (!index || !selected || !draft || !selected.editable) return;
    try {
      const patch: Record<string, unknown> = {
        name: draft.name,
        aliases: splitTags(draft.aliases),
        tags: splitTags(draft.tags),
      };
      if (draft.description) patch["description"] = draft.description;
      else if (Object.hasOwn(selected.properties, "description")) patch["description"] = undefined;
      if (selected.type === "manuscript") patch["body"] = draft.body;
      const change = planUpdateStoryEntity(index, selected.id, patch);
      makePreview(change, `${TYPE_LABELS[selected.type]}「${selected.name}」を編集`);
    } catch (error) {
      setDraftMessage(errorMessage(error));
    }
  }

  function applyAdditionalField(): void {
    if (!index || !selected || !fieldName.trim()) return;
    try {
      const value = JSON.parse(fieldJson) as unknown;
      const change = planUpdateStoryEntity(index, selected.id, { [fieldName.trim()]: value });
      makePreview(change, `「${fieldName.trim()}」を編集`);
      setFieldName("");
    } catch (error) {
      setDraftMessage(errorMessage(error));
    }
  }

  function startCreate(): void {
    if (!index) return;
    try {
      const other = JSON.parse(createFields) as unknown;
      if (!other || typeof other !== "object" || Array.isArray(other)) throw new Error("詳細項目はJSONオブジェクトで入力してください。");
      const fields = { ...(other as Record<string, unknown>) };
      if (splitTags(createAliases).length) fields["aliases"] = splitTags(createAliases);
      if (splitTags(createTags).length) fields["tags"] = splitTags(createTags);
      const input: CreateStoryInput = {
        type: createType,
        name: createName,
        fields,
        ...(createType === "chapter" && createVolumeId ? { volumeId: createVolumeId } : {}),
        ...(createType === "scene" && createChapterId ? { chapterId: createChapterId } : {}),
        ...(createType === "scene" || createType === "manuscript" ? { manuscriptBody: createBody } : {}),
      };
      const change = planCreateStoryEntity(index, input);
      makePreview(change, `${TYPE_LABELS[createType]}「${createName}」を作成`);
      setCreateError("");
    } catch (error) {
      setCreateError(errorMessage(error));
    }
  }

  function startDelete(): void {
    if (!index || !selected) return;
    const plan = planDeleteStoryEntity(index, selected.id, { cascade });
    setDeletePlan(plan);
    if (plan.allowed) {
      makePreview(plan.change, `${TYPE_LABELS[selected.type]}「${selected.name}」を削除`, plan.incoming.map((item) => `${item.provenance.path} · ${item.provenance.field} · ${item.fromId} → ${item.toId}`));
    }
  }

  function startCreateRelation(): void {
    if (!index || !selected || !relationTarget) return;
    try {
      const change = planCreateStoryRelation(index, selected.id, relationTarget, relationKind, relationNote || undefined);
      makePreview(change, "関連を追加", [`${selected.id} → ${relationTarget}（${relationKind}）`]);
      setRelationError("");
    } catch (error) {
      setRelationError(errorMessage(error));
    }
  }

  function startUpdateRelation(relation: StoryRelation, targetId: string, kind: string, note: string): void {
    if (!index) return;
    try {
      const change = planUpdateStoryRelation(index, relation.id, { targetId, kind, ...(note ? { note } : {}) });
      makePreview(change, "関連を編集", [relationLabel(index, relation)]);
      setRelationError("");
    } catch (error) {
      setRelationError(errorMessage(error));
    }
  }

  function startDeleteRelation(relation: StoryRelation): void {
    if (!index) return;
    try {
      const change = planDeleteStoryRelation(index, relation.id);
      makePreview(change, "関連を削除", [relationLabel(index, relation)]);
    } catch (error) {
      setRelationError(errorMessage(error));
    }
  }

  async function submitPreview(): Promise<void> {
    if (!preview) return;
    setWorking(true);
    setMessage("");
    try {
      const prepared = await host.prepare(preview.change);
      setMessage(`HostのReviewへ変更案を提出しました。操作ID: ${prepared.operationId} / ${prepared.changes.length}件のSource変更。CommitはHostのReviewで行います。`);
      setPreview(undefined);
      setDeletePlan(undefined);
      setCascade(false);
      if (selected && drafts.current.has(selected.id)) setDraftMessage("編集案はHostのReviewへ提出済みです。Commit後にWorkspace更新を読み込みます。");
    } catch (error) {
      setMessage(`変更案を提出できませんでした: ${errorMessage(error)}`);
    } finally {
      setWorking(false);
    }
  }

  async function openSource(path: string, revision: string): Promise<void> {
    if (!index) return;
    try {
      await host.requestSource({ workspaceId: index.workspaceId, path, revision });
      setMessage(`HostでSourceを開きました: ${path}`);
    } catch (error) {
      setMessage(`Sourceを開けませんでした: ${errorMessage(error)}`);
    }
  }

  function editRelationForm(relation: StoryRelation): void {
    if (relation.provenance.some((item) => item.field !== "relations")) {
      setRelationError("この関連は専用フィールドで方向/kindが定義されています。本文の関係方向は変更せず、Noteの編集または削除を行えます。");
    } else {
      setRelationError("");
    }
    const target = index?.entitiesById.get(relation.toId);
    const source = relation.provenance[0];
    setEditRelationTarget(target?.id ?? "");
    setEditRelationKind(relation.kind);
    setEditRelationNote(relation.note ?? "");
    if (source) setMessage(`編集対象: ${source.path} · ${source.field}`);
    setEditingRelationId(relation.id);
  }

  const fieldRows = selected ? Object.entries(selected.properties).filter(([field]) => !["id", "type", "name", "title", "aliases", "tags", "description", "body", "volume", "chapter", "manuscript", "location", "appears", "mentions", "plants", "advances", "related", "pov", "affiliated", "target", "first_appears", "planted", "payoff", "relations", "entities", "threads"].includes(field)) : [];

  return <main className="story-knowledge" lang="ja">
    <style>{`
      .story-knowledge{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#202a34;background:#f6f8fa;min-height:100%;padding:20px;box-sizing:border-box}
      .story-knowledge *{box-sizing:border-box}.story-knowledge h1,.story-knowledge h2,.story-knowledge h3{margin:0 0 10px}.story-knowledge h1{font-size:24px}.story-knowledge h2{font-size:18px}.story-knowledge h3{font-size:15px}
      .story-knowledge button,.story-knowledge input,.story-knowledge select,.story-knowledge textarea{font:inherit}.story-knowledge button{cursor:pointer;border:1px solid #bac5d0;border-radius:5px;background:#fff;padding:6px 10px;color:#24374a}.story-knowledge button:hover:not(:disabled){background:#edf4fa}.story-knowledge button:disabled{opacity:.5;cursor:not-allowed}
      .story-knowledge button:focus-visible,.story-knowledge input:focus-visible,.story-knowledge select:focus-visible,.story-knowledge textarea:focus-visible,.story-knowledge summary:focus-visible{outline:3px solid #176ea8;outline-offset:2px}
      .story-knowledge input,.story-knowledge select,.story-knowledge textarea{border:1px solid #bac5d0;border-radius:4px;padding:6px 8px;background:#fff;color:#17232f;width:100%}.story-knowledge textarea{min-height:84px;resize:vertical}.story-knowledge label{display:grid;gap:4px;margin:8px 0;font-weight:600}.story-knowledge small,.story-knowledge .muted{color:#5d6b78}.story-knowledge .topline,.story-knowledge .tabs,.story-knowledge .split,.story-knowledge .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.story-knowledge .topline{justify-content:space-between;margin-bottom:14px}.story-knowledge .tabs{border-bottom:1px solid #ccd5de;margin-bottom:14px}.story-knowledge .tabs button{border:0;border-radius:4px 4px 0 0;background:transparent}.story-knowledge .tabs button[aria-current=page]{background:#dcebf7;color:#123e61;font-weight:700}
      .story-knowledge .layout{display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:14px;align-items:start}.story-knowledge .card{background:#fff;border:1px solid #d5dde5;border-radius:7px;padding:14px;margin-bottom:12px}.story-knowledge .list{max-height:60vh;overflow:auto}.story-knowledge .entity-row{display:block;width:100%;text-align:left;margin:3px 0;border-color:transparent;background:transparent}.story-knowledge .entity-row[aria-current=true]{background:#e5f1fb;border-color:#9fc7e4}.story-knowledge .badge{display:inline-block;border-radius:12px;background:#e9edf1;padding:1px 8px;margin-right:5px;font-size:12px}.story-knowledge .warning{border-left:4px solid #cc8918;background:#fff9ec;padding:10px;margin:8px 0}.story-knowledge .error{border-left:4px solid #bd3843;background:#fff0f1;padding:10px;margin:8px 0}.story-knowledge .success{border-left:4px solid #24875c;background:#effaf4;padding:10px;margin:8px 0}.story-knowledge .formgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}.story-knowledge pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f7;padding:10px;border-radius:4px;max-height:300px;overflow:auto}.story-knowledge table{border-collapse:collapse;width:100%;margin:8px 0}.story-knowledge th,.story-knowledge td{text-align:left;vertical-align:top;border-bottom:1px solid #dbe2e8;padding:6px}.story-knowledge .relation{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid #e1e6eb}.story-knowledge .scroll{overflow:auto}.story-knowledge .pill{font-size:12px;color:#526476}.story-knowledge details{margin:6px 0}.story-knowledge .source-link{border:0;background:transparent;text-decoration:underline;color:#175d91;padding:0}
      @media(max-width:760px){.story-knowledge .layout{grid-template-columns:1fr}.story-knowledge .list{max-height:32vh}.story-knowledge .relation{grid-template-columns:1fr}}
      @media(prefers-color-scheme:dark){.story-knowledge{color:#e4ebf2;background:#151b22}.story-knowledge .card{background:#1d2731;border-color:#3b4a58}.story-knowledge button{background:#273542;border-color:#506170;color:#e4ebf2}.story-knowledge button:hover:not(:disabled){background:#344655}.story-knowledge input,.story-knowledge select,.story-knowledge textarea{background:#111820;border-color:#506170;color:#e4ebf2}.story-knowledge small,.story-knowledge .muted{color:#b0bdc9}.story-knowledge .tabs{border-color:#3b4a58}.story-knowledge .tabs button[aria-current=page]{background:#29445a;color:#d8efff}.story-knowledge .entity-row[aria-current=true]{background:#29445a;border-color:#527b98}.story-knowledge .badge{background:#34424e;color:#e4ebf2}.story-knowledge .pill{color:#b0bdc9}.story-knowledge .source-link{color:#8bcaff}.story-knowledge pre{background:#111820}.story-knowledge th,.story-knowledge td{border-color:#3b4a58}.story-knowledge .warning{background:#302818;border-color:#c79542}.story-knowledge .error{background:#321d22;border-color:#cf606b}.story-knowledge .success{background:#193126;border-color:#4caa78}.story-knowledge button:focus-visible,.story-knowledge input:focus-visible,.story-knowledge select:focus-visible,.story-knowledge textarea:focus-visible,.story-knowledge summary:focus-visible{outline-color:#80cfff}}
    `}</style>
    <div className="topline"><div><h1>Story Knowledge</h1><div className="muted">YAML / Markdownを正本として、物語設定・関係・原稿を管理します。</div></div><div>{index ? <span className="badge">{index.entities.length} 件</span> : null}{index ? <span className="badge" title={index.sourceRevision} aria-label={`Source revision ${index.sourceRevision}`}>revision {shortRevision(index.sourceRevision)}</span> : null}<button onClick={() => setRefreshVersion((value) => value + 1)} disabled={loading}>再読込</button></div></div>
    {loading && <p role="status">HostのWorkspaceを読み込んでいます…</p>}
    {loadError && <div className="error" role="alert">読み込みに失敗しました: {loadError}<div><button onClick={() => setRefreshVersion((value) => value + 1)}>再試行</button></div></div>}
    {index && <>
      {!index.referencesComplete && <div className="warning" role="status">入力の一部が不完全です。削除とCascadeは安全のため制限されます。診断を確認してください。</div>}
      <nav className="tabs" aria-label="Story Knowledgeの画面">
        {([["library", "ライブラリ"], ["hierarchy", "巻・章・場面"], ["timeline", "タイムライン"], ["relations", "関係"], ["diagnostics", "診断"]] as const).map(([key, label]) => <button key={key} aria-current={panel === key ? "page" : undefined} onClick={() => setPanel(key)}>{label}{key === "diagnostics" && index.diagnostics.length > 0 ? ` (${index.diagnostics.length})` : ""}</button>)}
      </nav>

      {panel === "library" && <div className="layout">
        <aside className="card" aria-label="Storyエンティティ一覧">
          <h2>ライブラリ</h2>
          <label>検索<input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="名前・ID・別名・タグ・パス" /></label>
          <label>種類<select value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value)}><option value="all">すべて</option>{STORY_ENTITY_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type] ?? type}</option>)}</select></label>
          <div className="list" role="listbox" aria-label="Story項目">
            {entities.map((entity) => <button className="entity-row" key={`${entity.path}:${entity.id}`} role="option" aria-selected={entity.id === selectedId} aria-current={entity.id === selectedId} onClick={() => setSelectedId(entity.id)}>
              <span className="badge">{TYPE_LABELS[entity.type]}</span>{entity.name}<br /><small>{entity.id} · {entity.path}{!entity.editable ? " · 読み取り専用" : ""}</small>
            </button>)}
            {entities.length === 0 && <p className="muted">該当する項目はありません。</p>}
          </div>
        </aside>
        <section>
          {selected && draft && <article className="card">
            <div className="topline"><div><h2>{TYPE_LABELS[selected.type]}: {selected.name}</h2><span className="pill">{selected.id} · {selected.path}</span></div><button className="source-link" onClick={() => void openSource(selected.path, selected.revision)}>Sourceを開く</button></div>
            {!selected.editable && <div className="warning">このSourceには診断があります。読み取り専用で表示しています。</div>}
            <form onSubmit={(event) => { event.preventDefault(); saveSelected(); }}>
              <div className="formgrid">
                <label>表示名<input value={draft.name} onChange={(event) => updateDraft("name", event.currentTarget.value)} disabled={!selected.editable} /></label>
                <label>別名（カンマ区切り）<input value={draft.aliases} onChange={(event) => updateDraft("aliases", event.currentTarget.value)} disabled={!selected.editable} /></label>
                <label>タグ（カンマ区切り）<input value={draft.tags} onChange={(event) => updateDraft("tags", event.currentTarget.value)} disabled={!selected.editable} /></label>
                <label>説明<textarea value={draft.description} onChange={(event) => updateDraft("description", event.currentTarget.value)} disabled={!selected.editable} /></label>
              </div>
              {selected.type === "manuscript" && <label>原稿本文<textarea value={draft.body} onChange={(event) => updateDraft("body", event.currentTarget.value)} disabled={!selected.editable} rows={12} /></label>}
              <div className="actions"><button type="button" onClick={saveSelected} disabled={!selected.editable || !draftDirty}>編集案をプレビュー</button>{draftDirty && <button type="button" onClick={() => { drafts.current.delete(selected.id); setDraft(createDraft(selected)); setDraftDirty(false); setDraftMessage("現在のSourceからフォームを再読込しました。"); }}>フォームをSourceに戻す</button>}<span className="muted">ID・Source Path・親子関係は専用操作で管理します。</span></div>
            </form>
            {draftMessage && <p role="status" className="muted">{draftMessage}</p>}
            <details><summary>Sourceのその他のフィールド</summary>
              {fieldRows.length === 0 ? <p className="muted">追加項目はありません。</p> : <div className="scroll"><table><thead><tr><th>Field</th><th>Value</th><th>操作</th></tr></thead><tbody>{fieldRows.map(([field, value]) => <tr key={field}><td>{field}</td><td><code>{JSON.stringify(value)}</code></td><td><button onClick={() => { setFieldName(field); setFieldJson(JSON.stringify(value, null, 2) ?? "null"); }}>編集</button></td></tr>)}</tbody></table></div>}
              <div className="formgrid"><label>Field名<input value={fieldName} onChange={(event) => setFieldName(event.currentTarget.value)} disabled={!selected.editable} /></label><label>JSON値<textarea value={fieldJson} onChange={(event) => setFieldJson(event.currentTarget.value)} disabled={!selected.editable} /></label></div><button onClick={applyAdditionalField} disabled={!selected.editable}>Field編集案を作成</button>
            </details>
          </article>}
            <article className="card"><h2>作成</h2><form onSubmit={(event) => { event.preventDefault(); startCreate(); }}>
            <div className="formgrid">
              <label>種類<select value={createType} onChange={(event) => setCreateType(event.currentTarget.value as EditableStoryEntityType)}>{CREATE_TYPES.map((type) => <option value={type} key={type}>{TYPE_LABELS[type]}</option>)}</select></label>
              <label>表示名<input value={createName} onChange={(event) => setCreateName(event.currentTarget.value)} required /></label>
              <label>別名<input value={createAliases} onChange={(event) => setCreateAliases(event.currentTarget.value)} /></label>
              <label>タグ<input value={createTags} onChange={(event) => setCreateTags(event.currentTarget.value)} /></label>
              {createType === "chapter" && <label>親の巻<select value={createVolumeId} onChange={(event) => setCreateVolumeId(event.currentTarget.value)} required><option value="">選択してください</option>{volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.name}</option>)}</select></label>}
              {createType === "scene" && <label>親の章<select value={createChapterId} onChange={(event) => setCreateChapterId(event.currentTarget.value)} required><option value="">選択してください</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}</select></label>}
            </div>
            {(createType === "scene" || createType === "manuscript") && <label>{createType === "scene" ? "対応する原稿本文" : "原稿本文"}<textarea value={createBody} onChange={(event) => setCreateBody(event.currentTarget.value)} rows={8} /></label>}
            <label>追加フィールド（JSON）<textarea value={createFields} onChange={(event) => setCreateFields(event.currentTarget.value)} /></label>
            <button type="button" onClick={startCreate}>作成案をプレビュー</button>{createError && <p role="alert" className="error">{createError}</p>}
          </form></article>
          {selected && <article className="card"><h2>関連する項目</h2>
            {selectedRelations.length === 0 ? <p className="muted">関係はありません。</p> : selectedRelations.map((relation) => <div className="relation" key={relation.id}><div>{relationLabel(index, relation)}<br /><small>{relation.provenance.map((item) => `${item.path} · ${item.field}`).join(" / ")}</small></div><div className="actions"><button onClick={() => { setSelectedId(relation.fromId); }}>From</button><button onClick={() => { setSelectedId(relation.toId); }}>To</button><button onClick={() => editRelationForm(relation)}>編集フォーム</button><button onClick={() => startDeleteRelation(relation)}>削除案</button></div></div>)}
            {editingRelation && <details open><summary>関連編集フォーム</summary><div className="formgrid"><label>Target<select value={editRelationTarget || editingRelation.toId} onChange={(event) => setEditRelationTarget(event.currentTarget.value)}>{index.entities.filter((entity) => entity.editable).map((entity) => <option value={entity.id} key={entity.id}>{entity.name} · {entity.id}</option>)}</select></label><label>Kind<input value={editRelationKind} onChange={(event) => setEditRelationKind(event.currentTarget.value)} disabled={editingRelation.provenance.some((item) => item.field !== "relations")} /></label><label>Note<input value={editRelationNote} onChange={(event) => setEditRelationNote(event.currentTarget.value)} /></label></div><div className="actions"><button onClick={() => { startUpdateRelation(editingRelation, editRelationTarget || editingRelation.toId, editRelationKind, editRelationNote); setEditingRelationId(""); }}>関連編集案を作成</button><button onClick={() => setEditingRelationId("")}>閉じる</button></div></details>}
            <form onSubmit={(event) => { event.preventDefault(); startCreateRelation(); }}>
              <h3>関連を追加</h3><div className="formgrid"><label>Target<select value={relationTarget} onChange={(event) => setRelationTarget(event.currentTarget.value)} required><option value="">選択してください</option>{index.entities.filter((entity) => entity.editable && entity.id !== selected.id).map((entity) => <option value={entity.id} key={entity.id}>{TYPE_LABELS[entity.type]} · {entity.name}</option>)}</select></label><label>Kind<select value={relationKind} onChange={(event) => setRelationKind(event.currentTarget.value)}>{RELATION_KINDS.map((kind) => <option value={kind} key={kind}>{kind}</option>)}</select></label><label>Note<input value={relationNote} onChange={(event) => setRelationNote(event.currentTarget.value)} /></label></div><button type="button" onClick={startCreateRelation} disabled={!relationTarget}>関連追加案を作成</button>{relationError && <p role="alert" className="error">{relationError}</p>}
            </form>
          </article>}
          {selected && <article className="card"><h2>削除</h2><p>incoming referenceが残る削除は既定で拒否されます。Cascadeを選ぶと、表示された参照元Sourceを同じ変更案で更新します。</p><label><span><input type="checkbox" checked={cascade} onChange={(event) => { setCascade(event.currentTarget.checked); setDeletePlan(undefined); }} /> incoming referenceをCascadeする</span></label><button onClick={startDelete} disabled={!selected.editable}>削除案を確認</button>
            {deletePlan && !deletePlan.allowed && <div className="warning" role="alert"><strong>{deletePlan.reason}</strong><ul>{deletePlan.incoming.map((item) => <li key={item.id}><button className="source-link" onClick={() => void openSource(item.provenance.path, item.provenance.revision)}>{item.provenance.path} · {item.provenance.field}</button> · {item.fromId} → {item.toId}</li>)}</ul>{deletePlan.children?.map((child) => <div key={child.id}>{TYPE_LABELS[child.type]}: {child.name}</div>)}</div>}
            {deletePlan?.allowed && <p role="status">{deletePlan.incoming.length}件の参照を含む変更案をプレビューしています。</p>}
          </article>}
        </section>
      </div>}

      {panel === "hierarchy" && <div className="card"><h2>巻・章・場面</h2>{index.hierarchy.length === 0 ? <p className="muted">階層データはありません。巻を作成し、章・場面を追加できます。</p> : <div className="scroll"><table><thead><tr><th>巻</th><th>章</th><th>場面</th></tr></thead><tbody>{index.hierarchy.map((item) => {
        const volume = index.entitiesById.get(item.volumeId);
        const chapter = index.entitiesById.get(item.chapterId);
        return <tr key={`${item.volumeId}:${item.chapterId}`}><td>{volume ? <button className="source-link" onClick={() => { setPanel("library"); setSelectedId(volume.id); }}>{volume.name}</button> : item.volumeId}</td><td>{chapter ? <button className="source-link" onClick={() => { setPanel("library"); setSelectedId(chapter.id); }}>{chapter.name}</button> : item.chapterId}</td><td>{item.sceneIds.map((id) => { const scene = index.entitiesById.get(id); return <div key={id}>{scene ? <button className="source-link" onClick={() => { setPanel("library"); setSelectedId(id); }}>{scene.name}</button> : id}</div>; })}</td></tr>;
      })}</tbody></table></div>}</div>}

      {panel === "timeline" && <div className="card" aria-label="Storyタイムライン"><h2>タイムライン</h2><p className="muted">EventとSceneのSourceに明示された日付・時刻・順序を表示します。未設定の時間は推測しません。値を変更する場合は項目を開き、Sourceの追加フィールドから編集します。</p>{timelineEntities.length === 0 ? <p className="muted">EventとSceneはありません。</p> : <div className="scroll"><table><thead><tr><th>明示された時系列</th><th>種類</th><th>項目</th><th>Source</th></tr></thead><tbody>{timelineEntities.map((entity) => <tr key={entity.id}><td>{timelineDetails(entity)}</td><td>{TYPE_LABELS[entity.type]}</td><td><button className="source-link" onClick={() => { setPanel("library"); setSelectedId(entity.id); }}>{entity.name}</button></td><td><button className="source-link" onClick={() => void openSource(entity.path, entity.revision)}>{entity.path}</button></td></tr>)}</tbody></table></div>}</div>}

      {panel === "relations" && <div className="card"><h2>関係一覧</h2><p className="muted">矢印はSourceに書かれた方向です。表示上の閲覧方向でSourceを書き換えません。</p>{index.relations.length === 0 ? <p className="muted">関係はありません。</p> : <div className="scroll"><table><thead><tr><th>From → To</th><th>Kind</th><th>Provenance</th><th>操作</th></tr></thead><tbody>{index.relations.map((relation) => <tr key={relation.id}><td>{relationLabel(index, relation)}</td><td>{relation.kind}</td><td>{relation.provenance.map((item) => <div key={`${item.path}:${item.field}`}><button className="source-link" onClick={() => void openSource(item.path, item.revision)}>{item.path}</button> · {item.field}</div>)}</td><td><button onClick={() => { setSelectedId(relation.fromId); setPanel("library"); }}>Fromを見る</button> <button onClick={() => startDeleteRelation(relation)}>削除案</button></td></tr>)}</tbody></table></div>}</div>}

      {panel === "diagnostics" && <div className="card"><h2>診断</h2>{index.diagnostics.length === 0 ? <p role="status">診断はありません。</p> : <div className="scroll"><table><thead><tr><th>Severity</th><th>Code</th><th>Source</th><th>内容</th></tr></thead><tbody>{index.diagnostics.map((item, position) => <tr key={`${item.path}:${item.code}:${position}`}><td>{item.severity === "error" ? "エラー" : "警告"}</td><td><code>{item.code}</code></td><td><button className="source-link" onClick={() => { const source = index.files.get(item.path); if (source) void openSource(item.path, source.revision); }}>{item.path}</button></td><td>{item.message}</td></tr>)}</tbody></table></div>}</div>}

      {preview && <section className="card" aria-label="変更案プレビュー"><h2>変更案プレビュー: {preview.title}</h2><p>HostのCAS read-setを使い、AuthorのCommitまではSourceを変更しません。</p>{preview.impact.length > 0 && <div><strong>関係への影響</strong><ul>{preview.impact.map((item) => <li key={item}>{item}</li>)}</ul></div>}<div className="scroll"><table><thead><tr><th>Path</th><th>旧Revision</th><th>新しい内容</th></tr></thead><tbody>{preview.change.writes.map((write) => <tr key={write.path}><td>{write.path}</td><td>{shortRevision(preview.change.reads.find((item) => item.path === write.path)?.revision)}</td><td>{write.content === null ? <strong>削除</strong> : <details><summary>内容を確認</summary><pre>{write.content}</pre></details>}</td></tr>)}</tbody></table></div><div className="actions"><button onClick={() => void submitPreview()} disabled={working}>{working ? "Hostへ提出中…" : "HostのReviewへ変更案を提出"}</button><button onClick={() => setPreview(undefined)} disabled={working}>プレビューを閉じる</button></div></section>}
      {message && <div className="success" role="status">{message}</div>}
    </>}
  </main>;
}

export default StoryKnowledge;
