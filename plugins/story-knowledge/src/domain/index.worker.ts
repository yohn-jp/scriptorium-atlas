import type { GraphDeltaPage, GraphEdgePage, NeighborPage, ProviderPage, ProviderRequest, SnapshotRef } from "@scriptorium-atlas/contracts";
import { buildStoryIndex } from "./index.js";
import {
  getStoryNodes,
  listStoryEdges,
  listStoryNodes,
  projectStoryGraph,
  storyDiff,
  storyNeighbors,
  type StoryGraphProjection,
} from "./graph.js";
import type { StorySnapshotPageContents, StorySnapshotExpectation } from "../workspace.js";
import type { StoryIndex, StorySourceFile, StoryUnavailableSource } from "./types.js";

type ListNodesQuery = Omit<Extract<ProviderRequest, { method: "listNodes" }>['params'], "handle">;
type ListEdgesQuery = Omit<Extract<ProviderRequest, { method: "listEdges" }>['params'], "handle">;
type GetNodesQuery = Omit<Extract<ProviderRequest, { method: "getNodes" }>['params'], "handle">;
type NeighborsQuery = Omit<Extract<ProviderRequest, { method: "neighbors" }>['params'], "handle">;
type DiffQuery = Omit<Extract<ProviderRequest, { method: "diff" }>['params'], "handle">;

export type StoryIndexWorkerRequest =
  | { id: number; method: "begin"; handle: string; params: StorySnapshotExpectation }
  | { id: number; method: "append"; params: StorySnapshotPageContents }
  | { id: number; method: "finish"; handle: string }
  | { id: number; method: "listNodes"; handle: string; params: ListNodesQuery }
  | { id: number; method: "listEdges"; handle: string; params: ListEdgesQuery }
  | { id: number; method: "getNodes"; handle: string; params: GetNodesQuery }
  | { id: number; method: "neighbors"; handle: string; params: NeighborsQuery }
  | { id: number; method: "diff"; handle: string; params: DiffQuery }
  | { id: number; method: "close"; handle: string };

export type StoryIndexWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

type WorkerGlobal = {
  onmessage: ((event: MessageEvent<StoryIndexWorkerRequest>) => void) | null;
  postMessage(message: StoryIndexWorkerResponse): void;
};

interface SnapshotState {
  index: StoryIndex;
  projection: StoryGraphProjection;
  estimatedBytes: number;
}

interface StagingSnapshot extends StorySnapshotExpectation {
  handle: string;
  files: StorySourceFile[];
  unavailableFiles: StoryUnavailableSource[];
}

const MAX_ACTIVE_LEASES = 64;
const MAX_CACHED_SNAPSHOTS = 3;
const MAX_RETAINED_INDEX_BYTES = 256 * 1024 * 1024;

const snapshots = new Map<string, SnapshotState>();
const leases = new Map<string, string>();
let staging: StagingSnapshot | undefined;

function snapshotKey(snapshot: SnapshotRef): string {
  return JSON.stringify([snapshot.workspaceId, snapshot.sourceRevision, snapshot.providerRevision, snapshot.epoch]);
}

function errorResponse(id: number, error: unknown): StoryIndexWorkerResponse {
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  return {
    id,
    ok: false,
    error: {
      code: typeof value.code === "string" ? value.code : "PROVIDER_FAILED",
      message: typeof value.message === "string" ? value.message.slice(0, 2048) : "Story index worker failed.",
    },
  };
}

function stateForHandle(handle: string): SnapshotState {
  const key = leases.get(handle);
  const state = key ? snapshots.get(key) : undefined;
  if (!state) throw Object.assign(new Error("Story provider lease is missing or closed."), { code: "UNAVAILABLE" });
  return state;
}

function isLeased(key: string): boolean {
  for (const value of leases.values()) if (value === key) return true;
  return false;
}

function retainedBytes(): number {
  let total = 0;
  for (const state of snapshots.values()) total += state.estimatedBytes;
  return total;
}

function evictOldestUnleased(): boolean {
  for (const key of snapshots.keys()) {
    if (isLeased(key)) continue;
    snapshots.delete(key);
    return true;
  }
  return false;
}

function trimUnleasedSnapshots(): void {
  let cached = [...snapshots.keys()].filter((key) => !isLeased(key)).length;
  while (cached > MAX_CACHED_SNAPSHOTS) {
    if (!evictOldestUnleased()) break;
    cached -= 1;
  }
}

function estimateIndexBytes(index: StoryIndex): number {
  const sourceBytes = [...index.files.values()].reduce((total, file) => total + new TextEncoder().encode(file.content).byteLength, 0);
  // Parsed YAML ASTs, entity objects, references and graph projections all add memory over source text.
  return sourceBytes * 2 + index.entities.length * 2048 + index.references.length * 1024 + index.diagnostics.length * 512;
}

