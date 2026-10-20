import {
  inferStoryType,
  isStorySourcePath,
  hierarchyParents,
  sourcePathToManuscriptId,
} from "./paths.js";
import { parseStorySourceFile, type ParsedStoryFile, type StorySourceDocument } from "./source.js";
import {
  STORY_PROVIDER_ID,
  type StoryDiagnostic,
  type StoryEntity,
  type StoryIndex,
  type StoryProvenance,
  type StoryReference,
  type StoryRelation,
  type StorySnapshotInput,
  type StorySourceFile,
} from "./types.js";

interface RelationDraft {
  sourceId: string;
  targetId: string;
  field: string;
  kind: string;
  note?: string;
  sourceRelationId?: string;
  publishable: boolean;
  provenance: StoryProvenance;
}

const SIMPLE_RELATION_FIELDS = [
  "appears",
  "mentions",
  "plants",
  "advances",
  "related",
  "pov",
  "affiliated",
  "target",
  "first_appears",
  "planted",
  "payoff",
] as const;

const GRAPH_KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isValidLocalId(value: string): boolean {
  return value.length > 0
    && new TextEncoder().encode(value).byteLength <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is required to create stable Story revisions and relation IDs.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pointerField(pointer: readonly (string | number)[]): string {
  return pointer.filter((part): part is string => typeof part === "string").join(".");
}

function refParts(value: unknown): { target?: string; note?: string; relationId?: string } {
  if (typeof value === "string") return { target: value };
  if (!isRecord(value)) return {};
  const target = [value.target, value.scene, value.id].find((item): item is string => typeof item === "string" && item.length > 0);
  return {
    ...(target ? { target } : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    ...(typeof value.id === "string" && typeof value.target === "string" ? { relationId: value.id } : {}),
  };
}

function collectValue(
  entity: StoryEntity,
  value: unknown,
  pointer: readonly (string | number)[],
  kind: string,
  drafts: RelationDraft[],
  diagnostics: StoryDiagnostic[],
  publishable = true,
): void {
  const values = Array.isArray(value) ? value.map((item, index) => ({ item, pointer: [...pointer, index] })) : [{ item: value, pointer }];
  for (const entry of values) {
    const parts = refParts(entry.item);
    if (!parts.target) {
      diagnostics.push({
        code: "relation-reference-invalid",
        severity: "warning",
        path: entity.path,
        entityId: entity.id,
        field: pointerField(pointer),
        message: `Unsupported reference value at ${pointerField(entry.pointer)} was retained but not indexed.`,
      });
      continue;
    }
    const field = pointerField(pointer);
    drafts.push({
      sourceId: entity.id,
      targetId: parts.target,
      field,
      kind,
      ...(parts.note !== undefined ? { note: parts.note } : {}),
      ...(parts.relationId ? { sourceRelationId: parts.relationId } : {}),
      publishable,
      provenance: { path: entity.path, revision: entity.revision, field, pointer: entry.pointer },
    });
  }
}

function collectRelations(entity: StoryEntity, diagnostics: StoryDiagnostic[], publishable: boolean): RelationDraft[] {
  const raw = entity.properties;
  const drafts: RelationDraft[] = [];
  for (const field of SIMPLE_RELATION_FIELDS) {
    if (Object.hasOwn(raw, field)) collectValue(entity, raw[field], [field], field, drafts, diagnostics, publishable);
  }

  const relations = raw.relations;
  if (Array.isArray(relations)) {
    relations.forEach((value, index) => {
      if (!isRecord(value)) {
        diagnostics.push({
          code: "relation-shape-invalid",
          severity: "warning",
          path: entity.path,
          entityId: entity.id,
          field: "relations",
          message: `relations[${index}] is not a mapping and was retained without indexing.`,
        });
        return;
      }
      const target = value.target;
      const kind = typeof value.kind === "string" ? value.kind : "related";
      if (typeof target !== "string" || target.length === 0) {
        diagnostics.push({
          code: "relation-reference-invalid",
          severity: "warning",
          path: entity.path,
          entityId: entity.id,
          field: "relations",
          message: `relations[${index}] has no string target and was retained without indexing.`,
        });
        return;
      }
      const field = "relations";
      const invalidKind = Object.hasOwn(value, "kind") && typeof value.kind !== "string";
      const invalidId = Object.hasOwn(value, "id") && typeof value.id !== "string";
      if (invalidKind || invalidId) {
        diagnostics.push({
          code: invalidKind ? "relation-kind-invalid" : "relation-id-invalid",
          severity: "error",
          path: entity.path,
          entityId: entity.id,
          field,
          message: `relations[${index}] has an invalid ${invalidKind ? "kind" : "id"} value and will not be published.`,
        });
      }
      drafts.push({
        sourceId: entity.id,
        targetId: target,
        field,
        kind,
        ...(typeof value.note === "string" ? { note: value.note } : {}),
        ...(Object.hasOwn(value, "id") && typeof value.id === "string" ? { sourceRelationId: value.id } : {}),
        publishable: publishable && !invalidKind && !invalidId,
        provenance: { path: entity.path, revision: entity.revision, field, pointer: ["relations", index] },
      });
    });
  } else if (relations !== undefined) {
    diagnostics.push({
      code: "relation-shape-invalid",
      severity: "warning",
      path: entity.path,
      entityId: entity.id,
      field: "relations",
      message: "relations must be a list; its declarations were retained without indexing.",
    });
  }

  if (isRecord(raw.entities)) {
    for (const [field, targets] of Object.entries(raw.entities)) {
      collectValue(entity, targets, ["entities", field], field, drafts, diagnostics, publishable);
    }
  } else if (raw.entities !== undefined) {
    diagnostics.push({
      code: "relation-shape-invalid",
      severity: "warning",
      path: entity.path,
      entityId: entity.id,
      field: "entities",
      message: "entities must be a mapping; its declarations were retained without indexing.",
    });
  }

  if (isRecord(raw.threads)) {
    for (const field of ["plants", "advances"] as const) {
      if (Object.hasOwn(raw.threads, field)) {
        collectValue(entity, raw.threads[field], ["threads", field], field, drafts, diagnostics, publishable);
      }
    }
  } else if (raw.threads !== undefined) {
    diagnostics.push({
      code: "relation-shape-invalid",
      severity: "warning",
      path: entity.path,
      entityId: entity.id,
      field: "threads",
      message: "threads must be a mapping; its declarations were retained without indexing.",
    });
  }

  if (entity.type === "scene") {
    for (const field of ["location", "manuscript"] as const) {
      if (Object.hasOwn(raw, field)) collectValue(entity, raw[field], [field], field, drafts, diagnostics, publishable);
    }
  }
  return drafts;
}

function sortDiagnostics(diagnostics: StoryDiagnostic[]): StoryDiagnostic[] {
  return diagnostics.sort((left, right) =>
    left.path.localeCompare(right.path) || left.code.localeCompare(right.code) || (left.field ?? "").localeCompare(right.field ?? ""),
  );
}

function sourceFiles(input: StorySnapshotInput): { files: Map<string, StorySourceFile>; duplicates: string[] } {
  const files = new Map<string, StorySourceFile>();
  const duplicates = new Set<string>();
  for (const file of input.files) {
    if (!isStorySourcePath(file.path)) continue;
    if (files.has(file.path)) {
      duplicates.add(file.path);
      continue;
    }
    files.set(file.path, file);
  }
  return { files: new Map([...files].sort(([left], [right]) => left.localeCompare(right))), duplicates: [...duplicates].sort() };
}

function addHierarchyDiagnostics(entities: readonly StoryEntity[], diagnostics: StoryDiagnostic[]): StoryIndex["hierarchy"] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const volumes = entities.filter((entity) => entity.type === "volume");
  const chapters = entities.filter((entity) => entity.type === "chapter");
  const scenes = entities.filter((entity) => entity.type === "scene");
  const manuscriptIdsByPath = new Map(entities.filter((entity) => entity.type === "manuscript").map((entity) => [entity.path, entity.id]));
  const hierarchy: Array<{ volumeId: string; chapterId: string; sceneIds: string[] }> = [];
  const chaptersByVolume = new Map<string, StoryEntity[]>();

  for (const chapter of chapters) {
    const pathParents = hierarchyParents(chapter.path);
    const volumeId = typeof chapter.properties.volume === "string" ? chapter.properties.volume : pathParents.volumePathId;
    const volume = volumeId ? byId.get(volumeId) : undefined;
    if (!volume || volume.type !== "volume") {
      diagnostics.push({ code: "hierarchy-volume-missing", severity: "warning", path: chapter.path, entityId: chapter.id, field: "volume", message: "Chapter references a volume that is not present in this Story snapshot." });
      continue;
    }
    if (pathParents.volumePathId && pathParents.volumePathId !== volume.id) {
      diagnostics.push({ code: "hierarchy-volume-path-mismatch", severity: "error", path: chapter.path, entityId: chapter.id, field: "volume", message: "Chapter path parent does not match its volume ID." });
    }
    const group = chaptersByVolume.get(volume.id) ?? [];
    group.push(chapter);
    chaptersByVolume.set(volume.id, group);
  }

  for (const scene of scenes) {
    const pathParents = hierarchyParents(scene.path);
    const chapterId = typeof scene.properties.chapter === "string" ? scene.properties.chapter : pathParents.chapterPathId;
    const chapter = chapterId ? byId.get(chapterId) : undefined;
    if (!chapter || chapter.type !== "chapter") {
      diagnostics.push({ code: "hierarchy-chapter-missing", severity: "warning", path: scene.path, entityId: scene.id, field: "chapter", message: "Scene references a chapter that is not present in this Story snapshot." });
      continue;
    }
    if (pathParents.chapterPathId && pathParents.chapterPathId !== chapter.id) {
      diagnostics.push({ code: "hierarchy-chapter-path-mismatch", severity: "error", path: scene.path, entityId: scene.id, field: "chapter", message: "Scene path parent does not match its chapter ID." });
    }
    const volumePathId = pathParents.volumePathId;
    const chapterPathParents = hierarchyParents(chapter.path);
    const expectedVolume = typeof chapter.properties.volume === "string" ? chapter.properties.volume : chapterPathParents.volumePathId;
    if (volumePathId && expectedVolume && volumePathId !== expectedVolume) {
      diagnostics.push({ code: "hierarchy-volume-mismatch", severity: "error", path: scene.path, entityId: scene.id, field: "volume", message: "Scene and chapter belong to different volume IDs." });
    }
    if (typeof scene.properties.manuscript !== "string" || !scene.properties.manuscript) {
      diagnostics.push({ code: "scene-manuscript-missing", severity: "warning", path: scene.path, entityId: scene.id, field: "manuscript", message: "Scene has no manuscript source path." });
    } else if (!byId.has(scene.properties.manuscript) && !manuscriptIdsByPath.has(scene.properties.manuscript)) {
      diagnostics.push({ code: "scene-manuscript-unresolved", severity: "warning", path: scene.path, entityId: scene.id, field: "manuscript", message: "Scene manuscript reference is not present in this Story snapshot." });
    }

    const volumeId = typeof scene.properties.volume === "string" ? scene.properties.volume : volumePathId ?? expectedVolume;
    if (!volumeId) continue;
    const existing = hierarchy.find((item) => item.volumeId === volumeId && item.chapterId === chapter.id);
    if (existing) existing.sceneIds.push(scene.id);
    else hierarchy.push({ volumeId, chapterId: chapter.id, sceneIds: [scene.id] });
  }

  for (const volume of volumes) {
    const volumePathId = /^plot\/volumes\/([^/]+)\/volume\.ya?ml$/i.exec(volume.path)?.[1];
    if (volumePathId && volumePathId !== volume.id) {
      diagnostics.push({ code: "hierarchy-volume-path-mismatch", severity: "error", path: volume.path, entityId: volume.id, field: "id", message: "Volume path identity differs from its source ID." });
    }
    for (const chapter of chaptersByVolume.get(volume.id) ?? []) {
      if (!hierarchy.some((item) => item.volumeId === volume.id && item.chapterId === chapter.id)) {
        hierarchy.push({ volumeId: volume.id, chapterId: chapter.id, sceneIds: [] });
      }
    }
  }

  return hierarchy
    .map((item) => ({ ...item, sceneIds: item.sceneIds.sort((left, right) => {
      const leftEntity = byId.get(left);
      const rightEntity = byId.get(right);
      return Number(leftEntity?.properties.order ?? 0) - Number(rightEntity?.properties.order ?? 0) || left.localeCompare(right);
    }) }))
    .sort((left, right) => left.volumeId.localeCompare(right.volumeId) || left.chapterId.localeCompare(right.chapterId));
}

/** Parse one complete, Host-pinned workspace snapshot without mutating Source. */
export async function buildStoryIndex(input: StorySnapshotInput): Promise<StoryIndex> {
  const sourceInventory = sourceFiles(input);
  const files = sourceInventory.files;
  const parsed: ParsedStoryFile[] = [...files.values()].map(parseStorySourceFile);
  const diagnostics = parsed.flatMap((item) => item.diagnostics);
  const unavailableStorySources = (input.unavailableFiles ?? []).filter((file) => isStorySourcePath(file.path));
  for (const file of unavailableStorySources) {
    diagnostics.push({
      code: "source-content-unavailable",
      severity: "error",
      path: file.path,
      message: file.byteLength > 2 * 1024 * 1024
        ? `Story source is ${file.byteLength} bytes, above the 2 MiB parsing limit.`
        : `Story source content is unavailable as ${file.contentType} at revision ${file.revision}.`,
    });
  }
  for (const path of sourceInventory.duplicates) {
    diagnostics.push({ code: "duplicate-source-path", severity: "error", path, message: `Source path '${path}' appears more than once in the Host snapshot.` });
  }
  const sourcesByPath = new Map<string, StorySourceDocument>();
  const entities: StoryEntity[] = [];
  for (const item of parsed) {
    if (item.source) sourcesByPath.set(item.source.file.path, item.source);
    if (item.entity) entities.push(item.entity);
  }

  const pathsById = new Map<string, string[]>();
  for (const entity of entities) {
    const paths = pathsById.get(entity.id) ?? [];
    paths.push(entity.path);
    pathsById.set(entity.id, paths);
  }
  const duplicateEntityIds = new Map<string, readonly string[]>();
  for (const [id, paths] of pathsById) {
    if (paths.length < 2) continue;
    const uniquePaths = [...new Set(paths)].sort();
    duplicateEntityIds.set(id, uniquePaths);
    for (const path of uniquePaths) {
      diagnostics.push({ code: "duplicate-entity-id", severity: "error", path, entityId: id, field: "id", message: `Entity ID '${id}' occurs in multiple source files: ${uniquePaths.join(", ")}.` });
    }
  }
  const duplicateIds = new Set(duplicateEntityIds.keys());
  const duplicatePaths = new Set(sourceInventory.duplicates);
  const uniqueEntities = entities
    .map((entity) => duplicateIds.has(entity.id) || duplicatePaths.has(entity.path) ? { ...entity, editable: false } : entity)
    .sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  const entitiesById = new Map(uniqueEntities.filter((entity) => !duplicateIds.has(entity.id) && !duplicatePaths.has(entity.path) && isValidLocalId(entity.id)).map((entity) => [entity.id, entity]));
  const sourceById = new Map(uniqueEntities.filter((entity) => entitiesById.has(entity.id)).map((entity) => [entity.id, sourcesByPath.get(entity.path)!]));
  const pathToManuscriptId = new Map(uniqueEntities.filter((entity) => entity.type === "manuscript").map((entity) => [entity.path, entity.id]));

  const drafts: RelationDraft[] = [];
  for (const entity of uniqueEntities) {
    const usableSource = !duplicateIds.has(entity.id) && sourceById.has(entity.id) && entity.editable;
    for (const relation of collectRelations(entity, diagnostics, usableSource)) {
      const manuscriptId = pathToManuscriptId.get(relation.targetId);
      if (manuscriptId) relation.targetId = manuscriptId;
      if (!isValidLocalId(relation.targetId)) {
        diagnostics.push({
          code: "relation-target-invalid",
          severity: "error",
          path: relation.provenance.path,
          entityId: relation.sourceId,
          field: relation.field,
          message: `Relation target '${relation.targetId}' is not a valid Graph local ID.`,
        });
        relation.publishable = false;
      }
      drafts.push(relation);
    }
  }

  const relationIdCache = new Map<string, Promise<string>>();
  const relationIds = await Promise.all(drafts.map(async (draft) => {
    if (draft.sourceRelationId !== undefined) return draft.sourceRelationId;
    const canonical = JSON.stringify([draft.sourceId, draft.field, draft.targetId, draft.kind]);
    let result = relationIdCache.get(canonical);
    if (!result) {
      result = sha256(canonical).then((hash) => `rel-${hash}`);
      relationIdCache.set(canonical, result);
    }
    return result;
  }));
  const relationBuckets = new Map<string, RelationDraft[]>();
  const signatureById = new Map<string, string>();
  const conflictingRelationIds = new Set<string>();
  const conflictingDraftIndexes = new Set<number>();
  drafts.forEach((draft, index) => {
    const relationId = relationIds[index]!;
    const signature = JSON.stringify([draft.sourceId, draft.targetId, draft.kind]);
    if (!relationId || new TextEncoder().encode(relationId).byteLength > 256 || /[\u0000-\u001f\u007f]/u.test(relationId)) {
      diagnostics.push({ code: "relation-id-invalid", severity: "error", path: draft.provenance.path, entityId: draft.sourceId, field: draft.field, message: "Relation ID is invalid under Graph Provider v1." });
      conflictingRelationIds.add(relationId);
      conflictingDraftIndexes.add(index);
      return;
    }
    if (!GRAPH_KIND.test(draft.kind)) {
      diagnostics.push({ code: "relation-kind-invalid", severity: "error", path: draft.provenance.path, entityId: draft.sourceId, field: draft.field, message: `Relation kind '${draft.kind}' is invalid under Graph Provider v1.` });
      conflictingRelationIds.add(relationId);
      conflictingDraftIndexes.add(index);
      return;
    }
    const previousSignature = signatureById.get(relationId);
    if (previousSignature && previousSignature !== signature) {
      conflictingRelationIds.add(relationId);
      conflictingDraftIndexes.add(index);
      const previousIndex = drafts.findIndex((candidate, candidateIndex) => candidateIndex < index && relationIds[candidateIndex] === relationId);
      if (previousIndex >= 0) conflictingDraftIndexes.add(previousIndex);
      diagnostics.push({ code: "duplicate-relation-id", severity: "error", path: draft.provenance.path, entityId: draft.sourceId, field: draft.field, message: `Relation ID '${relationId}' refers to different endpoints or kinds.` });
      return;
    }
    signatureById.set(relationId, signature);
    const bucket = relationBuckets.get(relationId) ?? [];
    bucket.push(draft);
    relationBuckets.set(relationId, bucket);
  });

  const relations: StoryRelation[] = [];
  const unpublishedRelationIds = new Set<string>(conflictingRelationIds);
  for (const [id, bucket] of relationBuckets) {
    if (conflictingRelationIds.has(id)) continue;
    if (bucket.some((item) => !item.publishable)) {
      unpublishedRelationIds.add(id);
      continue;
    }
    const first = bucket[0]!;
    const notes = [...new Set(bucket.flatMap((item) => item.note === undefined ? [] : [item.note]))];
    if (notes.length > 1) {
      diagnostics.push({ code: "relation-note-conflict", severity: "warning", path: first.provenance.path, entityId: first.sourceId, field: first.field, message: `Relation '${id}' has differing notes in its source declarations.` });
    }
    const provenance = bucket.map((item) => item.provenance)
      .sort((left, right) => left.path.localeCompare(right.path) || left.field.localeCompare(right.field) || stableStringify(left.pointer).localeCompare(stableStringify(right.pointer)));
    if (provenance.length > 64) {
      diagnostics.push({ code: "relation-provenance-limit", severity: "error", path: first.provenance.path, entityId: first.sourceId, field: first.field, message: `Relation '${id}' has more than 64 provenance records and cannot be published in Graph Provider v1.` });
      unpublishedRelationIds.add(id);
      continue;
    }
    const sourceRelationIds = [...new Set(bucket.flatMap((item) => item.sourceRelationId ? [item.sourceRelationId] : []))];
    relations.push({
      id,
      fromId: first.sourceId,
      toId: first.targetId,
      kind: first.kind,
      directed: true,
      ...(notes.length === 1 ? { note: notes[0] } : {}),
      provenance,
      resolved: entitiesById.has(first.targetId),
      ...(sourceRelationIds.length === 1 ? { sourceRelationId: sourceRelationIds[0] } : {}),
    });
    if (!entitiesById.has(first.targetId)) {
      diagnostics.push({ code: "relation-target-dangling", severity: "warning", path: first.provenance.path, entityId: first.sourceId, field: first.field, message: `Relation target '${first.targetId}' is not present in this Story snapshot.` });
    }
  }
  relations.sort((left, right) => left.id.localeCompare(right.id));

  const references: StoryReference[] = await Promise.all(drafts.map(async (draft, index) => ({
    id: `ref-${await sha256(JSON.stringify([
      draft.sourceId,
      draft.provenance.path,
      draft.provenance.pointer,
      draft.targetId,
      draft.kind,
      draft.sourceRelationId ?? null,
    ]))}`,
    fromId: draft.sourceId,
    toId: draft.targetId,
    kind: draft.kind,
    ...(draft.note !== undefined ? { note: draft.note } : {}),
    ...(draft.sourceRelationId !== undefined ? { sourceRelationId: draft.sourceRelationId } : {}),
    provenance: draft.provenance,
    publishable: draft.publishable && !conflictingDraftIndexes.has(index) && !unpublishedRelationIds.has(relationIds[index]!),
  })));

  const hierarchy = addHierarchyDiagnostics(uniqueEntities, diagnostics);
  const referencesComplete = sourceInventory.duplicates.length === 0
    && parsed.every((item) => item.entity !== undefined)
    && unavailableStorySources.length === 0
    && !diagnostics.some((item) => item.code === "relation-reference-invalid" || item.code === "relation-shape-invalid");
  // SourceRevision is the Host's digest over the complete workspace inventory. The version prefix
  // separates future Story index algorithms while allowing the Host to request this snapshot
  // without importing or running Story code.
  const providerRevision = `story-v1:${await sha256(input.sourceRevision)}`;
  return {
    workspaceId: input.workspaceId,
    sourceRevision: input.sourceRevision,
    epoch: input.epoch,
    providerRevision,
    referencesComplete,
    files,
    entities: uniqueEntities,
    entitiesById,
    duplicateEntityIds,
    relations,
    references: references.sort((left, right) => left.id.localeCompare(right.id)),
    hierarchy,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

export function findStoryEntity(index: StoryIndex, id: string): StoryEntity | undefined {
  return index.entitiesById.get(id);
}

export function searchStory(index: StoryIndex, query: string, types?: ReadonlySet<string>): readonly StoryEntity[] {
  const normalized = query.normalize("NFKC").trim().toLocaleLowerCase("ja");
  const results = index.entities.filter((entity) => {
    if (types && !types.has(entity.type)) return false;
    if (!normalized) return true;
    const haystack = [entity.id, entity.name, entity.path, ...entity.aliases, ...entity.tags]
      .join("\n").normalize("NFKC").toLocaleLowerCase("ja");
    return haystack.includes(normalized);
  });
  return results.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id));
}

export function incomingStoryRelations(index: StoryIndex, entityId: string): readonly StoryRelation[] {
  return index.relations.filter((relation) => relation.toId === entityId).sort((left, right) => left.id.localeCompare(right.id));
}

export function incomingStoryReferences(index: StoryIndex, entityId: string): readonly StoryReference[] {
  return index.references.filter((reference) => reference.toId === entityId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getStorySource(index: StoryIndex, path: string): StorySourceDocument | undefined {
  const file = index.files.get(path);
  if (!file) return undefined;
  return parseStorySourceFile(file).source;
}

export function getSceneAppearances(index: StoryIndex, entityId: string): readonly { scene: StoryEntity; kinds: readonly string[] }[] {
  const byScene = new Map<string, { scene: StoryEntity; kinds: Set<string> }>();
  for (const relation of index.relations) {
    if (relation.toId !== entityId || !["appears", "mentions", "pov"].includes(relation.kind)) continue;
    const scene = index.entitiesById.get(relation.fromId);
    if (scene?.type !== "scene") continue;
    const current = byScene.get(scene.id) ?? { scene, kinds: new Set<string>() };
    current.kinds.add(relation.kind);
    byScene.set(scene.id, current);
  }
  return [...byScene.values()]
    .map(({ scene, kinds }) => ({ scene, kinds: [...kinds].sort() }))
    .sort((left, right) => Number(left.scene.properties.order ?? 0) - Number(right.scene.properties.order ?? 0) || left.scene.id.localeCompare(right.scene.id));
}

export function storyNodeId(index: StoryIndex, localId: string): string {
  // Structured identity is still (providerId, localId); this helper only creates a stable cache key.
  return JSON.stringify([STORY_PROVIDER_ID, `${index.workspaceId}\0${localId}`]);
}

export function getStoryEntitySource(index: StoryIndex, entityId: string): StorySourceFile | undefined {
  const entity = index.entitiesById.get(entityId);
  return entity ? index.files.get(entity.path) : undefined;
}

export function knownStoryTypeForPath(path: string): ReturnType<typeof inferStoryType> {
  return inferStoryType(path);
}
