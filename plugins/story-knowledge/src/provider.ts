import type {
  PluginHostClient,
  ProviderOpenResult,
  ProviderRequest,
  SnapshotRef,
} from "@scriptorium-atlas/contracts";
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
    return new StoryProviderError(error.code, error instanceof Error ? error.message : String(error), ["PROVIDER_FAILED", "UNAVAILABLE", "OVERLOADED", "TIMEOUT"].includes(error.code));
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
 * until the first `open`; one Worker retains immutable snapshots while leases are active.
 */
export function createStoryProvider(host: PluginHostClient, options: StoryProviderOptions = {}): StoryProviderEndpoint {
  const handles = new Set<string>();
  const createWorker = options.createWorker ?? browserStoryWorkerFactory;
  const maxActiveLeases = 64;
  let disposed = false;
  let worker: StoryIndexWorkerClient | undefined;
  let openQueue: Promise<void> = Promise.resolve();

  function enqueueOpen<T>(operation: () => Promise<T>): Promise<T> {
    const result = openQueue.then(operation, operation);
    openQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function resetTerminatedWorker(candidate: StoryIndexWorkerClient): void {
    if (worker !== candidate || !candidate.isTerminated) return;
    worker = undefined;
    handles.clear();
  }

  function activeWorker(): StoryIndexWorkerClient {
    if (worker?.isTerminated) resetTerminatedWorker(worker);
    if (!worker) worker = new StoryIndexWorkerClient(createWorker());
    return worker;
  }

  async function open(request: Extract<ProviderRequest, { method: "open" }>, signal?: AbortSignal): Promise<ProviderOpenResult> {
    return enqueueOpen(async () => {
    if (disposed) throw new StoryProviderError("UNAVAILABLE", "Story Provider endpoint is disposed.");
    checkSignal(signal);
    checkDeadline(request.params.deadline);
    if (handles.size >= maxActiveLeases) throw new StoryProviderError("OVERLOADED", "Story Provider reached its 64 active lease limit.", true);
    const capabilities = assertOpenGrant(request);
    if (request.params.workspaceId !== request.params.requestedSnapshot.workspaceId) {
      throw new StoryProviderError("SNAPSHOT_STALE", "Requested Story workspace does not match its snapshot.");
    }

    const handle = handleId();
    const client = activeWorker();
    try {
      const expected = snapshotExpectation(request.params.requestedSnapshot);
      await client.begin(handle, expected, signal);
      const actualWorkspace = await streamStorySnapshot(
        host,
        expected,
        async (page) => {
          checkSignal(signal);
          checkDeadline(request.params.deadline);
          await client.append(page, signal);
        },
        signal,
      );
      if (actualWorkspace.workspaceId !== expected.workspaceId || actualWorkspace.sourceRevision !== expected.sourceRevision || actualWorkspace.epoch !== expected.epoch) {
        throw new StoryProviderError("SNAPSHOT_STALE", "Host returned a different Story workspace snapshot.");
      }
      checkSignal(signal);
      checkDeadline(request.params.deadline);
      const actualSnapshot = await client.finish(handle, signal);
      if (!equalSnapshot(actualSnapshot, request.params.requestedSnapshot)) {
        throw new StoryProviderError("SNAPSHOT_STALE", "Story index revision does not match the requested provider snapshot.");
      }
      checkSignal(signal);
      checkDeadline(request.params.deadline);
      handles.add(handle);
      return { handle, actualSnapshot, capabilities };
    } catch (error) {
      if (client.isTerminated) {
        resetTerminatedWorker(client);
      } else {
        try {
          await client.release(handle);
        } catch {
          if (client.isTerminated) resetTerminatedWorker(client);
        }
        if (handles.size === 0 && worker === client && !client.isTerminated) {
          client.close();
          worker = undefined;
        }
      }
      throw providerError(error);
    }
    });
  }

  function workerFor(handle: string): StoryIndexWorkerClient {
    if (!handles.has(handle) || !worker) throw new StoryProviderError("UNAVAILABLE", "Story provider lease is missing or closed.", true);
    if (worker.isTerminated) {
      resetTerminatedWorker(worker);
      throw new StoryProviderError("UNAVAILABLE", "Story provider worker stopped; all leases must be reopened.", true);
    }
    return worker;
  }

  async function withWorker<T>(handle: string, operation: (worker: StoryIndexWorkerClient) => Promise<T>): Promise<T> {
    const worker = workerFor(handle);
    try {
      return await operation(worker);
    } catch (error) {
      resetTerminatedWorker(worker);
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
          const { handle, ...params } = request.params;
          return await withWorker(handle, (client) => client.getNodes(handle, params, signal));
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
          const handle = request.params.handle;
          const client = worker;
          if (!handles.delete(handle)) {
            if (client?.isTerminated) resetTerminatedWorker(client);
            return null;
          }
          if (client?.isTerminated) resetTerminatedWorker(client);
          else if (client) await client.release(handle);
          if (handles.size === 0 && client && worker === client) {
            client.close();
            worker = undefined;
          }
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
    worker?.close();
    worker = undefined;
    handles.clear();
  }

  return { dispatch, dispose };
}

export { describeStoryProvider, providerDescriptor } from "./metadata.js";