function rememberSnapshot(key: string, state: SnapshotState, handle: string): void {
  while (retainedBytes() + state.estimatedBytes > MAX_RETAINED_INDEX_BYTES) {
    if (!evictOldestUnleased()) {
      throw Object.assign(new Error("Story snapshot cache is at its retained-memory limit."), { code: "OVERLOADED" });
    }
  }
  snapshots.set(key, state);
  leases.set(handle, key);
  trimUnleasedSnapshots();
}

function currentLatestIndex(expected: StorySnapshotExpectation): StoryIndex | undefined {
  for (const state of [...snapshots.values()].reverse()) {
    const index = state.index;
    if (index.workspaceId === expected.workspaceId && index.epoch === expected.epoch) return index;
  }
  return undefined;
}

function findPreviousProjection(snapshot: SnapshotRef): StoryGraphProjection | undefined {
  return snapshots.get(snapshotKey(snapshot))?.projection;
}

async function finishSnapshot(handle: string): Promise<SnapshotRef> {
  if (!staging || staging.handle !== handle) {
    throw Object.assign(new Error("Story index worker cannot finish this snapshot collection."), { code: "PROTOCOL_INVALID" });
  }
  const captured = staging;
  staging = undefined;
  const index = await buildStoryIndex({
    workspaceId: captured.workspaceId,
    sourceRevision: captured.sourceRevision,
    epoch: captured.epoch,
    files: captured.files,
    unavailableFiles: captured.unavailableFiles,
  }, currentLatestIndex(captured));
  const projection = projectStoryGraph(index);
  const key = snapshotKey(projection.snapshot);
  const existing = snapshots.get(key);
  if (existing) {
    snapshots.delete(key);
    snapshots.set(key, existing);
    leases.set(handle, key);
    trimUnleasedSnapshots();
    return existing.projection.snapshot;
  }
  const estimatedBytes = estimateIndexBytes(index);
  if (estimatedBytes > MAX_RETAINED_INDEX_BYTES) {
    throw Object.assign(new Error("Story snapshot exceeds the retained-memory budget."), { code: "OVERLOADED" });
  }
  rememberSnapshot(key, { index, projection, estimatedBytes }, handle);
  return projection.snapshot;
}

async function respond(request: StoryIndexWorkerRequest): Promise<StoryIndexWorkerResponse> {
  try {
    switch (request.method) {
      case "begin":
        if (staging) throw Object.assign(new Error("Story index worker is already collecting a snapshot."), { code: "OVERLOADED" });
        if (leases.has(request.handle)) throw Object.assign(new Error("Story lease handle is already active."), { code: "PROTOCOL_INVALID" });
        if (leases.size >= MAX_ACTIVE_LEASES) throw Object.assign(new Error("Story Worker reached its active lease limit."), { code: "OVERLOADED" });
        staging = { ...request.params, handle: request.handle, files: [], unavailableFiles: [] };
        return { id: request.id, ok: true, result: null };
      case "append":
        if (!staging) throw Object.assign(new Error("Story index worker is not collecting source pages."), { code: "PROTOCOL_INVALID" });
        staging.files.push(...request.params.files);
        staging.unavailableFiles.push(...request.params.unavailableFiles);
        return { id: request.id, ok: true, result: null };
      case "finish":
        return { id: request.id, ok: true, result: await finishSnapshot(request.handle) };
      case "listNodes": {
        const state = stateForHandle(request.handle);
        return { id: request.id, ok: true, result: listStoryNodes(state.projection, request.handle, request.params) as ProviderPage };
      }
      case "listEdges": {
        const state = stateForHandle(request.handle);
        return { id: request.id, ok: true, result: listStoryEdges(state.projection, request.handle, request.params) as GraphEdgePage };
      }
      case "getNodes": {
        const state = stateForHandle(request.handle);
        return { id: request.id, ok: true, result: getStoryNodes(state.projection, request.params.refs) as ProviderPage };
      }
      case "neighbors": {
        const state = stateForHandle(request.handle);
        return { id: request.id, ok: true, result: storyNeighbors(state.projection, request.handle, request.params) as NeighborPage };
      }
      case "diff": {
        const state = stateForHandle(request.handle);
        const previous = findPreviousProjection(request.params.previousSnapshot);
        if (!previous) throw Object.assign(new Error("The previous Story index is not available; request a full provider resync."), { code: "RESYNC_REQUIRED" });
        return { id: request.id, ok: true, result: storyDiff(state.projection, previous, request.handle, request.params) as GraphDeltaPage };
      }
      case "close": {
        const key = leases.get(request.handle);
        leases.delete(request.handle);
        if (key && snapshots.has(key)) {
          const state = snapshots.get(key)!;
          snapshots.delete(key);
          snapshots.set(key, state);
          trimUnleasedSnapshots();
        }
        return { id: request.id, ok: true, result: null };
      }
    }
  } catch (error) {
    return errorResponse(request.id, error);
  }
}

const worker = globalThis as unknown as WorkerGlobal;
worker.onmessage = (event) => {
  void respond(event.data).then((result) => worker.postMessage(result));
};
