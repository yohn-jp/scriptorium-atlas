export const STORY_PROVIDER_ID = "scriptorium.story-knowledge" as const;

export const STORY_ENTITY_TYPES = [
  "character",
  "location",
  "faction",
  "item",
  "event",
  "lore",
  "thread",
  "arc",
  "volume",
  "chapter",
  "scene",
  "manuscript",
  "dialogue_sketch",
] as const;

export type StoryEntityType = (typeof STORY_ENTITY_TYPES)[number];
export type EditableStoryEntityType = Exclude<StoryEntityType, "dialogue_sketch">;

export type DiagnosticSeverity = "error" | "warning";

export interface StoryDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  path: string;
  message: string;
  entityId?: string;
  field?: string;
}

export interface StorySourceFile {
  path: string;
  revision: string;
  content: string;
}

/** Snapshot metadata without content, usually for a source that exceeds Story's 2 MiB limit. */
export interface StoryUnavailableSource {
  path: string;
  revision: string;
  byteLength: number;
  contentType: string;
}

/** Source-bearing model for Story UI. Never copy `raw` into a Graph payload. */
export interface StoryEntity {
  id: string;
  type: StoryEntityType;
  name: string;
  path: string;
  revision: string;
  aliases: readonly string[];
  tags: readonly string[];
  properties: Readonly<Record<string, unknown>>;
  body?: string;
  editable: boolean;
}

export interface StoryProvenance {
  path: string;
  revision: string;
  field: string;
  /** AST location required to remove exactly this declaration during an explicit cascade. */
  pointer: readonly (string | number)[];
}

export interface StoryRelation {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  directed: true;
  note?: string;
  provenance: readonly StoryProvenance[];
  resolved: boolean;
  /** Existing source relation ID, when present. It is retained without changing the source. */
  sourceRelationId?: string;
}

/** Every parsed reference, including declarations that cannot be published as a valid Graph edge. */
export interface StoryReference {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  note?: string;
  /** Source identifier, even when invalid for Graph publication. */
  sourceRelationId?: string;
  provenance: StoryProvenance;
  publishable: boolean;
}

export interface StoryHierarchy {
  volumeId: string;
  chapterId: string;
  sceneIds: readonly string[];
}

export interface StoryIndex {
  workspaceId: string;
  sourceRevision: string;
  epoch: number;
  providerRevision: string;
  /** False when malformed or duplicate input prevents complete incoming-reference analysis. */
  referencesComplete: boolean;
  files: ReadonlyMap<string, StorySourceFile>;
  entities: readonly StoryEntity[];
  entitiesById: ReadonlyMap<string, StoryEntity>;
  duplicateEntityIds: ReadonlyMap<string, readonly string[]>;
  relations: readonly StoryRelation[];
  references: readonly StoryReference[];
  hierarchy: readonly StoryHierarchy[];
  diagnostics: readonly StoryDiagnostic[];
}

export interface StorySnapshotInput {
  workspaceId: string;
  sourceRevision: string;
  epoch: number;
  files: readonly StorySourceFile[];
  unavailableFiles?: readonly StoryUnavailableSource[];
}
