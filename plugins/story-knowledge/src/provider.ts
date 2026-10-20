import type {
  PluginHostClient,
  ProviderOpenResult,
  ProviderRequest,
  SnapshotRef,
} from "@scriptorium-atlas/contracts";
import { STORY_PROVIDER_ID } from "./domain/types.js";
import { StorySnapshotError, streamStorySnapshot } from "./workspace.js";
import { browserStoryWorkerFactory, StoryIndexWorkerClient, type StoryWorkerFactory } from "./worker-client.js";

export class StoryProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "StoryProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface StoryProviderEndpoint {
  dispatch(request: ProviderRequest, signal?: AbortSignal): Promise<unknown>;
  dispose(): void;
}

export interface StoryProviderOptions {
  /** Test seam; production always starts a real browser Worker on the first lease. */
  createWorker?: StoryWorkerFactory;
}

function providerError(error: unknown): StoryProviderError {
  if (error instanceof StoryProviderError) return error;
  if (error instanceof StorySnapshotError) return new StoryProviderError(error.code, error.message, error.code === "TIMEOUT" || error.code === "UNAVAILABLE");
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return new StoryProviderError(error.code, error instanceof Error ? error.message : String(error), error.code === "PROVIDER_FAILED" || error.code === "UNAVAILABLE");
  }
  return new StoryProviderError("PROVIDER_FAILED", error instanceof Error ? error.message : String(error), true);
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StoryProviderError("CANCELED", "Story provider request was canceled.");
}

function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new StoryProviderError("TIMEOUT", "Story provider request exceeded its deadline.", true);
}

function handleId(): string {
  if (!globalThis.crypto?.randomUUID) throw new StoryProviderError("UNAVAILABLE", "A cryptographic handle generator is required for Story Provider v1.");
  return `story-${globalThis.crypto.randomUUID()}`;
}

function equalSnapshot(left: SnapshotRef, right: SnapshotRef): boolean {
  return left.workspaceId === right.workspaceId && left.sourceRevision === right.sourceRevision
    && left.providerRevision === right.providerRevision && left.epoch === right.epoch;
}

function assertOpenGrant(request: Extract<ProviderRequest, { method: "open" }>): string[] {
  const graphRead = request.params.grants.some((grant) => grant.capability === "graph.read");
  const metadataRead = request.params.grants.find((grant) => grant.capability === "workspace.files.metadata");
  const fileRead = request.params.grants.find((grant) => grant.capability === "workspace.files.read");
  const prefixes = ["bible/", "plot/", "manuscript/"];
  const coversStory = (grant: typeof fileRead) => prefixes.every((prefix) => grant?.paths?.includes(prefix));
  if (!graphRead || !coversStory(metadataRead) || !coversStory(fileRead)) {
    throw new StoryProviderError("PERMISSION_DENIED", "Story Provider requires graph.read plus metadata and read grants scoped to Story source paths.");
  }
  return [...new Set(request.params.grants.map((grant) => grant.capability))].sort();
}

function snapshotExpectation(snapshot: SnapshotRef): { workspaceId: string; sourceRevision: string; epoch: number } {
  return { workspaceId: snapshot.workspaceId, sourceRevision: snapshot.sourceRevision, epoch: snapshot.epoch };
}

/**
 * Host adapter for the public Graph Provider contract. It is intentionally inert
 * until the first `open`; each live lease owns exactly one Story Worker.
 */
