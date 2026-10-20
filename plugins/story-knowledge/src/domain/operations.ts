import YAML from "yaml";
import { defaultStoryPath, hierarchyParents, normalizeStoryPath } from "./paths.js";
import {
  editSourceFields,
  editSourcePath,
  editSourcePaths,
  parseStorySourceFile,
  type StorySourceDocument,
} from "./source.js";
import {
  incomingStoryReferences,
  getStorySource,
} from "./index.js";
import type {
  EditableStoryEntityType,
  StoryEntity,
  StoryIndex,
  StoryRelation,
  StoryReference,
  StorySourceFile,
} from "./types.js";

export interface ChangeIntent {
  operationId: string;
  workspaceId: string;
  baseWorkspaceRevision: string;
  reads: Array<{ path: string; revision: string | null }>;
  writes: Array<{ path: string; content: string | null; encoding?: "utf8" }>;
  message: string;
  kind: "source";
}

export class StoryEditError extends Error {
  readonly code: string;
  readonly paths: readonly string[];

  constructor(code: string, message: string, paths: readonly string[] = []) {
    super(message);
    this.name = "StoryEditError";
    this.code = code;
    this.paths = paths;
  }
}

export type StoryDeletePlan =
  | { allowed: true; incoming: readonly StoryReference[]; change: ChangeIntent }
  | { allowed: false; incoming: readonly StoryReference[]; reason: string; code: string; children?: readonly StoryEntity[] };

const STRUCTURAL_FIELDS = new Set([
  "id", "type", "volume", "chapter", "manuscript", "location",
  "appears", "mentions", "plants", "advances", "related", "pov", "affiliated", "target", "first_appears", "planted", "payoff",
  "relations", "entities", "threads",
]);
const MAX_WRITE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHANGE_BYTES = 8 * 1024 * 1024;

function operationId(): string {
  if (!globalThis.crypto?.randomUUID) throw new StoryEditError("CRYPTO_UNAVAILABLE", "A cryptographic UUID generator is required for a source change.");
  return globalThis.crypto.randomUUID();
}

function assertSerializable(value: unknown, field: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new StoryEditError("FIELD_NOT_SERIALIZABLE", `${field} is not JSON-serializable.`);
  }
  if (serialized === undefined) throw new StoryEditError("FIELD_NOT_SERIALIZABLE", `${field} is not JSON-serializable.`);
  return JSON.parse(serialized) as unknown;
}

function assertEditableEntity(index: StoryIndex, id: string): StoryEntity {
  const entity = index.entitiesById.get(id);
  if (!entity) throw new StoryEditError("ENTITY_UNAVAILABLE", `Entity '${id}' is missing or has a duplicate ID.`);
  if (!entity.editable) throw new StoryEditError("SOURCE_READ_ONLY", `Entity '${id}' has source diagnostics and cannot be edited.`, [entity.path]);
  return entity;
}

function assertSource(index: StoryIndex, entity: StoryEntity): StorySourceDocument {
  const source = getStorySource(index, entity.path);
  if (!source || source.file.revision !== entity.revision) {
    throw new StoryEditError("SOURCE_UNAVAILABLE", `Source '${entity.path}' is not available at the indexed revision.`, [entity.path]);
  }
  return source;
}

