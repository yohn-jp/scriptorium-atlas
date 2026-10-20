import YAML, {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Document,
  type Node,
} from "yaml";
import { hierarchyParents, inferStoryType, normalizeStoryPath, pathSupportsType, sourcePathToManuscriptId } from "./paths.js";
import {
  STORY_ENTITY_TYPES,
  type StoryDiagnostic,
  type StoryEntity,
  type StoryEntityType,
  type StorySourceFile,
} from "./types.js";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_YAML_DEPTH = 64;
const MAX_YAML_ALIASES = 100;
const CORE_TAGS = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:timestamp",
  "tag:yaml.org,2002:binary",
]);

export interface StorySourceDocument {
  file: StorySourceFile;
  document: Document.Parsed;
  raw: Record<string, unknown>;
  body?: string;
  markdown?: {
    opening: string;
    header: string;
    closing: string;
    body: string;
    newline: "\n" | "\r\n";
  };
}

export interface ParsedStoryFile {
  source?: StorySourceDocument;
  entity?: StoryEntity;
  diagnostics: StoryDiagnostic[];
}

function diagnostic(path: string, code: string, message: string, severity: "error" | "warning" = "error", field?: string): StoryDiagnostic {
  return { code, severity, path, message, ...(field ? { field } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function nodeChildren(node: Node): Node[] {
  if (isAlias(node) || isScalar(node)) return [];
  if (isMap(node)) {
    const children: Node[] = [];
    for (const pair of node.items) {
      if (!isPair(pair)) continue;
      if (pair.key) children.push(pair.key as Node);
      if (pair.value) children.push(pair.value as Node);
    }
    return children;
  }
  if (isSeq(node)) return node.items.filter((child): child is Node => child !== null);
  return [];
}

function inspectAst(document: Document.Parsed, path: string, diagnostics: StoryDiagnostic[]): void {
  let aliasCount = 0;
  const pending: Array<{ node: Node; depth: number }> = document.contents
    ? [{ node: document.contents, depth: 1 }]
    : [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.depth > MAX_YAML_DEPTH) {
      diagnostics.push(diagnostic(path, "yaml-depth-limit", `YAML nesting exceeds ${MAX_YAML_DEPTH}.`));
      return;
    }
    if (isAlias(current.node)) aliasCount += 1;
    const tag = current.node.tag;
    if (tag && !CORE_TAGS.has(tag)) {
      diagnostics.push(diagnostic(path, "yaml-tag-unsupported", `Non-standard YAML tag is not editable: ${tag}.`));
    }
    for (const child of nodeChildren(current.node)) pending.push({ node: child, depth: current.depth + 1 });
  }
  if (aliasCount > MAX_YAML_ALIASES) {
    diagnostics.push(diagnostic(path, "yaml-alias-limit", `YAML contains more than ${MAX_YAML_ALIASES} aliases.`));
  }
}

function parseYaml(content: string, path: string, diagnostics: StoryDiagnostic[]): { document: Document.Parsed; raw: Record<string, unknown> } | null {
  const document = YAML.parseDocument(content, {
    version: "1.2",
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
    logLevel: "silent",
  });
  for (const issue of document.errors) {
    diagnostics.push(diagnostic(path, `yaml-${issue.code.toLowerCase()}`, issue.message));
  }
  for (const issue of document.warnings) {
    diagnostics.push(diagnostic(path, `yaml-${issue.code.toLowerCase()}`, issue.message, "warning"));
  }
  inspectAst(document, path, diagnostics);
  if (document.errors.length > 0 || diagnostics.some((item) => item.path === path && item.severity === "error")) return null;

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch (error) {
    diagnostics.push(diagnostic(path, "yaml-conversion-failed", error instanceof Error ? error.message : "YAML could not be converted."));
    return null;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(path, "yaml-root-not-object", "Story YAML root must be a mapping."));
    return null;
  }
  return { document, raw: value };
}

function parseMarkdown(file: StorySourceFile, diagnostics: StoryDiagnostic[]): StorySourceDocument | null {
  const openingMatch = /^---[ \t]*(\r?\n)/.exec(file.content);
  const newline: "\n" | "\r\n" = file.content.includes("\r\n") ? "\r\n" : "\n";
  if (!openingMatch) {
    const document = YAML.parseDocument("", { version: "1.2", strict: true, uniqueKeys: true, logLevel: "silent" });
    return { file, document, raw: {}, body: file.content, markdown: { opening: "", header: "", closing: "", body: file.content, newline } };
  }
  const opening = openingMatch[0];
  const headerStart = opening.length;
  const rest = file.content.slice(headerStart);
  const closingMatch = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closingMatch || closingMatch.index === undefined) {
    diagnostics.push(diagnostic(file.path, "frontmatter-unclosed", "Markdown frontmatter has no closing delimiter."));
    return null;
  }
  const parsed = parseYaml(rest.slice(0, closingMatch.index), file.path, diagnostics);
  if (!parsed) return null;
  const body = rest.slice(closingMatch.index + closingMatch[0].length);
  return {
    file,
    document: parsed.document,
    raw: parsed.raw,
    body,
    markdown: { opening, header: rest.slice(0, closingMatch.index), closing: closingMatch[0], body, newline },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sourceNewline(source: StorySourceDocument): "\n" | "\r\n" {
  return source.markdown?.newline ?? (source.file.content.includes("\r\n") ? "\r\n" : "\n");
}

function typedStringArray(value: unknown, path: string, field: string, diagnostics: StoryDiagnostic[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(diagnostic(path, "field-type-invalid", `${field} must be a string array.`, "warning", field));
    return [];
  }
  return [...value];
}

function hasErrorForPath(diagnostics: readonly StoryDiagnostic[], path: string): boolean {
  return diagnostics.some((item) => item.path === path && item.severity === "error");
}

function parseEntity(source: StorySourceDocument, inferredType: StoryEntityType, diagnostics: StoryDiagnostic[]): StoryEntity | undefined {
  const { file, raw, markdown } = source;
  const explicitType = raw.type;
  let type = inferredType;
  if (explicitType !== undefined) {
    if (typeof explicitType !== "string" || !STORY_ENTITY_TYPES.includes(explicitType as StoryEntityType)) {
      diagnostics.push(diagnostic(file.path, "entity-type-unknown", "Unknown explicit Story type; source is read-only.", "error", "type"));
      return undefined;
    }
    type = explicitType as StoryEntityType;
    if (!pathSupportsType(file.path, type)) {
      diagnostics.push(diagnostic(file.path, "entity-type-path-mismatch", `Declared type '${type}' does not match this source path.`, "error", "type"));
    }
  }

  let id: string;
  if (typeof raw.id === "string" && raw.id.length > 0) {
    id = raw.id;
  } else if (type === "manuscript") {
    id = sourcePathToManuscriptId(file.path);
  } else {
    diagnostics.push(diagnostic(file.path, "entity-id-missing", "Story YAML requires a stable string id.", "error", "id"));
    return undefined;
  }
  if (byteLength(id) > 256 || /[\u0000-\u001f\u007f]/u.test(id)) {
    diagnostics.push(diagnostic(file.path, "entity-id-invalid", "Entity ID must be 1–256 UTF-8 bytes without control characters.", "error", "id"));
  }

  const candidateName = raw.name ?? raw.title;
  const name = typeof candidateName === "string" && candidateName.length > 0 ? candidateName : id;
  const aliases = typedStringArray(raw.aliases, file.path, "aliases", diagnostics);
  const tags = typedStringArray(raw.tags, file.path, "tags", diagnostics);
  const parents = hierarchyParents(file.path);
  if (parents.volumePathId && typeof raw.volume === "string" && raw.volume !== parents.volumePathId) {
    diagnostics.push(diagnostic(file.path, "hierarchy-volume-path-mismatch", "Scene or chapter volume reference differs from its path.", "error", "volume"));
  }
  if (parents.chapterPathId && typeof raw.chapter === "string" && raw.chapter !== parents.chapterPathId) {
    diagnostics.push(diagnostic(file.path, "hierarchy-chapter-path-mismatch", "Scene chapter reference differs from its path.", "error", "chapter"));
  }

  return {
    id,
    type,
    name,
    path: file.path,
    revision: file.revision,
    aliases,
    tags,
    properties: raw,
    ...(markdown ? { body: markdown.body } : typeof raw.body === "string" ? { body: raw.body } : {}),
    editable: type !== "dialogue_sketch" && !hasErrorForPath(diagnostics, file.path),
  };
}

export function parseStorySourceFile(file: StorySourceFile): ParsedStoryFile {
  try {
    return parseStorySourceFileUnsafe(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source could not be parsed.";
    return { diagnostics: [diagnostic(file.path, "source-parse-failed", message)] };
  }
}

function parseStorySourceFileUnsafe(file: StorySourceFile): ParsedStoryFile {
  const diagnostics: StoryDiagnostic[] = [];
  const normalizedPath = normalizeStoryPath(file.path);
  if (!normalizedPath) {
    diagnostics.push(diagnostic(file.path, "source-path-invalid", "Source path must be normalized, relative, and contain no traversal."));
    return { diagnostics };
  }
  if (!isValidUnicode(file.content) || !isValidUnicode(file.path)) {
    diagnostics.push(diagnostic(file.path, "source-unicode-invalid", "Source contains invalid Unicode."));
    return { diagnostics };
  }
  if (byteLength(file.content) > MAX_SOURCE_BYTES) {
    diagnostics.push(diagnostic(file.path, "source-size-limit", `Source exceeds the ${MAX_SOURCE_BYTES}-byte limit.`));
    return { diagnostics };
  }
  const inferredType = inferStoryType(file.path);
  if (!inferredType) return { diagnostics };

  let source: StorySourceDocument | null;
  if (inferredType === "manuscript") source = parseMarkdown(file, diagnostics);
  else {
    const parsed = parseYaml(file.content, file.path, diagnostics);
    source = parsed ? { file, document: parsed.document, raw: parsed.raw } : null;
  }
  if (!source) return { diagnostics };
  const entity = parseEntity(source, inferredType, diagnostics);
  return { source, ...(entity ? { entity } : {}), diagnostics };
}

/** Apply top-level fields through the YAML AST, retaining comments and unknown keys. */
export function editSourceFields(source: StorySourceDocument, changes: Readonly<Record<string, unknown | undefined>>, markdownBody?: string): string {
  let changed = false;
  for (const [key, value] of Object.entries(changes)) {
    const existing = source.document.get(key);
    if (value === undefined) {
      if (existing !== undefined) {
        source.document.delete(key);
        changed = true;
      }
    } else if (!sameJsonValue(source.raw[key], value)) {
      source.document.set(key, value);
      changed = true;
    }
  }
  const bodyChanged = source.markdown !== undefined && markdownBody !== undefined && markdownBody !== source.markdown.body;
  if (!changed && !bodyChanged) return source.file.content;
  if (!changed && bodyChanged) return editStoryBody(source, markdownBody!);

  const serialized = source.document.toString().replaceAll("\n", sourceNewline(source));
  if (!source.markdown) return serialized;
  const body = markdownBody ?? source.markdown.body;
  if (!source.markdown.opening) return `---${source.markdown.newline}${serialized}---${source.markdown.newline}${body}`;
  const header = serialized.replace(/(?:\r?\n)+$/u, "");
  return `${source.markdown.opening}${header}${source.markdown.newline}${source.markdown.closing}${body}`;
}

/** Replace one existing AST value. Array indexes are validated against the parsed source. */
export function editSourcePath(source: StorySourceDocument, pointer: readonly (string | number)[], value: unknown | undefined): string {
  if (pointer.length === 0) throw new Error("The source root cannot be replaced.");
  const current = source.document.getIn(pointer as (string | number)[]);
  if (value === undefined) {
    if (current === undefined) return source.file.content;
    source.document.deleteIn(pointer as (string | number)[]);
  } else {
    if (sameJsonValue(valueAt(source.raw, pointer), value)) return source.file.content;
    source.document.setIn(pointer as (string | number)[], value);
  }
  const serialized = source.document.toString().replaceAll("\n", sourceNewline(source));
  if (!source.markdown) return serialized;
  if (!source.markdown.opening) return `---${source.markdown.newline}${serialized}---${source.markdown.newline}${source.markdown.body}`;
  const header = serialized.replace(/(?:\r?\n)+$/u, "");
  return `${source.markdown.opening}${header}${source.markdown.newline}${source.markdown.closing}${source.markdown.body}`;
}

export function editSourcePaths(
  source: StorySourceDocument,
  edits: readonly { pointer: readonly (string | number)[]; value: unknown | undefined }[],
): string {
  const ordered = [...edits].sort((left, right) => comparePointersDescending(left.pointer, right.pointer));
  let changed = false;
  for (const edit of ordered) {
    if (edit.pointer.length === 0) throw new Error("The source root cannot be replaced.");
    const currentSourceValue = valueAt(source.raw, edit.pointer);
    if (edit.value === undefined) {
      if (currentSourceValue !== undefined) {
        source.document.deleteIn(edit.pointer as (string | number)[]);
        changed = true;
      }
    } else if (!sameJsonValue(currentSourceValue, edit.value)) {
      source.document.setIn(edit.pointer as (string | number)[], edit.value);
      changed = true;
    }
  }
  if (!changed) return source.file.content;
  const serialized = source.document.toString().replaceAll("\n", sourceNewline(source));
  if (!source.markdown) return serialized;
  if (!source.markdown.opening) return `---${source.markdown.newline}${serialized}---${source.markdown.newline}${source.markdown.body}`;
  const header = serialized.replace(/(?:\r?\n)+$/u, "");
  return `${source.markdown.opening}${header}${source.markdown.newline}${source.markdown.closing}${source.markdown.body}`;
}

/** Replace only the Markdown body; frontmatter bytes are left untouched. */
export function editStoryBody(source: StorySourceDocument, body: string): string {
  if (!source.markdown || body === source.markdown.body) return source.file.content;
  if (!source.markdown.opening) return body;
  return `${source.markdown.opening}${source.markdown.header}${source.markdown.closing}${body}`;
}

function valueAt(root: unknown, pointer: readonly (string | number)[]): unknown {
  let value = root;
  for (const part of pointer) {
    if (Array.isArray(value) && typeof part === "number") value = value[part];
    else if (isRecord(value) && typeof part === "string") value = value[part];
    else return undefined;
  }
  return value;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameJsonValue(left[key], right[key]),
  );
}

function comparePointersDescending(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  const leftParent = JSON.stringify(left.slice(0, -1));
  const rightParent = JSON.stringify(right.slice(0, -1));
  if (leftParent !== rightParent) return leftParent.localeCompare(rightParent);
  const leftLast = left.at(-1);
  const rightLast = right.at(-1);
  if (typeof leftLast === "number" && typeof rightLast === "number") return rightLast - leftLast;
  return JSON.stringify(right).localeCompare(JSON.stringify(left));
}

export function isEditableStoryType(type: StoryEntityType): type is Exclude<StoryEntityType, "dialogue_sketch"> {
  return type !== "dialogue_sketch";
}

export function parseStoryType(value: unknown): StoryEntityType | null {
  return typeof value === "string" && STORY_ENTITY_TYPES.includes(value as StoryEntityType)
    ? value as StoryEntityType
    : null;
}