export function createStoryProvider(host: PluginHostClient, options: StoryProviderOptions = {}): StoryProviderEndpoint {
  const handles = new Map<string, StoryIndexWorkerClient>();
  const createWorker = options.createWorker ?? browserStoryWorkerFactory;
  let disposed = false;

  async function open(request: Extract<ProviderRequest, { method: "open" }>, signal?: AbortSignal): Promise<ProviderOpenResult> {
    if (disposed) throw new StoryProviderError("UNAVAILABLE", "Story Provider endpoint is disposed.");
    checkSignal(signal);
    checkDeadline(request.params.deadline);
    const capabilities = assertOpenGrant(request);
    if (request.params.workspaceId !== request.params.requestedSnapshot.workspaceId) {
      throw new StoryProviderError("SNAPSHOT_STALE", "Requested Story workspace does not match its snapshot.");
    }

    let worker: StoryIndexWorkerClient | undefined;
    try {
      worker = new StoryIndexWorkerClient(createWorker());
      const expected = snapshotExpectation(request.params.requestedSnapshot);
      await worker.begin(expected, signal);
      const actualWorkspace = await streamStorySnapshot(
        host,
        expected,
        async (page) => {
          checkSignal(signal);
          checkDeadline(request.params.deadline);
          await worker!.append(page, signal);
        },
        signal,
      );
      if (actualWorkspace.workspaceId !== expected.workspaceId || actualWorkspace.sourceRevision !== expected.sourceRevision || actualWorkspace.epoch !== expected.epoch) {
        throw new StoryProviderError("SNAPSHOT_STALE", "Host returned a different Story workspace snapshot.");
      }
      checkSignal(signal);
      checkDeadline(request.params.deadline);
      const actualSnapshot = await worker.finish(signal);
      if (!equalSnapshot(actualSnapshot, request.params.requestedSnapshot)) {
        throw new StoryProviderError("SNAPSHOT_STALE", "Story index revision does not match the requested provider snapshot.");
      }
      checkSignal(signal);
      checkDeadline(request.params.deadline);
      const handle = handleId();
      handles.set(handle, worker);
      return { handle, actualSnapshot, capabilities };
    } catch (error) {
      worker?.close();
      throw providerError(error);
    }
  }

  function workerFor(handle: string): StoryIndexWorkerClient {
    const worker = handles.get(handle);
    if (!worker) throw new StoryProviderError("UNAVAILABLE", "Story provider lease is missing or closed.", true);
    return worker;
  }

  async function withWorker<T>(handle: string, operation: (worker: StoryIndexWorkerClient) => Promise<T>): Promise<T> {
    const worker = workerFor(handle);
    try {
      return await operation(worker);
    } catch (error) {
      if (worker.isTerminated) handles.delete(handle);
      throw providerError(error);
    }
  }

  async function dispatch(request: ProviderRequest, signal?: AbortSignal): Promise<unknown> {
    if (disposed) throw new StoryProviderError("UNAVAILABLE", "Story Provider endpoint is disposed.");
    checkSignal(signal);
    try {
      switch (request.method) {
        case "open":
          return await open(request, signal);
        case "listNodes": {
          const { handle, ...params } = request.params;
          return await withWorker(handle, (worker) => worker.listNodes(handle, params, signal));
        }
        case "listEdges": {
          const { handle, ...params } = request.params;
          return await withWorker(handle, (worker) => worker.listEdges(handle, params, signal));
        }
        case "getNodes": {
          const { handle: _handle, ...params } = request.params;
          return await withWorker(request.params.handle, (worker) => worker.getNodes(params, signal));
        }
        case "neighbors": {
          const { handle, ...params } = request.params;
          return await withWorker(handle, (worker) => worker.neighbors(handle, params, signal));
        }
        case "diff": {
          const { handle, ...params } = request.params;
          return await withWorker(handle, (worker) => worker.diff(handle, params, signal));
        }
        case "close": {
          const worker = handles.get(request.params.handle);
          handles.delete(request.params.handle);
          worker?.close();
          return null;
        }
        case "cancel":
          // The Atlas Story frame owns request cancellation and aborts the dispatch signal.
          return null;
      }
    } catch (error) {
      throw providerError(error);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const worker of handles.values()) worker.close();
    handles.clear();
  }

  return { dispatch, dispose };
}

export { describeStoryProvider, providerDescriptor } from "./metadata.js";