function makeChange(index: StoryIndex, reads: ReadonlyMap<string, string | null>, writes: ReadonlyMap<string, string | null>, message: string): ChangeIntent | null {
  const changed = [...writes].filter(([path, content]) => {
    const existing = index.files.get(path);
    return content === null ? existing !== undefined : existing?.content !== content;
  });
  if (changed.length === 0) return null;
  if (changed.length > 256) throw new StoryEditError("CHANGE_FILE_LIMIT", "A Story change cannot write more than 256 files.");

  let totalBytes = 0;
  for (const [path, content] of changed) {
    if (!normalizeStoryPath(path)) throw new StoryEditError("INVALID_PATH", `Invalid Story source path '${path}'.`, [path]);
    if (content === null) continue;
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > MAX_WRITE_FILE_BYTES) throw new StoryEditError("SOURCE_SIZE_LIMIT", `Source '${path}' exceeds 2 MiB.`, [path]);
    totalBytes += bytes;
  }
  if (totalBytes > MAX_CHANGE_BYTES) throw new StoryEditError("CHANGE_SIZE_LIMIT", "A Story source change cannot exceed 8 MiB.");
  if (reads.size > 512) throw new StoryEditError("CHANGE_READ_LIMIT", "A Story change cannot validate more than 512 source revisions.");

  return {
    operationId: operationId(),
    workspaceId: index.workspaceId,
    baseWorkspaceRevision: index.sourceRevision,
    reads: [...reads].sort(([left], [right]) => left.localeCompare(right)).map(([path, revision]) => ({ path, revision })),
    writes: changed.sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({
      path,
      content,
      ...(content !== null ? { encoding: "utf8" as const } : {}),
    })),
    message,
    kind: "source",
  };
}

function assertValidNewId(type: EditableStoryEntityType, id: string): void {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (!new RegExp(`^${type}-${uuid}$`, "iu").test(id)) {
    throw new StoryEditError("NEW_ID_INVALID", `New ${type} IDs must use the opaque '${type}-<uuid>' format.`);
  }
}

export function createStoryId(type: EditableStoryEntityType): string {
  if (!globalThis.crypto?.randomUUID) throw new StoryEditError("CRYPTO_UNAVAILABLE", "A cryptographic UUID generator is required for a new Story ID.");
  return `${type}-${globalThis.crypto.randomUUID()}`;
}

function serializeYamlRecord(value: Record<string, unknown>): string {
  const document = new YAML.Document();
  document.contents = value as never;
  return document.toString();
}

function markdownContent(id: string, title: string, body: string, fields: Readonly<Record<string, unknown>> = {}): string {
  const document = new YAML.Document({ id, type: "manuscript", title, ...fields });
  return `---\n${document.toString()}---\n${body}`;
}

function parentEntity(index: StoryIndex, id: string, type: "volume" | "chapter"): StoryEntity {
  const parent = assertEditableEntity(index, id);
  if (parent.type !== type) throw new StoryEditError("HIERARCHY_PARENT_TYPE", `Expected a ${type} parent for this Story entity.`, [parent.path]);
  return parent;
}

function nextOrder(index: StoryIndex, type: "chapter" | "scene", parentId: string): number {
  const children = index.entities.filter((entity) => entity.type === type &&
    (type === "chapter" ? entity.properties["volume"] === parentId || hierarchyParents(entity.path).volumePathId === parentId
      : entity.properties["chapter"] === parentId || hierarchyParents(entity.path).chapterPathId === parentId));
  const values = children.map((entity) => entity.properties["order"]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) + 1 : children.length;
}

export interface CreateStoryInput {
  type: EditableStoryEntityType;
  name: string;
  fields?: Readonly<Record<string, unknown>>;
  volumeId?: string;
  chapterId?: string;
  manuscriptBody?: string;
}

