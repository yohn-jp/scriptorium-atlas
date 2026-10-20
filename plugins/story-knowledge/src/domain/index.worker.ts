import type { GraphDeltaPage, GraphEdgePage, NeighborPage, ProviderPage, ProviderRequest } from "@scriptorium-atlas/contracts";
import { buildStoryIndex } from "./index.js";
import {
  getStoryNodes,
  listStoryEdges,
  listStoryNodes,
  projectStoryGraph,
  storyDiff,
  storyNeighbors,
} from "./graph.js";
import type { StorySnapshotPageContents, StorySnapshotExpectation } from "../workspace.js";
import type { StoryIndex, StorySourceFile, StoryUnavailableSource } from "./types.js";

type ListNodesQuery = Omit<Extract<ProviderRequest, { method: "listNodes" }>['params'], "handle">;
type ListEdgesQuery = Omit<Extract<ProviderRequest, { method: "listEdges" }>['params'], "handle">;
type GetNodesQuery = Omit<Extract<ProviderRequest, { method: "getNodes" }>['params'], "handle">;
type NeighborsQuery = Omit<Extract<ProviderRequest, { method: "neighbors" }>['params'], "handle">;
type DiffQuery = Omit<Extract<ProviderRequest, { method: "diff" }>['params'], "handle">;

export type StoryIndexWorkerRequest =
  | { id: number; method: "begin"; params: StorySnapshotExpectation }
  | { id: number; method: "append"; params: StorySnapshotPageContents }
  | { id: number; method: "finish" }
  | { id: number; method: "listNodes"; handle: string; params: ListNodesQuery }
  | { id: number; method: "listEdges"; handle: string; params: ListEdgesQuery }
  | { id: number; method: "getNodes"; params: GetNodesQuery }
  | { id: number; method: "neighbors"; handle: string; params: NeighborsQuery }
  | { id: number; method: "diff"; handle: string; params: DiffQuery }
  | { id: number; method: "close" };

export type StoryIndexWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

type WorkerGlobal = {
  onmessage: ((event: MessageEvent<StoryIndexWorkerRequest>) => void) | null;
  postMessage(message: StoryIndexWorkerResponse): void;
};

let expected: StorySnapshotExpectation | undefined;
let sourceFiles: StorySourceFile[] = [];
let unavailableFiles: StoryUnavailableSource[] = [];
let index: StoryIndex | undefined;
let projection: ReturnType<typeof projectStoryGraph> | undefined;

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

async function respond(request: StoryIndexWorkerRequest): Promise<StoryIndexWorkerResponse> {
  try {
    switch (request.method) {
      case "begin":
        if (index) throw Object.assign(new Error("Story index worker is already open."), { code: "PROTOCOL_INVALID" });
        expected = request.params;
        sourceFiles = [];
        unavailableFiles = [];
        return { id: request.id, ok: true, result: null };
      case "append":
        if (!expected || index) throw Object.assign(new Error("Story index worker is not collecting source pages."), { code: "PROTOCOL_INVALID" });
        sourceFiles.push(...request.params.files);
        unavailableFiles.push(...request.params.unavailableFiles);
        return { id: request.id, ok: true, result: null };
      case "finish": {
        if (!expected || index) throw Object.assign(new Error("Story index worker cannot finish in its current state."), { code: "PROTOCOL_INVALID" });
        index = await buildStoryIndex({ ...expected, files: sourceFiles, unavailableFiles });
        sourceFiles = [];
        unavailableFiles = [];
        projection = projectStoryGraph(index);
        return { id: request.id, ok: true, result: projection.snapshot };
      }
      case "listNodes":
        if (!projection) throw Object.assign(new Error("Story index is not ready."), { code: "PROTOCOL_INVALID" });
        return { id: request.id, ok: true, result: listStoryNodes(projection, request.handle, request.params) as ProviderPage };
      case "listEdges":
        if (!projection) throw Object.assign(new Error("Story index is not ready."), { code: "PROTOCOL_INVALID" });
        return { id: request.id, ok: true, result: listStoryEdges(projection, request.handle, request.params) as GraphEdgePage };
      case "getNodes":
        if (!projection) throw Object.assign(new Error("Story index is not ready."), { code: "PROTOCOL_INVALID" });
        return { id: request.id, ok: true, result: getStoryNodes(projection, request.params.refs) as ProviderPage };
      case "neighbors":
        if (!projection) throw Object.assign(new Error("Story index is not ready."), { code: "PROTOCOL_INVALID" });
        return { id: request.id, ok: true, result: storyNeighbors(projection, request.handle, request.params) as NeighborPage };
      case "diff":
        if (!projection) throw Object.assign(new Error("Story index is not ready."), { code: "PROTOCOL_INVALID" });
        return { id: request.id, ok: true, result: storyDiff(projection, request.handle, request.params) as GraphDeltaPage };
      case "close":
        expected = undefined;
        sourceFiles = [];
        unavailableFiles = [];
        index = undefined;
        projection = undefined;
        return { id: request.id, ok: true, result: null };
    }
  } catch (error) {
    return errorResponse(request.id, error);
  }
}

const worker = globalThis as unknown as WorkerGlobal;
worker.onmessage = (event) => {
  void respond(event.data).then((result) => worker.postMessage(result));
};
