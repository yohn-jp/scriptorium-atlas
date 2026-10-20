import {
  decodeVersionedFileText,
  hasSnapshotContent,
} from "@scriptorium-atlas/contracts/host";
import type { SnapshotFileMetadata, VersionedFile, VersionedFileChunk, WorkspaceHandle, WorkspaceSnapshotFile } from "@scriptorium-atlas/contracts";
import type { PluginHostClient } from "@scriptorium-atlas/contracts";
import { isStorySourcePath } from "./domain/paths.js";
import type { StorySnapshotInput, StorySourceFile, StoryUnavailableSource } from "./domain/types.js";

export const MAX_STORY_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_SOURCE_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_PAGE_SIZE = 128;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

export class StorySnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StorySnapshotError";
    this.code = code;
  }
}

export interface StorySnapshotExpectation {
  workspaceId: string;
  sourceRevision: string;
  epoch: number;
}

export interface StorySnapshotPageContents {
  files: StorySourceFile[];
  unavailableFiles: StoryUnavailableSource[];
}

export type StorySnapshotPageConsumer = (contents: StorySnapshotPageContents) => Promise<void> | void;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StorySnapshotError("CANCELED", "Story snapshot loading was canceled.");
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new StorySnapshotError("CANCELED", "Story snapshot loading was canceled."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new StorySnapshotError("CANCELED", "Story snapshot loading was canceled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new StorySnapshotError("PROTOCOL_INVALID", "Host returned an invalid base64 source chunk.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function assertFileIdentity(file: VersionedFile | VersionedFileChunk, metadata: SnapshotFileMetadata, workspace: WorkspaceHandle): void {
  if (file.workspaceId !== workspace.workspaceId || file.path !== metadata.path || file.revision !== metadata.revision) {
    throw new StorySnapshotError("SNAPSHOT_STALE", `Source '${metadata.path}' changed while Story was loading the pinned snapshot.`);
  }
}

async function readMetadataSource(
  host: PluginHostClient,
  metadata: SnapshotFileMetadata,
  workspace: WorkspaceHandle,
  signal?: AbortSignal,
): Promise<string> {
  if (metadata.byteLength > MAX_STORY_SOURCE_BYTES) {
    throw new StorySnapshotError("SOURCE_SIZE_LIMIT", `Source '${metadata.path}' exceeds Story's 2 MiB parsing limit.`);
  }
  if (metadata.encoding !== "utf8") {
    throw new StorySnapshotError("SOURCE_ENCODING_UNSUPPORTED", `Source '${metadata.path}' is not marked as UTF-8 text.`);
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    checkAbort(signal);
    let result: VersionedFile | VersionedFileChunk;
    try {
      result = await awaitWithAbort(host.read({
        path: metadata.path,
        expectedRevision: metadata.revision,
        maxBytes: MAX_STORY_SOURCE_BYTES,
        offset,
        limit: Math.min(READ_CHUNK_BYTES, MAX_STORY_SOURCE_BYTES - offset),
      }), signal);
    } catch (error) {
      const code = errorCode(error);
      if (code === "SNAPSHOT_STALE" || code === "REVISION_CONFLICT") {
        throw new StorySnapshotError("SNAPSHOT_STALE", `Source '${metadata.path}' no longer matches the Host snapshot.`);
      }
      throw error;
    }
    checkAbort(signal);
    assertFileIdentity(result, metadata, workspace);

    if ("contentType" in result) {
      if (result.encoding !== "utf8") throw new StorySnapshotError("SOURCE_ENCODING_UNSUPPORTED", `Source '${metadata.path}' is not UTF-8 text.`);
      let text: string;
      try {
        text = decodeVersionedFileText(result);
      } catch {
        throw new StorySnapshotError("SOURCE_ENCODING_UNSUPPORTED", `Source '${metadata.path}' contains invalid UTF-8.`);
      }
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength !== metadata.byteLength || bytes.byteLength > MAX_STORY_SOURCE_BYTES) {
        throw new StorySnapshotError("SNAPSHOT_STALE", `Source '${metadata.path}' byte length differs from its Host metadata.`);
      }
      return text;
    }

    if (result.encoding !== "base64" || result.offset !== offset) {
      throw new StorySnapshotError("PROTOCOL_INVALID", `Host returned an invalid chunk offset for '${metadata.path}'.`);
    }
    const bytes = decodeBase64(result.content);
    if (bytes.byteLength === 0 && !result.complete) {
      throw new StorySnapshotError("PROTOCOL_INVALID", `Host returned an empty non-final chunk for '${metadata.path}'.`);
    }
    if (result.nextOffset !== offset + bytes.byteLength || result.nextOffset > MAX_STORY_SOURCE_BYTES) {
      throw new StorySnapshotError("PROTOCOL_INVALID", `Host returned an invalid chunk length for '${metadata.path}'.`);
    }
    chunks.push(bytes);
    offset = result.nextOffset;
    if (result.complete) break;
    if (offset >= MAX_STORY_SOURCE_BYTES) {
      throw new StorySnapshotError("SOURCE_SIZE_LIMIT", `Source '${metadata.path}' exceeds Story's 2 MiB parsing limit.`);
    }
  }

  if (offset !== metadata.byteLength) {
    throw new StorySnapshotError("SNAPSHOT_STALE", `Source '${metadata.path}' byte length differs from its Host metadata.`);
  }
  const joined = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    joined.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new StorySnapshotError("SOURCE_ENCODING_UNSUPPORTED", `Source '${metadata.path}' contains invalid UTF-8.`);
  }
}