export function planCreateStoryEntity(index: StoryIndex, input: CreateStoryInput): ChangeIntent {
  const id = createStoryId(input.type);
  assertValidNewId(input.type, id);
  if (!input.name.trim()) throw new StoryEditError("NAME_REQUIRED", "A display name is required.");
  const fields = input.fields ?? {};
  for (const field of Object.keys(fields)) {
    if (STRUCTURAL_FIELDS.has(field) || field === "id" || field === "type" || field === "name" || field === "title") {
      throw new StoryEditError("FIELD_IS_DERIVED", `The '${field}' field is controlled by Story identity or relation operations.`, [],);
    }
  }

  const copiedFields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) copiedFields[field] = assertSerializable(value, field);
  const sourceRecord: Record<string, unknown> = { id, type: input.type, name: input.name, ...copiedFields };
  const reads = new Map<string, string | null>();
  const writes = new Map<string, string | null>();

  if (input.type === "chapter") {
    if (!input.volumeId) throw new StoryEditError("HIERARCHY_PARENT_REQUIRED", "A chapter requires a volume.");
    const volume = parentEntity(index, input.volumeId, "volume");
    const path = defaultStoryPath("chapter", id, { volumeId: volume.id });
    if (index.files.has(path)) throw new StoryEditError("SOURCE_PATH_EXISTS", `Source path '${path}' already exists.`, [path]);
    sourceRecord["volume"] = volume.id;
    sourceRecord["order"] = nextOrder(index, "chapter", volume.id);
    reads.set(volume.path, volume.revision);
    reads.set(path, null);
    writes.set(path, serializeYamlRecord(sourceRecord));
  } else if (input.type === "scene") {
    if (!input.chapterId) throw new StoryEditError("HIERARCHY_PARENT_REQUIRED", "A scene requires a chapter.");
    const chapter = parentEntity(index, input.chapterId, "chapter");
    const pathParents = hierarchyParents(chapter.path);
    const volumeId = typeof chapter.properties["volume"] === "string" ? chapter.properties["volume"] : pathParents.volumePathId;
    if (!volumeId) throw new StoryEditError("HIERARCHY_VOLUME_REQUIRED", "The chapter has no resolvable volume parent.", [chapter.path]);
    const volume = parentEntity(index, volumeId, "volume");
    const path = defaultStoryPath("scene", id, { volumeId: volume.id, chapterId: chapter.id });
    const manuscriptId = createStoryId("manuscript");
    const manuscriptPath = defaultStoryPath("manuscript", `${id}.md`);
    if (index.files.has(path) || index.files.has(manuscriptPath)) {
      throw new StoryEditError("SOURCE_PATH_EXISTS", "A source file for this scene already exists.", [path, manuscriptPath]);
    }
    sourceRecord["volume"] = volume.id;
    sourceRecord["chapter"] = chapter.id;
    sourceRecord["manuscript"] = manuscriptPath;
    sourceRecord["order"] = nextOrder(index, "scene", chapter.id);
    reads.set(volume.path, volume.revision);
    reads.set(chapter.path, chapter.revision);
    reads.set(path, null);
    reads.set(manuscriptPath, null);
    writes.set(path, serializeYamlRecord(sourceRecord));
    writes.set(manuscriptPath, markdownContent(manuscriptId, input.name, input.manuscriptBody ?? ""));
  } else if (input.type === "volume") {
    const path = defaultStoryPath("volume", id);
    if (index.files.has(path)) throw new StoryEditError("SOURCE_PATH_EXISTS", `Source path '${path}' already exists.`, [path]);
    reads.set(path, null);
    writes.set(path, serializeYamlRecord({ ...sourceRecord, order: index.entities.filter((entity) => entity.type === "volume").length }));
  } else if (input.type === "manuscript") {
    const path = defaultStoryPath("manuscript", `${id}.md`);
    if (index.files.has(path)) throw new StoryEditError("SOURCE_PATH_EXISTS", `Source path '${path}' already exists.`, [path]);
    reads.set(path, null);
    writes.set(path, markdownContent(id, input.name, input.manuscriptBody ?? "", copiedFields));
  } else {
    const path = defaultStoryPath(input.type, id);
    if (index.files.has(path)) throw new StoryEditError("SOURCE_PATH_EXISTS", `Source path '${path}' already exists.`, [path]);
    reads.set(path, null);
    writes.set(path, serializeYamlRecord(sourceRecord));
  }

  const change = makeChange(index, reads, writes, `Create Story ${input.type}: ${input.name}`);
  if (!change) throw new StoryEditError("NO_OP", "The new Story entity did not produce a source change.");
  return change;
}

export function planUpdateStoryEntity(index: StoryIndex, id: string, fields: Readonly<Record<string, unknown | undefined>>): ChangeIntent | null {
  const entity = assertEditableEntity(index, id);
  const source = assertSource(index, entity);
  for (const field of Object.keys(fields)) {
    if (STRUCTURAL_FIELDS.has(field)) throw new StoryEditError("FIELD_IS_RELATION", `The '${field}' field must be changed through Story relation or hierarchy operations.`, [entity.path]);
  }
  const changes: Record<string, unknown | undefined> = {};
  let markdownBody: string | undefined;
  for (const [field, value] of Object.entries(fields)) {
    if (field === "body") {
      if (entity.type !== "manuscript" || typeof value !== "string") throw new StoryEditError("FIELD_TYPE_INVALID", "Only a manuscript body can be edited as raw Markdown.", [entity.path]);
      markdownBody = value;
      continue;
    }
    const sourceField = field === "name" && entity.type === "manuscript" && !Object.hasOwn(source.raw, "name") ? "title" : field;
    changes[sourceField] = value === undefined ? undefined : assertSerializable(value, field);
  }
  const content = editSourceFields(source, changes, markdownBody);
  return makeChange(index, new Map([[entity.path, entity.revision]]), new Map([[entity.path, content]]), `Update Story ${entity.type}: ${entity.name}`);
}