async function resolveStoryFile(
  host: PluginHostClient,
  file: WorkspaceSnapshotFile,
  workspace: WorkspaceHandle,
  signal?: AbortSignal,
): Promise<StorySourceFile | StoryUnavailableSource | undefined> {
  if (!isStorySourcePath(file.path)) return undefined;
  if (file.workspaceId !== workspace.workspaceId) {
    throw new StorySnapshotError("SNAPSHOT_STALE", `Source '${file.path}' belongs to a different workspace.`);
  }
  if (hasSnapshotContent(file)) {
    try {
      const content = decodeVersionedFileText(file);
      const byteLength = new TextEncoder().encode(content).byteLength;
      if (byteLength > MAX_STORY_SOURCE_BYTES) {
        return { path: file.path, revision: file.revision, byteLength, contentType: file.contentType };
      }
      return { path: file.path, revision: file.revision, content };
    } catch {
      return { path: file.path, revision: file.revision, byteLength: new TextEncoder().encode(file.content).byteLength, contentType: file.contentType };
    }
  }

  try {
    const content = await readMetadataSource(host, file, workspace, signal);
    return { path: file.path, revision: file.revision, content };
  } catch (error) {
    if (signal?.aborted || errorCode(error) === "CANCELED" || errorCode(error) === "SNAPSHOT_STALE") throw error;
    return { path: file.path, revision: file.revision, byteLength: file.byteLength, contentType: file.contentType };
  }
}

/**
 * Walk every Host page and deliver only in-scope Story sources. It refuses to turn a
 * changing workspace, repeated cursor, or incomplete inventory into a plausible index.
 */
export async function streamStorySnapshot(
  host: PluginHostClient,
  expected?: StorySnapshotExpectation,
  consumePage?: StorySnapshotPageConsumer,
  signal?: AbortSignal,
): Promise<WorkspaceHandle> {
  let cursor: string | undefined;
  let workspace: WorkspaceHandle | undefined;
  let totalSourceBytes = 0;
  let totalStoryFiles = 0;
  const seenCursors = new Set<string>();

  for (;;) {
    checkAbort(signal);
    const page = await awaitWithAbort(host.snapshot({ ...(cursor ? { cursor } : {}), limit: SNAPSHOT_PAGE_SIZE }), signal);
    checkAbort(signal);
    if (!workspace) {
      workspace = page.workspace;
      if (expected && (workspace.workspaceId !== expected.workspaceId || workspace.sourceRevision !== expected.sourceRevision || workspace.epoch !== expected.epoch)) {
        throw new StorySnapshotError("SNAPSHOT_STALE", "Host workspace does not match the requested Story snapshot.");
      }
    } else if (page.workspace.workspaceId !== workspace.workspaceId || page.workspace.sourceRevision !== workspace.sourceRevision || page.workspace.epoch !== workspace.epoch) {
      throw new StorySnapshotError("SNAPSHOT_STALE", "Host workspace changed while Story was reading snapshot pages.");
    }

    const contents: StorySnapshotPageContents = { files: [], unavailableFiles: [] };
    for (const file of page.files) {
      checkAbort(signal);
      const resolved = await resolveStoryFile(host, file, workspace, signal);
      if (!resolved) continue;
      totalStoryFiles += 1;
      if (totalStoryFiles > 100_000) throw new StorySnapshotError("QUOTA_EXCEEDED", "Story source inventory exceeds 100,000 files.");
      if ("content" in resolved) {
        totalSourceBytes += new TextEncoder().encode(resolved.content).byteLength;
        contents.files.push(resolved);
      } else {
        totalSourceBytes += resolved.byteLength;
        contents.unavailableFiles.push(resolved);
      }
      if (totalSourceBytes > MAX_WORKSPACE_SOURCE_BYTES) throw new StorySnapshotError("QUOTA_EXCEEDED", "Story source inventory exceeds the 256 MiB workspace limit.");
    }
    await consumePage?.(contents);

    if (page.complete) return workspace;
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new StorySnapshotError("RESYNC_REQUIRED", "Host snapshot pagination ended before the inventory was complete.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export async function loadStorySnapshot(
  host: PluginHostClient,
  expected?: StorySnapshotExpectation,
  signal?: AbortSignal,
): Promise<StorySnapshotInput> {
  const files: StorySourceFile[] = [];
  const unavailableFiles: StoryUnavailableSource[] = [];
  const workspace = await streamStorySnapshot(host, expected, (page) => {
    files.push(...page.files);
    unavailableFiles.push(...page.unavailableFiles);
  }, signal);
  return {
    workspaceId: workspace.workspaceId,
    sourceRevision: workspace.sourceRevision,
    epoch: workspace.epoch,
    files,
    unavailableFiles,
  };
}