function relationDocumentValue(source: StorySourceDocument, relation: StoryRelation, provenance: StoryRelation["provenance"][number], next: { targetId: string; kind: string; note?: string }): { pointer: readonly (string | number)[]; value: unknown } {
  const current = getAt(source.raw, provenance.pointer);
  if (provenance.field === "relations") {
    if (!isRecord(current)) throw new StoryEditError("RELATION_SOURCE_INVALID", `Relation '${relation.id}' has an unsupported source form.`, [source.file.path]);
    const replacement: Record<string, unknown> = { ...current, target: next.targetId, kind: next.kind };
    if (next.note !== undefined) replacement["note"] = next.note;
    else delete replacement["note"];
    return { pointer: provenance.pointer, value: replacement };
  }
  const value = current;
  if (typeof value === "string") {
    if (next.kind !== relation.kind || next.note !== undefined) {
      return { pointer: provenance.pointer, value: { target: next.targetId, kind: next.kind, ...(next.note !== undefined ? { note: next.note } : {}) } };
    }
    return { pointer: provenance.pointer, value: next.targetId };
  }
  if (isRecord(value)) {
    const targetKey = ["target", "scene", "id"].find((key) => typeof value[key] === "string");
    const replacement: Record<string, unknown> = { ...value };
    replacement[targetKey ?? "target"] = next.targetId;
    if (targetKey === undefined || targetKey === "target") replacement["kind"] = next.kind;
    if (next.note !== undefined) replacement["note"] = next.note;
    else delete replacement["note"];
    return { pointer: provenance.pointer, value: replacement };
  }
  throw new StoryEditError("RELATION_SOURCE_INVALID", `Relation '${relation.id}' has an unsupported source form.`, [source.file.path]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getAt(root: unknown, pointer: readonly (string | number)[]): unknown {
  let value = root;
  for (const part of pointer) {
    if (Array.isArray(value) && typeof part === "number") value = value[part];
    else if (isRecord(value) && typeof part === "string") value = value[part];
    else return undefined;
  }
  return value;
}

function validateRelationSource(source: StorySourceDocument, relation: StoryRelation): void {
  if (relation.provenance.length === 0) throw new StoryEditError("RELATION_SOURCE_MISSING", `Relation '${relation.id}' has no provenance.`);
  if (relation.provenance.some((item) => item.path !== source.file.path || item.revision !== source.file.revision)) {
    throw new StoryEditError("RELATION_MULTI_SOURCE_EDIT_UNSUPPORTED", "This relation has multiple source files; edit one source declaration at a time.", relation.provenance.map((item) => item.path));
  }
}

export function planCreateStoryRelation(index: StoryIndex, sourceId: string, targetId: string, kind: string, note?: string): ChangeIntent {
  const sourceEntity = assertEditableEntity(index, sourceId);
  const target = index.entitiesById.get(targetId);
  if (!target) throw new StoryEditError("RELATION_TARGET_UNAVAILABLE", `Target '${targetId}' is missing or duplicated.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(kind)) throw new StoryEditError("RELATION_KIND_INVALID", "Relation kind must be a valid Graph kind.");
  const source = assertSource(index, sourceEntity);
  const existing = source.raw["relations"];
  if (existing !== undefined && !Array.isArray(existing)) throw new StoryEditError("RELATION_LIST_INVALID", "The source relations field is not an array.", [source.file.path]);
  const id = `relation-${operationId()}`;
  const relation = { id, target: targetId, kind, ...(note !== undefined ? { note } : {}) };
  const content = editSourcePath(source, ["relations"], [...(Array.isArray(existing) ? existing : []), relation]);
  const change = makeChange(index, new Map([[source.file.path, source.file.revision]]), new Map([[source.file.path, content]]), `Add ${kind} relation: ${sourceEntity.name} → ${target.name}`);
  if (!change) throw new StoryEditError("NO_OP", "The relation did not produce a source change.");
  return change;
}

export function planUpdateStoryRelation(index: StoryIndex, relationId: string, next: { targetId: string; kind: string; note?: string }): ChangeIntent | null {
  const relation = index.relations.find((item) => item.id === relationId);
  if (!relation) throw new StoryEditError("RELATION_UNAVAILABLE", `Relation '${relationId}' is missing or invalid.`);
  if (next.kind !== relation.kind && relation.provenance.some((item) => item.field !== "relations")) {
    throw new StoryEditError("RELATION_KIND_FIXED", "The relation kind is fixed by its source field.", relation.provenance.map((item) => item.path));
  }
  const target = index.entitiesById.get(next.targetId);
  if (!target) throw new StoryEditError("RELATION_TARGET_UNAVAILABLE", `Target '${next.targetId}' is missing or duplicated.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(next.kind)) throw new StoryEditError("RELATION_KIND_INVALID", "Relation kind must be a valid Graph kind.");
  const paths = new Set(relation.provenance.map((item) => item.path));
  if (paths.size !== 1) throw new StoryEditError("RELATION_MULTI_SOURCE_EDIT_UNSUPPORTED", "This relation is declared by multiple files and cannot be updated as one change.", [...paths]);
  const source = getStorySource(index, [...paths][0]!);
  if (!source) throw new StoryEditError("RELATION_SOURCE_MISSING", `Source for '${relationId}' is missing.`, [...paths]);
  validateRelationSource(source, relation);
  if (relation.provenance.some((item) => item.field !== "relations") && next.kind !== relation.kind) {
    throw new StoryEditError("RELATION_KIND_FIXED", "The relation kind is fixed by its source field.", relation.provenance.map((item) => item.path));
  }
  const edits = relation.provenance.map((provenance) => {
    const storedTarget = provenance.field === "manuscript" && target.type === "manuscript" ? target.path : next.targetId;
    return relationDocumentValue(source, relation, provenance, { ...next, targetId: storedTarget });
  });
  const content = editSourcePaths(source, edits);
  return makeChange(index, new Map([[source.file.path, source.file.revision]]), new Map([[source.file.path, content]]), `Update ${relation.kind} relation`);
}

export function planDeleteStoryRelation(index: StoryIndex, relationId: string): ChangeIntent | null {
  const relation = index.relations.find((item) => item.id === relationId);
  if (!relation) throw new StoryEditError("RELATION_UNAVAILABLE", `Relation '${relationId}' is missing or invalid.`);
  const paths = [...new Set(relation.provenance.map((item) => item.path))];
  const edits = new Map<string, { source: StorySourceDocument; pointers: Array<readonly (string | number)[]> }>();
  for (const path of paths) {
    const source = getStorySource(index, path);
    if (!source) throw new StoryEditError("RELATION_SOURCE_MISSING", `Source '${path}' is missing.`, [path]);
    if (source.file.revision !== relation.provenance.find((item) => item.path === path)?.revision) {
      throw new StoryEditError("RELATION_SOURCE_STALE", `Source '${path}' changed since the relation was indexed.`, [path]);
    }
    const group = edits.get(path) ?? { source, pointers: [] };
    group.pointers.push(...relation.provenance.filter((item) => item.path === path).map((item) => item.pointer));
    edits.set(path, group);
  }
  const reads = new Map<string, string | null>();
  const writes = new Map<string, string | null>();
  for (const [path, group] of edits) {
    const seen = new Set<string>();
    const uniquePointers = group.pointers.filter((pointer) => {
      const key = JSON.stringify(pointer);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    reads.set(path, group.source.file.revision);
    writes.set(path, editSourcePaths(group.source, uniquePointers.map((pointer) => ({ pointer, value: undefined }))));
  }
  const change = makeChange(index, reads, writes, `Delete ${relation.kind} relation`);
  return change;
}

export function planDeleteStoryEntity(index: StoryIndex, id: string, options: { cascade?: boolean } = {}): StoryDeletePlan {
  const entity = assertEditableEntity(index, id);
  const incoming = incomingStoryReferences(index, id);
  const childType = entity.type === "volume" ? "chapter" : entity.type === "chapter" ? "scene" : undefined;
  const children = childType ? index.entities.filter((candidate) => candidate.type === childType && (
    (entity.type === "volume" && (candidate.properties["volume"] === id || hierarchyParents(candidate.path).volumePathId === id))
    || (entity.type === "chapter" && (candidate.properties["chapter"] === id || hierarchyParents(candidate.path).chapterPathId === id))
  )) : [];
  if (children.length > 0) {
    return { allowed: false, incoming, children, code: "HIERARCHY_CHILDREN", reason: `Delete or move the ${childType} entities before deleting this ${entity.type}.` };
  }
  if (!index.referencesComplete) {
    return { allowed: false, incoming, code: "REFERENCE_INDEX_INCOMPLETE", reason: "Malformed or duplicate Story sources prevent a safe incoming-reference check." };
  }
  if (incoming.length > 0 && !options.cascade) {
    return { allowed: false, incoming, code: "INCOMING_REFERENCES", reason: "Incoming references must be removed explicitly before this entity can be deleted." };
  }
  const reads = new Map<string, string | null>([[entity.path, entity.revision]]);
  const writes = new Map<string, string | null>([[entity.path, null]]);
  const groups = new Map<string, { source: StorySourceDocument; pointers: Array<readonly (string | number)[]> }>();
  if (options.cascade) {
    for (const reference of incoming) {
      for (const provenance of [reference.provenance]) {
        if (provenance.path === entity.path) continue;
        const source = getStorySource(index, provenance.path);
        if (!source || source.file.revision !== provenance.revision) {
          return { allowed: false, incoming, code: "CASCADE_SOURCE_UNAVAILABLE", reason: `Incoming reference source '${provenance.path}' is missing or stale.` };
        }
        const sourceEntity = index.entities.find((item) => item.path === provenance.path);
        if (sourceEntity && !sourceEntity.editable) {
          return { allowed: false, incoming, code: "CASCADE_SOURCE_READ_ONLY", reason: `Incoming reference source '${provenance.path}' has diagnostics and cannot be edited.` };
        }
        const group = groups.get(provenance.path) ?? { source, pointers: [] };
        group.pointers.push(provenance.pointer);
        groups.set(provenance.path, group);
      }
    }
  }

  for (const [path, group] of groups) {
    const seen = new Set<string>();
    const uniquePointers = group.pointers.filter((pointer) => {
      const key = JSON.stringify(pointer);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    reads.set(path, group.source.file.revision);
    writes.set(path, editSourcePaths(group.source, uniquePointers.map((pointer) => ({ pointer, value: undefined }))));
  }
  try {
    const change = makeChange(index, reads, writes, `Delete Story ${entity.type}: ${entity.name}${options.cascade ? " with incoming reference cleanup" : ""}`);
    if (!change) return { allowed: false, incoming, code: "NO_OP", reason: "Deleting this entity did not produce a source change." };
    return { allowed: true, incoming, change };
  } catch (error) {
    if (error instanceof StoryEditError) return { allowed: false, incoming, code: error.code, reason: error.message };
    throw error;
  }
}

export function draftSourceFromFile(file: StorySourceFile): StorySourceDocument | undefined {
  return parseStorySourceFile(file).source;
}
